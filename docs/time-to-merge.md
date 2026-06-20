# Time-to-Merge (Cycle Time)

**Status:** ✅ Shipped. Tracking issue [#194](https://github.com/mergewatch/mergewatch.ai/issues/194). Delivered in three staged PRs: capture ([#196](https://github.com/mergewatch/mergewatch.ai/pull/196)) → rollup ([#198](https://github.com/mergewatch/mergewatch.ai/pull/198)) → dashboard ([#199](https://github.com/mergewatch/mergewatch.ai/pull/199)).
**Purpose:** Surface **time-to-PR-merge** (cycle time) as a headline outcome metric, segmented to show MergeWatch's impact (reviewed vs not-reviewed). Cycle time is the metric engineering leaders already budget against; if MergeWatch shortens the review loop, it should show up as faster merges. Pairs with cost ([#193](https://github.com/mergewatch/mergewatch.ai/issues/193)) and engagement (NPS) to form a complete ROI view.

---

## What we measure

For every pull request MergeWatch sees, we capture its lifecycle and, in the nightly rollup, compute per rolling window (7d / 30d / 90d):

- **Time to merge** — `created_at` → `merged_at`.
- **Time from first MergeWatch review → merge** — does our feedback land early enough to matter?
- **Round-trips before merge** — pushes after the first review (a proxy for iteration cost).
- **Distribution stats** — **median / p75 / p90**, never a mean. Merge times are heavily right-skewed; a mean is dominated by a handful of stale PRs.

**Segmentation** isolates the signal:

- **Reviewed vs not-reviewed/skipped merged PRs** — the "did MergeWatch make us faster?" comparison.
- Counts of still-open and closed-without-merge PRs are reported but excluded from the time percentiles.

---

## Architecture

Three stages, each shipped independently, mirroring the existing FB-A (disposition store) → FB-E (rollup) → FB-F..J (dashboard) pipeline.

```
GitHub webhook                  Nightly rollup                 Dashboard
──────────────                  ──────────────                 ─────────
pull_request opened    ┐        listByInstallation       ┐     /api/insights
            synchronize │  ───►  buildCycleTimeInsight()  │ ──► InsightsClient
            closed      ┘        → InstallationFPInsight   ┘     CycleTimeSection
review complete/skip            .cycleTime block
   │
   ▼
PRLifecycleRecord  (one row per PR)
  DynamoDB: mergewatch-pr-lifecycle   |   Postgres: pr_lifecycle
```

### Stage 1 — Capture (#196)

A dedicated **`PRLifecycleRecord`** — one row per PR — independent of the per-commit `ReviewItem`. A merge is a per-PR event, but `ReviewItem` is keyed per-commit (`{prNumber}#{sha}`) and a PR has N review rows; unreviewed PRs may have no review row at all. A separate lifecycle store is the clean home.

- **Type:** `PRLifecycleRecord` in `packages/core/src/types/db.ts`.
- **Interface:** `IPRLifecycleStore` in `packages/core/src/storage/types.ts` — `upsertOpened`, `recordPush`, `markReviewed`, `markSkipped`, `markMerged`, `markClosedUnmerged`, `listByInstallation`.
- **Implementations:** `DynamoPRLifecycleStore` (PK `${installationId}#${repoFullName}`, SK `prNumber`; TTL-reaped ~90d past close) and `PostgresPRLifecycleStore` (`pr_lifecycle` table). Both mirror the FB-A disposition store: best-effort writes that never block the review pipeline, with terminal-state discipline enforced via conditional writes.

**Write triggers** (both the Lambda and self-hosted webhook paths):

| Event | Method | Effect |
|---|---|---|
| `pull_request` `opened` / `reopened` / `ready_for_review` | `upsertOpened` | create row, anchor `prCreatedAt`, `state=open` |
| `pull_request` `synchronize` | `recordPush` | `totalPushes++`; `pushesAfterFirstReview++` once a review has landed |
| `pull_request` `closed` (merged) | `markMerged` | terminal: `mergedAt`, `state=merged` (authoritative `prCreatedAt`) |
| `pull_request` `closed` (unmerged) | `markClosedUnmerged` | terminal: `closedAt`, `state=closed_unmerged` |
| review completes | `markReviewed` | set-once `firstReviewAt`, `reviewed=true` |
| `shouldSkipPR` fires | `markSkipped` | `skipped=true` |

### Stage 2 — Rollup (#198)

A pure module, `packages/core/src/insights/cycle-time.ts`:

- `percentile(sortedAsc, p)` — R-7 linear interpolation (Excel `PERCENTILE.INC`).
- `percentilesOf(values)` — `{ p50, p75, p90 }` or `null` for an empty sample.
- `buildCycleTimeInsight(window, windowEnd, records)` — windows PRs by their terminal (or, for open PRs, creation) timestamp and computes the block below.

The nightly orchestrator (`runInsightRollup`) gained an optional `prLifecycleStore`; when wired it pages each installation's lifecycle rows (same cursor pagination as dispositions) and attaches a `cycleTime` block to every window's `InstallationFPInsight`. **Back-compat:** when the store isn't wired (e.g. mid-deploy), `cycleTime` stays `undefined` and the rollup behaves exactly as before.

### Stage 3 — Dashboard (#199)

`CycleTimeSection` in `packages/dashboard/components/InsightsClient.tsx`, rendered above the FP-feedback charts on `/dashboard/insights`:

- **StatCards** — median time-to-merge, time-from-first-review, round-trips, merged count, each with a `p75 · p90` spread.
- **Reviewed-vs-unreviewed comparison** — a grouped bar chart of time-to-merge (median/p75/p90) split by whether MergeWatch reviewed the PR.

No new API route — `/api/insights` already returns the `cycleTime` block via the fp-insight store. The zero-state gate was relaxed so the page renders when **either** FP-feedback **or** cycle-time has data, gated independently (a repo can have merges but a clean review history).

---

## Storage shapes

### `PRLifecycleRecord`

```ts
interface PRLifecycleRecord {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  prCreatedAt: string;               // ISO 8601 — anchor for time-to-merge
  firstReviewAt?: string;            // ISO 8601 — set once, anchor for first-review→merge
  mergedAt?: string;                 // ISO 8601 — set on merge
  closedAt?: string;                 // ISO 8601 — set on close-without-merge
  state: 'open' | 'merged' | 'closed_unmerged';
  reviewed: boolean;                 // segmentation: reviewed vs not
  skipped: boolean;                  // shouldSkipPR fired
  totalPushes: number;
  pushesAfterFirstReview: number;    // round-trip proxy
  updatedAt: string;
  ttl?: number;                      // DynamoDB TTL (epoch s), ~90d past terminal
}
```

### `InstallationFPInsight.cycleTime`

```ts
cycleTime?: {
  mergedCount: number;               // merged in-window — denominator for time stats
  reviewedMergedCount: number;
  unreviewedMergedCount: number;
  closedUnmergedCount: number;       // counted, excluded from time stats
  openCount: number;                 // counted, no merge time yet
  timeToMergeHours: Percentiles | null;                 // created → merged, all
  timeToMergeHoursReviewed: Percentiles | null;         //   …reviewed only
  timeToMergeHoursUnreviewed: Percentiles | null;       //   …unreviewed only
  timeToMergeFromFirstReviewHours: Percentiles | null;  // firstReview → merged
  roundTripsBeforeMerge: Percentiles | null;            // pushesAfterFirstReview
};
// Percentiles = { p50: number; p75: number; p90: number }  — durations in HOURS
```

Each percentile object is `null` (not `0`) when its sample is empty, so the dashboard distinguishes "0 hours" from "no data".

---

## Edge cases (handled)

- **Empty installation** → all-zero counts, `null` percentiles.
- **Closed-without-merge** and **still-open** PRs → counted but excluded from the duration percentiles.
- **Unknown `prCreatedAt` sentinel (`''`)** — a row first created via a non-`opened` entry point (a push or review that arrived before we saw the open) carries `''`. It still counts toward `mergedCount` but is omitted from the created→merged percentiles, since its anchor is unknown. `markMerged` repairs it from the authoritative closed payload.
- **Negative spans** (clock skew / bad data) → dropped, never fed to stats.
- **Terminal-state discipline** — a merged row never downgrades to `closed_unmerged`; `upsertOpened` / `recordPush` never resurrect a terminal row; `firstReviewAt` is set once and later reviews don't move it.
- **Window boundary** — a merge before `windowStart` is excluded from the narrow window and appears in the wider one.

---

## Cost & privacy notes

- **No extra LLM cost.** Lifecycle capture is webhook + storage only; the percentile math is a pure function over a bounded record set in the existing nightly rollup.
- **Storage is bounded.** One row per PR; DynamoDB rows TTL-reap ~90 days past the terminal event (long enough for the 90d window). Postgres rows persist (no TTL) but are small.
- **No PR content stored** — only timestamps, counts, and booleans. The lifecycle row carries no titles, diffs, or author PII beyond what `ReviewItem` already holds.

---

## Configuration

Nothing to configure. Cycle-time tracking activates automatically once the PR-lifecycle store is provisioned:

- **SaaS:** the `mergewatch-pr-lifecycle-${Stage}` table (in `infra/template.yaml`) + the `PR_LIFECYCLE_TABLE` env var wired into the webhook, review-agent, and insights-rollup Lambdas.
- **Self-hosted:** the `pr_lifecycle` table (auto-migrated on startup, migration `0008`) + `cycle_time` column (migration `0009`). The Express server wires the store into the webhook handler and nightly cron.

---

## Out of scope / future

- **Historical backfill** (deferred — separate follow-up). The dashboard already holds a GitHub token; an on-demand backfill could fetch historical `merged_at` for already-reviewed PRs to populate cycle-time immediately on deploy rather than waiting for new merges.
- **Full DORA suite** (deploy frequency, MTTR, change-fail rate).
- **Causal attribution** beyond simple reviewed-vs-unreviewed segmentation.
- **Before/after-enablement segmentation** — comparing cycle time before vs after MergeWatch was activated on a repo (needs installation-activation dating).

---

## Cross-references

- Tracking issue: [#194](https://github.com/mergewatch/mergewatch.ai/issues/194).
- E2E coverage: `e2e/RUNBOOK.md` → **E2E-55** (capture), **E2E-56** (rollup), **E2E-57** (dashboard).
- Sibling analytics surface: [`false-positive-feedback-plan.md`](./false-positive-feedback-plan.md) (the FB-A→FB-E→FB-F..J pipeline this feature mirrors).
- Architecture overview: [`architecture.md`](./architecture.md).

---

## Update protocol

When you change cycle-time behavior:

1. Update the storage shapes / write-trigger table above if the lifecycle state machine changes.
2. Keep the percentile methodology note accurate (the R-7 method is load-bearing for reproducibility).
3. Update the corresponding E2E cards (E2E-55..57) in `e2e/RUNBOOK.md` in the same PR.
4. If backfill ships, move it from "Out of scope / future" into the architecture section.
