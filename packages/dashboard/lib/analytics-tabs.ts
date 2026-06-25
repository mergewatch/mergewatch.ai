/**
 * Tab configuration for the tabbed Analytics surface (/dashboard/analytics).
 *
 * Kept as a pure, dependency-free module so the tab-resolution logic can be
 * unit-tested without pulling in React/Next. The component layer
 * (AnalyticsClient) renders these and syncs the active key to `?tab=`.
 */

export type AnalyticsTabKey =
  | "overview"
  | "cost"
  | "findings"
  | "activity"
  | "accuracy";

export interface AnalyticsTab {
  key: AnalyticsTabKey;
  label: string;
}

/**
 * Tab order, left-to-right. "Cost" sits second so the ROI metrics — the whole
 * point of the redesign — are one click from the default landing tab and never
 * buried below a wall of charts.
 */
export const ANALYTICS_TABS: readonly AnalyticsTab[] = [
  { key: "overview", label: "Overview" },
  { key: "cost", label: "Cost & Impact" },
  { key: "findings", label: "Findings" },
  { key: "activity", label: "Activity" },
  { key: "accuracy", label: "Accuracy" },
];

export const DEFAULT_ANALYTICS_TAB: AnalyticsTabKey = "overview";

const TAB_KEYS: ReadonlySet<string> = new Set(
  ANALYTICS_TABS.map((t) => t.key),
);

/**
 * Resolve an arbitrary `?tab=` query value to a valid tab key, falling back to
 * the default for anything missing, malformed, or unknown. Accepts the array
 * form Next.js produces for repeated params (uses the first entry).
 */
export function resolveTab(
  param: string | string[] | null | undefined,
): AnalyticsTabKey {
  const raw = Array.isArray(param) ? param[0] : param;
  if (raw && TAB_KEYS.has(raw)) {
    return raw as AnalyticsTabKey;
  }
  return DEFAULT_ANALYTICS_TAB;
}

/**
 * Whether a tab renders the `/api/analytics` dataset (stat cards + charts) and
 * therefore shares the global date-range + repo filter bar. The Cost/Impact and
 * Accuracy tabs own their own rolling-window selector and fetch independently,
 * so the global filter bar is hidden for them.
 */
export function isAnalyticsDataTab(key: AnalyticsTabKey): boolean {
  return key === "overview" || key === "findings" || key === "activity";
}
