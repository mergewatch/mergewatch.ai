# Developer engagement / NPS metrics

**Status:** ✅ Shipped — see [`docs/feat/20260620-01-engagement-metrics.plan.md`](./feat/20260620-01-engagement-metrics.plan.md)
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

**E2E:** [E2E-58](../e2e/RUNBOOK.md#e2e-58-engagement--resolve-capture-engagement-metrics-stage-1).

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

**E2E:** [E2E-59](../e2e/RUNBOOK.md#e2e-59-engagement--tier-1-rollup-engagement-metrics-stage-2).

## Stage 3 — Engagement dashboard section

Surfaces the Tier-1 KPIs on `/dashboard/insights`.

**What changed** (`packages/dashboard/components/InsightsClient.tsx`)

- New `EngagementSection` (mirrors `CycleTimeSection`), rendered below Cycle time and above the FP funnel. Four StatCards — **Acceptance rate**, **Action rate (approx)**, **Command usage** (`N resolve · N reject`), **Re-review rate** (`N PRs reviewed`) — plus a cross-window acceptance/action **trend line** across 7d / 30d / 90d (mirrors the FB-I severity detector).
- `Engagement` type + `engagement?` on the `Insight` shape; `fmtPct` helper (0..1 → whole-percent, `null`/`undefined` → `—`).
- Zero-state gate relaxed: the page renders when **any** of FP-feedback, cycle-time, or engagement has data (`hasEngagementData`), each section gated independently.
- No API change — `/api/insights` already returns the `engagement` block from the fp-insight store.

**Edge cases**

- `null` rates render `—`, never `0%` (empty denominator ≠ a real 0).
- The trend line uses `connectNulls={false}` so a window with no signal shows a gap, not an interpolated line.
- A pre-#195 rollup row (no `engagement`) renders the page unchanged.

**Verification:** dashboard `tsc --noEmit` + Next production build (runs ESLint) — consistent with how the TTM cycle-time section (#199) shipped; the dashboard has no unit-test harness, so behavior is covered by the RUNBOOK E2E.

**E2E:** [E2E-60](../e2e/RUNBOOK.md#e2e-60-engagement--dashboard-section-engagement-metrics-stage-3).

## Stage 4 — Tier 2 footer helpful prompt

A one-click satisfaction signal on the summary comment, captured + aggregated into `engagement.helpful*`.

**What changed**

- New `ISatisfactionStore` (`packages/core/src/storage/types.ts`) with `recordHelpfulVotes` / `listHelpfulVotes` (+ the Stage-5 NPS methods), implemented on both backends:
  - DynamoDB `DynamoSatisfactionStore` (`mergewatch-satisfaction` table) — partitioned by installation, SK `HV#<repo>#<pr>`; atomic `up`/`down` increments.
  - Postgres `PostgresSatisfactionStore` (`helpful_votes` table) — `up + N` / `down + N` on conflict; new tables via idempotent migration `0012_lean_star_brand.sql` (`CREATE TABLE IF NOT EXISTS`).
- `HelpfulVoteRecord` type (`packages/core/src/types/db.ts`) + `summaryReactionsSnapshot?` on `ReviewItem` (the delta baseline).
- Footer prompt: `formatReviewComment` renders "Was this review helpful? React with 👍 or 👎 on this comment." (`showHelpfulPrompt`, default on).
- Capture: new `recordSummaryHelpfulVotes` (`packages/core/src/insights/satisfaction-writer.ts`) folds the **positive delta** of the summary comment's reaction counts (👍/❤️/🚀 → up, 👎/🤔 → down) vs the prior review's snapshot into `recordHelpfulVotes` — monotonic, best-effort. Wired into both runtimes alongside the existing summary-reaction fetch.
- Rollup: `run-rollup.ts` pages helpful-vote rows from the optional `satisfactionStore` and `engagement.ts` fills `helpfulUp/helpfulDown/helpfulRate` (windowed by `lastVoteAt`).
- Dashboard: an "Explicit satisfaction" block in `EngagementSection` with a **Helpful rate** StatCard (`N 👍 · N 👎`).

**Edge cases**

- Monotonic: a removed reaction never decrements (only positive deltas record).
- Best-effort: a satisfaction write error never blocks the review.
- No satisfaction store wired → helpful fields read `0` / `null`; the dashboard block hides.

**Tests:** `satisfaction-writer.test.ts` (delta mapping, monotonicity, first-sight, no-store no-op, error swallow); store tests both backends; `engagement.test.ts` helpful-vote math + windowing; `comment-formatter.test.ts` prompt render/suppress.

**E2E:** [E2E-61](../e2e/RUNBOOK.md#e2e-61-engagement--helpful-footer-prompt-engagement-metrics-stage-4).

## Stage 5 — Tier 2 dashboard NPS survey

A throttled NPS prompt (0–10, once / 90d per admin); NPS computed + displayed.

**What changed**

- `ISatisfactionStore` extended with `getNpsResponse` / `recordNpsResponse` / `listNpsResponses`; `IDashboardSatisfactionStore` (the `getNpsResponse` + `recordNpsResponse` subset) added to `IDashboardStore` and wired into both dashboard-store factories (Dynamo gated on `satisfactionTable`, Postgres always).
- `NpsResponseRecord` type; one row per (installation, `githubUserId`), latest-wins.
- `GET /api/nps?installation_id=…` → `{ eligible }` (true when the store is wired and the caller has no response in the last 90 days); `POST /api/nps` records `{ installation_id, score }` (validates integer 0–10, verifies installation access). Both behind the same NextAuth + `fetchUserInstallations` gate as `/api/insights`.
- `NpsPrompt` client component (`packages/dashboard/components/NpsPrompt.tsx`) — fetches eligibility on mount, renders the 0–10 scale, POSTs, thanks; per-session `sessionStorage` dismissal.
- Rollup + dashboard: `engagement.ts` computes `npsResponses` + `npsScore` (= %promoters (9–10) − %detractors (0–6), integer −100..100, `null` when none, windowed by `respondedAt`); `EngagementSection` renders the **NPS** StatCard.
- Infra: `SatisfactionTable` in `infra/template.yaml` (+ `SATISFACTION_TABLE` env + IAM grant); `DYNAMODB_TABLE_SATISFACTION` exposed via `next.config.js`.

**Edge cases**

- Throttle is per (installationId, githubUserId): one response / 90 days.
- Eligibility fails closed (no prompt) on a read error or unprovisioned table — a missed survey beats a survey loop.
- NPS passives (7–8) count toward the denominator only.

**Tests:** `engagement.test.ts` NPS buckets / rounding / windowing; satisfaction store tests (get/record/list, both backends). The dashboard route + prompt are covered by the production build (tsc + ESLint) and RUNBOOK E2E, consistent with the rest of the dashboard.

**E2E:** [E2E-62](../e2e/RUNBOOK.md#e2e-62-engagement--dashboard-nps-survey-engagement-metrics-stage-5).

> **Deploy note (SaaS):** the Amplify SSR role needs the `mergewatch-satisfaction-*` table in its DynamoDB inline policy (covered by the existing `mergewatch-*` wildcard), and `DYNAMODB_TABLE_SATISFACTION` must be set in the Amplify environment for the NPS route to read/write.

---

## Deferred (follow-up tickets)

- **Exact finding-action rate** — true per-commit diff confirmation that cited code changed (Stage 2 ships an `(agreements + resolves)/surfaced` proxy).
- **Fleet-wide / WoW retention** — cross-installation %-active and week-over-week retained installations (insights page is installation-scoped).
- **Per-developer attribution & leaderboards** — out of scope per #195.
