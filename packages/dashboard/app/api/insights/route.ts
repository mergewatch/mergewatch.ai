/**
 * FB-F..FB-J — FP-insight read API for dashboard chart routes.
 *
 * GET /api/insights?installation_id=<id>
 *
 * Returns the 7d / 30d / 90d `InstallationFPInsight` rows for the given
 * installation. All charts on the `/dashboard/insights` route read from
 * this one endpoint — single query, all three windows returned together.
 * (`/dashboard/insights` is a sibling route to `/dashboard/analytics`,
 * not a subview — distinct intents per the page.tsx header doc.)
 *
 * Access: the requester must have access to the installation (same
 * fetchUserInstallations gate the rest of the dashboard uses).
 * Admin-only is NOT required to read the rollups — view access is enough.
 *
 * Zero-state: when no rows exist yet (fresh install) OR the dashboard's
 * fp-insight store isn't wired (older deployments), returns
 * `{ insights: [] }`. The chart components render a "not enough data yet"
 * panel rather than erroring out.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const installationId = req.nextUrl.searchParams.get("installation_id");
  if (!installationId) {
    return NextResponse.json({ error: "Missing installation_id" }, { status: 400 });
  }

  // Verify the requester has access to this installation (mirrors the
  // /api/settings access gate). Token-expired is mapped to 401 so the
  // client knows to refresh; everything else is forbidden.
  try {
    const installations = await fetchUserInstallations(accessToken);
    const hasAccess = installations.some((i) => String(i.id) === installationId);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    // Fall through to zero-state — better to show "no data yet" than to
    // 500 the page when the GitHub API is flaky.
    return NextResponse.json({ insights: [] });
  }

  try {
    const store = await getDashboardStore();
    if (!store.fpInsights) {
      // Older deployment without the FB-E table provisioned. Zero-state.
      return NextResponse.json({ insights: [] });
    }
    const insights = await store.fpInsights.listByInstallation(installationId);
    return NextResponse.json({ insights });
  } catch (err) {
    console.warn("[/api/insights] fp-insight read failed:", err);
    return NextResponse.json({ insights: [] });
  }
}
