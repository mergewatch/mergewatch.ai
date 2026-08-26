"use client";

import { useEffect, useState } from "react";
import {
  groupByStage,
  reasonText,
  buildFunnel,
  demotedCount,
  type FindingOutcome,
} from "../lib/filter-trail";

interface TraceResponse {
  trace: {
    outcomes: FindingOutcome[];
    truncated?: boolean;
    totalOutcomes?: number;
  } | null;
}

/**
 * #472 Part C — the filtered-findings trail.
 *
 * Fetched client-side (CLAUDE.md: Amplify SSR makes server-component DynamoDB
 * queries unreliable, and the same pattern is correct for self-hosted), and in
 * its own request so the review renders without waiting on a trace that can be
 * hundreds of outcomes long.
 */
export default function FilterTrail({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<TraceResponse["trace"] | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reviews/${encodeURIComponent(reviewId)}/trace`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: TraceResponse) => { if (!cancelled) setData(j.trace); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [reviewId]);

  if (failed) {
    // Distinguishable from "no trace": a failed fetch is not evidence that
    // nothing was filtered, and must not be presented as if it were.
    return (
      <Panel>
        <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
          The decision trail could not be loaded.
        </p>
      </Panel>
    );
  }

  if (data === undefined) {
    return (
      <Panel>
        <p className="px-4 py-6 text-center text-sm text-fg-tertiary">Loading decision trail…</p>
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel>
        <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
          No decision trail was recorded for this review.
          <br />
          <span className="text-xs text-fg-faint">
            Reviews from before the trail shipped have none. This is not the same as
            &ldquo;nothing was filtered&rdquo;.
          </span>
        </p>
      </Panel>
    );
  }

  const groups = groupByStage(data.outcomes);
  const funnel = buildFunnel(data.outcomes);
  const demoted = demotedCount(data.outcomes);

  return (
    <Panel>
      <div className="border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="text-fg-secondary">{funnel.raw} raised</span>
          {funnel.steps.map((s) => (
            <span key={s.label} className="text-fg-tertiary">
              → <span className="text-fg-secondary">−{s.removed}</span> {s.label}
            </span>
          ))}
          <span className="text-fg-tertiary">→</span>
          <span className="font-medium text-fg-primary">{funnel.surfaced} shown</span>
        </div>
        {demoted > 0 && (
          <p className="mt-1.5 text-xs text-fg-tertiary">
            {demoted} finding{demoted === 1 ? " was" : "s were"} demoted rather than removed —
            still shown above, as advisory.
          </p>
        )}
        {data.truncated && (
          <p className="mt-1.5 text-xs text-fg-tertiary">
            Showing {data.outcomes.length} of {data.totalOutcomes} outcomes — the rest were not
            retained.
          </p>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
          Nothing was filtered — every finding raised was shown.
        </p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {groups.map((g) => (
            <div key={g.stage} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-secondary">
                  {g.label}
                </h4>
                {g.judgement && (
                  <span
                    className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-fg-tertiary"
                    title="A model made a judgement here, rather than a rule being applied"
                  >
                    judgement
                  </span>
                )}
                <span className="text-xs text-fg-tertiary">{g.entries.length}</span>
              </div>
              <ul className="mt-2 space-y-2">
                {g.entries.map((e, i) => (
                  <li key={`${e.key}:${i}`} className="text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <OutcomeChip outcome={e.outcome} />
                      <span className="text-fg-primary">{e.title}</span>
                      <code className="text-fg-faint">{e.file}:{e.line}</code>
                      {e.agents.length > 1 && (
                        <span className="text-fg-faint">{e.agents.join(" + ")}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-fg-tertiary">{reasonText(e)}</p>
                    {e.mergedInto && (
                      <p className="mt-0.5 text-fg-faint">
                        folded into <code>{e.mergedInto}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-default overflow-hidden">
      <div className="bg-surface-card-hover px-4 py-2.5 border-b border-border-default">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-fg-muted">
          Decision trail
        </h3>
      </div>
      {children}
    </div>
  );
}

/**
 * `demoted` reads distinctly from `dropped` on purpose: a demoted critical is
 * still a live concern the developer should read, and colouring it like a
 * removal would tell them to stop looking.
 */
function OutcomeChip({ outcome }: { outcome: FindingOutcome["outcome"] }) {
  const styles: Record<string, string> = {
    dropped: "bg-surface-subtle text-fg-tertiary",
    merged: "bg-surface-subtle text-fg-tertiary",
    demoted: "bg-primer-orange/15 text-primer-orange",
    surfaced: "bg-primer-green/15 text-primer-green",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[outcome] ?? styles.dropped}`}>
      {outcome}
    </span>
  );
}
