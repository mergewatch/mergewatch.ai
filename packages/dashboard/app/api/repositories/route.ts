import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import {
  fetchUserInstallations,
  fetchInstallationReposPage,
  TokenExpiredError,
} from "@/lib/github-repos";

/**
 * GET /api/repositories?installation_id=<id>&page=<n>&per_page=<n>
 *
 * Returns a single page of repos enriched with review stats.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  const installationIdParam = req.nextUrl.searchParams.get("installation_id");
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? "1"));
  const perPage = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("per_page") ?? "30")));

  if (!installationIdParam) {
    return NextResponse.json({ error: "installation_id is required" }, { status: 400 });
  }

  try {
    const userInstallations = await fetchUserInstallations(accessToken);
    const installation = userInstallations.find((i) => String(i.id) === installationIdParam);
    if (!installation) {
      return NextResponse.json({ error: "Installation not found" }, { status: 404 });
    }

    // Fetch one page of repos from GitHub
    const { repos: ghRepos, totalCount, hasMore } = await fetchInstallationReposPage(
      accessToken,
      installation.id,
      page,
      perPage,
    );

    const store = await getDashboardStore();

    // Fetch review stats for this page's repos
    const repoNames = ghRepos.map((r) => r.repoFullName);
    const statsMap = await store.reviews.getRepoStats(repoNames);

    // Build enriched response
    const repos = ghRepos.map((r) => {
      const stats = statsMap.get(r.repoFullName);
      return {
        fullName: r.repoFullName,
        githubUrl: r.htmlUrl,
        language: r.language,
        isPrivate: r.isPrivate,
        reviewCount: stats?.reviewCount ?? 0,
        issueCount: stats?.issueCount ?? 0,
        lastReviewedAt: stats?.lastReviewedAt ?? null,
        installationId: installationIdParam,
      };
    });

    return NextResponse.json({
      repos,
      totalCount,
      page,
      hasMore,
    });
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    console.error("[/api/repositories] error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
