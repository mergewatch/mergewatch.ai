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
 * GET /api/reviews/[id]
 *
 * Fetch a single review by id. The id is URL-encoded "owner/repo:prNumber#commitSha".
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

  // Verify the user has access to this repo
  try {
    const hasAccess = await canAccessRepo(accessToken, repoFullName);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    throw err;
  }

  const store = await getDashboardStore();
  const item = await store.reviews.getReview(repoFullName, prNumberCommitSha);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    review: {
      // The canonical key, under the same name the LIST endpoint uses.
      // ReviewDrawer's ReviewDetail declares `id` as required and casts this
      // response to it, so omitting it made the type a lie and every
      // `review.id` guard silently false — hiding the decision trail and the
      // full-review link with no error anywhere.
      id: item.prNumberCommitSha,
      repoFullName: item.repoFullName,
      prNumberCommitSha: item.prNumberCommitSha,
      prNumber: Number(String(item.prNumberCommitSha).split("#")[0]),
      commitSha: String(item.prNumberCommitSha).split("#")[1] ?? "",
      prTitle: item.prTitle ?? "",
      status: item.status === "complete" ? "completed" : item.status,
      model: item.model ?? "",
      createdAt: item.createdAt ?? "",
      completedAt: item.completedAt ?? undefined,
      commentId: item.commentId ?? undefined,
      prAuthor: item.prAuthor ?? undefined,
      prAuthorAvatar: item.prAuthorAvatar ?? undefined,
      headBranch: item.headBranch ?? undefined,
      baseBranch: item.baseBranch ?? undefined,
      findingCount: item.findingCount ?? undefined,
      topSeverity: item.topSeverity ?? undefined,
      durationMs: item.durationMs ?? undefined,
      summaryText: item.summaryText ?? undefined,
      diagramText: item.diagramText ?? undefined,
      findings: item.findings ?? [],
      settingsUsed: item.settingsUsed ?? undefined,
      feedback: item.feedback ?? undefined,
      mergeScore: item.mergeScore ?? undefined,
      mergeScoreReason: item.mergeScoreReason ?? undefined,
    },
  });
}

/**
 * POST /api/reviews/[id]
 *
 * Submit feedback (thumbs up/down) for a review.
 * Body: { feedback: "up" | "down" }
 */
export async function POST(
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

  // Verify the user has access to this repo
  try {
    const hasAccess = await canAccessRepo(accessToken, repoFullName);
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    throw err;
  }

  const body = await req.json();
  const feedback = body.feedback;
  if (feedback !== "up" && feedback !== "down" && feedback !== null) {
    return NextResponse.json({ error: "Invalid feedback" }, { status: 400 });
  }

  const store = await getDashboardStore();
  await store.reviews.updateFeedback(repoFullName, prNumberCommitSha, feedback);

  return NextResponse.json({ ok: true });
}
