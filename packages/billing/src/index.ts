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
  OSS_PREAPPROVAL_TTL_DAYS,
} from './constants';

// ─── OSS Program grant (#261) ───────────────────────────────────────────────
export {
  evaluateOssGrant,
  currentPeriod,
  sponsoredCentsThisPeriod,
} from './oss-grant';
export type { RepoContext, OssEligibility, OssIneligibleReason } from './oss-grant';

// ─── OSS Program pre-approval (#409) ────────────────────────────────────────
export {
  PREAPPROVAL_PK,
  normalizeLogin,
  putPreapproval,
  getPreapproval,
  listPreapprovals,
  claimOssPreapproval,
} from './oss-preapproval';
export type {
  OssPreapproval,
  PreapprovalInput,
  ClaimResult,
  ClaimSkipReason,
} from './oss-preapproval';

// ─── GitHub Marketplace records (#421) ──────────────────────────────────────
export {
  MARKETPLACE_PK,
  normalizeAccount,
  getMarketplaceRecord,
  listMarketplaceRecords,
  recordMarketplaceEvent,
  attachMarketplaceToInstallation,
} from './marketplace';
export type { MarketplaceRecord, AttachResult } from './marketplace';

// ─── Cost calculation ───────────────────────────────────────────────────────
export { calculateReviewCost } from './cost';
export type { ReviewCost } from './cost';

// ─── Billing check ──────────────────────────────────────────────────────────
export { billingCheck, isLapsedOssGrant } from './billing-check';
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
export type { BlockVariant } from './block-notify';

// ─── Stripe client ──────────────────────────────────────────────────────────
export { getStripe } from './stripe-client';

// ─── SSM secrets ────────────────────────────────────────────────────────────
export { getStripeSecretKey, getStripeWebhookSecret, getBillingApiSecret } from './ssm';

// ─── Checkout & top-up ──────────────────────────────────────────────────────
export { ensureStripeCustomer, createSetupSession, createTopUp } from './checkout';

// ─── Auto-reload ────────────────────────────────────────────────────────────
export { maybeAutoReload } from './auto-reload';
