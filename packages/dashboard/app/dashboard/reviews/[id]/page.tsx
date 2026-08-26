export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getDashboardStore } from "@/lib/store";
import { canAccessRepo } from "@/lib/access-control";
import ReviewDetail from "@/components/ReviewDetail";

interface ReviewDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Review detail page.
 *
 * The [id] param is a URL-safe encoded string: `owner/repo:prNumber#commitSha`
 * encoded with encodeURIComponent.
 */
export default async function ReviewDetailPage({ params }: ReviewDetailPageProps) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/");

  const accessToken = (session as any).accessToken as string | undefined;
  if (!accessToken) redirect("/");

  const { id } = await params;
  const decoded = decodeURIComponent(id);

  // Parse "owner/repo:prNumber#commitSha"
  const colonIdx = decoded.lastIndexOf(":");
  if (colonIdx === -1) notFound();

  const repoFullName = decoded.slice(0, colonIdx);
  const prNumberCommitSha = decoded.slice(colonIdx + 1);

  if (!repoFullName || !prNumberCommitSha) notFound();

  // Verify the user has access to this repo
  try {
    const hasAccess = await canAccessRepo(accessToken, repoFullName);
    if (!hasAccess) notFound();
  } catch {
    redirect("/signout");
  }

  const store = await getDashboardStore();
  const item = await store.reviews.getReview(repoFullName, prNumberCommitSha);

  if (!item) notFound();

  const prNumber = Number(String(prNumberCommitSha).split("#")[0]);
  const commitSha = String(prNumberCommitSha).split("#")[1] ?? "";

  return (
    <ReviewDetail
      review={{
        repoFullName: item.repoFullName as string,
        prNumber,
        prNumberCommitSha: item.prNumberCommitSha as string,
        commitSha,
        prTitle: item.prTitle ?? "",
        status: (item.status === "complete" ? "completed" : item.status) as any,
        model: item.model ?? "",
        createdAt: item.createdAt ?? "",
        completedAt: item.completedAt ?? undefined,
        commentId: item.commentId as number | undefined,
        settingsUsed: item.settingsUsed as any,
        // #472 Part A — these were fetched and then dropped, which is why
        // every review detail page rendered no result at all.
        findings: (item.findings as any) ?? [],
        summaryText: (item.summaryText as string | undefined) ?? undefined,
        mergeScore: item.mergeScore as number | undefined,
        mergeScoreReason: (item.mergeScoreReason as string | undefined) ?? undefined,
        // #472 Part B — the floor a finding's confidence was judged against.
        minConfidence: (item.settingsUsed as any)?.minConfidence as number | undefined,
      }}
    />
  );
}
