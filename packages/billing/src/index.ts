// ─── Deployment mode ────────────────────────────────────────────────────────
export { getDeploymentMode, isSaas, isSelfHosted } from './deployment';
export type { DeploymentMode } from './deployment';

// ─── Constants ──────────────────────────────────────────────────────────────
export {
  FREE_REVIEW_LIMIT,
  INFRA_FEE,
  MARGIN_PERCENT,
  MIN_BALANCE_USD,
  MIN_BALANCE_CENTS,
  OSS_DEFAULT_MONTHLY_CAP_CENTS,
  OSS_DEFAULT_TERM_MONTHS,
} from './constants';

// ─── OSS Program grant (#261) ───────────────────────────────────────────────
export {
  evaluateOssGrant,
  currentPeriod,
  sponsoredCentsThisPeriod,
} from './oss-grant';
export type { RepoContext, OssEligibility, OssIneligibleReason } from './oss-grant';

// ─── Cost calculation ───────────────────────────────────────────────────────
export { calculateReviewCost } from './cost';
export type { ReviewCost } from './cost';

// ─── Billing check ──────────────────────────────────────────────────────────
export { billingCheck } from './billing-check';
export type { BillingCheckResult } from './billing-check';

// ─── Record review ──────────────────────────────────────────────────────────
export { recordReview } from './record-review';

// ─── DynamoDB billing ops ───────────────────────────────────────────────────
export {
  getBillingFields,
  incrementFreeReviewsUsed,
  deductBalance,
  deductBalanceAndRecordUsage,
  accrueOssSponsoredCost,
  updateBillingFields,
} from './dynamo-billing';

// ─── Block notifications ────────────────────────────────────────────────────
export { postBlockedCheckRun, ensureBillingIssue, closeBillingIssue } from './block-notify';

// ─── Stripe client ──────────────────────────────────────────────────────────
export { getStripe } from './stripe-client';

// ─── SSM secrets ────────────────────────────────────────────────────────────
export { getStripeSecretKey, getStripeWebhookSecret, getBillingApiSecret } from './ssm';

// ─── Checkout & top-up ──────────────────────────────────────────────────────
export { ensureStripeCustomer, createSetupSession, createTopUp } from './checkout';

// ─── Auto-reload ────────────────────────────────────────────────────────────
export { maybeAutoReload } from './auto-reload';
