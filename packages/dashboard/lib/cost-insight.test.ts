import { describe, it, expect } from "vitest";
import { isAllUnpriced } from "./cost-insight";

describe("isAllUnpriced", () => {
  it("is true when there are unpriced reviews and no priced ones", () => {
    expect(isAllUnpriced({ pricedReviewCount: 0, unpricedReviewCount: 3 })).toBe(true);
  });

  it("is false when at least one review is priced", () => {
    expect(isAllUnpriced({ pricedReviewCount: 1, unpricedReviewCount: 3 })).toBe(false);
    expect(isAllUnpriced({ pricedReviewCount: 5, unpricedReviewCount: 0 })).toBe(false);
  });

  it("is false for an empty window (no reviews at all)", () => {
    expect(isAllUnpriced({ pricedReviewCount: 0, unpricedReviewCount: 0 })).toBe(false);
  });
});
