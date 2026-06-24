"use client";

/**
 * Impact panel — the "is MergeWatch worth it?" value view, rendered on the
 * Analytics page. Self-contained: fetches `/api/insights` (the hourly rollup),
 * owns a 7d/30d/90d window selector, and renders the cycle-time, engagement,
 * and LLM-cost sections for the active window.
 *
 * Backend-agnostic — reads through `/api/insights`, which resolves to the
 * Dynamo (SaaS) or Postgres (self-hosted) dashboard store via DEPLOYMENT_MODE,
 * so this works identically in both runtimes.
 */

import { useEffect, useMemo, useState } from "react";
import type { Insight } from "./types";
import { CostSection, CycleTimeSection, EngagementSection } from "./ImpactSections";
import NpsPrompt from "../NpsPrompt";

function pickWindow(insights: Insight[], window: "7d" | "30d" | "90d"): Insight | undefined {
  return insights.find((i) => i.window === window);
}

export default function ImpactPanel({ installationId }: { installationId: string }) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeWindow, setActiveWindow] = useState<"7d" | "30d" | "90d">("30d");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/insights?installation_id=${encodeURIComponent(installationId)}`);
        if (!r.ok) {
          // 503 = upstream-degraded; the API returns an `error` string we can
          // surface verbatim for an actionable message.
          let upstreamMessage: string | undefined;
          try {
            const body = (await r.json()) as { error?: string };
            upstreamMessage = body.error;
          } catch { /* not JSON; fall through to generic */ }
          throw new Error(
            r.status === 503 && upstreamMessage ? upstreamMessage : `HTTP ${r.status}`,
          );
        }
        const data = (await r.json()) as { insights?: Insight[] };
        if (!cancelled) setInsights(data.insights ?? []);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [installationId]);

  const active = useMemo(
    () => (insights ? pickWindow(insights, activeWindow) : undefined),
    [insights, activeWindow],
  );

  if (error) {
    return (
      <div className="rounded-lg border border-border-default bg-surface-card p-6">
        <div className="text-sm text-text-error">Failed to load impact metrics: {error}</div>
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="animate-pulse rounded-lg border border-border-default bg-surface-card p-6">
        <div className="h-4 w-40 rounded bg-border-default" />
        <div className="mt-4 h-48 rounded bg-border-default" />
      </div>
    );
  }

  // Each block is gated independently — a window can have spend or cycle-time
  // with no findings (all-clear reviews still cost tokens / merge PRs).
  const cyc = active?.cycleTime;
  const hasCycleData = !!cyc && (cyc.mergedCount > 0 || cyc.closedUnmergedCount > 0 || cyc.openCount > 0);
  const eng = active?.engagement;
  const hasEngagementData = !!eng && (
    eng.commandUsageCount > 0 ||
    eng.reviewedPrCount > 0 ||
    eng.acceptanceRate !== null ||
    eng.findingActionRateApprox !== null ||
    (eng.helpfulUp ?? 0) > 0 ||
    (eng.helpfulDown ?? 0) > 0 ||
    (eng.npsResponses ?? 0) > 0
  );
  const cost = active?.cost;
  const hasCostData = !!cost && cost.reviewCount > 0;
  const hasAnyImpact = hasCycleData || hasEngagementData || hasCostData;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Impact</h2>
        <p className="mt-0.5 text-xs text-text-secondary">
          Is MergeWatch worth it? — cycle time, spend, and developer engagement. Updated hourly.
        </p>
      </div>

      {/* Window selector — the rollup's three fixed windows. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary">Window:</span>
        {(["7d", "30d", "90d"] as const).map((w) => (
          <button
            key={w}
            onClick={() => setActiveWindow(w)}
            className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
              activeWindow === w
                ? "border-accent-default bg-accent-subtle text-accent-default"
                : "border-border-default bg-surface-card text-text-secondary hover:border-border-default-hover"
            }`}
          >
            {w}
          </button>
        ))}
        {active && (
          <span className="ml-auto text-xs text-text-secondary">
            last rolled-up {new Date(active.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {!hasAnyImpact ? (
        <div className="rounded-lg border border-border-default bg-surface-card p-6">
          <p className="text-sm text-text-secondary">
            No impact metrics for this window yet. Cycle time, spend, and engagement
            appear once reviews run and PRs start merging — the hourly rollup
            aggregates them.
          </p>
        </div>
      ) : (
        <>
          {hasCycleData && cyc && <CycleTimeSection cycleTime={cyc} window={activeWindow} />}
          {hasEngagementData && eng && (
            <EngagementSection engagement={eng} insights={insights} window={activeWindow} />
          )}
          {hasCostData && cost && <CostSection cost={cost} insights={insights} window={activeWindow} />}
          <NpsPrompt installationId={installationId} />
        </>
      )}
    </section>
  );
}
