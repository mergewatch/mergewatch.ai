# MergeWatch for Open Source — sponsored reviews

**Status:** 🚧 In progress (#261)

Approved open-source repositories have their PR reviews sponsored: no balance, no payment method, and no consumption of the standard 5-review free tier. This is the runtime behind the promise on [mergewatch.ai/open-source](https://mergewatch.ai/open-source).

Self-hosting is free regardless and is unaffected by any of this — the whole mechanism sits behind `isSaas()`.

## How a grant is represented

A grant is an **entitlement**, not money. It lives on the installation's `#SETTINGS` sentinel row in the installations table, alongside the existing billing fields:

| Field | Meaning |
|---|---|
| `ossGrantRepos` | `{ id, fullName }[]` — the repositories covered. Required and non-empty for an active grant. |
| `ossGrantExpiresAt` | ISO 8601. Presence + a future date = active. Revoking is setting this to the past. |
| `ossGrantedAt` | When the grant was written. Informational. |
| `ossGrantNote` | Application reference, project name, approver. Informational. |
| `ossMonthlyCapCents` | Fair-use ceiling per calendar month, shared across the named repos. |
| `ossPeriod` | Accrual period (`YYYY-MM`) the period counter belongs to. |
| `ossSponsoredCentsThisPeriod` | Sponsored cost accrued this period. |
| `ossSponsoredCentsLifetime` | Sponsored cost accrued over the grant's life. Monotonic. |

Three design choices are load-bearing:

**Named repos only.** There is no installation-wide mode. An installation can mix a genuinely-OSS repo with public-but-commercial ones (open core), and a blanket grant would sponsor all of them. A cap bounds the money but not the principle.

**Matched on the numeric repo id.** GitHub renames and org transfers change `full_name` while `id` is immutable. A name-keyed list would silently stop matching after a rename — sponsorship lapses, the next PR gets gated, and a "credits required" issue lands on a public OSS repo. `fullName` is stored for readability only and may be stale.

**Stored on `#SETTINGS`, not per-repo rows.** The gate already reads `#SETTINGS` for billing, so an in-row list costs zero extra reads; per-repo flags would add a second DynamoDB read to every review. The cap and accrual counters are installation-level regardless.

## When a review is sponsored

All of the following must hold, evaluated fresh on every review:

1. The grant has not expired.
2. The repository's numeric id appears in `ossGrantRepos`.
3. The repository is **public right now**.
4. The month's accrued sponsored cost is under `ossMonthlyCapCents`.

Being named is necessary but not sufficient. Visibility is read from the webhook payload of the triggering event rather than snapshotted at approval time, so a repo flipped private after approval stops being sponsored on its very next review — that is the actual cost leak, and an approval-time check cannot catch it.

## What happens when a grant doesn't apply

Ineligibility **never blocks directly**. The gate falls through to the standard path: the installation still has its 5 free reviews and any balance. Only if *that* path blocks does a block notification go out.

When the installation had a real grant that lapsed or hit its ceiling (`grant_expired`, `cap_exceeded`), the block copy points at renewal, bring-your-own-key, and self-hosting rather than at a credit card — telling a maintainer we invited into a free program to "add credits" is the wrong message, and the public page already frames heavy usage as moving to BYOK or sponsorship.

This ordering matters: a sponsored review must never increment `freeReviewsUsed`. If it did, a maintainer whose grant lapsed would become an instantly-blocked paid account, with an issue filed on their public repo, instead of landing softly on the free tier.

## Accounting

A sponsored review's cost is computed with the same formula the paid path charges (`llmCost + infra fee + margin`) and accrued to the two OSS counters instead of deducting balance. **No Stripe call is made on the sponsored path**, and no auto-reload check runs.

Accrual is atomic: same-period accruals use DynamoDB `ADD` so concurrent reviews across repos in one installation can't lose an increment, with a conditional second path that resets the period counter on month rollover. Two reviews racing exactly at a month boundary can undercount the period figure by one review; the lifetime counter stays exact because it is always an `ADD`.

## Granting

Grants are written only by `scripts/grant-oss.sh`, run manually by an operator. There is no admin API route and no dashboard granting UI. Because of that, the `#SETTINGS` row is the sole record of who was granted what and why — which is what `ossGrantedAt` and `ossGrantNote` exist for, and what `--inspect` renders back.

See [Operating the OSS Program](#operating-the-oss-program) below (added in stage 3).

## Scope

- **SaaS only.** The gate is behind `isSaas()`; `installation_settings` in Postgres has no billing columns at all.
- **Webhook path only.** MCP `review_diff` is not sponsored: its `repo` input is optional and often literally `'unknown'`, so visibility cannot be verified at review time.
- Approval stays manual, as the public page promises. There is no automated eligibility detection.
