import { describe, it, expect } from "vitest";
import { normalizeDateParam } from "./date-range";

describe("normalizeDateParam (#337)", () => {
  it("expands a date-only start to the first instant of the UTC day", () => {
    expect(normalizeDateParam("2026-08-16", "start")).toBe("2026-08-16T00:00:00.000Z");
  });

  it("expands a date-only end to the last instant of the UTC day", () => {
    expect(normalizeDateParam("2026-08-16", "end")).toBe("2026-08-16T23:59:59.999Z");
  });

  it("passes full timestamps through untouched, with and without millis", () => {
    // The dashboard UI sends exact instants derived from viewer-local day
    // boundaries — re-widening them would change the selected range.
    expect(normalizeDateParam("2026-08-16T09:31:00.000Z", "end")).toBe("2026-08-16T09:31:00.000Z");
    expect(normalizeDateParam("2026-08-16T09:31:00Z", "start")).toBe("2026-08-16T09:31:00Z");
  });

  it("returns undefined for absent input", () => {
    expect(normalizeDateParam(null, "start")).toBeUndefined();
    expect(normalizeDateParam("", "end")).toBeUndefined();
  });

  it("rejects invalid forms rather than passing them to the store", () => {
    for (const bad of [
      "2026-8-16",              // unpadded
      "16-08-2026",             // wrong order
      "2026-08-16T09:31Z",      // missing seconds
      "2026-08-16T09:31:00",    // missing Z
      "2026-08-16T09:31:00+02:00", // offset form not accepted
      "2026-08-16T09:31:00.1Z", // millis must be exactly 3 digits
      "not-a-date",
      "2026-08-16 09:31:00Z",   // space separator
    ]) {
      expect(normalizeDateParam(bad, "end"), bad).toBeUndefined();
    }
  });

  it("string-compares correctly: the expanded end bound includes every stored timestamp on that day", () => {
    // The #337 defect: '2026-08-16T09:31:00.000Z' <= '2026-08-16' is FALSE,
    // excluding the whole final day. After expansion the comparison holds
    // for any toISOString()-format value on the day, and still excludes the
    // next day.
    const end = normalizeDateParam("2026-08-16", "end")!;
    expect("2026-08-16T09:31:00.000Z" <= end).toBe(true);
    expect("2026-08-16T23:59:59.998Z" <= end).toBe(true);
    expect("2026-08-16T00:00:00.000Z" <= end).toBe(true);
    expect("2026-08-17T00:00:00.000Z" <= end).toBe(false);

    const start = normalizeDateParam("2026-08-16", "start")!;
    expect("2026-08-16T00:00:00.000Z" >= start).toBe(true);
    expect("2026-08-15T23:59:59.999Z" >= start).toBe(false);
  });
});
