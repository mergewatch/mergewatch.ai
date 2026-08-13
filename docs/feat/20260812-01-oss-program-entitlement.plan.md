# OSS Program — Sponsored-Review Entitlement

**Status:** In progress
**Tracking issue:** [#261](https://github.com/mergewatch/mergewatch.ai/issues/261)

## Summary

Make the runtime honor the free-hosted-access promise on [mergewatch.ai/open-source](https://mergewatch.ai/open-source). Approved open-source repositories get their PR reviews sponsored — no balance, no credit card, no `freeReviewsUsed` consumption — via an entitlement flag on the installation's `#SETTINGS` row. Grants are written by a manually-run operator script.

## Why

The public page and `docs-site/saas/billing.mdx` both promise free hosted review to approved OSS projects, and a live Google Form collects applications. Nothing in the runtime implements it.

`billingCheck()` (`packages/billing/src/billing-check.ts:23`) is a two-branch decision — free tier, then balance, then block. The only way to service an approved application today is hand-editing `balanceCents`, which drains. When a granted balance hits zero, `packages/billing/src/block-notify.ts` files a *"reviews paused — credits required"* GitHub Issue **on the maintainer's public repo**. That is the worst outcome this program could produce, and it is the current default behavior.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Grant primitive | Entitlement flag in DynamoDB, **not** money | A balance grant drains, books sponsorship as revenue, and has no ceiling. An entitlement has none of those failure modes. |
| Stripe coupons | **Rejected** | No subscriptions or invoices exist; top-ups are a raw off-session `paymentIntents.create` (`checkout.ts:106`) which coupons cannot attach to. Decisively: the gate reads DynamoDB, not Stripe (`record-review.ts:69`). A 100% coupon would not change whether one review runs. |
| Grant scope | **Explicitly named repos only** | Open core: a company with one OSS repo alongside public-but-commercial repos would get all of them sponsored under an installation-wide grant. A cap bounds the money, not the principle. |
| Repo matching | Immutable numeric `repo.id` | Renames and org transfers change `full_name`; a name-keyed list silently stops matching, sponsorship lapses, and a "credits required" issue lands on a public OSS repo. This repo has itself been transferred. |
| Grant storage | `#SETTINGS` row, not per-repo rows | The gate already reads `#SETTINGS`, so an in-row repo list costs **zero extra reads**; per-repo flags would add a second DynamoDB read per review. Cap and accrual are installation-level regardless. |
| New param shape | **Optional** 4th arg to `billingCheck` | `BillingCheckFn = typeof billingCheck` (`packages/mcp/src/middleware/billing.ts:17`) derives from the function. An optional param means MCP compiles untouched and keeps its current gate. |
| MCP path | **Not sponsored** — webhook only | MCP's `repo` input is optional and defaults to `'unknown'` (`packages/mcp/src/tools/review-diff.ts:182`), so visibility cannot be verified at review time. |
| Default cap | **$20/month** per grant, shared across named repos | ~200–2000 reviews at the $0.01–$0.10 range. Generous for any real OSS project while bounding a runaway repo. Overridable with `--cap`. |
| Default term | **12 months** | Annual re-verification. Low-touch, but abandoned projects fall off without individual attention. |
| Self-hosted | **Out of scope** | Billing is SaaS-only behind `isSaas()`. `installation_settings` in `packages/storage-postgres/src/schema.ts` has **no billing columns at all** — no migration, no parity work. |

## Architecture

### Data model

New optional fields on `BillingFields` (`packages/core/src/types/db.ts:470`), stored on the existing `#SETTINGS` sentinel row. No new tables, no schema migration — DynamoDB attributes are additive.

```ts
ossGrantRepos?: Array<{ id: number; fullName: string }>;  // required non-empty for an active grant
ossGrantExpiresAt?: string;      // ISO 8601; presence + future = active. Revoke = set to past.
ossGrantedAt?: string;           // informational provenance
ossGrantNote?: string;           // informational provenance
ossMonthlyCapCents?: number;
ossPeriod?: string;              // YYYY-MM
ossSponsoredCentsThisPeriod?: number;
ossSponsoredCentsLifetime?: number;
```

`getBillingFields` uses an explicit `ProjectionExpression` (`dynamo-billing.ts:21`) — the new fields **must** be added there or they read back `undefined`.

### Gate

```ts
billingCheck(client, table, installationId, repoContext?)
  → { status, firstBlock, reason: 'oss' | 'free_tier' | 'paid' }
```

`repoContext?: { repoId: number; repoFullName: string; isPublic: boolean }`. Absent → OSS branch skipped entirely, behavior identical to today.

Allow as `oss` when **all** hold: grant not expired · `repoId` ∈ `ossGrantRepos` · repo is **public right now** · period spend under cap.

Two behaviors carry the value:

- **Named is necessary but not sufficient.** `isPublic` is evaluated live at review time, so a named repo flipped private stops being sponsored on the next review. An approval-time snapshot cannot catch that, and it is the actual cost leak.
- **Sponsored reviews must not increment `freeReviewsUsed`.** Otherwise a lapsed grant becomes an instantly-blocked paid account with an issue on the repo, instead of landing on the 5 free reviews every install gets.

### Recording

`recordReview` (`record-review.ts:19`) gets a first branch: same `calculateReviewCost`, accrue to `ossSponsoredCentsThisPeriod` / `ossSponsoredCentsLifetime` with period rollover, instead of deducting balance. **No Stripe call, no auto-reload check** on this path.

### Degradation

Over cap → fall through to the standard gate; the install still has its free tier and any balance. Only if *that* blocks does the block path run, with `block-notify.ts` copy branching to BYOK/sponsorship rather than "add a credit card."

### Call sites

| Site | Repo context | Treatment |
|---|---|---|
| `packages/lambda/src/handlers/review-agent.ts:450` | full — webhook payload | OSS branch active |
| `packages/mcp/src/middleware/billing.ts:37` | optional, often `'unknown'` | unchanged (param omitted) |

`repository.id` and `repository.private` both live on `GitHubRepository` (`packages/core/src/types/github.ts:24-28`) and **neither** is forwarded today — the event built at `packages/lambda/src/handlers/webhook.ts:230` drops both. Same object, so one plumbing change carries both.

## Phased breakdown

### Phase 1 — Core entitlement (`packages/billing`, `packages/core`)

- [x] `BillingFields` additions + `getBillingFields` projection.
- [x] `billingCheck` optional `repoContext` + OSS branch + `reason` in the result.
- [x] `recordReview` OSS accrual branch with period rollover.

**Files:** `packages/core/src/types/db.ts`, `packages/billing/src/{billing-check,record-review,dynamo-billing,constants}.ts`

**Tests:** named public repo sponsored · unnamed public repo in same install **not** sponsored · private repo named in grant still gated · named repo gone private · expired grant · cap exceeded → falls through, not blocked · `freeReviewsUsed` untouched on sponsored path · period rollover resets counter · repo matched by ID after rename · `repoContext` omitted → identical to current behavior.

**RUNBOOK:** none (no user-visible behavior yet).

Ships dark — nothing writes the fields yet, so this is a no-op in prod and safe to merge alone.

### Phase 2 — Webhook plumbing + gate wiring

- [ ] Forward `repoId` + `isPublic` from `webhook.ts:230` through the review-agent event.
- [ ] Pass `repoContext` at `review-agent.ts:450`.
- [ ] OSS-aware copy in `block-notify.ts` for the over-cap/lapsed case.

**Tests:** event carries both fields · gate receives them · over-cap block copy references BYOK.

**RUNBOOK:** `E2E-82` — sponsored review on a granted public repo (zero balance, zero free-tier consumption).

### Phase 3 — Operator script

- [ ] `scripts/grant-oss.sh` — `grant` / `--add` / `--remove` / `--revoke` / `--inspect`.
- [ ] Repo → installation resolution via App JWT minted from SSM (as `github-auth-ssm.ts:57` does); `gh api` cannot hit `/repos/{owner}/{repo}/installation` with a user token.
- [ ] Eligibility check (`private === false`), blast-radius print listing covered **and** uncovered repos in the installation (a `Query` on `installationId`, the partition key — no GSI needed), confirm before write.
- [ ] Refuse to run without explicit `--stage prod|dev`.

**RUNBOOK:** `E2E-83` — grant, verify sponsorship, revoke, verify fallback to free tier.

### Phase 4 — Dashboard + docs (capstone)

- [ ] OSS fields in the `/billing/status` response (`packages/lambda/src/handlers/billing.ts:254`).
- [ ] OSS Program state in `BillingClient.tsx` — covered repos, sponsored this month, fair-use headroom — replacing the balance/top-up prompt.
- [ ] Update `docs-site/saas/billing.mdx` to describe actual grant behavior.
- [ ] Graduate `docs/pending/oss-program.md` → `docs/oss-program.md`.

## Out of scope / deferred

- Self-hosted — already free; no billing columns exist in Postgres.
- MCP `review_diff` sponsorship (see Decisions).
- Automated eligibility detection — approval stays manual, as the page promises.
- Dashboard admin granting UI — the script is run manually by an operator, by design.
- Replacing the Google Form with an in-app application flow.

## Acceptance criteria

- [ ] Named public repo reviews with zero balance and zero `freeReviewsUsed` consumption.
- [ ] Unnamed public repo in the same installation is gated normally.
- [ ] Private repo gated normally even when named in the grant.
- [ ] Named repo flipped private stops being sponsored on the next review.
- [ ] Named repo renamed or transferred stays sponsored (ID match).
- [ ] Expired or revoked grant falls back to the standard gate — never straight to blocked.
- [ ] Sponsored cost queryable per install, per month, and lifetime.
- [ ] No sponsored review touches Stripe.
- [ ] Over-cap installs degrade to the normal gate with BYOK-oriented copy.
