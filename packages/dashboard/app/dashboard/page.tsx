export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { resolveActiveInstallation } from "@/lib/server-org";
import {
  fetchUserInstallations,
  fetchAccessibleRepoNames,
  TokenExpiredError,
} from "@/lib/github-repos";
import DashboardContent from "@/components/DashboardContent";

interface DashboardPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Dashboard page — shows repos with recent review activity, sorted by last review.
 */
export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/");
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    redirect("/");
  }

  const params = await searchParams;

  // Fetch installations
  let installations;
  try {
    installations = await fetchUserInstallations(accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    throw err;
  }

  if (installations.length === 0) {
    redirect("/onboarding");
  }

  // Determine active installation from ?org= param or default to first
  const orgParam = typeof params.org === "string" ? params.org : undefined;
  const activeInstallation = await resolveActiveInstallation({
    installations,
    orgParam,
    githubUserId: (session as any).githubUserId as string | undefined,
  });

  const installationId = String(activeInstallation.id);

  const store = await getDashboardStore();

  // Fetch accessible repo names from GitHub
  let repoNames: string[] = [];
  try {
    const repoSet = await fetchAccessibleRepoNames(accessToken, activeInstallation.id);
    repoNames = Array.from(repoSet);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    console.error("[dashboard] failed to fetch accessible repos:", err);
  }

  // Get per-repo stats, filter to repos with reviews, sort by last reviewed
  const statsMap = repoNames.length > 0
    ? await store.reviews.getRepoStats(repoNames)
    : new Map();

  const repos = Array.from(statsMap.entries())
    .map(([repoFullName, stats]) => ({
      repoFullName,
      reviewCount: stats.reviewCount,
      lastReviewedAt: stats.lastReviewedAt,
    }))
    .sort((a, b) => {
      const aDate = a.lastReviewedAt ?? "";
      const bDate = b.lastReviewedAt ?? "";
      return bDate.localeCompare(aDate);
    });

  return (
    <DashboardContent
      repos={repos}
      installationId={installationId}
    />
  );
}
