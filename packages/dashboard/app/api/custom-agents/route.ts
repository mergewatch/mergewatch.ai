import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { fetchUserInstallations, checkInstallationAdmin, TokenExpiredError } from "@/lib/github-repos";
import { sanitizeOrgCustomAgents, ORG_CUSTOM_AGENT_SOFT_CAP } from "@mergewatch/core";
import { stampAudit } from "@/lib/custom-agents";

export const dynamic = "force-dynamic";

/**
 * #235 — Org Custom Agents read/write API.
 *
 * GET  /api/custom-agents?installation_id=<id>  — any user with access (read-only).
 * PUT  /api/custom-agents?installation_id=<id>  — org admins only; replaces the
 *      full set. Server assigns ids for new entries and stamps last-edited
 *      audit metadata (updatedAt / updatedBy) on created or changed agents.
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
    const agents = await store.installations.getCustomAgents(installationId);
    // `canEdit` lets the client render read-only for non-admins.
    return NextResponse.json({ agents, canEdit: isAdmin, softCap: ORG_CUSTOM_AGENT_SOFT_CAP });
  } catch {
    return NextResponse.json({ agents: [], canEdit: isAdmin, softCap: ORG_CUSTOM_AGENT_SOFT_CAP });
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
    throw err;
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.agents)) {
    return NextResponse.json({ error: "Missing agents[]" }, { status: 400 });
  }

  // Sanitize first so malformed entries can't reach storage.
  const incoming = sanitizeOrgCustomAgents(body.agents);
  const editor =
    ((session as any).user?.name as string | undefined) ||
    ((session as any).githubUserId as string | undefined) ||
    "unknown";
  const now = new Date().toISOString();

  try {
    const store = await getDashboardStore();
    const existing = await store.installations.getCustomAgents(installationId);
    const stamped = stampAudit(incoming, existing, editor, now);
    await store.installations.updateCustomAgents(installationId, stamped);
    return NextResponse.json({ ok: true, agents: stamped });
  } catch (err) {
    console.error("Failed to save custom agents:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
