/**
 * Paginated collection for the analytics surface (#333).
 *
 * `/api/analytics` used to fetch a single 500-row page and discard
 * `nextCursor`, then present the reduction of that page as a total. Because
 * the stores return newest-first, the rows that got dropped were the *oldest*
 * ones in the selected range — so the trend charts lost their history while
 * still being labelled with the full range, and widening the date filter
 * changed nothing.
 *
 * This module walks the cursor to exhaustion instead, and reports honestly
 * when it had to stop early.
 *
 * The page fetcher is injected rather than imported so this is unit-testable
 * without standing up next-auth, the store, or a Next.js request — there is no
 * API-route test harness in this repo, and adding one to test a loop would be
 * the wrong trade.
 */

/** One page as returned by `IDashboardReviewStore.listReviews`. */
export interface ReviewPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Fetch one page. `cursor` is `undefined` for the first call. */
export type FetchReviewPage<T> = (cursor: string | undefined) => Promise<ReviewPage<T>>;

export interface CollectResult<T> {
  reviews: T[];
  /**
   * True when collection stopped before the store ran out of rows — the
   * aggregate below it is a partial view and must not be shown as a total.
   */
  truncated: boolean;
  pagesFetched: number;
}

/**
 * Rows per page. Larger than the old cap so typical installations finish in
 * one or two round trips, small enough that a single page stays a reasonable
 * query for both Postgres (offset pagination) and DynamoDB (1MB page limit).
 */
export const ANALYTICS_PAGE_SIZE = 1000;

/**
 * Upper bound on rows pulled into memory for one aggregation.
 *
 * This is a backstop against an unbounded request, not a product decision:
 * 20k reviews is far past any current installation, and an instance that
 * reaches it gets a truncation flag rather than silence. The real fix for
 * that scale is aggregating in the database (see #333's fix direction) —
 * which is also what #335 needs, since DynamoDB cannot page this efficiently.
 */
export const ANALYTICS_MAX_REVIEWS = 20_000;

/**
 * Hard ceiling on iterations. `maxReviews / pageSize` already bounds the loop
 * for a well-behaved store; this catches a store that returns a cursor
 * alongside an empty page forever, which would otherwise spin without ever
 * growing `reviews`.
 */
const MAX_PAGES = Math.ceil(ANALYTICS_MAX_REVIEWS / ANALYTICS_PAGE_SIZE) + 5;

/**
 * Follow `nextCursor` until the store is exhausted or a safety bound trips.
 *
 * `maxReviews` is a **soft** bound: collection stops once the total reaches it,
 * but the page that crossed the line is kept whole rather than sliced. Keeping
 * partial pages would mean silently discarding rows we already paid to fetch,
 * and the overshoot is bounded by one page.
 *
 * Ordering is irrelevant to the caller — aggregation is order-independent, and
 * exhausting the range is precisely what makes it so. That also means this
 * incidentally sidesteps #335's DynamoDB sort-order and pre-filter-`Limit`
 * defects for the analytics path, though not for the paginated review list.
 */
export async function collectAllReviews<T>(
  fetchPage: FetchReviewPage<T>,
  options: { maxReviews?: number } = {},
): Promise<CollectResult<T>> {
  const maxReviews = options.maxReviews ?? ANALYTICS_MAX_REVIEWS;

  const reviews: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined = undefined;
  let pagesFetched = 0;
  let exhausted = false;

  while (pagesFetched < MAX_PAGES) {
    const page: ReviewPage<T> = await fetchPage(cursor);
    pagesFetched++;
    reviews.push(...page.items);

    const next = page.nextCursor;
    if (!next) {
      exhausted = true; // store ran out — the only clean exit
      break;
    }

    if (reviews.length >= maxReviews) break;

    // A repeated cursor means the store is not advancing. Stopping is right:
    // we cannot claim completeness, and looping to MAX_PAGES would just burn
    // queries to reach the same conclusion.
    if (seenCursors.has(next)) break;

    seenCursors.add(next);
    cursor = next;
  }

  // Anything other than running the store dry leaves us with a partial view —
  // including exiting on the final allowed page while still holding a cursor.
  return { reviews, truncated: !exhausted, pagesFetched };
}
