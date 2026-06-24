"use client";

/**
 * Impact sections — the "is MergeWatch worth it?" value views, shared by the
 * Analytics page (where they live) and originally extracted from the FP-insights
 * surface. Each is a pure presentational component over one insight row's block:
 *   - CycleTimeSection (#194) — time-to-merge percentiles + reviewed-vs-not.
 *   - EngagementSection (#195) — behavioral + explicit-satisfaction KPIs.
 *   - CostSection (#193) — LLM spend KPIs + per-repo + spend-over-time.
 *
 * Behavior is unchanged from the original InsightsClient definitions; this file
 * only relocates them so both Analytics and the Accuracy view can import them.
 */

import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import type { Cost, CycleTime, Engagement, Insight, Percentiles } from "./types";
import { fmtHours, fmtPct, fmtUsd } from "./format";

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

// ─── TTM (#194) — cycle time ───────────────────────────────────────────────

// Reviewed-vs-unreviewed comparison palette.
const CYCLE_COLOURS = {
  reviewed: "#10b981",   // emerald — MergeWatch reviewed
  unreviewed: "#94a3b8", // slate — not reviewed (baseline)
};

/**
 * Cycle-time / time-to-merge section. Renders headline percentile stat cards
 * plus a reviewed-vs-unreviewed median comparison — the "did MergeWatch make
 * us faster?" view. Each percentile object can be null (empty sample), which
 * the formatters render as an em-dash rather than a misleading "0".
 */
export function CycleTimeSection({ cycleTime, window }: { cycleTime: CycleTime; window: string }) {
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
export function EngagementSection({
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
export function CostSection({
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
