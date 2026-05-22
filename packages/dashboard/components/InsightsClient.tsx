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

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";
import { ChevronDown, ChevronUp, Copy, Check } from "lucide-react";

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
