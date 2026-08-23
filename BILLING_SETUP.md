# Stripe Billing Setup — MergeWatch SaaS

This guide covers how to enable prepaid credits billing for MergeWatch SaaS mode.

## Prerequisites

- AWS CLI configured with the `mergewatch` profile
- SAM CLI installed
- A [Stripe account](https://dashboard.stripe.com) (test mode is fine for dev)
- GitHub App already deployed via SAM (existing `setup-ssm.sh` complete)

## Step 1: Store Stripe credentials in SSM

```bash
# For development
./scripts/setup-stripe-ssm.sh dev

# For production
./scripts/setup-stripe-ssm.sh prod
```

The script prompts for:
- **Stripe secret key** — `sk_test_...` (test) or `sk_live_...` (prod)
- **Stripe webhook signing secret** — `whsec_...` (from Stripe Dashboard → Webhooks)
- **Billing API secret** — shared secret for dashboard→Lambda auth (auto-generated if you press Enter)

These are stored as encrypted SSM SecureStrings at:
- `/mergewatch/{stage}/stripe-secret-key`
- `/mergewatch/{stage}/stripe-webhook-secret`
- `/mergewatch/{stage}/billing-api-secret`

## Step 2: Set DeploymentMode

### Option A: GitHub Actions (CI/CD)

Go to **repo → Settings → Variables → Actions → New variable**:
- Name: `DEPLOYMENT_MODE`
- Value: `saas`

The deploy workflow passes this as the `DeploymentMode` SAM parameter.

### Option B: Manual SAM deploy

```bash
sam deploy \
  --parameter-overrides "Stage=dev DeploymentMode=saas" \
  ...
```

### Option C: deploy.sh

```bash
# Edit infra/samconfig.toml to add DeploymentMode=saas to parameter_overrides
./scripts/deploy.sh dev
```

## Step 3: Configure Stripe webhook endpoint

In the [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks):

1. Click **Add endpoint**
2. **Endpoint URL**: `<BillingUrl>/webhook`
   - Find `BillingUrl` in SAM stack outputs:
     ```bash
     aws cloudformation describe-stacks \
       --stack-name mergewatch-dev \
       --query 'Stacks[0].Outputs[?OutputKey==`BillingUrl`].OutputValue' \
       --output text \
       --profile mergewatch
     ```
   - Example: `https://abc123.execute-api.us-east-1.amazonaws.com/dev/billing/webhook`
3. **Events to listen for**:
   - `customer.updated`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
4. Copy the **Signing secret** (`whsec_...`) — this is what you entered in Step 1

## Step 4: Set Amplify environment variables

Add these to your Amplify app's environment variables (Console → App settings → Environment variables):

| Variable | Value | Example |
|---|---|---|
| `DEPLOYMENT_MODE` | `saas` | `saas` |
| `BILLING_API_URL` | BillingUrl from SAM output | `https://abc123.execute-api.us-east-1.amazonaws.com/dev/billing` |
| `BILLING_API_SECRET` | From SSM (see below) | `(base64 string)` |

To retrieve the billing API secret:
```bash
aws ssm get-parameter --name /mergewatch/dev/billing-api-secret \
  --with-decryption --profile mergewatch --query Parameter.Value --output text
```

Then trigger an Amplify rebuild (push to main, or Console → Redeploy this version).

## Step 5: Verify

### Free tier (first 5 reviews)

1. Open a PR → MergeWatch reviews it normally
2. Repeat 4 more times → all succeed
3. Dashboard `/dashboard/billing` shows free tier progress bar (5/5 used)

### Billing block (6th review)

4. Open a 6th PR → Check Run shows `action_required: credits required`
5. A GitHub Issue is filed: "MergeWatch: reviews paused — credits required"

### Add credits

6. Go to Dashboard → Billing → **Add payment method**
7. Complete Stripe Checkout (use test card `4242 4242 4242 4242`)
8. Click a top-up button ($10 / $25 / $50 / $100)
9. Balance appears, billing issue is auto-closed
10. Next PR → reviewed successfully, balance deducted

### Auto-reload

11. Toggle auto-reload ON in Dashboard → Billing
12. When balance drops below threshold ($1 default), Stripe auto-charges the saved card

## Architecture

```
Dashboard ─── /api/billing/* ──→ BillingHandler Lambda ──→ Stripe API
                                        │                      │
                                        ▼                      ▼
                                   DynamoDB                Stripe Customer
                               (#SETTINGS row)               Balance
                              (source of truth)          (secondary ledger)
```

### Billing flow per review

```
PR opened
  → review-agent Lambda
    → isSaas()? → billingCheck()
      → free tier (< 5 reviews): allow → increment counter
      → paid tier (balance >= $0.05): allow → deduct from balance → debit Stripe
      → insufficient balance: block → Check Run + GitHub Issue
```

### Race condition guards

| Operation | Guard |
|---|---|
| Free review counter | DynamoDB atomic `ADD` with `ConditionExpression: freeReviewsUsed < 5` |
| Balance deduction | DynamoDB atomic `SET` with `ConditionExpression: balanceCents >= amount` |
| Auto-reload mutex | DynamoDB conditional write on `autoReloadInFlight = false` |
| Block issue creation | DynamoDB conditional write on `blockIssueNumber not exists` |
| Top-up idempotency | Stripe idempotency key: `topup-{id}-{cents}-{5minWindow}` |

## SSM Parameter Reference

| Parameter | Used by |
|---|---|
| `/mergewatch/{stage}/stripe-secret-key` | BillingHandler Lambda (env: `STRIPE_SECRET_KEY`) |
| `/mergewatch/{stage}/stripe-webhook-secret` | BillingHandler Lambda (env: `STRIPE_WEBHOOK_SECRET`) |
| `/mergewatch/{stage}/billing-api-secret` | BillingHandler Lambda (env: `BILLING_API_SECRET`) + Amplify dashboard |
| `/mergewatch/{stage}/github-app-id` | All Lambdas (existing) |
| `/mergewatch/{stage}/github-private-key` | All Lambdas (existing) |
| `/mergewatch/{stage}/github-webhook-secret` | WebhookHandler Lambda (existing) |

## Billing API Routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/billing/setup` | Create Stripe Customer + Checkout Session (card capture) |
| `GET` | `/billing/success` | Redirect to dashboard after setup |
| `POST` | `/billing/topup` | Charge saved card, credit balance |
| `POST` | `/billing/webhook` | Stripe webhook events |
| `GET` | `/billing/status` | Full billing state for dashboard |
| `POST` | `/billing/auto-reload` | Toggle and configure auto-reload |

## Cost Formula

```
total = llmCost + $0.005 (infra fee) + (llmCost × 40% margin)
```

Example: a review that costs $0.02 in LLM tokens:
```
total = $0.02 + $0.005 + ($0.02 × 0.40) = $0.02 + $0.005 + $0.008 = $0.033
```

## Stripe Test Cards

| Card | Scenario |
|---|---|
| `4242 4242 4242 4242` | Succeeds (any exp, any CVC) |
| `4000 0000 0000 3220` | Requires 3D Secure |
| `4000 0000 0000 0002` | Declined |

Full list: https://docs.stripe.com/testing#cards

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| 402 on every PR | Balance exhausted, no card on file | Add card + top up via Dashboard → Billing |
| Webhook events not arriving | Endpoint URL wrong or secret mismatch | Check `BillingUrl` output, re-enter `whsec_` in SSM |
| "Billing not configured" in dashboard | `BILLING_API_URL` not set in Amplify | Add env var, redeploy |
| Auto-reload not firing | Mutex stuck (`autoReloadInFlight=true`) | Check Stripe webhook delivery; clear flag manually if needed |
| Double charges | Lambda retry without idempotency | Review `prNumberCommitSha` in DynamoDB; refund via Stripe Dashboard |

## PR Stack

| PR | Description |
|---|---|
| #35 | Billing package + billing gate in review-agent |
| #36 | Stripe client + BillingHandler Lambda + checkout flows |
| #37 | Wire recordReview to Stripe balance deduction |
| #38 | Dashboard billing page |
| #39 | Auto-reload + CI/CD + setup script |

Merge in order: #35 → #36 → #37 → #38 → #39
