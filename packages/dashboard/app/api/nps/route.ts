/**
 * #195 Phase 5 — NPS survey endpoint.
 *
 * GET  /api/nps?installation_id=<id>
 *   → { eligible: boolean } — whether to show the 0–10 prompt to this admin.
 *     Eligible when the satisfaction store is wired AND this `githubUserId`
 *     has not responded for this installation in the last 90 days.
 *
 * POST /api/nps   body: { installation_id: string, score: 0..10 }
 *   → { ok: true } — records (latest-wins) the admin's response.
 *
 * Access: the requester must have access to the installation (same
 * fetchUserInstallations gate the rest of the dashboard uses). Throttle is
 * per (installationId, githubUserId): one response per 90 days.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { fetchUserInstallations, TokenExpiredError } from "@/lib/github-repos";

export const dynamic = "force-dynamic";

/** Once every 90 days per admin. */
const THROTTLE_MS = 90 * 24 * 60 * 60 * 1000;

interface SessionExtras {
  accessToken?: string;
  githubUserId?: string;
}

/** Shared session + installation-access gate. Returns the resolved identity or a NextResponse to short-circuit. */
async function authorize(
  req: NextRequest,
  installationId: string | null,
): Promise<{ githubUserId: string } | NextResponse> {
  const session = await getServerSession(authOptions);
  const extras = session as SessionExtras | null;
  if (!session || !extras?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const githubUserId = extras.githubUserId;
  if (!githubUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!installationId) {
    return NextResponse.json({ error: "Missing installation_id" }, { status: 400 });
  }
  try {
    const installations = await fetchUserInstallations(extras.accessToken);
    const hasAccess = installations.some((i) => String(i.id) === installationId);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    console.warn("[/api/nps] fetchUserInstallations failed:", err);
    return NextResponse.json({ error: "GitHub API unavailable, please retry" }, { status: 503 });
  }
  return { githubUserId };
}

export async function GET(req: NextRequest) {
  const installationId = req.nextUrl.searchParams.get("installation_id");
  const auth = await authorize(req, installationId);
  if (auth instanceof NextResponse) return auth;

  try {
    const store = await getDashboardStore();
    if (!store.satisfaction) {
      // No satisfaction table provisioned — never prompt.
      return NextResponse.json({ eligible: false });
    }
    const last = await store.satisfaction.getNpsResponse(installationId!, auth.githubUserId);
    const eligible =
      !last ||
      Number.isNaN(Date.parse(last.respondedAt)) ||
      Date.now() - Date.parse(last.respondedAt) >= THROTTLE_MS;
    return NextResponse.json({ eligible });
  } catch (err) {
    // On a read failure, fail closed (don't prompt) — a missed survey is far
    // less disruptive than a survey loop on a flaky backend.
    console.warn("[/api/nps] eligibility read failed:", err);
    return NextResponse.json({ eligible: false });
  }
}

export async function POST(req: NextRequest) {
  let body: { installation_id?: string; score?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const installationId = body.installation_id ?? null;
  const auth = await authorize(req, installationId);
  if (auth instanceof NextResponse) return auth;

  const score = body.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10) {
    return NextResponse.json({ error: "score must be an integer 0–10" }, { status: 400 });
  }

  try {
    const store = await getDashboardStore();
    if (!store.satisfaction) {
      return NextResponse.json({ error: "NPS not available" }, { status: 503 });
    }
    await store.satisfaction.recordNpsResponse({
      installationId: installationId!,
      githubUserId: auth.githubUserId,
      score,
      respondedAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.warn("[/api/nps] recordNpsResponse failed:", err);
    return NextResponse.json({ error: "Failed to record response" }, { status: 503 });
  }
}
