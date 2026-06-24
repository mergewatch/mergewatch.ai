"use client";

/**
 * FB-F + FB-G + FB-H + FB-I + FB-J + FB-K — FP-insights dashboard surface.
 *
 * Reads `/api/insights?installation_id=…` for the three rolling-window
 * `InstallationFPInsight` rows (7d / 30d / 90d) produced by the nightly
 * FB-E rollup, then renders:
 *   - **TTM (#194)** — cycle-time section: time-to-merge percentiles
 *     (median / p75 / p90), time-from-first-review-to-merge, round-trips,
 *     and a reviewed-vs-unreviewed comparison ("did MergeWatch make us
 *     faster?"). Computed from the `cycleTime` block on each insight row.
 *   - **#195** — developer-engagement section: Tier-1 behavioral KPIs
 *     (acceptance rate, approx finding-action rate, `/mergewatch` command
 *     usage, re-review rate) plus a cross-window acceptance/action trend.
 *     Computed from the `engagement` block on each insight row.
 *   - **FB-F** — FP funnel (stacked bar): unsignaled / agreed / silent-
 *     dropped / disputed counts per window. Single chart that answers
 *     "is the review noise increasing or decreasing for us?".
 *   - **FB-G** — dispute-rate by agent (horizontal bar): one bar per
 *     `perCategory` entry, height = `rate`. Tells the org which agent
 *     is the noisiest.
 *   - **FB-H** — top recurring FP themes table (with FB-K CTA).
 *   - **FB-I** — severity-shopping detector (two-line chart across the
 *     three windows): warnings dispute-rate vs criticals dispute-rate. An
 *     annotation banner fires when warningsRate > criticalsRate × 1.5
 *     across two adjacent windows — a signal that agents are dodging W2
 *     verification by downgrading Critical → Warning.
 *   - **FB-J** — per-repo dispute heatmap (org-wide drill-down).
 *
 * Zero-state: when the API returns `insights: []` (fresh installation OR
 * a deployment without the FB-E table provisioned), the component renders
 * an explanatory panel rather than empty charts.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";
import { ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import NpsPrompt from "./NpsPrompt";

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

interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
}

/** TTM (#194) — cycle-time block. Optional for back-compat with pre-Stage-2 rollups. */
interface CycleTime {
  mergedCount: number;
  reviewedMergedCount: number;
  unreviewedMergedCount: number;
  closedUnmergedCount: number;
  openCount: number;
  timeToMergeHours: Percentiles | null;
  timeToMergeHoursReviewed: Percentiles | null;
  timeToMergeHoursUnreviewed: Percentiles | null;
  timeToMergeFromFirstReviewHours: Percentiles | null;
  roundTripsBeforeMerge: Percentiles | null;
}

/** #195 — developer-engagement block. Optional for pre-engagement rollups. */
interface Engagement {
  // Tier 1 — behavioral
  acceptanceRate: number | null;
  totalResolves: number;
  totalRejectCommands: number;
  commandUsageCount: number;
  findingActionRateApprox: number | null;
  reReviewRate: number | null;
  reviewedPrCount: number;
  activeInstallation: boolean;
  // Tier 2 — explicit satisfaction (Phase 4 + 5). `0` / `null` on rollups run
  // before a satisfaction store was wired.
  helpfulUp?: number;
  helpfulDown?: number;
  helpfulRate?: number | null;
  npsResponses?: number;
  npsScore?: number | null;
}

/** #193 — LLM-cost block. Optional for pre-cost rollups. */
interface Cost {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reviewCount: number;
  pricedReviewCount: number;
  unpricedReviewCount: number;
  avgCostPerReview: number | null;
  findingCount: number;
  avgCostPerFinding: number | null;
  perRepo: Record<string, { costUsd: number; reviewCount: number }>;
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
  /** FB-I — buckets by severity. Optional for back-compat with pre-FB-I rollups (treated as `{}`). */
  perSeverity?: Record<string, CategoryBucket>;
  perRepo: Record<string, CategoryBucket>;
  topClusters: ClusterRow[];
  /** TTM (#194) — present only on rollups generated after Stage 2 shipped. */
  cycleTime?: CycleTime;
  /** #195 — present only on rollups generated after the engagement stage shipped. */
  engagement?: Engagement;
  /** #193 — present only on rollups generated after the cost stage shipped. */
  cost?: Cost;
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

// TTM (#194) — reviewed-vs-unreviewed comparison palette.
const CYCLE_COLOURS = {
  reviewed: "#10b981",   // emerald — MergeWatch reviewed
  unreviewed: "#94a3b8", // slate — not reviewed (baseline)
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Format a duration given in hours as a compact human string:
 *   < 1h → minutes, < 48h → hours, else → days. `null`/`undefined` → em-dash.
 */
function fmtHours(h: number | null | undefined): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Format a 0..1 rate as a whole-number percentage; null/undefined → em-dash. */
function fmtPct(r: number | null | undefined): string {
  if (r == null) return "—";
  return `${Math.round(r * 100)}%`;
}

/**
 * #193 — format a USD amount. Sub-dollar values (a per-finding cost is often a
 * few cents) keep more precision; dollar+ values round to cents. `null` → `—`.
 */
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 1) return `$${n.toFixed(n < 0.01 ? 4 : 3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
// ─── FB-K — YAML snippet synthesis ────────────────────────────────────────

/**
 * Threshold for showing the FB-K "Suggest ignore rule" CTA on a cluster.
 * Both conditions must hold:
 *   • disputeRate > 80% (the cluster is overwhelmingly disputed)
 *   • surfaceCount ≥ 5  (we have enough samples to trust the rate)
 */
const FB_K_DISPUTE_RATE_THRESHOLD = 0.8;
const FB_K_SURFACE_COUNT_THRESHOLD = 5;

function clusterQualifiesForCTA(c: ClusterRow): boolean {
  return c.rate > FB_K_DISPUTE_RATE_THRESHOLD && c.surfaceCount >= FB_K_SURFACE_COUNT_THRESHOLD;
}

/**
 * Render a copy-able `.mergewatch.yml` snippet for a high-dispute cluster.
 * The snippet uses `customStyleRules` because it's the existing config
 * surface that lets a prompt-level instruction shape the style agent's
 * behaviour — a soft guard rather than a hard ignore. We deliberately
 * don't hard-suppress: the cluster pattern STILL gets evaluated, just
 * with "be more cautious here" guidance.
 *
 * For non-style clusters the snippet is structurally the same; the user
 * decides whether `customStyleRules` is the right surface (style agent
 * only) or whether to use it as a prompt for filing a tracking issue.
 */
function fbKYamlFor(cluster: ClusterRow): string {
  const tokens = cluster.sigTokens.slice(0, 8).join(", ") || "(no tokens captured)";
  const rate = (cluster.rate * 100).toFixed(0);
  const title = cluster.representativeTitle.replace(/\s+/g, " ").trim();
  return [
    `# FP-feedback dashboard suggested rule — review before adding`,
    `#   Cluster:           ${title}`,
    `#   Significant tokens: ${tokens}`,
    `#   Dispute rate:      ${rate}% over ${cluster.surfaceCount} surfacings`,
    ``,
    `customStyleRules:`,
    `  - >`,
    `    De-prioritize findings matching this pattern. Tokens: ${tokens}.`,
    `    Disputed ${rate}% of the time across ${cluster.surfaceCount} reviews —`,
    `    require explicit evidence before flagging on similar code.`,
  ].join("\n");
}

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
  // FB-H — which cluster row has its FB-K snippet panel expanded.
  const [expandedClusterIdx, setExpandedClusterIdx] = useState<number | null>(null);
  // FB-K — track which cluster's snippet was last copied so we can flash the
  // confirmation icon. Cleared after 1.5s via setTimeout in the handler.
  const [copiedClusterIdx, setCopiedClusterIdx] = useState<number | null>(null);
  // FB-H — sort column + direction state.
  const [sortBy, setSortBy] = useState<"leverage" | "rate" | "surfaced" | "disputed">("leverage");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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

  // TTM (#194) — cycle-time can have data even when no findings were ever
  // surfaced (a repo with merges but a clean review history), so it must NOT
  // be gated behind `totalFindingsSurfaced`. We show the page when EITHER
  // signal has data, and gate each section independently below.
  const cyc = active?.cycleTime;
  const hasCycleData = !!cyc && (cyc.mergedCount > 0 || cyc.closedUnmergedCount > 0 || cyc.openCount > 0);
  const hasFpData = (active?.totalFindingsSurfaced ?? 0) > 0;
  // #195 — engagement can carry signal (command usage, re-review) even with no
  // findings surfaced, so it's gated independently like cycle-time.
  const eng = active?.engagement;
  const hasEngagementData = !!eng && (
    eng.commandUsageCount > 0 ||
    eng.reviewedPrCount > 0 ||
    eng.acceptanceRate !== null ||
    eng.findingActionRateApprox !== null ||
    // Tier 2 — satisfaction can carry signal independently of Tier 1.
    (eng.helpfulUp ?? 0) > 0 ||
    (eng.helpfulDown ?? 0) > 0 ||
    (eng.npsResponses ?? 0) > 0
  );
  // #193 — cost is gated independently: a window can have spend even with no
  // findings (all-clear reviews still cost tokens).
  const cost = active?.cost;
  const hasCostData = !!cost && cost.reviewCount > 0;

  if (insights.length === 0 || !active || (!hasFpData && !hasCycleData && !hasEngagementData && !hasCostData)) {
    return (
      <div className="rounded-lg border border-border-default bg-surface-card p-6">
        <h2 className="text-base font-semibold text-text-primary">No insights yet</h2>
        <p className="mt-2 text-sm text-text-secondary">
          MergeWatch starts collecting per-finding feedback (👍 / 👎 reactions,
          inline-thread resolves, <code>/mergewatch reject</code> commands) and
          PR cycle-time from the moment the GitHub App is installed. The nightly
          rollup aggregates that data. Once a few reviews have run — and PRs
          start merging — you&apos;ll see cycle-time, funnel, and dispute-rate
          charts here.
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

      {/* ─── TTM (#194): Cycle time (time-to-merge) ──────────────────── */}
      {hasCycleData && cyc && <CycleTimeSection cycleTime={cyc} window={activeWindow} />}

      {/* ─── #195: Developer engagement ──────────────────────────────── */}
      {hasEngagementData && eng && (
        <EngagementSection engagement={eng} insights={insights} window={activeWindow} />
      )}

      {/* ─── #193: LLM cost ──────────────────────────────────────────── */}
      {hasCostData && cost && <CostSection cost={cost} insights={insights} window={activeWindow} />}

      {/* ─── #195 Phase 5: throttled NPS survey prompt ───────────────── */}
      <NpsPrompt installationId={installationId} />

      {/* ─── FB-F..FB-J: FP-feedback sections (only when findings exist) ── */}
      {hasFpData && (
      <Fragment>
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

      {/* ─── FB-I: Severity-shopping detector ────────────────────────── */}
      <FBISeverityShoppingDetector insights={insights} />

      {/* ─── FB-H: Top recurring FP themes (sortable table + FB-K CTA) ── */}
      <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Top recurring FP themes — {activeWindow}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Top-10 finding clusters ranked by leverage (disputeRate × surfaceCount).
            High-dispute clusters with ≥ {FB_K_SURFACE_COUNT_THRESHOLD} surfacings
            offer a copy-able <code>.mergewatch.yml</code> rule suggestion (FB-K).
            Click a row to expand.
          </p>
        </header>
        {active.topClusters.length === 0 ? (
          <div className="text-xs text-text-secondary">
            No clusters yet — needs at least 2 surfacings sharing significant tokens.
          </div>
        ) : (
          <FBHTable
            clusters={sortClusters(active.topClusters, sortBy, sortDir)}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={(col) => {
              if (col === sortBy) {
                setSortDir((d) => (d === "asc" ? "desc" : "asc"));
              } else {
                setSortBy(col);
                setSortDir("desc");
              }
            }}
            expandedIdx={expandedClusterIdx}
            onToggleExpand={(idx) =>
              setExpandedClusterIdx((cur) => (cur === idx ? null : idx))
            }
            copiedIdx={copiedClusterIdx}
            onCopy={async (idx, snippet) => {
              try {
                await navigator.clipboard.writeText(snippet);
                setCopiedClusterIdx(idx);
                setTimeout(() => setCopiedClusterIdx((cur) => (cur === idx ? null : cur)), 1500);
              } catch {
                // Clipboard API can be blocked (non-https, browser settings).
                // Silently fail; the user can still select-and-copy from the
                // visible <pre> block.
              }
            }}
          />
        )}
      </section>

      {/* ─── FB-J: Per-repo dispute heatmap ──────────────────────────── */}
      <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
        <header className="mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Per-repo dispute heatmap — {activeWindow}</h2>
          <p className="mt-1 text-xs text-text-secondary">
            Dispute rate per repository in the window. Cell colour mirrors the
            FB-G severity palette. Repos with &lt; 3 surfacings render neutral
            to avoid noisy single-event highlights.
          </p>
        </header>
        <FBJHeatmap perRepo={active.perRepo} />
      </section>
      </Fragment>
      )}
    </div>
  );
}

// ─── FB-H — sortable themes table component ────────────────────────────────

type SortColumn = "leverage" | "rate" | "surfaced" | "disputed";

function sortClusters(
  clusters: ClusterRow[],
  sortBy: SortColumn,
  sortDir: "asc" | "desc",
): ClusterRow[] {
  const sorted = [...clusters];
  sorted.sort((a, b) => {
    const av =
      sortBy === "leverage" ? a.rate * a.surfaceCount :
      sortBy === "rate"     ? a.rate :
      sortBy === "surfaced" ? a.surfaceCount :
                              a.disputeCount;
    const bv =
      sortBy === "leverage" ? b.rate * b.surfaceCount :
      sortBy === "rate"     ? b.rate :
      sortBy === "surfaced" ? b.surfaceCount :
                              b.disputeCount;
    return sortDir === "desc" ? bv - av : av - bv;
  });
  return sorted;
}

interface FBHTableProps {
  clusters: ClusterRow[];
  sortBy: SortColumn;
  sortDir: "asc" | "desc";
  onSort: (col: SortColumn) => void;
  expandedIdx: number | null;
  onToggleExpand: (idx: number) => void;
  copiedIdx: number | null;
  onCopy: (idx: number, snippet: string) => void;
}

function FBHTable({
  clusters, sortBy, sortDir, onSort,
  expandedIdx, onToggleExpand, copiedIdx, onCopy,
}: FBHTableProps) {
  const headerCell = (col: SortColumn, label: string, align: "left" | "right" = "right") => (
    <th
      className={`cursor-pointer select-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary ${
        align === "right" ? "text-right" : "text-left"
      }`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === col && (
          sortDir === "desc" ? <ChevronDown size={12} /> : <ChevronUp size={12} />
        )}
      </span>
    </th>
  );

  return (
    <div className="overflow-hidden rounded-md border border-border-default">
      <table className="w-full text-sm">
        <thead className="bg-surface-subtle">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Cluster</th>
            {headerCell("surfaced", "Surfaced")}
            {headerCell("disputed", "Disputed")}
            {headerCell("rate", "Rate")}
            {headerCell("leverage", "Leverage")}
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {clusters.map((c, idx) => {
            const isExpanded = expandedIdx === idx;
            const qualifies = clusterQualifiesForCTA(c);
            const yaml = qualifies ? fbKYamlFor(c) : "";
            return (
              <Fragment key={idx}>
                <tr
                  className={`border-t border-border-default hover:bg-surface-subtle ${
                    qualifies ? "cursor-pointer" : ""
                  }`}
                  onClick={() => qualifies && onToggleExpand(idx)}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-text-primary">{c.representativeTitle || "(untitled cluster)"}</div>
                    {c.sigTokens.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {c.sigTokens.slice(0, 6).map((t) => (
                          <span
                            key={t}
                            className="rounded bg-surface-subtle px-1.5 py-0.5 text-[10px] text-text-secondary"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{c.surfaceCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{c.disputeCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={
                        c.rate >= 0.5 ? "text-text-error" :
                        c.rate >= 0.25 ? "text-text-warning" :
                                         "text-text-secondary"
                      }
                    >
                      {(c.rate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                    {(c.rate * c.surfaceCount).toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {qualifies && (
                      <ChevronDown
                        size={14}
                        className={`inline transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      />
                    )}
                  </td>
                </tr>
                {qualifies && isExpanded && (
                  <tr className="border-t border-border-default bg-surface-subtle">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-xs text-text-secondary">
                          <strong>Suggested .mergewatch.yml rule</strong> — copy + paste into
                          the repo&apos;s <code>.mergewatch.yml</code> at the root. The
                          snippet uses <code>customStyleRules</code> as a soft guard
                          (the style agent gets a &quot;be cautious&quot; instruction; no hard
                          suppression). Adjust for your repo&apos;s actual config shape.
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onCopy(idx, yaml);
                          }}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-border-default bg-surface-card px-3 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-default-hover"
                        >
                          {copiedIdx === idx ? (
                            <><Check size={12} /> Copied</>
                          ) : (
                            <><Copy size={12} /> Copy snippet</>
                          )}
                        </button>
                      </div>
                      <pre className="mt-2 overflow-x-auto rounded bg-surface-card p-3 text-xs text-text-primary">
                        {yaml}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── FB-J — per-repo heatmap component ─────────────────────────────────────

const MIN_SURFACED_FOR_COLOUR = 3;

function FBJHeatmap({ perRepo }: { perRepo: Record<string, CategoryBucket> }) {
  const rows = Object.entries(perRepo)
    .map(([repo, b]) => ({ repo, ...b }))
    .filter((r) => r.surfaced > 0)
    .sort((a, b) => b.disputed - a.disputed);

  if (rows.length === 0) {
    return <div className="text-xs text-text-secondary">No per-repo data yet.</div>;
  }

  return (
    <div className="space-y-1">
      {rows.map((r) => {
        const tooSparse = r.surfaced < MIN_SURFACED_FOR_COLOUR;
        const colour = tooSparse
          ? SEGMENT_COLOURS.unsignaled
          : r.rate >= 0.5 ? SEGMENT_COLOURS.disputed
          : r.rate >= 0.25 ? SEGMENT_COLOURS.silentDropped
          : AGENT_COLOUR;
        return (
          <div key={r.repo} className="flex items-center gap-3">
            <div className="w-48 shrink-0 truncate text-xs text-text-secondary" title={r.repo}>
              {r.repo}
            </div>
            <div
              className="h-6 rounded transition-all"
              style={{
                width: `${Math.max(4, Math.min(100, r.surfaced * 4))}%`,
                backgroundColor: colour,
                opacity: tooSparse ? 0.4 : 1,
              }}
              title={`${(r.rate * 100).toFixed(1)}% — ${r.disputed}/${r.surfaced} disputed${
                tooSparse ? " (low sample size; colour muted)" : ""
              }`}
            />
            <div className="shrink-0 text-xs tabular-nums text-text-secondary">
              {(r.rate * 100).toFixed(0)}%
            </div>
            <div className="shrink-0 text-[10px] tabular-nums text-text-secondary">
              {r.disputed}/{r.surfaced}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── TTM (#194) — cycle-time section ───────────────────────────────────────

/** Small headline metric card matching the dashboard StatCard pattern. */
function StatCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  return (
    <div className="rounded-lg border border-border-default bg-surface-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary tabular-nums">{value}</p>
      {subtext && <p className="mt-0.5 text-xs text-text-secondary">{subtext}</p>}
    </div>
  );
}

/** Compact "p75 X · p90 Y" subtext for a percentile triple. */
function spread(p: Percentiles | null, fmt: (n: number) => string): string | undefined {
  if (!p) return undefined;
  return `p75 ${fmt(p.p75)} · p90 ${fmt(p.p90)}`;
}

/**
 * Cycle-time / time-to-merge section. Renders headline percentile stat cards
 * plus a reviewed-vs-unreviewed median comparison — the "did MergeWatch make
 * us faster?" view. Each percentile object can be null (empty sample), which
 * the formatters render as an em-dash rather than a misleading "0".
 */
function CycleTimeSection({ cycleTime, window }: { cycleTime: CycleTime; window: string }) {
  const c = cycleTime;
  const reviewed = c.timeToMergeHoursReviewed;
  const unreviewed = c.timeToMergeHoursUnreviewed;

  // Reviewed-vs-unreviewed comparison: one group per percentile, two bars.
  // Only rendered when at least one segment has data.
  const comparisonData = (reviewed || unreviewed)
    ? (["p50", "p75", "p90"] as const).map((k) => ({
        stat: k === "p50" ? "Median" : k.toUpperCase(),
        reviewed: reviewed ? reviewed[k] : null,
        unreviewed: unreviewed ? unreviewed[k] : null,
      }))
    : [];

  return (
    <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Cycle time — {window}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Time-to-merge for PRs merged in this window. {c.mergedCount.toLocaleString()} merged
          {" "}({c.reviewedMergedCount.toLocaleString()} reviewed · {c.unreviewedMergedCount.toLocaleString()} not),
          {" "}{c.openCount.toLocaleString()} still open, {c.closedUnmergedCount.toLocaleString()} closed without merge.
          Merge times are skewed, so we show percentiles, not averages.
        </p>
      </header>

      {c.mergedCount === 0 ? (
        <div className="text-xs text-text-secondary">
          No PRs merged in this window yet — cycle-time stats appear once
          MergeWatch-tracked PRs start merging.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Median time to merge"
              value={fmtHours(c.timeToMergeHours?.p50)}
              subtext={spread(c.timeToMergeHours, fmtHours)}
            />
            <StatCard
              label="From first review"
              value={fmtHours(c.timeToMergeFromFirstReviewHours?.p50)}
              subtext={spread(c.timeToMergeFromFirstReviewHours, fmtHours)}
            />
            <StatCard
              label="Round-trips before merge"
              value={c.roundTripsBeforeMerge ? c.roundTripsBeforeMerge.p50.toFixed(1) : "—"}
              subtext={spread(c.roundTripsBeforeMerge, (n) => n.toFixed(1))}
            />
            <StatCard
              label="Merged in window"
              value={c.mergedCount.toLocaleString()}
              subtext={`${c.reviewedMergedCount} reviewed · ${c.unreviewedMergedCount} not`}
            />
          </div>

          {comparisonData.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-1 text-xs font-semibold text-text-primary">
                Reviewed vs not-reviewed — time to merge
              </h3>
              <p className="mb-3 text-[11px] text-text-secondary">
                Lower bars for reviewed PRs suggest MergeWatch is shortening the
                review loop. Compare like-for-like — a segment with few PRs is noisy.
              </p>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={comparisonData} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="stat" fontSize={11} />
                    <YAxis tickFormatter={(v) => fmtHours(v)} fontSize={11} width={48} />
                    <Tooltip
                      formatter={(value: number, name: string) => [
                        fmtHours(value),
                        name === "reviewed" ? "Reviewed" : "Not reviewed",
                      ]}
                    />
                    <Legend
                      formatter={(value) => (value === "reviewed" ? "Reviewed" : "Not reviewed")}
                    />
                    <Bar dataKey="reviewed" fill={CYCLE_COLOURS.reviewed} />
                    <Bar dataKey="unreviewed" fill={CYCLE_COLOURS.unreviewed} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─── #195 — developer-engagement section ───────────────────────────────────

// Engagement trend palette.
const ENGAGEMENT_COLOURS = {
  acceptance: "#10b981", // emerald — accepted vs disputed/dropped
  action: "#6366f1",     // indigo — acted-on (approx)
};

interface EngagementPoint {
  window: "7d" | "30d" | "90d";
  acceptance: number | null; // 0..1, null = no signal in window
  action: number | null;     // 0..1
}

/** #195 Tier 2 — true when the engagement block carries any explicit-satisfaction signal. */
function hasSatisfactionData(e: Engagement): boolean {
  return (e.helpfulUp ?? 0) > 0 || (e.helpfulDown ?? 0) > 0 || (e.npsResponses ?? 0) > 0;
}

/** Acceptance + approx action rate across the three windows (for the trend line). */
function buildEngagementPoints(insights: Insight[]): EngagementPoint[] {
  const order: EngagementPoint["window"][] = ["7d", "30d", "90d"];
  return order
    .map((w) => insights.find((i) => i.window === w))
    .filter((i): i is Insight => Boolean(i))
    .map((i) => ({
      window: i.window,
      acceptance: i.engagement?.acceptanceRate ?? null,
      action: i.engagement?.findingActionRateApprox ?? null,
    }));
}

/**
 * Developer-engagement section. Headline Tier-1 KPIs (acceptance rate, approx
 * finding-action rate, `/mergewatch` command usage, re-review rate) for the
 * active window, plus a cross-window trend line for the two finding-level
 * rates — "are developers acting on and accepting reviews, and is it holding
 * over time?". null rates render as an em-dash, never a misleading 0%.
 */
function EngagementSection({
  engagement,
  insights,
  window,
}: {
  engagement: Engagement;
  insights: Insight[];
  window: string;
}) {
  const e = engagement;
  const points = buildEngagementPoints(insights);
  // Only plot the trend when at least one window carries a finding-level rate;
  // an all-null line is noise, not signal.
  const hasTrend = points.some((p) => p.acceptance !== null || p.action !== null);

  return (
    <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">Developer engagement — {window}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Whether developers find reviews useful — behavioral signals, not surveys.
          Acceptance weighs 👍 against 👎 / quiet drops; action rate is an{" "}
          <em>approximation</em> ((agreements + resolves) / findings, capped at 100%) —
          the exact &ldquo;cited code changed&rdquo; signal is a planned follow-up.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Acceptance rate"
          value={fmtPct(e.acceptanceRate)}
          subtext="👍 vs 👎 / quiet drops"
        />
        <StatCard
          label="Action rate (approx)"
          value={fmtPct(e.findingActionRateApprox)}
          subtext="findings acted on"
        />
        <StatCard
          label="Command usage"
          value={e.commandUsageCount.toLocaleString()}
          subtext={`${e.totalResolves.toLocaleString()} resolve · ${e.totalRejectCommands.toLocaleString()} reject`}
        />
        <StatCard
          label="Re-review rate"
          value={fmtPct(e.reReviewRate)}
          subtext={`${e.reviewedPrCount.toLocaleString()} PRs reviewed`}
        />
      </div>

      {/* #195 Tier 2 — explicit satisfaction: 👍/👎 helpful rate + NPS. Only
          rendered once a satisfaction store is wired and has signal. */}
      {hasSatisfactionData(e) && (
        <div className="mt-4 border-t border-border-default pt-4">
          <h3 className="mb-3 text-xs font-semibold text-text-primary">
            Explicit satisfaction
          </h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Helpful rate"
              value={fmtPct(e.helpfulRate ?? null)}
              subtext={`${(e.helpfulUp ?? 0).toLocaleString()} 👍 · ${(e.helpfulDown ?? 0).toLocaleString()} 👎`}
            />
            <StatCard
              label="NPS"
              value={e.npsScore == null ? "—" : (e.npsScore > 0 ? `+${e.npsScore}` : String(e.npsScore))}
              subtext={`${(e.npsResponses ?? 0).toLocaleString()} response${(e.npsResponses ?? 0) === 1 ? "" : "s"}`}
            />
          </div>
        </div>
      )}

      {hasTrend && (
        <div className="mt-5">
          <h3 className="mb-1 text-xs font-semibold text-text-primary">
            Acceptance &amp; action rate — across 7d / 30d / 90d
          </h3>
          <p className="mb-3 text-[11px] text-text-secondary">
            Rates holding or rising across widening windows suggest reviews stay
            useful as more history accrues. A gap means no signal in that window.
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="window" fontSize={11} />
                <YAxis
                  domain={[0, 1]}
                  tickFormatter={(v) => `${Math.round(v * 100)}%`}
                  fontSize={11}
                  width={40}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    fmtPct(value),
                    name === "acceptance" ? "Acceptance" : "Action (approx)",
                  ]}
                />
                <Legend
                  formatter={(value) => (value === "acceptance" ? "Acceptance" : "Action (approx)")}
                />
                <Line
                  type="monotone"
                  dataKey="acceptance"
                  stroke={ENGAGEMENT_COLOURS.acceptance}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  connectNulls={false}
                />
                <Line
                  type="monotone"
                  dataKey="action"
                  stroke={ENGAGEMENT_COLOURS.action}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── #193 — LLM cost ──────────────────────────────────────────────────────

const COST_COLOUR = "#f59e0b"; // amber — spend

interface CostPoint {
  window: "7d" | "30d" | "90d";
  spend: number;
}

/** Total spend across the three windows (for the trend bars). */
function buildCostPoints(insights: Insight[]): CostPoint[] {
  const order: CostPoint["window"][] = ["7d", "30d", "90d"];
  return order
    .map((w) => insights.find((i) => i.window === w))
    .filter((i): i is Insight => Boolean(i?.cost))
    .map((i) => ({ window: i.window, spend: i.cost!.totalCostUsd }));
}

/** Top repos by spend (descending), for the per-repo breakdown. */
function topRepoSpend(cost: Cost, limit = 5): Array<{ repo: string; costUsd: number; reviewCount: number }> {
  return Object.entries(cost.perRepo)
    .map(([repo, v]) => ({ repo, costUsd: v.costUsd, reviewCount: v.reviewCount }))
    .filter((r) => r.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, limit);
}

/**
 * LLM-cost section. Headline spend KPIs (total spend, avg cost / review, cost /
 * finding) for the active window, a per-repo spend breakdown, and a spend-over-
 * time bar across 7d / 30d / 90d. Unpriced (unknown-model) reviews are surfaced
 * explicitly and excluded from the money figures.
 */
function CostSection({
  cost,
  insights,
  window,
}: {
  cost: Cost;
  insights: Insight[];
  window: string;
}) {
  const c = cost;
  const points = buildCostPoints(insights);
  const hasTrend = points.length > 1 && points.some((p) => p.spend > 0);
  const repos = topRepoSpend(c);
  const totalTokens = c.totalInputTokens + c.totalOutputTokens;

  return (
    <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">LLM cost — {window}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Estimated spend on review LLM calls. Costs are estimates from the
          provider pricing table; reviews on an unpriced model are counted but
          excluded from the dollar figures.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total spend"
          value={fmtUsd(c.totalCostUsd)}
          subtext={`${totalTokens.toLocaleString()} tokens`}
        />
        <StatCard
          label="Avg cost / review"
          value={fmtUsd(c.avgCostPerReview)}
          subtext={`${c.pricedReviewCount.toLocaleString()} priced review${c.pricedReviewCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Cost / finding"
          value={fmtUsd(c.avgCostPerFinding)}
          subtext={`${c.findingCount.toLocaleString()} finding${c.findingCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Reviews"
          value={c.reviewCount.toLocaleString()}
          subtext={c.unpricedReviewCount > 0 ? `${c.unpricedReviewCount.toLocaleString()} unpriced` : "all priced"}
        />
      </div>

      {repos.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-text-primary">Spend by repo</h3>
          <ul className="space-y-1">
            {repos.map((r) => (
              <li key={r.repo} className="flex items-center justify-between text-xs">
                <span className="truncate text-text-secondary">{r.repo}</span>
                <span className="ml-3 shrink-0 tabular-nums text-text-primary">
                  {fmtUsd(r.costUsd)} <span className="text-text-secondary">· {r.reviewCount.toLocaleString()} review{r.reviewCount === 1 ? "" : "s"}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasTrend && (
        <div className="mt-5">
          <h3 className="mb-1 text-xs font-semibold text-text-primary">Spend — across 7d / 30d / 90d</h3>
          <p className="mb-3 text-[11px] text-text-secondary">
            Cumulative spend over each widening window. The 90d bar includes the
            30d and 7d spend.
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="window" fontSize={11} />
                <YAxis tickFormatter={(v) => fmtUsd(v)} fontSize={11} width={56} />
                <Tooltip formatter={(value: number) => [fmtUsd(value), "Spend"]} />
                <Bar dataKey="spend" fill={COST_COLOUR} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── FB-I — severity-shopping detector ────────────────────────────────────

/**
 * Threshold for the severity-shopping annotation. When warnings dispute-rate
 * exceeds criticals dispute-rate by this factor across two adjacent windows
 * (7d + 30d, OR 30d + 90d), we flag potential severity-shopping. Calibrated
 * to be sensitive enough to surface a regression of the FP-E intent while
 * tolerating short-lived anomalies in the 7d window only.
 */
const SEVERITY_SHOPPING_RATIO = 1.5;
const SEVERITY_SHOPPING_MIN_SURFACED = 5; // require enough samples per side

interface SeverityPoint {
  window: "7d" | "30d" | "90d";
  critical: number; // dispute rate (0..1)
  warning: number;
  info: number;
  criticalSurfaced: number;
  warningSurfaced: number;
}

function buildSeverityPoints(insights: Insight[]): SeverityPoint[] {
  const order: SeverityPoint["window"][] = ["7d", "30d", "90d"];
  return order
    .map((w) => insights.find((i) => i.window === w))
    .filter((i): i is Insight => Boolean(i))
    .map((i) => {
      const sev = i.perSeverity ?? {};
      return {
        window: i.window,
        critical: sev.critical?.rate ?? 0,
        warning:  sev.warning?.rate  ?? 0,
        info:     sev.info?.rate     ?? 0,
        criticalSurfaced: sev.critical?.surfaced ?? 0,
        warningSurfaced:  sev.warning?.surfaced  ?? 0,
      };
    });
}

/**
 * The detector fires when *two adjacent windows* both show the same
 * severity-shopping shape (warning rate >> critical rate). One-window
 * spikes are tolerated — only persistent skew triggers the annotation.
 * Requires a minimum sample size per side to avoid the 1/2-disputed
 * false-positive on a fresh installation.
 */
function detectSeverityShopping(points: SeverityPoint[]): boolean {
  if (points.length < 2) return false;
  const ratios = points.map((p) => {
    const enough = p.criticalSurfaced >= SEVERITY_SHOPPING_MIN_SURFACED
                && p.warningSurfaced >= SEVERITY_SHOPPING_MIN_SURFACED;
    if (!enough) return null;
    if (p.critical === 0) return p.warning > 0 ? Infinity : null;
    return p.warning / p.critical;
  });
  for (let i = 0; i < ratios.length - 1; i++) {
    if (ratios[i] !== null && ratios[i + 1] !== null
      && ratios[i]! >= SEVERITY_SHOPPING_RATIO
      && ratios[i + 1]! >= SEVERITY_SHOPPING_RATIO) {
      return true;
    }
  }
  return false;
}

function FBISeverityShoppingDetector({ insights }: { insights: Insight[] }) {
  const points = buildSeverityPoints(insights);
  // Empty perSeverity across every window → nothing to plot. Treat as
  // pre-FB-I rollup state and render an explanatory zero panel; charts
  // with all-zero lines mislead more than they inform.
  const hasAnySeverityData = points.some(
    (p) => p.criticalSurfaced > 0 || p.warningSurfaced > 0,
  );
  const shopping = detectSeverityShopping(points);

  return (
    <section className="rounded-lg border border-border-default bg-surface-card p-4 sm:p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">
          Severity-shopping detector
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          Warnings vs criticals dispute-rate across 7d / 30d / 90d windows. A
          persistently higher warnings rate signals agents may be downgrading
          findings to dodge W2/W7&apos;s critical-only attention rather than
          letting verification do its job (FP-E loophole).
        </p>
      </header>

      {shopping && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100"
        >
          <span aria-hidden="true">⚠️</span>
          <div>
            <strong className="font-semibold">Severity-shopping detected.</strong>{" "}
            Warnings dispute-rate exceeds criticals by ≥{SEVERITY_SHOPPING_RATIO}×
            across two adjacent windows. Inspect recent reviews where the
            orchestrator downgraded Critical → Warning, and consider whether
            FP-E verification scope still covers the relevant agent prompts.
          </div>
        </div>
      )}

      {!hasAnySeverityData ? (
        <div className="text-xs text-text-secondary">
          No severity data yet — needs at least one nightly rollup after FB-I
          shipped (or backfill via subsequent surfacings).
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="window" fontSize={11} />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v) => `${Math.round(v * 100)}%`}
                fontSize={11}
              />
              <Tooltip
                formatter={(value: number, name: string, item) => {
                  const payload = (item as { payload?: SeverityPoint } | undefined)?.payload;
                  const surfaced = name === "critical"
                    ? payload?.criticalSurfaced ?? 0
                    : name === "warning"
                    ? payload?.warningSurfaced ?? 0
                    : 0;
                  return [`${(value * 100).toFixed(1)}%  (${surfaced} surfaced)`, name];
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="critical"
                stroke={SEGMENT_COLOURS.disputed}
                strokeWidth={2}
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="warning"
                stroke={SEGMENT_COLOURS.silentDropped}
                strokeWidth={2}
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
