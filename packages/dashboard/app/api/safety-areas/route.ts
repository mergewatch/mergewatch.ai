import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { fetchUserInstallations, checkInstallationAdmin, TokenExpiredError } from "@/lib/github-repos";
import { sanitizeOrgSafetyAreas, ORG_SAFETY_AREA_CAP } from "@mergewatch/core";
import { safetyAreasValidationError, stampSafetyAreasAudit } from "@/lib/safety-areas";

export const dynamic = "force-dynamic";

/**
 * #718 — Org Safety Areas read/write API.
 *
 * GET  /api/safety-areas?installation_id=<id>  — any user with access (read-only).
 * PUT  /api/safety-areas?installation_id=<id>  — org admins only; replaces the
 *      full set (at most 50). Server assigns ids for new entries and stamps
 *      last-edited audit metadata on created or changed areas.
 */

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const installationId = new URL(req.url).searchParams.get("installation_id");
  if (!installationId) return NextResponse.json({ error: "Missing installation_id" }, { status: 400 });

  let isAdmin = false;
  try {
    const installations = await fetchUserInstallations(accessToken);
    const installation = installations.find((i) => String(i.id) === installationId);
    if (!installation) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    isAdmin = await checkInstallationAdmin(accessToken, installation);
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    return NextResponse.json({ error: "GitHub API unavailable, please retry" }, { status: 503 });
  }

  try {
    const store = await getDashboardStore();
    const areas = await store.installations.getSafetyAreas(installationId);
    return NextResponse.json({ areas, canEdit: isAdmin, cap: ORG_SAFETY_AREA_CAP });
  } catch {
    return NextResponse.json({ areas: [], canEdit: isAdmin, cap: ORG_SAFETY_AREA_CAP });
  }
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const installationId = new URL(req.url).searchParams.get("installation_id");
  if (!installationId) return NextResponse.json({ error: "Missing installation_id" }, { status: 400 });

  // Admin gate.
  try {
    const installations = await fetchUserInstallations(accessToken);
    const installation = installations.find((i) => String(i.id) === installationId);
    if (!installation) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const isAdmin = await checkInstallationAdmin(accessToken, installation);
    if (!isAdmin) return NextResponse.json({ error: "Forbidden — org admins only" }, { status: 403 });
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    console.error("[safety-areas] admin check failed:", err);
    return NextResponse.json({ error: "GitHub API unavailable, please retry" }, { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const invalid = safetyAreasValidationError(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  let existing;
  try {
    const store = await getDashboardStore();
    existing = await store.installations.getSafetyAreas(installationId);
  } catch (err) {
    console.error("Failed to load safety areas:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  // Sanitize first so malformed entries can't reach storage.
  const incoming = sanitizeOrgSafetyAreas(body.areas);
  const editor =
    ((session as any).user?.name as string | undefined) ||
    ((session as any).githubUserId as string | undefined) ||
    "unknown";

  try {
    const store = await getDashboardStore();
    const stamped = stampSafetyAreasAudit(incoming, existing, editor, new Date().toISOString());
    await store.installations.updateSafetyAreas(installationId, stamped);
    return NextResponse.json({ ok: true, areas: stamped });
  } catch (err) {
    console.error("Failed to save safety areas:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
