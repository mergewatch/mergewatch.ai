# LLM cost analytics

**Status:** 🚧 In review
**Issue:** [#193](https://github.com/mergewatch/mergewatch.ai/issues/193)

Surface **LLM cost** as a first-class metric — aggregated in the hourly insights rollup, returned by `/api/insights`, and rendered on `/dashboard/analytics`. The per-review capture (tokens + estimated USD on `ReviewItem`, cost in the PR comment's "Review details" drawer) already shipped; this closes the aggregation + visualization gap.

## Architecture

```
capture (per review)              aggregation (hourly)        surface
──────────────────────            ─────────────────────        ───────────────
review completes  ─► ReviewCostRecord ─► buildCostInsight() ─► InstallationFPInsight
  inputTokens          (IReviewCostStore   (insights/cost.ts)     .cost ─► /api/insights
  outputTokens          row per review,                           └► CostSection
  estimatedCostUsd      installation-keyed)                          (InsightsClient.tsx)
  findingCount
  model
```

The issue noted cost lives on `ReviewItem` (repo-partitioned), so the rollup — which fans out per installation — can't read it cheaply. We took the **denormalize** option: write one `ReviewCostRecord` per completed review into an installation-partitioned store, then page those rows in the rollup exactly like the disposition / PR-lifecycle / satisfaction records. One extra best-effort write per review; O(1) per-installation read at rollup time.

## `cost` block shape

```ts
cost?: {
  totalCostUsd: number;          // sum over PRICED reviews in-window
  totalInputTokens: number;      // sum over ALL reviews (tokens known regardless of pricing)
  totalOutputTokens: number;
  reviewCount: number;           // priced + unpriced
  pricedReviewCount: number;     // model matched the pricing table
  unpricedReviewCount: number;   // unknown-model reviews — excluded from money totals
  avgCostPerReview: number | null;   // totalCostUsd / pricedReviewCount
  findingCount: number;          // findings across priced reviews
  avgCostPerFinding: number | null;  // totalCostUsd / findingCount
  perRepo: Record<string, { costUsd: number; reviewCount: number }>;
};
```

Optional-by-block: pre-feature rollups (and rollups run without a cost store) have no `cost`; consumers handle `undefined`. Averages are `null` (not `0`) when their denominator is empty — the dashboard tells "no spend data" from a real `$0`.

## What changed

**Capture**
- `ReviewCostRecord` type (`packages/core/src/types/db.ts`) + `IReviewCostStore` (`recordCost` / `listByInstallation`, `storage/types.ts`).
- `DynamoReviewCostStore` (`mergewatch-review-costs`, PK=installation, SK=`repo#pr#commit`, 90d TTL) and `PostgresReviewCostStore` (`review_costs`, `cost_usd` as text → no float drift), both idempotent per review. Migration `0013_clean_xorn.sql` (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`).
- Both runtimes (`review-processor.ts`, lambda `review-agent.ts`) call `recordCost` at completion — best-effort; unknown-model cost (`null`) is recorded as **unpriced**, never coerced to `0`.

**Aggregation**
- New pure module `packages/core/src/insights/cost.ts` — `buildCostInsight(window, windowEndIso, costRecords)`, windowed by `completedAt`, exported from `@mergewatch/core` with `CostInsight`.
- `runInsightRollup` pages cost rows from the optional `costStore` and assigns `insight.cost` only when wired; persisted in both fp-insight stores (`cost` jsonb / attribute, null↔undefined coercion).

**Surface**
- `/api/insights` passes the `cost` block through (it returns the full `InstallationFPInsight` — no route change).
- `CostSection` on `/dashboard/analytics`: StatCards (**Total spend**, **Avg cost / review**, **Cost / finding**, **Reviews** with an unpriced count), a **Spend by repo** breakdown, and a **spend-over-time** bar across 7d / 30d / 90d. Gated independently (a window can have spend with zero findings).

## Edge cases

- **Unknown model** → `estimatedCostUsd` null → recorded unpriced; excluded from money totals + the cost-per-finding denominator; surfaced as "N unpriced". Tokens still summed (they're known).
- **Re-reviews** accrue cost: identity is per (installation, repo, PR, commit), so a re-review on a new commit is a distinct row; a retried review of the same commit overwrites idempotently.
- Averages `null` on empty denominators; `cost` absent on pre-feature rollups.

## Tests

- `cost.test.ts` — aggregation, per-repo bucketing, windowing (7d vs 30d, out-of-window exclusion), and the full null-pricing path (unpriced excluded from money, included in tokens; all-unpriced → null averages; zero-finding → null cost-per-finding).
- `review-cost-store.test.ts` (both backends) — key/SK construction, null-cost round-trip, idempotent upsert, pagination cursor, best-effort swallow.
- `run-rollup.test.ts` — cost block attached when wired (aggregates across pages, counts unpriced), omitted otherwise.
- Dashboard `CostSection` covered by the production build (tsc + ESLint) and the RUNBOOK E2E, consistent with the rest of the dashboard.

> **Deploy note (SaaS):** the Amplify SSR role's DynamoDB inline policy already covers `mergewatch-*`, so the new `mergewatch-review-costs-*` table is in scope. No dashboard env var is needed — the cost block rides the existing `/api/insights` read.

**E2E:** [E2E-63](../e2e/RUNBOOK.md#e2e-63-cost--llm-spend-rollup--dashboard-193).
