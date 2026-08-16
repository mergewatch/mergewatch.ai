# Time-bounded insight rollup windows

**Status:** 🚧 In review
**Issue:** [#334](https://github.com/mergewatch/mergewatch.ai/issues/334)

Make the 7d / 30d / 90d insight rollups mean what they say. The rollup previously selected records by window (`lastSeen` inside it) but summed **lifetime** counters, so one still-active long-lived finding injected its entire history into every window — all three windows converged toward all-time totals, and `disputeRate`, `perCategory`, `perSeverity`, `perRepo`, and the `topClusters` leverage ranking all inherited the distortion.

## Architecture

```
capture (per event)                       aggregation (nightly)
─────────────────────                     ─────────────────────
counter increment  ─► lifetime counter    buildInsightFromDispositions()
                       + periodCounts       per-record windowed contribution:
                       day bucket             firstSeen in window → lifetime counters (exact)
                       (YYYY-MM-DD, UTC)      older → Σ day buckets overlapping the window
```

Windowed counts require per-period data — a lifetime counter cannot be retroactively sliced. Every counter increment now also bumps a sparse per-UTC-day bucket (`periodCounts`) on the `FindingDispositionRecord`, written atomically with the lifetime counter on both backends:

- **Postgres** — `period_counts` jsonb column; single-statement `jsonb_set` merge (no read-modify-write, concurrent writers can't lose increments). Migration `0015` is `ADD COLUMN IF NOT EXISTS`.
- **DynamoDB** — flattened `pc#<day>#<counter>` numeric attributes (Dynamo can't atomically create-and-increment a two-level nested map path in one UpdateExpression); folded back into the typed `periodCounts` map on read. No table or infra change.

## Window semantics after the change

A record's contribution to a window is:

- **`firstSeen` inside the window** — its lifetime counters, verbatim. Every event in its lifetime is in-window by definition, so this is exact — and complete even for activity that predates the buckets shipping. Recent findings never wait for buckets to accumulate.
- **`firstSeen` before the window** — the sum of its day buckets overlapping the window. Buckets are whole UTC days; the bucket on the window's start day is included wholesale (bounded overcount of < 1 day of activity).
- Inclusion follows **activity**, not `lastSeen` — a dispute or reaction landing after a finding's last surfacing now counts in the window it happened in.

This guarantees **7d ≤ 30d ≤ 90d** on any dataset.

## Migration / backfill plan

There is no backfill: per-period data was never recorded, so it cannot be reconstructed. Consequences, in the honest direction (undercount, never overcount):

- Buckets accumulate from the moment stage 1 deploys.
- Pre-existing **long-lived** records (first seen before the window) contribute only their post-deploy bucketed activity — they ramp up and are fully accurate within one window-length of deploy (7d windows heal within a week, 90d within a quarter).
- Records **born after** deploy (and any record first seen inside the window) are exact immediately.
- Rollup rows written before the change keep their old lifetime-summed semantics until the next nightly run overwrites them (`upsert` per `(installationId, window)`).

## What changed

- `packages/core/src/types/db.ts` — `PeriodCounterBucket`, `periodCounts` on `FindingDispositionRecord`, shared `periodDayKey()` helper.
- `packages/core/src/storage/types.ts` — optional `nowIso` on the `IFindingDispositionStore.increment*` methods (stores default to now; existing callers unchanged).
- `packages/storage-postgres` / `packages/storage-dynamo` disposition stores — atomic bucket writes + read-back mapping.
- `packages/core/src/insights/rollup.ts` — per-record windowed contribution substituted before totals / buckets / clusters, so every derived number is window-bounded.

## Edge cases

- **Legacy record, no buckets, `firstSeen` predates window** — contributes nothing (ramp-up above), rather than injecting lifetime history.
- **Record first seen after `windowEnd`** (rollup anchored in the past) — contributes nothing.
- **Dispute with zero in-window surfacings** — counted in `totalDisputes`; `disputeRate` keeps its divide-by-zero guard (rate 0).
- **Unbounded bucket growth** — buckets are sparse (a key exists only for days with activity), so growth is bounded by a record's active days. Pruning buckets older than 90 days is a possible follow-up if record sizes ever warrant it.
