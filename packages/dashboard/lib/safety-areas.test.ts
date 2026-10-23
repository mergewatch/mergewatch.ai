import { describe, it, expect } from "vitest";
import type { OrgSafetyArea } from "@mergewatch/core";
import { safetyAreasValidationError, stampSafetyAreasAudit } from "./safety-areas";

const area = (over: Partial<OrgSafetyArea> = {}): OrgSafetyArea => ({
  id: "a", patterns: ["p/**"], level: "risky", enabled: true, scope: { mode: "all" }, updatedAt: "old", updatedBy: "alice",
  ...over,
});

describe("safetyAreasValidationError (#718)", () => {
  it("accepts up to 50 areas", () => {
    expect(safetyAreasValidationError({ areas: Array.from({ length: 50 }, (_, i) => area({ id: `a${i}` })) })).toBeNull();
  });
  it("rejects more than 50", () => {
    expect(safetyAreasValidationError({ areas: Array.from({ length: 51 }, (_, i) => area({ id: `a${i}` })) })).toMatch(/At most 50/);
  });
  it("rejects an invalid scope rather than widening it to all repos", () => {
    for (const scope of [{ mode: "some" }, { mode: "selected" }, { mode: "selected", repos: [1] }, "all"]) {
      expect(safetyAreasValidationError({ areas: [{ ...area(), scope }] }), JSON.stringify(scope)).toMatch(/Invalid scope/);
    }
  });
  it("rejects a missing areas[]", () => {
    expect(safetyAreasValidationError({})).toBe("Missing areas[]");
    expect(safetyAreasValidationError(null)).toBe("Missing areas[]");
  });
});

describe("stampSafetyAreasAudit (#718)", () => {
  it("keeps updatedAt/updatedBy on an unchanged area, and stamps a changed or new one", () => {
    const out = stampSafetyAreasAudit(
      [area(), area({ id: "b", level: "caution" }), area({ id: "" })],
      [area(), area({ id: "b" })],
      "bob", "now", () => "new-id",
    );
    expect(out[0]).toMatchObject({ id: "a", updatedAt: "old", updatedBy: "alice" });
    expect(out[1]).toMatchObject({ id: "b", updatedAt: "now", updatedBy: "bob" });
    expect(out[2]).toMatchObject({ id: "new-id", updatedAt: "now", updatedBy: "bob" });
  });
});
