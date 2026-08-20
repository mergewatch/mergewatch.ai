# MergeWatch for Open Source — sponsored reviews

**Status:** ✅ Shipped (#261; org scope + pre-approval #409)

Approved open-source repositories have their PR reviews sponsored: no balance, no payment method, and no consumption of the standard 5-review free tier. This is the runtime behind the promise on [mergewatch.ai/open-source](https://mergewatch.ai/open-source).

Self-hosting is free regardless and is unaffected by any of this — the whole mechanism sits behind `isSaas()`.

## How a grant is represented

A grant is an **entitlement**, not money. It lives on the installation's `#SETTINGS` sentinel row in the installations table, alongside the existing billing fields:

| Field | Meaning |
|---|---|
| `ossGrantScope` | `'repos'` (default when absent) or `'org'`. Decides whether coverage is the named list or every public repo in the installation. |
| `ossGrantAccount` | `{ id, login }` — the account the grant was written for. Display and audit only; the gate never matches on it. |
| `ossGrantRepos` | `{ id, fullName }[]` — the repositories covered. Required and non-empty under `'repos'` scope; ignored entirely under `'org'`. |
| `ossGrantExpiresAt` | ISO 8601. Presence + a future date = active. Revoking is setting this to the past. |
| `ossGrantedAt` | When the grant was written. Informational. |
| `ossGrantNote` | Application reference, project name, approver. Informational. |
| `ossMonthlyCapCents` | Fair-use ceiling per calendar month, shared across everything the grant covers. Installation-level under both scopes. |
| `ossPeriod` | Accrual period (`YYYY-MM`) the period counter belongs to. |
| `ossSponsoredCentsThisPeriod` | Sponsored cost accrued this period. |
| `ossSponsoredCentsLifetime` | Sponsored cost accrued over the grant's life. Monotonic. |

Three design choices are load-bearing:

**Named repos by default, org-wide by choice.** `'repos'` scope stays the default because an installation can mix a genuinely-OSS repo with public-but-commercial ones (open core), and a blanket grant would sponsor all of them — a cap bounds the money but not the principle. `'org'` scope (#409) is the opposite trade, made deliberately per grant: for an account where everything public is open source, enumerating repos means every new one silently falls outside the grant until an operator notices. The operator picks; nothing infers it.

**Matched on the numeric repo id.** GitHub renames and org transfers change `full_name` while `id` is immutable. A name-keyed list would silently stop matching after a rename — sponsorship lapses, the next PR gets gated, and a "credits required" issue lands on a public OSS repo. `fullName` is stored for readability only and may be stale.

**Stored on `#SETTINGS`, not per-repo rows.** The gate already reads `#SETTINGS` for billing, so an in-row list costs zero extra reads; per-repo flags would add a second DynamoDB read to every review. The cap and accrual counters are installation-level regardless.

## When a review is sponsored

All of the following must hold, evaluated fresh on every review:

1. The grant has not expired.
2. Coverage matches — under `'repos'` scope the repository's numeric id appears in `ossGrantRepos`; under `'org'` scope every repository in the installation qualifies at this step.
3. The repository is **public right now**.
4. The month's accrued sponsored cost is under `ossMonthlyCapCents`.

Org scope widens step 2 and nothing else. Visibility, expiry, and the cap are identical in both scopes, and the cap stays installation-level — org scope widens coverage, not the ceiling.

Org scope does not need to check the account, because a grant lives on exactly one installation's `#SETTINGS` row: anything reviewed under that installation belongs to that account by construction.

Being covered is necessary but not sufficient. Visibility is read from the webhook payload of the triggering event rather than snapshotted at approval time, so a repo flipped private after approval stops being sponsored on its very next review — that is the actual cost leak, and an approval-time check cannot catch it.

## What happens when a grant doesn't apply

Ineligibility **never blocks directly**. The gate falls through to the standard path: the installation still has its 5 free reviews and any balance. Only if *that* path blocks does a block notification go out.

When the installation had a real grant that lapsed or hit its ceiling (`grant_expired`, `cap_exceeded`), the block copy points at renewal, bring-your-own-key, and self-hosting rather than at a credit card — telling a maintainer we invited into a free program to "add credits" is the wrong message, and the public page already frames heavy usage as moving to BYOK or sponsorship.

This ordering matters: a sponsored review must never increment `freeReviewsUsed`. If it did, a maintainer whose grant lapsed would become an instantly-blocked paid account, with an issue filed on their public repo, instead of landing softly on the free tier.

## Accounting

A sponsored review's cost is computed with the same formula the paid path charges (`llmCost + infra fee + margin`) and accrued to the two OSS counters instead of deducting balance. **No Stripe call is made on the sponsored path**, and no auto-reload check runs.

Accrual is atomic: same-period accruals use DynamoDB `ADD` so concurrent reviews across repos in one installation can't lose an increment, with a conditional second path that resets the period counter on month rollover. Two reviews racing exactly at a month boundary can undercount the period figure by one review; the lifetime counter stays exact because it is always an `ADD`.

## Granting

Grants are written only by `scripts/grant-oss.ts`, run manually by an operator. There is no admin API route and no dashboard granting UI. Because of that, the `#SETTINGS` row is the sole record of who was granted what and why — which is what `ossGrantedAt` and `ossGrantNote` exist for, and what `--inspect` renders back.

### Operating the program

```bash
# Approve a project (the maintainer must have installed the App first —
# the installation is what a grant attaches to)
scripts/grant-oss.ts octocat/hello-world --stage prod --note "form response #42"

# Several repos in one installation
scripts/grant-oss.ts octocat/hello-world,octocat/docs --stage prod

# Amend an existing grant rather than re-granting
scripts/grant-oss.ts --add    octocat/new-project --stage prod
scripts/grant-oss.ts --remove octocat/old-project --stage prod

# End it. Reviews fall back to the standard gate — they are NOT blocked.
scripts/grant-oss.ts --revoke octocat/hello-world --stage prod

# Audit an existing grant months later
scripts/grant-oss.ts --inspect octocat/hello-world --stage prod

# --- Org-scoped: every PUBLIC repo in the org, including ones created later ---
scripts/grant-oss.ts --org acme-corp --stage prod --note "form response #42"
scripts/grant-oss.ts --inspect --org acme-corp --stage prod
scripts/grant-oss.ts --revoke  --org acme-corp --stage prod

# --- Pre-approval: the org has NOT installed the App yet ---
scripts/grant-oss.ts --preapprove acme-corp --stage prod --note "form response #43"
scripts/grant-oss.ts --list-preapprovals --stage prod
```

Options: `--cap <cents>` (default 2000 = $20/month), `--months <n>` (default 12), `--ttl-days <n>` (pre-approval lifetime, default 90), `--note "<text>"`, `--yes` to skip the confirmation.

Picking a mode:

| Situation | Command |
|---|---|
| Installed, some repos are OSS (open core) | a repo list |
| Installed, everything public is OSS | `--org` |
| Not installed yet | `--preapprove` |

`--preapprove` refuses if the org has **already** installed, because a pre-approval is only ever claimed on `installation.created` — that event has already fired and will not fire again. It points at `--org` instead.

Four things the script does before writing:

1. **Refuses to run without `--stage`.** There is no default. It writes to a live table, and defaulting the environment is how a grant lands in the wrong one.
2. **Verifies the repo is public** and reports last-push and open-issue counts, so the human approving has the activity signal in front of them.
3. **Prints the blast radius** — the repos this grant will cover *and* the other repos in the same installation it will not. An accidental omission is then visible before the write, not after a maintainer reports that half their project isn't being reviewed. Under `--org` it instead lists every public repo currently known and warns explicitly about the open-core case, since there is no omission to spot — the point of that mode is that coverage is unbounded.
4. **Refuses `--org` combined with a repo list.** They are two different coverage models; guessing which one was meant is exactly the kind of silent wrong answer a grant script must never give.

Under the hood it needs two GitHub identities: an **App JWT** to call `GET /repos/{owner}/{repo}/installation` (the repo→installation lookup, which a user token cannot reach — this is why it isn't a `gh api` one-liner), then an **installation token** to read the repository itself. Org-targeted modes use the JWT-only `GET /orgs/{org}/installation`, falling back to `GET /users/{username}/installation` for a personal account. Credentials come from SSM (`/mergewatch/{stage}/github-app-id`, `/mergewatch/{stage}/github-private-key`) using the `mergewatch` AWS profile.

`scripts/grant-oss.ts` duplicates a handful of constants and the pre-approval row shape from `@mergewatch/billing` rather than importing them. That is forced: workspace packages do not resolve from the repo root, so the script can only import hoisted third-party dependencies. The duplicated values are marked in both files.

## Pre-approving an org that hasn't installed (#409)

A grant attaches to an installation, so before #409 approval was blocked on the maintainer installing first — "install, then tell us, then we'll grant", three round trips before a single sponsored review.

A **pre-approval** parks the decision instead. It lives in the same installations table under a `#PENDING-OSS` partition key, sorted by the **lowercased org login**:

| Field | Meaning |
|---|---|
| `orgLogin` | The login as the operator typed it. Display only. |
| `capCents` / `months` | What the claimed grant will carry. The term runs from the **claim**, not the approval, so a slow-to-install org still gets its full year. |
| `note` | Provenance, carried into `ossGrantNote` on claim. |
| `preapprovedAt` | When the decision was made. |
| `preapprovalExpiresAt` | After this, the pre-approval is dead. Default 90 days. |
| `claimedAt` / `claimedInstallationId` | Set when the org installed and the grant landed. A claimed row is inert. |
| `expiredAt` | Set when a claim attempt found the row already stale. |

When `installation.created` arrives, the webhook (`packages/lambda/src/handlers/webhook.ts`) looks for a pending row and writes an **org-scoped** grant onto the new installation's `#SETTINGS` row.

Three properties matter more than the happy path, because this runs unattended:

**Idempotent.** The `#SETTINGS` write is conditional on `attribute_not_exists(ossGrantExpiresAt)`. `installation.created` is redeliverable, and an operator may amend or revoke the grant afterwards — a redelivery must never reset it. A failed condition is a successful no-op.

**Ordered.** The pending row is marked claimed only *after* the grant lands. If the mark fails, a redelivery retries and stops at `grant_exists`. Marking first would risk spending the approval while the org gets nothing, silently.

**Never re-fires.** A row carrying `claimedAt` is inert, so uninstall/reinstall does not re-grant. A spent approval goes back through an operator.

Claim failures never propagate: an installation must still be recorded even if the OSS claim throws.

### Known limitation — matched on login, not id

The sort key is the org login, lowercased. This is the one place the system matches on a mutable name rather than a numeric id, because before installation the numeric account id is not reliably obtainable (an App JWT cannot read `GET /orgs/{org}`).

If an org renames between approval and install, the pre-approval silently does not fire. The blast radius is bounded — they land on the standard free tier rather than someone else being mis-sponsored — but it is a real failure mode, and `--list-preapprovals` is how you'd notice a row that never got claimed.

### Expiry

An unclaimed pre-approval goes stale after 90 days (`OSS_PREAPPROVAL_TTL_DAYS`), enforced logically at claim time rather than by a DynamoDB TTL — the installations table has no `TimeToLiveSpecification`, and keeping the lapsed row leaves it auditable. A stale row is stamped `expiredAt` and nothing is written to `#SETTINGS`.

## Scope

- **SaaS only.** The gate is behind `isSaas()`; `installation_settings` in Postgres has no billing columns at all.
- **Webhook path only.** MCP `review_diff` is not sponsored: its `repo` input is optional and often literally `'unknown'`, so visibility cannot be verified at review time.
- Approval stays manual, as the public page promises. There is no automated eligibility detection — including for pre-approvals, which are still an operator decision, just one that no longer has to wait for an install.
- **A claimed pre-approval is spent.** Uninstall/reinstall does not re-grant; re-approving means running the script again.
