/**
 * Pure helpers for the LLM-cost (Impact) surface. Kept dependency-free so the
 * logic is unit-testable without React.
 */

/** Minimal shape needed to classify a window's cost data. */
interface CostCounts {
  pricedReviewCount: number;
  unpricedReviewCount: number;
}

/**
 * True when a window has reviews but **none** were priced — i.e. every review
 * ran on a model with no known pricing, so all the money figures are $0. The
 * dashboard uses this to show an actionable "set a `pricing:` override" hint
 * instead of a silent $0. A window with zero reviews is not "all unpriced".
 */
export function isAllUnpriced(cost: CostCounts): boolean {
  return cost.unpricedReviewCount > 0 && cost.pricedReviewCount === 0;
}
