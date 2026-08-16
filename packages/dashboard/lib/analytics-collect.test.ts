import { describe, it, expect } from "vitest";
import {
  collectAllReviews,
  ANALYTICS_PAGE_SIZE,
  ANALYTICS_MAX_REVIEWS,
  type ReviewPage,
} from "./analytics-collect";

/**
 * A fake store that serves `total` rows in pages of `pageSize`, recording the
 * cursors it was called with so tests can assert the walk itself, not just the
 * result.
 */
function fakeStore(total: number, pageSize = 3) {
  const calls: Array<string | undefined> = [];

  const fetchPage = async (cursor: string | undefined): Promise<ReviewPage<number>> => {
    calls.push(cursor);
    const offset = cursor ? Number(cursor) : 0;
    const items = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - offset)) },
      (_, i) => offset + i,
    );
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  };

  return { fetchPage, calls };
}

describe("collectAllReviews — exhausting the store", () => {
  it("returns a single page and does not report truncation", async () => {
    const { fetchPage, calls } = fakeStore(3, 3);
    const r = await collectAllReviews(fetchPage);

    expect(r.reviews).toEqual([0, 1, 2]);
    expect(r.truncated).toBe(false);
    expect(r.pagesFetched).toBe(1);
    expect(calls).toEqual([undefined]);
  });

  it("follows the cursor across many pages and concatenates in order", async () => {
    const { fetchPage, calls } = fakeStore(10, 3);
    const r = await collectAllReviews(fetchPage);

    expect(r.reviews).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.truncated).toBe(false);
    expect(r.pagesFetched).toBe(4);
    // First call passes no cursor; each subsequent call passes the previous one.
    expect(calls).toEqual([undefined, "3", "6", "9"]);
  });

  it("handles an empty store", async () => {
    const { fetchPage } = fakeStore(0, 3);
    const r = await collectAllReviews(fetchPage);

    expect(r.reviews).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.pagesFetched).toBe(1);
  });

  it("stops on a full final page that carries no cursor", async () => {
    // total is an exact multiple of pageSize — the last page is full but the
    // store still signals the end, so there must be no extra request.
    const { fetchPage } = fakeStore(9, 3);
    const r = await collectAllReviews(fetchPage);

    expect(r.reviews).toHaveLength(9);
    expect(r.pagesFetched).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("collects well past the old 500-row cap", async () => {
    const { fetchPage } = fakeStore(1234, 100);
    const r = await collectAllReviews(fetchPage);

    expect(r.reviews).toHaveLength(1234);
    expect(r.truncated).toBe(false);
  });
});

describe("collectAllReviews — safety bounds", () => {
  it("stops at maxReviews and reports truncation", async () => {
    const { fetchPage } = fakeStore(1000, 10);
    const r = await collectAllReviews(fetchPage, { maxReviews: 50 });

    expect(r.truncated).toBe(true);
    expect(r.reviews).toHaveLength(50);
  });

  it("keeps the crossing page whole rather than slicing it", async () => {
    // Soft bound: 7 rows per page, cap of 10 → stops after two pages at 14.
    const { fetchPage } = fakeStore(1000, 7);
    const r = await collectAllReviews(fetchPage, { maxReviews: 10 });

    expect(r.reviews).toHaveLength(14);
    expect(r.truncated).toBe(true);
    // Overshoot is bounded by a single page.
    expect(r.reviews.length).toBeLessThan(10 + 7);
  });

  it("does not report truncation when the store ends exactly at the cap", async () => {
    const { fetchPage } = fakeStore(10, 5);
    const r = await collectAllReviews(fetchPage, { maxReviews: 10 });

    // The final page carried no cursor, so this is a clean exhaustion even
    // though the cap was reached on the same iteration.
    expect(r.reviews).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it("stops when the store repeats a cursor instead of advancing", async () => {
    let calls = 0;
    const fetchPage = async (): Promise<ReviewPage<number>> => {
      calls++;
      return { items: [1], nextCursor: "stuck" };
    };

    const r = await collectAllReviews(fetchPage);

    expect(r.truncated).toBe(true);
    // First page yields "stuck"; the second sees it repeat and stops.
    expect(calls).toBe(2);
    expect(r.reviews).toEqual([1, 1]);
  });

  it("terminates when a store returns empty pages with a cursor forever", async () => {
    // Pathological: never advances the row count, so maxReviews can never trip.
    // Only the page ceiling stops this.
    let n = 0;
    const fetchPage = async (): Promise<ReviewPage<number>> => {
      n++;
      return { items: [], nextCursor: `cursor-${n}` };
    };

    const r = await collectAllReviews(fetchPage);

    expect(r.truncated).toBe(true);
    expect(r.reviews).toEqual([]);
    // Bounded, not infinite — the point of the test.
    expect(r.pagesFetched).toBeLessThanOrEqual(
      Math.ceil(ANALYTICS_MAX_REVIEWS / ANALYTICS_PAGE_SIZE) + 5,
    );
  });

  it("propagates a store error rather than returning a partial total", async () => {
    // The route's catch handles this. Silently returning page 1 would be the
    // 500-cap bug all over again, with no flag to show for it.
    const fetchPage = async (cursor: string | undefined): Promise<ReviewPage<number>> => {
      if (cursor) throw new Error("connection reset");
      return { items: [1, 2], nextCursor: "next" };
    };

    await expect(collectAllReviews(fetchPage)).rejects.toThrow("connection reset");
  });
});

describe("collectAllReviews — bounds are sane", () => {
  it("defaults to a cap far above the old 500 limit", () => {
    expect(ANALYTICS_MAX_REVIEWS).toBeGreaterThan(500);
    expect(ANALYTICS_PAGE_SIZE).toBeGreaterThan(500);
  });

  it("reaches the default cap in a reasonable number of round trips", () => {
    expect(ANALYTICS_MAX_REVIEWS / ANALYTICS_PAGE_SIZE).toBeLessThanOrEqual(20);
  });
});
