"use client";

import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import RelativeTime from "./RelativeTime";
import {
  X,
  ExternalLink,
  Clock,
  FileText,
  GitBranch,
  BarChart3,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { FindingsSection } from "./FindingEvidence";
import FilterTrail from "./FilterTrail";
import type { DetailFinding } from "../lib/review-findings";

// -- Types ------------------------------------------------------------------

interface ReviewDetail {
  id: string;
  repoFullName: string;
  prNumber: number;
  commitSha: string;
  prTitle: string;
  status: string;
  model: string;
  createdAt: string;
  completedAt?: string;
  prAuthor?: string;
  prAuthorAvatar?: string;
  headBranch?: string;
  baseBranch?: string;
  findingCount?: number;
  topSeverity?: string;
  durationMs?: number;
  summaryText?: string;
  diagramText?: string;
  findings?: Finding[];
  settingsUsed?: SettingsUsed;
  feedback?: "up" | "down";
  commentId?: number;
  mergeScore?: number;
  mergeScoreReason?: string;
}

// #486 — the shared shape, so the drawer and the page cannot drift apart.
type Finding = DetailFinding;

interface SettingsUsed {
  severityThreshold: string;
  /** #486 — the confidence floor in force, shown against each finding's score. */
  minConfidence?: number;
  commentTypes: { syntax: boolean; logic: boolean; style: boolean };
  maxComments: number;
  summaryEnabled: boolean;
  customInstructions: boolean;
}

// -- Helpers ----------------------------------------------------------------

const statusStyles: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: "bg-primer-orange/15", text: "text-primer-orange", label: "Pending" },
  in_progress: { bg: "bg-primer-blue/15", text: "text-primer-blue", label: "In Progress" },
  completed: { bg: "bg-primer-green/15", text: "text-primer-green", label: "Completed" },
  failed: { bg: "bg-primer-red/15", text: "text-primer-red", label: "Failed" },
  skipped: { bg: "bg-[#555]/15", text: "text-fg-secondary", label: "Skipped" },
};

function StatusBadge({ status }: { status: string }) {
  const s = statusStyles[status] ?? statusStyles.pending;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

const mergeScoreMeta: Record<number, { color: string; bg: string; label: string }> = {
  5: { color: "text-primer-green", bg: "bg-primer-green/10", label: "Safe to merge" },
  4: { color: "text-primer-green", bg: "bg-primer-green/10", label: "Generally safe" },
  3: { color: "text-primer-orange", bg: "bg-primer-orange/10", label: "Review recommended" },
  2: { color: "text-orange-500", bg: "bg-orange-500/10", label: "Needs fixes" },
  1: { color: "text-primer-red", bg: "bg-primer-red/10", label: "Do not merge" },
};

function MergeScoreBadge({ score, reason }: { score: number; reason?: string }) {
  const s = mergeScoreMeta[score] ?? mergeScoreMeta[3];
  return (
    <div className={`mx-5 mt-4 rounded-lg border border-border-default ${s.bg} px-4 py-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-2xl font-bold ${s.color}`}>{score}/5</span>
          <span className={`text-sm font-medium ${s.color}`}>{s.label}</span>
        </div>
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                i <= score ? s.color.replace("text-", "bg-") : "bg-fg-faint"
              }`}
            />
          ))}
        </div>
      </div>
      {reason && (
        <p className="mt-1.5 text-xs text-fg-secondary">{reason}</p>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function DrawerSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: typeof Clock;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-surface-card-hover transition-colors"
      >
        {open ? <ChevronDown size={14} className="text-fg-tertiary" /> : <ChevronRight size={14} className="text-fg-tertiary" />}
        <Icon size={14} className="text-fg-tertiary" />
        <span className="text-xs font-semibold uppercase tracking-widest text-fg-muted">{title}</span>
      </button>
      {open && <div className="px-5 pb-4">{children}</div>}
    </div>
  );
}

// -- ReviewDrawer -----------------------------------------------------------

export default function ReviewDrawer({
  reviewId,
  onClose,
}: {
  reviewId: string;
  onClose: () => void;
}) {
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedbackState, setFeedbackState] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/reviews/${encodeURIComponent(reviewId)}`)
      .then((r) => r.json())
      .then((data) => {
        setReview(data.review);
        setFeedbackState(data.review?.feedback ?? null);
      })
      .finally(() => setLoading(false));
  }, [reviewId]);

  async function handleFeedback(fb: "up" | "down") {
    const newFb = feedbackState === fb ? null : fb;
    setFeedbackState(newFb);
    await fetch(`/api/reviews/${encodeURIComponent(reviewId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: newFb }),
    });
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const prUrl = review ? `https://github.com/${review.repoFullName}/pull/${review.prNumber}` : "";
  const commentUrl = review?.commentId ? `${prUrl}#issuecomment-${review.commentId}` : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-overlay" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border-default bg-surface-card shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border-default px-5 py-4">
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="h-5 w-48 animate-pulse rounded bg-surface-subtle" />
            ) : review ? (
              <>
                <h2 className="text-base font-semibold text-fg-primary truncate">
                  #{review.prNumber} {review.prTitle || "Untitled PR"}
                </h2>
                <p className="mt-0.5 text-xs text-fg-tertiary">{review.repoFullName}</p>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {review && <StatusBadge status={review.status} />}
            <button
              onClick={onClose}
              className="rounded p-1 text-fg-tertiary hover:bg-surface-subtle hover:text-fg-primary transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-4 p-5">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-surface-subtle" />
              ))}
            </div>
          ) : review ? (
            <>
              {review.mergeScore != null && (
                <MergeScoreBadge score={review.mergeScore} reason={review.mergeScoreReason} />
              )}
              <DrawerSection title="Overview" icon={FileText} defaultOpen>
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-fg-tertiary">Author</span>
                    {review.prAuthor ? (
                      <span className="flex items-center gap-1.5 text-fg-primary">
                        {review.prAuthorAvatar && (
                          <img src={review.prAuthorAvatar} alt="" className="h-4 w-4 rounded-full" />
                        )}
                        {review.prAuthor}
                      </span>
                    ) : (
                      <span className="text-fg-faint">&mdash;</span>
                    )}
                  </div>
                  {review.headBranch && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Branch</span>
                      <code className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs text-fg-secondary">
                        {review.headBranch} &rarr; {review.baseBranch ?? "main"}
                      </code>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-fg-tertiary">Commit</span>
                    <a
                      href={`https://github.com/${review.repoFullName}/commit/${review.commitSha}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primer-blue hover:underline"
                    >
                      <code className="text-xs">{review.commitSha}</code>
                      <ExternalLink size={10} />
                    </a>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-fg-tertiary">Model</span>
                    <code className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs text-fg-secondary">
                      {review.model || "&mdash;"}
                    </code>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-fg-tertiary">Duration</span>
                    <span className="text-fg-primary">
                      {review.durationMs ? formatDuration(review.durationMs) : "&mdash;"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-fg-tertiary">Started</span>
                    <span className="text-fg-primary">
                      {review.createdAt ? <RelativeTime date={review.createdAt} /> : "&mdash;"}
                    </span>
                  </div>
                  {commentUrl && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Comment</span>
                      <a
                        href={commentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primer-blue hover:underline text-xs"
                      >
                        View on GitHub <ExternalLink size={10} />
                      </a>
                    </div>
                  )}
                </div>
              </DrawerSection>

              {review.summaryText && (
                <DrawerSection title="Summary" icon={FileText} defaultOpen>
                  <div className="prose prose-invert prose-sm max-w-none text-sm text-fg-secondary leading-relaxed [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_code]:rounded [&_code]:bg-surface-subtle [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-fg-secondary [&_pre]:rounded-lg [&_pre]:bg-surface-card-hover [&_pre]:p-3 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:text-fg-primary [&_h2]:text-fg-primary [&_h3]:text-fg-primary [&_strong]:text-fg-primary [&_a]:text-primer-blue [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-fg-faint [&_blockquote]:pl-3 [&_blockquote]:text-fg-secondary">
                    <Markdown>{review.summaryText}</Markdown>
                  </div>
                </DrawerSection>
              )}

              {review.diagramText && (
                <DrawerSection title="Diagram" icon={GitBranch}>
                  <div className="overflow-x-auto rounded-lg bg-surface-card-hover border border-border-subtle p-3">
                    <pre className="text-xs text-fg-secondary whitespace-pre-wrap">{review.diagramText}</pre>
                  </div>
                </DrawerSection>
              )}

              <DrawerSection
                title={`Findings (${review.findings?.length ?? review.findingCount ?? 0})`}
                icon={AlertCircle}
                defaultOpen
              >
                {/* #486 — the SAME component the detail page renders, so the drawer
                    carries the full review rather than a summary of it. This was
                    hand-rolled markup, which is why evidence was unreachable from the
                    surface people actually click. */}
                {(!review.findings || review.findings.length === 0) ? (
                  <p className="text-sm text-fg-tertiary">No issues found.</p>
                ) : (
                  <FindingsSection
                    findings={review.findings as DetailFinding[]}
                    minConfidence={review.settingsUsed?.minConfidence}
                  />
                )}
              </DrawerSection>

              {/* #486 — why every other finding is not above. */}
              {review.status === "complete" && (
                <DrawerSection title="Decision trail" icon={AlertCircle}>
                  <FilterTrail
                    reviewId={`${review.repoFullName}:${review.prNumber}#${review.commitSha}`}
                  />
                </DrawerSection>
              )}

              {review.settingsUsed && (
                <DrawerSection title="Settings Used" icon={BarChart3}>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Severity threshold</span>
                      <span className="text-fg-primary">{review.settingsUsed.severityThreshold}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Agents</span>
                      <div className="flex gap-1">
                        {(["syntax", "logic", "style"] as const).map((k) => (
                          <span
                            key={k}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              review.settingsUsed!.commentTypes[k]
                                ? "bg-[#00ff88]/10 text-accent-green"
                                : "bg-surface-subtle text-fg-faint line-through"
                            }`}
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Max comments</span>
                      <span className="text-fg-primary">{review.settingsUsed.maxComments}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-fg-tertiary">Summary</span>
                      <span className={review.settingsUsed.summaryEnabled ? "text-accent-green" : "text-fg-tertiary"}>
                        {review.settingsUsed.summaryEnabled ? "On" : "Off"}
                      </span>
                    </div>
                  </div>
                </DrawerSection>
              )}

              <div className="border-b border-border-subtle px-5 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
                    Was this review helpful?
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleFeedback("up")}
                      className={`rounded-lg p-2 transition-colors ${
                        feedbackState === "up"
                          ? "bg-primer-green/15 text-primer-green"
                          : "text-fg-tertiary hover:bg-surface-subtle hover:text-fg-primary"
                      }`}
                    >
                      <ThumbsUp size={16} />
                    </button>
                    <button
                      onClick={() => handleFeedback("down")}
                      className={`rounded-lg p-2 transition-colors ${
                        feedbackState === "down"
                          ? "bg-primer-red/15 text-primer-red"
                          : "text-fg-tertiary hover:bg-surface-subtle hover:text-fg-primary"
                      }`}
                    >
                      <ThumbsDown size={16} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-lg border border-border-default px-4 py-2.5 text-sm text-fg-secondary hover:border-fg-faint hover:text-fg-primary transition-colors"
                >
                  View PR on GitHub <ExternalLink size={14} />
                </a>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <p className="text-base font-medium text-fg-primary">Review not found</p>
              <p className="mt-2 text-sm text-fg-secondary">
                This review may have been removed or the link may be incorrect.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
