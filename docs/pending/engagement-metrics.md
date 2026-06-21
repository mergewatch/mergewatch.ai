# Developer engagement / NPS metrics

**Status:** 🚧 In progress — see [`docs/feat/20260620-01-engagement-metrics.plan.md`](../feat/20260620-01-engagement-metrics.plan.md)
**Issue:** [#195](https://github.com/mergewatch/mergewatch.ai/issues/195)

High-signal metrics that show MergeWatch is *used and valued*, not just that reviews ran. Two tiers, shipped in stacked PRs:

- **Tier 1 — behavioral (passive):** acceptance/agreement rate, `/mergewatch` command usage, re-review rate, per-installation activity, and an *approximate* finding-action rate — derived in the nightly insights rollup from data we already capture (`FindingDispositionRecord`, `PRLifecycleRecord`).
- **Tier 2 — explicit satisfaction:** a one-click "Was this review helpful? 👍 / 👎" prompt on the summary-comment footer, and a throttled dashboard NPS prompt (0–10) → NPS = %promoters − %detractors.

All of it rides as an optional `engagement?` block on `InstallationFPInsight` and surfaces in a new **Engagement** section on `/dashboard/insights` — mirroring how time-to-merge (#194) shipped its `cycleTime?` block.

## Architecture

```
capture (per finding / per PR)        aggregation (nightly)         surface
─────────────────────────────        ─────────────────────         ───────────────
FindingDispositionRecord  ─┐
  .agreementCount          │
  .disputeCount            ├─► buildEngagementInsight() ─► InstallationFPInsight
  .silentDropCount         │     (packages/core/src/         .engagement  ─► /api/insights
  .resolveCount  (#195)    │      insights/engagement.ts)                    └► EngagementSection
  .rejectReasons[]         │                                                    (InsightsClient.tsx)
PRLifecycleRecord  ────────┘
  .reviewed / .pushesAfterFirstReview
SatisfactionStore (Tier 2) ─────────► helpful votes + NPS responses
```

The rollup (`runInsightRollup`, `packages/core/src/insights/run-rollup.ts`) already paginates disposition + PR-lifecycle records per installation over the 7d / 30d / 90d windows. The engagement block is computed alongside the existing FP-funnel and cycle-time blocks and persisted in the same fp-insight store (DynamoDB + Postgres).

## `engagement` block shape (target)

```ts
engagement?: {
  // Tier 1 — behavioral
  acceptanceRate: number | null;          // agreements / (agreements + disputes + silentDrops)
  totalResolves: number;                  // /resolve command usage (resolveCount, summed)
  totalRejectCommands: number;            // /mergewatch reject usage (rejectReasons[].at in-window)
  commandUsageCount: number;              // totalResolves + totalRejectCommands
  findingActionRateApprox: number | null; // PROXY: (agreements + resolves) / surfaced — exact deferred
  reReviewRate: number | null;            // reviewed PRs with pushesAfterFirstReview>0 / reviewed PRs
  reviewedPrCount: number;
  activeInstallation: boolean;            // reviewedPrCount > 0

  // Tier 2 — satisfaction
  helpfulUp: number;
  helpfulDown: number;
  helpfulRate: number | null;             // up / (up + down)
  npsResponses: number;
  npsScore: number | null;                // %promoters − %detractors
};
```

All fields are optional-by-block: pre-feature rollups have no `engagement`; consumers handle `undefined`. `null` (not `0`) means "no data", exactly like `cycleTime`'s percentiles.

---

## Stage 1 — `/resolve` capture

Adds a first-class `resolveCount` counter to the per-finding disposition record so `/mergewatch` command usage is fully aggregatable before the rollup consumes it.

**What changed**

- `FindingDispositionRecord.resolveCount: number` (`packages/core/src/types/db.ts`) — defaults to 0 on records written before the counter existed.
- `IFindingDispositionStore.incrementResolve(...)` (`packages/core/src/storage/types.ts`), implemented atomically in both backends:
  - DynamoDB: `resolveCount = if_not_exists(resolveCount, :zero) + :one`, pre-seeded on `upsertSurface`.
  - Postgres: `resolve_count + 1`; new column `resolve_count integer NOT NULL DEFAULT 0` via idempotent migration `0010_lying_dracula.sql` (`ADD COLUMN IF NOT EXISTS`).
- `recordResolves(...)` helper (`packages/core/src/insights/disposition-writer.ts`), exported from `@mergewatch/core`, mirroring `recordDisputes`.
- Both runtimes call it when an inline thread is resolved (`packages/server/src/review-processor.ts`, `packages/lambda/src/handlers/review-agent.ts`): on `action === 'resolved'` we now `recordResolves` **in addition to** the existing `recordDisputes`. Resolve still counts toward the FP funnel (`disputeCount`); `resolveCount` is the separate positive-engagement signal.

**Edge cases**

- A pre-#195 record reads `resolveCount: 0` (Dynamo `Number(it.resolveCount ?? 0)`, Postgres column default), never `undefined`/`NaN`.
- Best-effort writes: a failed `incrementResolve` logs and never blocks the pipeline.
- Double-channel resolves (rare) may double-count, same accepted bias as `recordDisputes`.

**Tests:** `recordResolves` increments once per key, records independently of dispute, no-ops on empty/no-store, and logs-but-doesn't-throw on store rejection (`disposition-writer.test.ts`).

**E2E:** [E2E-58](../../e2e/RUNBOOK.md#e2e-58-engagement--resolve-capture-engagement-metrics-stage-1).

---

## Stage 2 — Engagement rollup (Tier 1 KPIs)

Computes and persists the Tier-1 `engagement` block per window in the nightly insights rollup.

**`engagement` block (Tier 1)**

```ts
engagement?: {
  acceptanceRate: number | null;          // agreements / (agreements + disputes + silentDrops)
  totalResolves: number;                  // /resolve usage (resolveCount, summed)
  totalRejectCommands: number;            // /mergewatch reject usage (rejectReasons[].at in-window)
  commandUsageCount: number;              // totalResolves + totalRejectCommands
  findingActionRateApprox: number | null; // (agreements + resolves) / surfaced, capped at 1 — PROXY
  reReviewRate: number | null;            // reviewed PRs re-pushed after first review / reviewed PRs
  reviewedPrCount: number;
  activeInstallation: boolean;            // reviewedPrCount > 0
};
```

**What changed**

- `InstallationFPInsight.engagement?` block (`packages/core/src/types/db.ts`) — optional, nullable rates, exactly like `cycleTime`.
- New pure module `packages/core/src/insights/engagement.ts` — `buildEngagementInsight(window, windowEndIso, dispositionRecords, prLifecycleRecords)`, exported from `@mergewatch/core` along with the `EngagementInsight` type. Mirrors `cycle-time.ts`.
- `runInsightRollup` (`run-rollup.ts`) computes `insight.engagement` **unconditionally** — it only needs the mandatory disposition records; PR-lifecycle records refine the re-review KPIs when that store is wired and are empty otherwise.
- Persistence in both fp-insight stores (`engagement` jsonb / attribute, null↔undefined coercion); Postgres column via idempotent migration `0011_soft_liz_osborn.sql` (`ADD COLUMN IF NOT EXISTS`).

**Windowing**

- Disposition counters (agreement / dispute / silentDrop / resolve / surface) are summed over records whose `lastSeen` is in-window — the same convention the FP-funnel rollup uses.
- `/mergewatch reject` commands carry their own `at` timestamp, so they're windowed precisely by that (independent of `lastSeen`).
- PR-lifecycle engagement (reviewed / re-review) windows by `firstReviewAt`.

**Edge cases**

- Rates are `null` when their denominator is 0 — the dashboard tells "no signal" from a real `0`.
- `findingActionRateApprox` is capped at 1 (a finding can carry both a 👍 and a `/resolve`).
- Pre-#195 rollup rows have no `engagement` block; consumers handle `undefined`.

**Tests:** `engagement.test.ts` — acceptance/action/command/re-review math, the empty/low-volume case, windowing (7d vs 30d, out-of-window exclusion), and the cap.

**E2E:** [E2E-59](../../e2e/RUNBOOK.md#e2e-59-engagement--tier-1-rollup-engagement-metrics-stage-2).

## Stage 3 — Engagement dashboard section — _planned_

## Stage 4 — Tier 2 footer 👍/👎 helpful prompt — _planned_

## Stage 5 — Tier 2 dashboard NPS survey — _planned_

---

## Deferred (follow-up tickets)

- **Exact finding-action rate** — true per-commit diff confirmation that cited code changed (Stage 2 ships an `(agreements + resolves)/surfaced` proxy).
- **Fleet-wide / WoW retention** — cross-installation %-active and week-over-week retained installations (insights page is installation-scoped).
- **Per-developer attribution & leaderboards** — out of scope per #195.
