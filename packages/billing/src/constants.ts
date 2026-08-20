/** Number of free reviews per installation (lifetime). */
export const FREE_REVIEW_LIMIT = 5;

/** Fixed infrastructure fee added to each review (USD). */
export const INFRA_FEE = 0.005;

/** Margin applied on top of LLM cost + infra fee (40%). */
export const MARGIN_PERCENT = 0.40;

/** Minimum balance in USD required to run a paid review. */
export const MIN_BALANCE_USD = 0.05;

/** Minimum balance in cents (derived from MIN_BALANCE_USD). */
export const MIN_BALANCE_CENTS = Math.round(MIN_BALANCE_USD * 100);

/**
 * #261 — Default fair-use ceiling for an OSS grant, per calendar month, shared
 * across everything the grant covers (the named repos, or every public repo in
 * the installation under #409 org scope). At the $0.01–$0.10 per-review range
 * this is ~200–2000 reviews: generous for any real OSS project while bounding
 * a runaway repo. Overridable per grant via `scripts/grant-oss.ts --cap`.
 */
export const OSS_DEFAULT_MONTHLY_CAP_CENTS = 2000;

/** #261 — Default OSS grant term in months, after which it needs renewal. */
export const OSS_DEFAULT_TERM_MONTHS = 12;
