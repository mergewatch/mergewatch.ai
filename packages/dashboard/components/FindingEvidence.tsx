"use client";

/**
 * #486 — the review's findings and their evidence, as ONE implementation.
 *
 * These were local functions inside ReviewDetail.tsx, which is the only reason
 * the drawer — the surface people actually click — could not show evidence.
 * That was an accident of how #472 was built, not a design constraint: nothing
 * about them is page-specific.
 *
 * Both ReviewDrawer and ReviewDetail mount these. Sharing also collapses a
 * fork that already existed: ReviewDetail's severity styling was copied from
 * the drawer during #472.
 */

import {
  sortFindingsBySeverity,
  findingsSummaryLine,
  confidenceVsFloor,
  groundingSummary,
  type DetailFinding,
} from "../lib/review-findings";

export type { DetailFinding };

// The single severity palette. It was duplicated between ReviewDrawer and
// ReviewDetail; both now import this one.
const severityStyles: Record<string, { dot: string; label: string }> = {
  critical: { dot: "bg-red-500", label: "Critical" },
  warning: { dot: "bg-yellow-500", label: "Warning" },
  info: { dot: "bg-blue-500", label: "Info" },
};

export function SeverityDot({ severity }: { severity?: string }) {
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
export function EvidencePanel({
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

export function FindingsSection({ findings, minConfidence }: { findings: DetailFinding[]; minConfidence?: number }) {
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
