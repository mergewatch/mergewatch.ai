# Time-ordered review listing (SaaS / DynamoDB)

**Status:** 🚧 In review
**Issue:** [#335](https://github.com/mergewatch/mergewatch.ai/issues/335)

Fix the three `listReviews` defects that made SaaS analytics numbers unreliable: candidate rows ordered by PR-number **string** (`"9#…" > "42#…" > "100#…"`), `Limit` applied per repo instead of to the result set, and `Limit` applied to items *read* before the date `FilterExpression` ran — silently losing matching rows the narrower the date range got.

## Architecture

```
before                                   after
──────                                   ─────
Query base table per repo                Query ByRepoCreatedAt GSI per repo (parallel)
  sort key: prNumberCommitSha              keys: (repoFullName, createdAt)
  order: PR-number string ❌                order: reverse chronological ✅
  dates: FilterExpression (post-read) ❌    dates: KeyConditionExpression (pre-read) ✅
  Limit: per repo, pre-filter ❌            Limit: merged result; status filter pages ✅
```

- **Infra**: `ByRepoCreatedAt` GSI (PK `repoFullName`, SK `createdAt`, projection ALL) on the reviews table. Every review row carries `createdAt`, so the index covers the full table; CFN backfills it online. IAM needed no change (index ARNs were already granted on both the Lambda role and the Amplify SSR policy).
- **Store**: `listReviews` queries the GSI descending on `createdAt`. Date bounds live in the key condition (`BETWEEN` / `>=` / `<=`), so `Limit` counts **matching** items. Only the status filter remains a `FilterExpression`; a bounded per-repo paging loop (≤ 10 pages) keeps reading until the target count or the stream runs dry.
- **Pagination (v2 cursors)**: the per-repo resume position is the GSI key of the last item the page *returned* for that repo — not the raw `LastEvaluatedKey`, which has already advanced past rows that were fetched but dropped by the global limit slice. Dropped rows are re-fetched next page; nothing is lost or duplicated across a full pagination walk (tested).
- **Fallback**: on a stack without the GSI, the first index-missing error flips a sticky flag and the store degrades to the legacy base-table path (its defects intact — still better than a hard failure) with a one-time warning. v1 cursors (from clients mid-pagination at deploy time) also finish their sequence on the legacy path; new sequences start on the GSI.

## Read-cost impact

Measured on the dev table (`mergewatch-reviews-dev`, repo `santthosh/mergewatch-kitchensink`, 31 rows) with `ReturnConsumedCapacity`:

- **Before** — 7-day date-filtered query, base table: read all **31 items, 16 RCU, returned 0 matches**. The filter runs after the read, so 100% of the read cost was wasted; on a large repo the waste is bounded only by `Limit: 500` per repo, and the matching rows can sit unread past `LastEvaluatedKey` (the actual data loss).
- **After** — the same bounds in the GSI key condition read only matching items: an empty result consumes ~0.5 RCU (one key lookup), and a k-match result reads k items. The per-repo fan-out (`limit` candidates per repo, worst case) is unchanged in shape but now reads only in-range rows; post-deploy measurement on dev to be appended to the #335 tracker.

The long-term shape for aggregates remains a scheduled rollup (the insights pipeline precedent) rather than live per-repo fan-out; #335's fix makes the live path correct, not free.

## Edge cases

- **Repo with zero matches / empty repo list** — exhausted immediately; cursor null when all repos are done.
- **Status filter removing an entire read page** — the loop continues from `LastEvaluatedKey` (bounded), and the cursor stores the raw read position when nothing matched, so progress is never lost.
- **All of a repo's fetched rows dropped by the global slice** — the incoming resume position is carried forward unchanged; the rows are re-fetched next page.
- **Unparseable cursor** — starts a fresh sequence (existing behavior).
- **Non-index query errors** (throttling, auth) — rethrown, never masked by the fallback.
