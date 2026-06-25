import { describe, it, expect } from "vitest";
import {
  ANALYTICS_TABS,
  DEFAULT_ANALYTICS_TAB,
  resolveTab,
  isAnalyticsDataTab,
  type AnalyticsTabKey,
} from "./analytics-tabs";

describe("ANALYTICS_TABS", () => {
  it("exposes the five tabs in display order", () => {
    expect(ANALYTICS_TABS.map((t) => t.key)).toEqual([
      "overview",
      "cost",
      "findings",
      "activity",
      "accuracy",
    ]);
  });

  it("defaults to overview", () => {
    expect(DEFAULT_ANALYTICS_TAB).toBe("overview");
    expect(ANALYTICS_TABS.some((t) => t.key === DEFAULT_ANALYTICS_TAB)).toBe(true);
  });

  it("gives every tab a non-empty label", () => {
    for (const tab of ANALYTICS_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveTab", () => {
  it("returns each valid key unchanged", () => {
    for (const tab of ANALYTICS_TABS) {
      expect(resolveTab(tab.key)).toBe(tab.key);
    }
  });

  it("falls back to the default for unknown values", () => {
    expect(resolveTab("bogus")).toBe(DEFAULT_ANALYTICS_TAB);
    expect(resolveTab("Overview")).toBe(DEFAULT_ANALYTICS_TAB); // case-sensitive
  });

  it("falls back to the default for missing / empty values", () => {
    expect(resolveTab(null)).toBe(DEFAULT_ANALYTICS_TAB);
    expect(resolveTab(undefined)).toBe(DEFAULT_ANALYTICS_TAB);
    expect(resolveTab("")).toBe(DEFAULT_ANALYTICS_TAB);
  });

  it("uses the first entry of a repeated (array) param", () => {
    expect(resolveTab(["cost", "findings"])).toBe("cost");
    expect(resolveTab(["bogus", "cost"])).toBe(DEFAULT_ANALYTICS_TAB);
    expect(resolveTab([])).toBe(DEFAULT_ANALYTICS_TAB);
  });
});

describe("isAnalyticsDataTab", () => {
  it("is true for tabs backed by /api/analytics", () => {
    expect(isAnalyticsDataTab("overview")).toBe(true);
    expect(isAnalyticsDataTab("findings")).toBe(true);
    expect(isAnalyticsDataTab("activity")).toBe(true);
  });

  it("is false for tabs that own their rolling-window selector", () => {
    expect(isAnalyticsDataTab("cost")).toBe(false);
    expect(isAnalyticsDataTab("accuracy")).toBe(false);
  });

  it("classifies every declared tab", () => {
    // Guards against a new tab being added without deciding its filter behaviour.
    const classified: Record<AnalyticsTabKey, boolean> = {
      overview: true,
      cost: false,
      findings: true,
      activity: true,
      accuracy: false,
    };
    for (const tab of ANALYTICS_TABS) {
      expect(isAnalyticsDataTab(tab.key)).toBe(classified[tab.key]);
    }
  });
});
