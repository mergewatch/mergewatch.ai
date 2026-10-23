import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

// #718 review — a failed GET must not read as "no areas": the next save would
// replace the stored set and wipe the org's areas. There is no route or
// component harness in the dashboard, so both halves are pinned by source.
describe("a failed read never looks like an empty set", () => {
  const route = readFileSync(new URL("../app/api/safety-areas/route.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../components/SafetyAreasManager.tsx", import.meta.url), "utf8");

  it("GET logs the read failure and answers 500, not 200 with areas: []", () => {
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
    const readCatch = get.slice(get.lastIndexOf("} catch"));
    expect(readCatch).toMatch(/console\.error\(/);
    expect(readCatch).toMatch(/status: 500/);
    expect(readCatch).not.toMatch(/areas: \[\]/);
  });

  it("the manager refuses to edit or save after a failed load", () => {
    expect(manager).toMatch(/setLoadFailed\(true\)/);
    expect(manager).toMatch(/if \(loadFailed\)/);
  });
});
