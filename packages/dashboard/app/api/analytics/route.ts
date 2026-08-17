import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { aggregateReviews } from "@/lib/analytics-aggregate";
import { collectAllReviews, ANALYTICS_PAGE_SIZE } from "@/lib/analytics-collect";
import { normalizeDateParam } from "@/lib/date-range";
import {
  fetchUserInstallations,
  fetchAccessibleRepoNames,
  TokenExpiredError,
} from "@/lib/github-repos";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics?installation_id=<id>
 *
 * Returns aggregated analytics data for repos the user has access to.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const installationIdParam = sp.get("installation_id");
  const repoParam = sp.get("repo") ?? undefined;

  // #337 — validate + normalize date parameters. The stores compare
  // `createdAt` as strings against full ISO timestamps, so a date-only bound
  // is expanded to the edge instant of that UTC day here at the boundary
  // (`end_date=2026-08-16` → `…T23:59:59.999Z`); previously it silently
  // excluded the whole final day. Both backends receive the same expanded
  // instants, so behavior is identical by construction.
  //
  // Timezone decision (#337): date-only parameters mean UTC calendar days,
  // and the trend buckets computed downstream (aggregateReviews' substring
  // day-keys) are likewise UTC days labeled by UTC date. The dashboard UI
  // never sends date-only values — it converts the viewer's local day range
  // to exact instants, so its FILTER honors local days while bucket labels
  // remain UTC. Bucketing in the viewer's zone would need a tz parameter
  // threaded through the API; deliberately not done until edge-day
  // attribution proves to matter in practice.
  const startDate = normalizeDateParam(sp.get("start_date"), "start");
  const endDate = normalizeDateParam(sp.get("end_date"), "end");

  try {
    const userInstallations = await fetchUserInstallations(accessToken);
    if (userInstallations.length === 0) {
      return NextResponse.json({ analytics: null });
    }

    const targetInstallations = installationIdParam
      ? userInstallations.filter((i) => String(i.id) === installationIdParam)
      : userInstallations;

    const store = await getDashboardStore();

    // Get repos the user can actually access via GitHub API.
    const githubAccessible = await Promise.all(
      targetInstallations.map((inst) => fetchAccessibleRepoNames(accessToken, inst.id)),
    );
    const userRepoNames = new Set<string>();
    for (const set of githubAccessible) {
      set.forEach((name) => userRepoNames.add(name));
    }

    if (userRepoNames.size === 0) {
      return NextResponse.json({ analytics: null, availableRepos: [] });
    }

    const allRepos = Array.from(userRepoNames).sort();
    const targetRepos = repoParam
      ? allRepos.filter((r) => r === repoParam)
      : allRepos;

    // Walk every page in the range. Aggregating a single page and calling the
    // result a total is what #333 was: because the stores return newest-first,
    // the dropped rows were the *oldest* in the range, so the trends lost
    // their history while still being labelled with the full range.
    const { reviews, truncated } = await collectAllReviews((cursor) =>
      store.reviews.listReviews(
        targetRepos,
        ANALYTICS_PAGE_SIZE,
        cursor,
        undefined,
        startDate,
        endDate,
      ),
    );

    const analytics = aggregateReviews(reviews);

    return NextResponse.json({
      analytics,
      availableRepos: allRepos,
      // Only ever true at the safety bound. The UI must label the figures as
      // partial when it is — a capped aggregate shown as a total is the bug.
      truncated,
    });
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    console.error("[/api/analytics] error:", err);
    return NextResponse.json({ analytics: null });
  }
}
