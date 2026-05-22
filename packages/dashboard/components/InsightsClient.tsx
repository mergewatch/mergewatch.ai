"use client";

/**
 * FB-F + FB-G — FP-insights dashboard surface.
 *
 * Reads `/api/insights?installation_id=…` for the three rolling-window
 * `InstallationFPInsight` rows (7d / 30d / 90d) produced by the nightly
 * FB-E rollup, then renders:
 *   - **FB-F** — FP funnel (stacked bar): unsignaled / agreed / silent-
 *     dropped / disputed counts per window. Single chart that answers
 *     "is the review noise increasing or decreasing for us?".
 *   - **FB-G** — dispute-rate by agent (horizontal bar): one bar per
 *     `perCategory` entry, height = `rate`. Tells the org which agent
 *     is the noisiest.
 *
 * FB-I (severity-shopping detector) is scoped to a follow-up PR — it
 * needs a `severity` field on `FindingDispositionRecord` that the data
 * shape doesn't yet carry. FB-H (top recurring themes table) and FB-J
 * (per-repo heatmap) ship in PR 5 alongside FB-K.
 *
 * Zero-state: when the API returns `insights: []` (fresh installation OR
 * a deployment without the FB-E table provisioned), the component renders
 * an explanatory panel rather than empty charts.
 */

import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────

interface CategoryBucket {
  surfaced: number;
  disputed: number;
  rate: number;
}

interface ClusterRow {
  sigTokens: string[];
  representativeTitle: string;
  surfaceCount: number;
  disputeCount: number;
  rate: number;
}

interface Insight {
  installationId: string;
  window: "7d" | "30d" | "90d";
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  totalFindingsSurfaced: number;
  totalDisputes: number;
  disputeRate: number;
  totalSilentDrops: number;
  totalAgreements: number;
  perCategory: Record<string, CategoryBucket>;
  perRepo: Record<string, CategoryBucket>;
  topClusters: ClusterRow[];
}

interface InsightsClientProps {
  installationId: string;
}

// ─── Colours (semantic) ───────────────────────────────────────────────────

const SEGMENT_COLOURS = {
  unsignaled: "#94a3b8", // neutral slate (no FP/TP signal either way)
  agreed:     "#10b981", // emerald (TP signal — 👍/❤️/🚀)
  silentDropped: "#f59e0b", // amber (implicit FP — orchestrator dropped without code change)
  disputed:   "#ef4444", // red (explicit FP — 👎/🤔/triage/reject)
};

const AGENT_COLOUR = "#6366f1"; // indigo, neutral

// ─── Helpers ──────────────────────────────────────────────────────────────

function pickWindow(insights: Insight[], window: "7d" | "30d" | "90d"): Insight | undefined {
  return insights.find((i) => i.window === window);
}

/**
 * Derive funnel segments from a single insight row. We don't track
 * "carried over" or "resolved" counters directly — they're derivable
 * relative to the prior window but require a separate signal. v1 funnel
 * is the four explicit + implicit signals we DO track: unsignaled (the
 * remainder), agreed, silentDropped, disputed. The four sum to
 * `totalFindingsSurfaced` by construction.
 */
function funnelSegmentsFor(insight: Insight): { name: string; value: number; colour: string }[] {
  // Defensive clamping — each segment is `min(counter, remainingHeadroom)`
  // wrapped in `max(0, ...)`. The remainingHeadroom is already ≥ 0 by
  // induction from the earlier clamps, BUT the inner Math.max(0, ...)
  // wrapper survives a future rollup-aggregation refactor that quietly
  // breaks the non-negativity invariant. Cheap belt-and-braces.
  const surfaced = Math.max(0, insight.totalFindingsSurfaced);
  const disputed = Math.min(insight.totalDisputes, surfaced);
  const silentDropped = Math.min(insight.totalSilentDrops, Math.max(0, surfaced - disputed));
  const agreed = Math.min(
    insight.totalAgreements,
    Math.max(0, surfaced - disputed - silentDropped),
  );
  const unsignaled = Math.max(0, surfaced - disputed - silentDropped - agreed);
  return [
    { name: "Unsignaled", value: unsignaled, colour: SEGMENT_COLOURS.unsignaled },
    { name: "Agreed", value: agreed, colour: SEGMENT_COLOURS.agreed },
    { name: "Silently dropped", value: silentDropped, colour: SEGMENT_COLOURS.silentDropped },
    { name: "Disputed", value: disputed, colour: SEGMENT_COLOURS.disputed },
  ];
}

// ─── Component ────────────────────────────────────────────────────────────

export default function InsightsClient({ installationId }: InsightsClientProps) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeWindow, setActiveWindow] = useState<"7d" | "30d" | "90d">("30d");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/insights?installation_id=${encodeURIComponent(installationId)}`);
        if (!r.ok) {
          // 503 = upstream-degraded (GitHub API or DB read failed). The
          // API returns an `error` string we can surface verbatim — gives
          // the user actionable signal instead of a generic "HTTP 503".
          let upstreamMessage: string | undefined;
          try {
            const body = (await r.json()) as { error?: string };
            upstreamMessage = body.error;
          } catch { /* not JSON; fall through to generic */ }
          throw new Error(
            r.status === 503 && upstreamMessage
              ? upstreamMessage
              : `HTTP ${r.status}`,
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
        <div className="text-sm text-text-error">Failed to load insights: {error}</div>
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

  if (insights.length === 0 || !active || active.totalFindingsSurfaced === 0) {
    return (
      <div className="rounded-lg border border-border-default bg-surface-card p-6">
        <h2 className="text-base font-semibold text-text-primary">No insights yet</h2>
        <p className="mt-2 text-sm text-text-secondary">
          MergeWatch starts collecting per-finding feedback (👍 / 👎 reactions,
          inline-thread resolves, <code>/mergewatch reject</code> commands)
          from the moment the GitHub App is installed. The nightly rollup
          aggregates that data into FP-insight rows. Once a few reviews
          have run, you&apos;ll see funnel + dispute-rate charts here.
        </p>
      </div>
    );
  }

  const funnelData = funnelSegmentsFor(active);
  // FB-G — flatten perCategory into a sorted array.
  const categoryRows = Object.entries(active.perCategory)
    .map(([category, b]) => ({ category, ...b }))
    .filter((r) => r.surfaced > 0)
    .sort((a, b) => b.rate - a.rate);

  return (
    <div className="space-y-6">
      {/* ─── Window selector ─────────────────────────────────────────── */}
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
        <span className="ml-auto text-xs text-text-secondary">
          last rolled-up {new Date(active.generatedAt).toLocaleString()}
        </span>
      </div>

      {/* ─── FB-F: FP funnel (stacked bar) ───────────────────────────── */}
      <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="text-sm font-semibold text-text-primary">FP funnel — {activeWindow}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Of {active.totalFindingsSurfaced.toLocaleString()} findings surfaced in this window:
            {" "}{active.totalDisputes.toLocaleString()} disputed
            ({(active.disputeRate * 100).toFixed(1)}%),
            {" "}{active.totalSilentDrops.toLocaleString()} silently dropped (implicit FP),
            {" "}{active.totalAgreements.toLocaleString()} agreed via reactions.
          </p>
        </header>
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={[{ name: "All findings", ...Object.fromEntries(funnelData.map((s) => [s.name, s.value])) }]}>
              <XAxis type="number" hide />
              <YAxis dataKey="name" type="category" hide />
              <Tooltip
                formatter={(value: number, name: string) => [
                  `${value.toLocaleString()} (${active.totalFindingsSurfaced > 0 ? ((value / active.totalFindingsSurfaced) * 100).toFixed(1) : 0}%)`,
                  name,
                ]}
              />
              <Legend />
              {funnelData.map((s) => (
                <Bar key={s.name} dataKey={s.name} stackId="funnel" fill={s.colour} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ─── FB-G: Dispute rate by agent (horizontal bar) ────────────── */}
      <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Dispute rate by agent — {activeWindow}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Per-category disputeCount / surfaceCount. Hover for raw counts. Categories with zero surfacings are omitted.
          </p>
        </header>
        {categoryRows.length === 0 ? (
          <div className="text-xs text-text-secondary">No category data yet.</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryRows} layout="vertical" margin={{ left: 24, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  type="number"
                  domain={[0, 1]}
                  tickFormatter={(v) => `${Math.round(v * 100)}%`}
                  fontSize={11}
                />
                <YAxis dataKey="category" type="category" fontSize={11} width={140} />
                <Tooltip
                  formatter={(value: number, _name, item) => {
                    const payload = (item as { payload?: { surfaced?: number; disputed?: number } } | undefined)?.payload;
                    const surfaced = payload?.surfaced ?? 0;
                    const disputed = payload?.disputed ?? 0;
                    return [`${(value * 100).toFixed(1)}%  (${disputed} / ${surfaced})`, "Dispute rate"];
                  }}
                />
                <Bar dataKey="rate">
                  {categoryRows.map((row) => (
                    <Cell
                      key={row.category}
                      fill={row.rate >= 0.5 ? SEGMENT_COLOURS.disputed : row.rate >= 0.25 ? SEGMENT_COLOURS.silentDropped : AGENT_COLOUR}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}
