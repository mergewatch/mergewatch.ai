# Developer engagement / NPS metrics

**Status:** In progress
**Issue:** [#195 — Add developer engagement / NPS metrics to validate usage and value](https://github.com/mergewatch/mergewatch.ai/issues/195)
**Author:** `/ship-feature`

## Summary

Add high-signal developer-engagement metrics that show MergeWatch is *used and valued*, not just that reviews ran. Two tiers:

- **Tier 1 — behavioral (passive):** acceptance/agreement rate, `/mergewatch` command usage, re-review rate, per-installation activity/retention, and an *approximate* finding-action rate — all derived from data we already capture (`FindingDispositionRecord`, `PRLifecycleRecord`) in the nightly insights rollup.
- **Tier 2 — explicit satisfaction:** a one-click "Was this review helpful? 👍 / 👎" prompt on the summary-comment footer, and a throttled dashboard NPS prompt (0–10, once / 90 days per admin) → NPS = %promoters − %detractors.

All of it rides as an **optional `engagement?` block** on `InstallationFPInsight`, surfaced in a new **Engagement** section on `/dashboard/insights`. This mirrors exactly how time-to-merge (#194) shipped its `cycleTime?` block.

## Why

We can see *that* reviews run but not whether developers find them useful. Behavioral signals are higher-fidelity than surveys (passive, unbiased) and we already collect most of the raw events. An explicit 👍/👎 + NPS gives a direct satisfaction read for ourselves and prospective adopters. See #195.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | **Full — Tier 1 + Tier 2 footer 👍/👎 + dashboard NPS** | User opted into the complete feature; ship in strict dep order. |
| Finding-action rate | **Approximate now, defer exact** | No persisted per-commit diff exists to confirm cited code was edited. Ship a labeled proxy from existing signals (agreements + `/resolve`); file a follow-up ticket for true diff-based capture. |
| Carrier type | **Extend `InstallationFPInsight` with optional `engagement?` block** | Mirrors `cycleTime?` (#194). No new read path for the dashboard; rides the existing fp-insight store + `/api/insights`. |
| Aggregation | **New pure module `packages/core/src/insights/engagement.ts`** | Mirrors `cycle-time.ts` — pure, table-testable, wired into `runInsightRollup`. |
| `/resolve` tracking | **Add `resolveCount` counter to `FindingDispositionRecord`** | `/resolve` is currently recorded only on `ReviewItem.inlineResolvedKeys` (per-commit, not aggregatable in the rollup). A first-class disposition counter closes the gap without dragging the review store into the rollup. |
| Satisfaction storage | **New `ISatisfactionStore` (helpful votes + NPS responses), both backends** | 👍/👎 footer votes and NPS responses are timestamped events that don't fit the per-finding disposition or per-PR lifecycle shapes. |
| Fleet-wide retention | **Per-installation only (`activeInstallation` + `reviewedPrCount`)** | `InstallationFPInsight` and `/dashboard/insights` are installation-scoped. Cross-installation WoW-retained-% needs an admin/fleet view that doesn't exist — deferred (see Out of scope). |

## Architecture

How it plugs into the existing pipeline (real paths):

- **Type:** `packages/core/src/types/db.ts` — add optional `engagement?` block to `InstallationFPInsight` (alongside `cycleTime?`, ~L658-691). Re-exported from `@mergewatch/core` index.
- **Aggregation (Tier 1):** new `packages/core/src/insights/engagement.ts` — pure `buildEngagementInsight(window, windowEndIso, dispositionRecords, prLifecycleRecords, satisfactionRecords?)`, mirroring `cycle-time.ts`'s `buildCycleTimeInsight` (L68-127) and reusing the `WINDOW_LENGTH_MS` windowing from `rollup.ts` (L14-18).
- **Rollup wiring:** `packages/core/src/insights/run-rollup.ts` — `runInsightRollup` already paginates disposition + PR-lifecycle records per installation (L89-108). Add an optional `satisfactionStore?` to `RollupStores` (mirror the optional `prLifecycleStore`, L29-34) and assign `insight.engagement` (mirror L112-114).
- **Persistence:** `packages/storage-dynamo/src/fp-insight-store.ts` + `packages/storage-postgres/src/fp-insight-store.ts` — add `engagement` to `upsert` and the `itemToInsight`/`rowToInsight` coercion (null↔undefined), exactly as `cycleTime` is handled.
- **Capture:**
  - `/resolve` → `packages/core/src/agents/inline-reply.ts` resolve handler + `packages/server/src/review-processor.ts` / Lambda review-agent → `IFindingDispositionStore.incrementResolve` (new).
  - Footer 👍/👎 → `packages/core/src/comment-formatter.ts` footer (L515-525) renders the prompt; reaction polling for the **summary** comment (new, alongside `pollAndRecordInlineReactions` in `packages/core/src/insights/disposition-writer.ts`) → `ISatisfactionStore.recordHelpfulVote`.
  - NPS → new dashboard prompt + `packages/dashboard/app/api/nps/route.ts` → `ISatisfactionStore.recordNpsResponse`.
- **Dashboard:** `packages/dashboard/components/InsightsClient.tsx` — new `EngagementSection` (mirror `CycleTimeSection`, L718-810; reuse `StatCard` L695-704 + recharts), rendered after `CycleTimeSection`; relax the zero-state gate (L281) to also fire on `hasEngagementData`. No `/api/insights` change.

## `engagement` block shape (target)

```ts
engagement?: {
  // Tier 1 — behavioral (phase 2)
  acceptanceRate: number | null;        // agreements / (agreements + disputes + silentDrops); null = no signal
  totalResolves: number;                // /resolve command usage (new resolveCount, summed in-window)
  totalRejectCommands: number;          // /mergewatch reject usage (rejectReasons[].at in-window)
  commandUsageCount: number;            // totalResolves + totalRejectCommands
  findingActionRateApprox: number | null; // PROXY: (agreements + resolves) / surfaced — exact deferred (#195 follow-up)
  reReviewRate: number | null;          // reviewed PRs with pushesAfterFirstReview>0 / reviewed PRs
  reviewedPrCount: number;              // PRs this installation had reviewed in-window
  activeInstallation: boolean;          // reviewedPrCount > 0 (per-installation retention signal)

  // Tier 2 — satisfaction (phase 4 fills helpful*, phase 5 fills nps*)
  helpfulUp: number;
  helpfulDown: number;
  helpfulRate: number | null;           // up / (up + down)
  npsResponses: number;
  npsScore: number | null;              // %promoters − %detractors, integer −100..100
};
```

All fields optional-by-block: pre-feature rollups have no `engagement`; consumers handle `undefined`. `null` (not `0`) distinguishes "no data" from a real zero, exactly like `cycleTime`'s percentiles.

## Phased breakdown — one PR per phase, strict dep order

### Phase 1 — `/resolve` capture completeness (storage) — [x] PR #207 (MergeWatch 5/5, 0 findings)
- **Goal:** make `/mergewatch` command usage fully aggregatable before the rollup consumes it.
- **Files:** `packages/core/src/types/db.ts` (`FindingDispositionRecord.resolveCount?`), `packages/core/src/storage/types.ts` (`IFindingDispositionStore.incrementResolve`), both `finding-disposition-store.ts` impls (atomic increment, mirror `incrementDispute`), `packages/storage-postgres/src/schema.ts` + generated migration (`ADD COLUMN IF NOT EXISTS resolve_count`), and the `/resolve` handler path (`inline-reply.ts` + `review-processor.ts` + Lambda review-agent) to call `incrementResolve` for each resolved key.
- **RUNBOOK:** E2E-58 — `/resolve` increments `resolveCount` on the disposition record.
- **Tests:** store increment (both backends, mock), handler wiring, migration idempotency (`migrations:check`).

### Phase 2 — Engagement rollup (Tier 1 KPIs, core) — [x] (in review)
- **Goal:** compute and persist the Tier 1 `engagement` block per 7d/30d/90d window. Depends on Phase 1 (`resolveCount`).
- **Files:** `packages/core/src/types/db.ts` (`engagement?` block), new `packages/core/src/insights/engagement.ts` (pure `buildEngagementInsight` + helpers, exported via core index), `run-rollup.ts` (assign `insight.engagement`), both `fp-insight-store.ts` impls (persist + coerce), `schema.ts` + migration (`engagement` jsonb, idempotent).
- **RUNBOOK:** E2E-59 — nightly rollup attaches an `engagement` block (acceptance rate, command usage, re-review rate, approx action rate, reviewed-PR count) over each window; empty/low-volume installation yields `null` rates not crashes.
- **Tests:** KPI math (acceptance/action/re-review rates, command counts, windowing), empty + single-record edge cases, back-compat when `satisfactionStore` absent.

### Phase 3 — Engagement dashboard section (Tier 1 surfaced) — [ ]
- **Goal:** render the Tier 1 engagement metrics. Depends on Phase 2.
- **Files:** `packages/dashboard/components/InsightsClient.tsx` — `EngagementSection` (StatCards: acceptance rate, command usage, re-review rate, approx action rate; trend across windows where useful), render after `CycleTimeSection`, relax zero-state gate (L281) to include `hasEngagementData`. No API route change.
- **RUNBOOK:** E2E-60 — `/dashboard/insights` Engagement section: StatCards render; `null` rates show `—`; the action-rate card is labeled "approx."
- **Tests:** component render with populated / null / absent `engagement`; gate logic.

### Phase 4 — Tier 2: footer 👍/👎 helpful prompt — [ ]
- **Goal:** one-click satisfaction signal on the summary comment, captured + aggregated into `engagement.helpful*`. Depends on Phase 2 (block exists) + Phase 3 (section to surface it).
- **Files:** new `ISatisfactionStore` (helpful votes) in `packages/core/src/storage/types.ts` + both backends + `schema.ts`/migration + Dynamo table in `infra/template.yaml`; `comment-formatter.ts` footer renders "Was this review helpful? 👍 / 👎"; summary-comment reaction polling (new fn near `disposition-writer.ts`) → `recordHelpfulVote`; `run-rollup.ts` wires optional `satisfactionStore` and `engagement.ts` fills `helpfulUp/Down/Rate`; `EngagementSection` shows helpful rate.
- **RUNBOOK:** E2E-61 — 👍/👎 prompt renders on the summary footer; reactions captured; rollup fills helpful rate; dashboard shows it.
- **Tests:** vote store (both backends), reaction→vote mapping + snapshot delta, helpful-rate math, migration idempotency.

### Phase 5 — Tier 2: dashboard NPS survey (capstone) — [ ]
- **Goal:** throttled NPS prompt (0–10, once / 90d per admin), NPS computed + displayed. Depends on Phase 4 (`ISatisfactionStore`). **Carries the docs graduation.**
- **Files:** extend `ISatisfactionStore` with NPS responses (both backends + migration); `packages/dashboard/app/api/nps/route.ts` (GET eligibility + POST response, 90d throttle per `githubUserId`); throttled prompt component in the dashboard; `engagement.ts` computes `npsScore`/`npsResponses`; `EngagementSection` renders NPS; graduate `docs/pending/engagement-metrics.md` → `docs/engagement-metrics.md`, flip RUNBOOK E2E-58..62 to ✅ SHIPPED.
- **RUNBOOK:** E2E-62 — NPS prompt shown to admin, throttled to once / 90d; response recorded; NPS = %promoters − %detractors rendered.
- **Tests:** NPS store, throttle logic, NPS math (promoters/detractors buckets, empty case), API route auth/throttle.

## Out of scope / deferred (file follow-up tickets)

- **Exact finding-action rate** — true per-commit diff confirmation that cited code changed (Phase 2 ships an `(agreements + resolves)/surfaced` proxy). Needs new capture (`addressedCount` counter at review time, mirroring `silentDropCount` in `review-delta.ts`).
- **Fleet-wide / WoW retention** — cross-installation %-active and week-over-week retained installations. `InstallationFPInsight` and `/dashboard/insights` are installation-scoped; needs an admin/fleet aggregate view.
- **Per-developer attribution & leaderboards** — commands/votes aren't attributed to a GitHub login today; explicitly out of scope per #195.
- **Email/Slack survey campaigns** — out of scope per #195.
