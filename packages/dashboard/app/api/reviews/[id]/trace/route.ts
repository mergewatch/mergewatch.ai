import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { canAccessRepo, TokenExpiredError } from "@/lib/access-control";

/** Parse the [id] param into repoFullName + prNumberCommitSha. */
function parseReviewId(id: string): { repoFullName: string; prNumberCommitSha: string } | null {
  const decoded = decodeURIComponent(id);
  const colonIdx = decoded.lastIndexOf(":");
  if (colonIdx === -1) return null;
  return {
    repoFullName: decoded.slice(0, colonIdx),
    prNumberCommitSha: decoded.slice(colonIdx + 1),
  };
}

/**
 * GET /api/reviews/[id]/trace
 *
 * The filter outcome ledger for one review (#470/#471).
 *
 * A separate route rather than a field on /api/reviews/[id]: a trace can be
 * hundreds of outcomes, and the detail page should render the review without
 * waiting on it. Fetched client-side per CLAUDE.md — Amplify SSR makes
 * server-component DynamoDB queries unreliable, and the same pattern works
 * for self-hosted, so it is correct for both.
 *
 * `{ trace: null }` is a legitimate answer, not an error: reviews from before
 * #471 have no ledger, and a trace write is best-effort by design.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = parseReviewId(id);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { repoFullName, prNumberCommitSha } = parsed;

  // Same repo-access gate as the review itself — a trace names files and code,
  // so it must never be readable by someone who cannot read the review.
  try {
    const hasAccess = await canAccessRepo(accessToken, repoFullName);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }

  // A store error must not propagate as an unformatted 500 with nothing
  // logged. The client already distinguishes a failed fetch from an absent
  // trace, so the UI stays honest either way — but without this the operator
  // has no record that the store failed at all, and a transient infrastructure
  // fault looks identical to "no trace recorded" in every log they can read.
  try {
    const store = await getDashboardStore();
    const trace = await store.reviews.getReviewTrace(repoFullName, prNumberCommitSha);
    return NextResponse.json({ trace });
  } catch (err) {
    console.error(
      "[trace] getReviewTrace failed for %s %s:",
      repoFullName,
      prNumberCommitSha,
      err,
    );
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
