# GitHub Marketplace listing — webhook and attribution

**Status:** ✅ Shipped (#421)

MergeWatch is listed on the GitHub Marketplace with a **free plan only**. Discovery and installation happen through the listing; **money never does**. Paid conversion stays on MergeWatch's own SaaS billing — Stripe prepaid credits, the 5-review free tier, and OSS grants (`docs/oss-program.md`).

That single decision removes the entire double-billing risk class: there is no plan→entitlement mapping, no Marketplace branch in `billingCheck` / `recordReview`, and no path where a customer is charged by both GitHub and Stripe.

## Listing configuration

The listing's **Manage webhook** section takes three values:

| Field | Value |
|---|---|
| Payload URL | the `WebhookUrl` output of the stage's stack — prod: `https://wet81p7nzf.execute-api.us-west-2.amazonaws.com/prod/webhook` |
| Content type | **`application/json`** |
| Secret | the same value as SSM `/mergewatch/{stage}/github-webhook-secret` |

**Content type is not a preference.** `verifySignature` computes HMAC-SHA256 over the **raw request body**. `application/x-www-form-urlencoded` wraps the payload as `payload=<urlencoded>`, which breaks both `JSON.parse` and the signature comparison.

**The secret must match the App's webhook secret**, because the listing reuses the App's `/webhook` endpoint and one route verifies against one secret. Marketplace events are distinguished by the `X-GitHub-Event: marketplace_purchase` header, exactly as `installation` and `pull_request` are.

A dedicated `/marketplace` route with its own secret was considered and rejected: it duplicates signature handling for no behavioral gain. It becomes worth it only if Marketplace and App secrets need independent rotation.

## What the handler does

Records the purchase for **attribution** — which installations arrived via Marketplace, on what plan, and when. It grants nothing, because installation already grants access, and it **revokes nothing**.

### Storage

A Marketplace event carries an **account** (login + numeric id), never an installation, and the installations table is partitioned by `installationId` — so a login cannot be resolved to an installation without scanning. Rather than scan, the account-keyed row *is* the record, under a `#MARKETPLACE` sentinel partition (the same idiom as `#SETTINGS`, `#AGENTS`, `#PENDING-OSS`):

| Field | Meaning |
|---|---|
| `repoFullName` | Sort key — the **lowercased** account login. Not a repository. |
| `accountLogin` / `accountId` | GitHub's original casing, and the immutable numeric id. |
| `planName` / `planId` | The plan at the time of the event. |
| `lastAction` | Most recent action seen. |
| `purchasedAt` | First `purchased` sighting. **Never overwritten** — a redelivery must not move when the account arrived. |
| `cancelledAt` | Set on `cancelled`. Recorded only. |
| `attachedInstallationId` / `attachedAt` | Set once `installation.created` attached the record. |

`installation.created` then attaches it, writing `marketplaceAccountLogin`, `marketplaceAccountId`, `marketplacePlanName`, and `marketplaceAttachedAt` onto that installation's `#SETTINGS` row so the dashboard needs no second lookup.

For a free plan GitHub processes the purchase **before** redirecting to install, so purchase-then-install is the normal order and the one that must work. Because the record is account-keyed and durable, neither ordering loses the purchase.

### Deliberate non-behaviors

**`cancelled` revokes nothing.** With a free plan and Stripe-side paid billing, a Marketplace cancellation says nothing about whether the customer still has the App installed or credits on file. Revoking would look like obvious symmetry and would quietly break a paying customer.

**Re-attaching is a no-op.** `installation.created` is redeliverable, and an uninstall/reinstall produces a new installation id. Keeping the first attachment means the record reflects where the purchase originally landed rather than flapping.

**Failures never propagate.** GitHub surfaces failed deliveries on the listing and retries; a retry storm over an attribution record would be a self-inflicted outage. Every path returns 200.

**SaaS only.** Behind `isSaas()` — self-hosted has no Marketplace listing.

### The tripwire

`changed`, `pending_change`, and `pending_change_cancelled` should never occur under a free-only listing. If one arrives it means a **paid plan was added to the listing** and this handler is now under-scoped. It is still recorded, and it logs:

```
[marketplace] UNDER-SCOPED: action=changed for <account>. The listing is
supposed to carry a free plan only — a plan change implies paid plans were
added, which needs entitlement mapping (see #421).
```

If paid plans are ever added, three things become required at once: plan→entitlement mapping, a Marketplace branch in `billingCheck` / `recordReview`, and revocation on cancel. That log line is the signal that the day has arrived.

Scenario: **E2E-97**.
