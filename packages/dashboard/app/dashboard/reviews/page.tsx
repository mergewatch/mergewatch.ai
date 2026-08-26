export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { resolveActiveInstallation } from "@/lib/server-org";
import {
  fetchUserInstallations,
  fetchAccessibleRepoNames,
  TokenExpiredError,
} from "@/lib/github-repos";
import ReviewsClient from "@/components/ReviewsClient";

interface ReviewsPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function ReviewsPage({ searchParams }: ReviewsPageProps) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) redirect("/");

  const params = await searchParams;

  let installations;
  try {
    installations = await fetchUserInstallations(accessToken);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    throw err;
  }

  if (installations.length === 0) redirect("/onboarding");

  const orgParam = typeof params.org === "string" ? params.org : undefined;
  const activeInstallation = await resolveActiveInstallation({
    installations,
    orgParam,
    githubUserId: (session as any).githubUserId as string | undefined,
  });

  const installationId = String(activeInstallation.id);

  // Get repo names for the filter dropdown, scoped to repos
  // the user can actually access via GitHub
  const repos: string[] = [];

  try {
    const userRepoNames = await fetchAccessibleRepoNames(accessToken, activeInstallation.id);
    userRepoNames.forEach((name) => repos.push(name));
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      redirect("/signout");
    }
    // Other errors — show empty state
  }

  repos.sort();

  return (
    <ReviewsClient
      repos={repos}
      installationId={installationId}
    />
  );
}
