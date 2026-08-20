# OSS Program — org-scoped grants and pre-approval

**Status:** Shipped

**Tracking issue:** #409 · Follow-up to #261 (`docs/oss-program.md`).

Shipped as #410 (stage 1) → #411 (stage 2) → #412 (stage 3). Runtime behavior is documented in `docs/oss-program.md`; the scenarios are E2E-91/92/93.

**Not yet exercised against live infrastructure.** E2E-91/92/93 have never been run — the AWS session was expired throughout implementation, so no code path in this feature has touched DynamoDB. Unit coverage is thorough, but the claim-on-install path especially is worth a manual pass.

## Summary

Two extensions to the OSS Program entitlement:

1. **Org-scoped grants** — sponsor *every public repository* in an installation, instead of only the repositories named by numeric id.
2. **Pre-approval** — approve an org that has **not yet installed** the MergeWatch App. The grant is parked in a pending row and applied automatically the moment they install.

## Why

The current mechanism (#261) can only express "these specific repos, by immutable numeric id". That has two sharp edges in practice:

- **Whole-org OSS foundations.** An org where *everything* public is open source has to be enumerated repo by repo, and every new repo they create silently falls outside the grant until an operator notices and runs `--add`.
- **Approval requires installation.** `scripts/grant-oss.ts` resolves a repo to its installation via `GET /repos/{owner}/{repo}/installation`, so approving a project is blocked on the maintainer installing first. The approval email currently has to say "install, then tell us, then we'll grant" — three round trips before a single sponsored review.

## Decisions

| Fork | Chosen | Rationale |
|---|---|---|
| Where a pre-approval lives | `#PENDING-OSS` sentinel row in `mergewatch-installations-{stage}`, SK = lowercased org login | Matches the existing `#SETTINGS` / `#AGENTS` sentinel idiom. Zero infra change: the webhook Lambda already has a `DynamoDBDocumentClient` and write access to this table (`storeInstallation`). Claim is a single `GetCommand`. |
| What a claimed pre-approval covers | Org-wide, all public repos | Before installation there are no repo ids, and the gate matches only on the immutable numeric id. Resolving names at claim time would add a failure mode (repo renamed/deleted between approval and install) for no benefit. |
| Unclaimed pre-approval TTL | 90 days, enforced logically at claim time | The installations table has **no** `TimeToLiveSpecification` (`infra/template.yaml:578`), so a native TTL would require a template change. A logical check is equivalent here and keeps the row auditable after it lapses. |
| Staging | 3 stacked PRs | Matches MCP (#112) and time-to-merge (#194). Stage 1 is pure gate logic and independently reviewable; stage 2 touches the webhook path; stage 3 is operator + surfaces. |
| Postgres parity | Not applicable | The whole gate sits behind `isSaas()`; `installation_settings` has no billing columns. Same scope decision as #261 (`docs/oss-program.md` § Scope). |
| Private repos under org scope | Still excluded | `repo_not_public` is checked live on every review from the webhook payload. Org scope widens *which repos* are eligible, never the visibility rule. |
| Monthly cap under org scope | Unchanged, still installation-level | `ossMonthlyCapCents` is already shared across the grant. Org scope widens coverage, not the ceiling — a runaway org still degrades to the standard gate at `cap_exceeded`. |

## Architecture

### Org scope

`ossGrantRepos` stops being the sole definition of a grant. Two new fields on `BillingFields` (`packages/core/src/types/db.ts:498`):

| Field | Meaning |
|---|---|
| `ossGrantScope?: 'repos' \| 'org'` | Absent = `'repos'`. Every existing #261 grant reads as `'repos'` with no migration. |
| `ossGrantAccount?: { id, login }` | The account the grant was written for. **Informational only** — the gate never matches on it. |

The gate does not need to match the account, because a grant already lives on exactly one installation's `#SETTINGS` row: anything reviewed under that installation belongs to that account by construction. Storing the account is for `--inspect` and the dashboard, and for catching an operator who granted the wrong installation.

`evaluateOssGrant` (`packages/billing/src/oss-grant.ts:79`) gains one branch:

```
no repo context                      → no_repo_context   (unchanged)
no ossGrantExpiresAt                 → no_grant
scope === 'repos' && repos empty     → no_grant
expired / unparseable                → grant_expired     (unchanged)
scope === 'repos' && id not in list  → repo_not_granted
!repo.isPublic                       → repo_not_public   (both scopes)
period spend >= cap                  → cap_exceeded      (unchanged)
otherwise                            → eligible
```

`repo_not_granted` simply never fires under org scope. No new `OssIneligibleReason` variant, so `isLapsedOssGrant()` and the `oss` block copy in `block-notify.ts` need no change.

`record-review.ts` re-derives eligibility from the stored fields rather than trusting the gate, so it picks up org scope for free — the accrual path needs no edit beyond its tests.

### Pre-approval and claim

```
operator: grant-oss.ts --preapprove acme-corp --stage prod
    │
    ▼
mergewatch-installations-prod
  PK #PENDING-OSS   SK acme-corp   { scope, capCents, months, note,
                                     preapprovedAt, preapprovalExpiresAt }
    │
    │   …org installs the App…
    ▼
installation.created  →  handleInstallationEvent (webhook.ts:549)
    │                      └─ claimOssPreapproval(client, table, id, account)
    ▼
PK <installationId>  SK #SETTINGS  { ossGrantScope: 'org',
                                     ossGrantAccount: { id, login },
                                     ossGrantExpiresAt, ossMonthlyCapCents,
                                     ossGrantedAt, ossGrantNote }
  PK #PENDING-OSS    SK acme-corp   { …, claimedAt, claimedInstallationId }
```

Three properties the claim must have:

**Idempotent.** `installation.created` is redeliverable, and an operator may amend the grant afterwards. The `#SETTINGS` write carries `ConditionExpression: attribute_not_exists(ossGrantExpiresAt)` so a redelivery can never reset an amended or deliberately-revoked grant. A `ConditionalCheckFailedException` is a successful no-op, not an error.

**Non-fatal.** The claim is wrapped so a failure logs and returns — an installation must still be recorded even if the OSS claim throws. Same posture as `recordPrLifecycle`.

**Marked, not deleted.** A claimed row is rewritten with `claimedAt` + `claimedInstallationId` rather than removed, so `--list-preapprovals` stays an honest record of who was approved and what happened. A row with `claimedAt` is inert: an uninstall/reinstall does **not** re-claim it. That is deliberate — a spent approval should go back through an operator, and a silent re-grant on reinstall is exactly the kind of thing nobody would notice.

**Expiry.** A row whose `preapprovalExpiresAt` is in the past is ignored and stamped `expiredAt`. Nothing is written to `#SETTINGS`.

### Login matching

The SK is `account.login.toLowerCase()` — GitHub logins are case-insensitive for lookup, and the operator types whatever casing the application form had. This is the one place the system matches on a mutable name rather than a numeric id, because before installation the numeric account id is not reliably obtainable (an App JWT cannot read `GET /orgs/{org}`). The blast radius is bounded: a rename between approval and install means the pre-approval silently doesn't fire, which degrades to the standard free tier rather than mis-sponsoring someone. Documented as a known limitation.

## Phased breakdown

### Phase 1 — org scope in the gate

- [x] **Goal:** `ossGrantScope: 'org'` sponsors every public repo in the installation. Pure logic; nothing writes the field yet. **Shipped in PR #410** (MergeWatch 5/5, no findings).
- **Files:** `packages/core/src/types/db.ts` (two fields + revise the "no installation-wide mode" comment), `packages/billing/src/oss-grant.ts` (the branch), `packages/billing/src/index.ts` (re-export any new type), `packages/billing/src/oss-grant.test.ts`, `packages/billing/src/record-review.test.ts`.
- **Tests:** org-scope eligible with an empty/absent repo list; org scope still rejects private (`repo_not_public`); org scope still respects expiry and cap; absent `ossGrantScope` behaves byte-for-byte as today (back-compat); `repos` scope with an empty list is still `no_grant`; `recordReview` accrues (and does not touch balance or `freeReviewsUsed`) under org scope.
- **RUNBOOK:** E2E-91 — org-scoped grant sponsors a new public repo with no operator action, and stops sponsoring it when flipped private.

### Phase 2 — pre-approval store + claim on install

- [x] **Goal:** pre-approve an org that hasn't installed; the grant lands automatically on `installation.created`. **Shipped in PR #411.**
- **Files:** new `packages/billing/src/oss-preapproval.ts` (`putPreapproval`, `getPreapproval`, `listPreapprovals`, `claimOssPreapproval`), `packages/billing/src/index.ts`, `packages/lambda/src/handlers/webhook.ts` (call the claim from `handleInstallationEvent`, `created` action only), new `packages/billing/src/oss-preapproval.test.ts`, `packages/lambda/src/handlers/webhook.test.ts`.
- **Tests:** claim writes an org-scoped grant; redelivery is a no-op (condition fails); an existing grant is never overwritten; an expired pre-approval writes nothing and stamps `expiredAt`; a claimed row is inert on reinstall; login casing is normalized; a claim failure doesn't break `storeInstallation`; non-`created` actions never claim.
- **RUNBOOK:** E2E-92 — pre-approve an org, install the App, first PR is sponsored with no operator step in between.
- **Note:** no `infra/template.yaml` change — the webhook Lambda already has table write access and a `@mergewatch/billing` dependency.

### Phase 3 — operator script, dashboard, docs

- [x] **Goal:** make both features operable and visible. **Shipped in PR #412.**
- **Files:** `scripts/grant-oss.ts` (`--org`, `--preapprove`, `--list-preapprovals`; `--inspect` renders scope + any pending row; `--revoke` handles org grants and pending rows), `packages/lambda/src/handlers/billing.ts` (`ossStatus` currently returns `null` when the repo list is empty — line 242 — which would make every org-scoped grant invisible; add `scope` and `account` to the payload), `packages/dashboard/app/dashboard/billing/BillingClient.tsx` (render "all public repositories" instead of a repo list under org scope), `docs/oss-program.md`, `e2e/RUNBOOK.md`, `packages/billing/src/constants.ts` (`OSS_PREAPPROVAL_TTL_DAYS = 90`).
- **Tests:** `ossStatus` returns non-null for an org-scoped grant with no repo list; still `null` with no grant at all; script arg-parsing rejects `--org` combined with a repo list.
- **RUNBOOK:** E2E-93 — operator lifecycle: `--org`, `--preapprove`, `--list-preapprovals`, `--inspect`, `--revoke`; `--stage` guard still refuses to default.
- **Docs:** update `docs/oss-program.md` **in place** rather than creating a `docs/pending/` doc. The #261 doc already graduated; a parallel pending doc that gets merged back in at the end is pure churn, and the "named repos only" section is now actively wrong and should not stay wrong for three PRs.

## Deviations from the plan as written

- **`OSS_PREAPPROVAL_TTL_DAYS` moved from stage 3 to stage 2.** `putPreapproval` needs it to compute `preapprovalExpiresAt`, so it had to ship with the store rather than with the script that calls it.
- **`getBillingFields`'s `ProjectionExpression` was missing the stage-1 fields.** Found while writing stage 2. `packages/billing/src/dynamo-billing.ts` projects an explicit attribute list, and stage 1 added `ossGrantScope` / `ossGrantAccount` to `BillingFields` without adding them there — so the gate would have read `ossGrantScope` as `undefined`, defaulted to `'repos'`, and silently ignored every org-scoped grant. Latent (nothing wrote the field until stage 2), fixed in stage 2. The file's own comment warns about exactly this; MergeWatch's review of #410 did not catch it.
- **`ossStatus` had to be exported** from `packages/lambda/src/handlers/billing.ts` to be testable. It is a pure function over billing fields; the alternative was leaving the regression this stage fixes uncovered.
- **`scripts/grant-oss.ts` duplicates constants and the pre-approval row shape** from `@mergewatch/billing` instead of importing them. Forced: workspace packages do not resolve from the repo root (root `package.json` has no dependencies and pnpm only hoists third-party deps there), so the script can import the AWS SDK and Octokit but never `@mergewatch/*`. The file already duplicated `DEFAULT_CAP_CENTS` / `DEFAULT_TERM_MONTHS` for the same reason. Both sides are commented; E2E-93 lists drift as a failure mode.
- **Dashboard lint could not be run** — `packages/dashboard` has no ESLint config and `pnpm run lint` drops into an interactive setup prompt. Pre-existing; the dashboard still builds as part of `pnpm run build`.
- **Date arithmetic is UTC, not local.** `setMonth`/`setDate` shift by an extra hour across a DST boundary, which would make a grant's expiry depend on the timezone of whoever ran the operator script. `addMonths` uses `setUTCMonth`; the TTL is plain millisecond arithmetic. Pinned by tests that run the same computation under four timezones.

## Out of scope / deferred

- **MCP `review_diff` sponsorship** — still unsponsored. Its `repo` input is optional and often literally `'unknown'`, so visibility can't be verified at review time. Unchanged by this work.
- **Self-hosted / Postgres** — no billing columns exist there; the gate is `isSaas()`-only.
- **A dashboard granting UI or admin API** — #261 deliberately made the script the sole writer, and that stays true. Pre-approval makes the script *more* load-bearing, not less.
- **Automated eligibility detection** — approval stays manual, as the public page promises.
- **Native DynamoDB TTL on pending rows** — would need a `TimeToLiveSpecification` on the installations table; the logical check is sufficient and keeps lapsed rows auditable.
- **Re-claim on reinstall** — a spent pre-approval stays spent. File a follow-up if operators find this annoying in practice.
- **Two stale doc references** found while grounding this plan: `packages/billing/src/constants.ts:20` and `packages/core/src/types/db.ts:499` both say `scripts/grant-oss.sh`; the file is `grant-oss.ts`. Fix opportunistically in phase 1 (both files are already being edited).
