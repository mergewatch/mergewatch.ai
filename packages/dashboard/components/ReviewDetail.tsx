"use client";

import Link from "next/link";
import RelativeTime from "./RelativeTime";
import {
  sortFindingsBySeverity,
  findingsSummaryLine,
  mergeScoreMeta,
  confidenceVsFloor,
  groundingSummary,
  type DetailFinding,
} from "../lib/review-findings";
import FilterTrail from "./FilterTrail";
import {
  ArrowLeft,
  ExternalLink,
  GitCommit,
  Clock,
  Cpu,
  Shield,
  Bug,
  Paintbrush,
  FileText,
  BarChart3,
  Table2,
  GitBranch,
  MessageSquare,
} from "lucide-react";

interface SettingsUsed {
  severityThreshold: string;
  commentTypes: { syntax: boolean; logic: boolean; style: boolean };
  maxComments: number;
  summaryEnabled: boolean;
  customInstructions: boolean;
}

export interface ReviewData {
  repoFullName: string;
  prNumber: number;
  prNumberCommitSha: string;
  commitSha: string;
  prTitle: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  model: string;
  createdAt: string;
  completedAt?: string;
  commentId?: number;
  settingsUsed?: SettingsUsed;
  /**
   * #472 Part A — these three were already returned by the store and by
   * /api/reviews/[id]; page.tsx simply did not pass them through, so every
   * review detail page rendered no findings, no summary and no score.
   */
  findings?: DetailFinding[];
  summaryText?: string;
  mergeScore?: number;
  mergeScoreReason?: string;
  /** #472 Part B — the confidence floor in force for this review. */
  minConfidence?: number;
}

// Borrowed from ReviewDrawer so the two surfaces describe the same review the
// same way. A second palette here would drift.
const severityStyles: Record<string, { dot: string; label: string }> = {
  critical: { dot: "bg-red-500", label: "Critical" },
  warning: { dot: "bg-yellow-500", label: "Warning" },
  info: { dot: "bg-blue-500", label: "Info" },
};

function SeverityDot({ severity }: { severity?: string }) {
  const s = severityStyles[severity ?? ""] ?? severityStyles.info;
  return <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${s.dot}`} title={s.label} />;
}

/**
 * #472 Part B — everything #469 puts in the PR comment, uncollapsed, plus the
 * two elements deliberately cut from that surface as too jargon-heavy:
 * confidence against the active floor, and the grounding result.
 *
 * Uncollapsed on purpose. The reader opened a review detail page to find out
 * why a finding exists; making them click again to see the proof is the same
 * mistake as hiding it in the comment.
 */
function EvidencePanel({
  finding,
  minConfidence,
}: {
  finding: DetailFinding;
  minConfidence?: number;
}) {
  const e = finding.evidence;
  const confidence = confidenceVsFloor(finding.confidence, minConfidence);
  const grounding = groundingSummary(finding);
  const agents = e?.agents ?? [];
  if (!e?.code && !e?.reason && agents.length < 2 && !confidence) return null;

  return (
    <div className="mt-2 rounded border border-border-subtle bg-surface-subtle/40 px-3 py-2">
      {e?.code && (
        <pre className="overflow-x-auto rounded bg-surface-card px-2 py-1.5 text-[11px] leading-relaxed text-fg-secondary">
          <code>{e.code}</code>
        </pre>
      )}
      {e?.reason && <p className="mt-1.5 text-xs text-fg-secondary">{e.reason}</p>}
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-tertiary">
        {confidence && (
          <div className="flex gap-1">
            <dt className="text-fg-faint">Confidence</dt>
            <dd>{confidence}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-fg-faint">Grounding</dt>
          <dd>{grounding}</dd>
        </div>
        {/* Only on convergence — one agent's name restates the category. */}
        {agents.length > 1 && (
          <div className="flex gap-1">
            <dt className="text-fg-faint">Agents</dt>
            <dd>{agents.join(" + ")} agreed independently</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function FindingsSection({ findings, minConfidence }: { findings: DetailFinding[]; minConfidence?: number }) {
  const sorted = sortFindingsBySeverity(findings);
  return (
    <div className="rounded-lg border border-border-default overflow-hidden">
      <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
          Findings ({findings.length})
        </h3>
        <span className="text-xs text-fg-tertiary">{findingsSummaryLine(findings)}</span>
      </div>
      <div className="divide-y divide-border-subtle">
        {sorted.map((f, i) => (
          <div key={`${f.file}:${f.line}:${i}`} className="flex items-start gap-2.5 px-4 py-3">
            <SeverityDot severity={f.severity} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg-primary">{f.title}</span>
                {f.category && (
                  <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] uppercase text-fg-secondary">
                    {f.category}
                  </span>
                )}
                {f.confidence != null && (
                  <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-fg-secondary">
                    {f.confidence}%
                  </span>
                )}
                {/* FP-L — an unverified critical is advisory, and saying so here
                    keeps the dashboard aligned with the PR comment's split. */}
                {f.verification === "unverified" && (
                  <span className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-fg-tertiary">
                    unverified
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs">
                <code className="text-fg-tertiary">{f.file}:{f.line}</code>
              </p>
              {f.description && (
                <p className="mt-1.5 text-xs leading-relaxed text-fg-secondary">{f.description}</p>
              )}
              {f.suggestion && (
                <p className="mt-1.5 text-xs leading-relaxed text-fg-tertiary">
                  <span className="font-medium">Suggestion: </span>{f.suggestion}
                </p>
              )}
              <EvidencePanel finding={f} minConfidence={minConfidence} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const statusConfig: Record<
  ReviewData["status"],
  { label: string; color: string; bg: string }
> = {
  pending: { label: "Pending", color: "text-primer-orange", bg: "bg-primer-orange/15" },
  in_progress: { label: "In Progress", color: "text-primer-blue", bg: "bg-primer-blue/15" },
  completed: { label: "Completed", color: "text-primer-green", bg: "bg-primer-green/15" },
  failed: { label: "Failed", color: "text-primer-red", bg: "bg-primer-red/15" },
};

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Clock;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Icon size={15} className="mt-0.5 shrink-0 text-fg-tertiary" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-fg-tertiary mb-0.5">{label}</div>
        <div className="text-sm text-fg-primary">{children}</div>
      </div>
    </div>
  );
}

function SettingsCard({ settings }: { settings: SettingsUsed }) {
  const severityColors: Record<string, string> = {
    Low: "bg-primer-blue/15 text-primer-blue",
    Med: "bg-primer-orange/15 text-primer-orange",
    High: "bg-primer-red/15 text-primer-red",
  };

  return (
    <div className="rounded-lg border border-border-default overflow-hidden">
      <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
          Settings Used
        </h3>
      </div>
      <div className="divide-y divide-border-subtle">
        {/* Severity */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={14} className="text-fg-tertiary" />
            <span className="text-sm text-fg-secondary">Severity threshold</span>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColors[settings.severityThreshold] ?? "bg-surface-subtle text-fg-secondary"}`}
          >
            {settings.severityThreshold}
          </span>
        </div>

        {/* Agents */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-fg-tertiary" />
            <span className="text-sm text-fg-secondary">Agents enabled</span>
          </div>
          <div className="flex gap-1.5">
            {(
              [
                { key: "syntax" as const, label: "Syntax", icon: Bug },
                { key: "logic" as const, label: "Logic", icon: Cpu },
                { key: "style" as const, label: "Style", icon: Paintbrush },
              ] as const
            ).map(({ key, label }) => (
              <span
                key={key}
                className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                  settings.commentTypes[key]
                    ? "bg-[#00ff88]/10 text-accent-green"
                    : "bg-surface-subtle text-fg-faint line-through"
                }`}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Max comments */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare size={14} className="text-fg-tertiary" />
            <span className="text-sm text-fg-secondary">Max comments</span>
          </div>
          <span className="text-sm text-fg-primary">{settings.maxComments}</span>
        </div>

        {/* Summary */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-fg-tertiary" />
            <span className="text-sm text-fg-secondary">PR summary</span>
          </div>
          <span
            className={`text-xs font-medium ${settings.summaryEnabled ? "text-accent-green" : "text-fg-tertiary"}`}
          >
            {settings.summaryEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>

        {/* Custom instructions */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Table2 size={14} className="text-fg-tertiary" />
            <span className="text-sm text-fg-secondary">Custom instructions</span>
          </div>
          <span
            className={`text-xs font-medium ${settings.customInstructions ? "text-accent-green" : "text-fg-tertiary"}`}
          >
            {settings.customInstructions ? "Active" : "None"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ReviewDetail({ review }: { review: ReviewData }) {
  const status = statusConfig[review.status];
  const duration =
    review.createdAt && review.completedAt
      ? Math.round(
          (new Date(review.completedAt).getTime() -
            new Date(review.createdAt).getTime()) /
            1000,
        )
      : null;

  const prUrl = `https://github.com/${review.repoFullName}/pull/${review.prNumber}`;
  const commitUrl = `https://github.com/${review.repoFullName}/commit/${review.commitSha}`;
  const commentUrl = review.commentId
    ? `${prUrl}#issuecomment-${review.commentId}`
    : null;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-10">
      {/* Back link */}
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm text-fg-tertiary hover:text-fg-primary transition-colors mb-6"
      >
        <ArrowLeft size={14} />
        Back to dashboard
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl text-fg-primary">
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              #{review.prNumber} {review.prTitle || "Untitled PR"}
            </a>
          </h1>
          <p className="mt-1 text-sm text-fg-tertiary">{review.repoFullName}</p>
        </div>
        <span className={`${status.bg} ${status.color} rounded-full px-3 py-1 text-xs font-medium shrink-0`}>
          {status.label}
        </span>
      </div>

      {/* Two-column layout on larger screens */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Left column: Review info */}
        <div className="rounded-lg border border-border-default overflow-hidden">
          <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
              Review Details
            </h3>
          </div>
          <div className="divide-y divide-border-subtle px-4">
            <InfoRow icon={Cpu} label="Model">
              <code className="rounded bg-surface-subtle px-1.5 py-0.5 text-xs">
                {review.model || "—"}
              </code>
            </InfoRow>

            <InfoRow icon={GitCommit} label="Commit">
              <a
                href={commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primer-blue hover:underline"
              >
                <code className="text-xs">{review.commitSha}</code>
                <ExternalLink size={11} />
              </a>
            </InfoRow>

            <InfoRow icon={GitBranch} label="Pull Request">
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primer-blue hover:underline"
              >
                #{review.prNumber}
                <ExternalLink size={11} />
              </a>
            </InfoRow>

            {commentUrl && (
              <InfoRow icon={MessageSquare} label="Review Comment">
                <a
                  href={commentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primer-blue hover:underline"
                >
                  View on GitHub
                  <ExternalLink size={11} />
                </a>
              </InfoRow>
            )}

            <InfoRow icon={Clock} label="Started">
              {review.createdAt
                ? <RelativeTime date={review.createdAt} />
                : "—"}
            </InfoRow>

            {review.completedAt && (
              <InfoRow icon={Clock} label="Completed">
                <RelativeTime date={review.completedAt} />
                {duration !== null && (
                  <span className="ml-2 text-xs text-fg-tertiary">
                    ({duration}s)
                  </span>
                )}
              </InfoRow>
            )}
          </div>
        </div>

        {/* Right column: Settings used */}
        {review.settingsUsed ? (
          <SettingsCard settings={review.settingsUsed} />
        ) : (
          <div className="rounded-lg border border-border-default overflow-hidden">
            <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
                Settings Used
              </h3>
            </div>
            <div className="px-4 py-8 text-center text-sm text-fg-tertiary">
              Settings snapshot not available for this review.
              <br />
              <span className="text-xs text-fg-faint">
                Reviews created before settings tracking will not have this data.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* #472 Part A — the review's actual result. The data was always here;
          only the prop plumbing was missing. */}
      {(review.mergeScore != null || review.summaryText || (review.findings?.length ?? 0) > 0) && (
        <div className="mt-6 space-y-4">
          {review.mergeScore != null && (() => {
            const meta = mergeScoreMeta(review.mergeScore);
            return (
              <div className="rounded-lg border border-border-default px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold text-fg-primary">
                    {meta.emoji} {meta.score}/5 — {meta.label}
                  </span>
                  {review.mergeScoreReason && (
                    <span className="text-sm text-fg-secondary">{review.mergeScoreReason}</span>
                  )}
                </div>
              </div>
            );
          })()}

          {review.summaryText && (
            <div className="rounded-lg border border-border-default overflow-hidden">
              <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
                  Summary
                </h3>
              </div>
              <p className="px-4 py-3 text-sm leading-relaxed text-fg-secondary">
                {review.summaryText}
              </p>
            </div>
          )}

          {(review.findings?.length ?? 0) > 0
            ? <FindingsSection findings={review.findings!} minConfidence={review.minConfidence} />
            : review.status === "completed" && (
              <div className="rounded-lg border border-border-default px-4 py-8 text-center text-sm text-fg-tertiary">
                No findings were rendered for this review.
                <br />
                <span className="text-xs text-fg-faint">
                  A clean review, or every finding was filtered — the decision trail will say which.
                </span>
              </div>
            )}
        </div>
      )}

      {/* #472 Part C — why every other finding is not above. */}
      {review.status === "completed" && (
        <div className="mt-4">
          <FilterTrail reviewId={`${review.repoFullName}:${review.prNumberCommitSha}`} />
        </div>
      )}
    </div>
  );
}
