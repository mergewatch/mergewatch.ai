import { describe, it, expect } from "vitest";
import { stampAudit, contentKey, reservedNameViolations, annotateNameCollisions } from "./custom-agents";
import type { OrgCustomAgent } from "@mergewatch/core";

function agent(over: Partial<OrgCustomAgent> = {}): OrgCustomAgent {
  return {
    id: "a1",
    name: "No console.log",
    prompt: "Flag console.log.",
    severityDefault: "warning",
    enforcement: "advisory",
    enabled: true,
    scope: { mode: "all" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "alice",
    ...over,
  };
}

const NOW = "2026-06-25T12:00:00.000Z";

describe("stampAudit", () => {
  it("assigns ids to new agents and stamps the editor", () => {
    let n = 0;
    const out = stampAudit([agent({ id: "" })], [], "bob", NOW, () => `gen-${++n}`);
    expect(out[0].id).toBe("gen-1");
    expect(out[0].updatedAt).toBe(NOW);
    expect(out[0].updatedBy).toBe("bob");
  });

  it("preserves prior audit metadata for an unchanged agent", () => {
    const existing = [agent()];
    const out = stampAudit([agent()], existing, "bob", NOW);
    expect(out[0].updatedBy).toBe("alice"); // unchanged → keep original editor
    expect(out[0].updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("re-stamps an agent whose content changed", () => {
    const existing = [agent()];
    const out = stampAudit([agent({ prompt: "Flag console.error too." })], existing, "bob", NOW);
    expect(out[0].updatedBy).toBe("bob");
    expect(out[0].updatedAt).toBe(NOW);
  });

  it("treats a scope change as an edit", () => {
    const existing = [agent()];
    const out = stampAudit(
      [agent({ scope: { mode: "selected", repos: ["o/a"] } })],
      existing,
      "bob",
      NOW,
    );
    expect(out[0].updatedBy).toBe("bob");
  });
});

describe("contentKey", () => {
  it("is stable across audit-only differences", () => {
    expect(contentKey(agent({ updatedBy: "x", updatedAt: "y" }))).toBe(
      contentKey(agent({ updatedBy: "z", updatedAt: "w" })),
    );
  });
  it("differs when a meaningful field changes", () => {
    expect(contentKey(agent())).not.toBe(contentKey(agent({ enforcement: "blocking" })));
  });
});

describe("reservedNameViolations (#662)", () => {
  const storedBug = agent({ id: "s1", name: "bug" });

  it("flags a new agent named after a built-in category", () => {
    expect(reservedNameViolations([{ id: "", name: "bug" }], [])).toEqual(["bug"]);
  });

  it("matches the trimmed name", () => {
    expect(reservedNameViolations([{ id: "", name: " bug " }], [])).toEqual(["bug"]);
  });

  it("flags a reserved name under an id that is not stored", () => {
    expect(reservedNameViolations([{ id: "unknown", name: "bug" }], [storedBug])).toEqual(["bug"]);
  });

  it("flags a rename to a reserved name", () => {
    expect(reservedNameViolations([{ id: "a1", name: "bug" }], [agent({ id: "a1", name: "No console.log" })])).toEqual(["bug"]);
  });

  it("lets an unchanged stored agent keep its reserved name", () => {
    expect(reservedNameViolations([{ ...storedBug }], [storedBug])).toEqual([]);
  });

  it("is case-sensitive: Bug is not reserved", () => {
    expect(reservedNameViolations([{ id: "", name: "Bug" }], [])).toEqual([]);
  });

  it("ignores entries sanitizing would drop anyway", () => {
    expect(reservedNameViolations([null, 3, { name: 7 }, { id: "", name: "perf" }], [])).toEqual([]);
  });

  it("names every offender", () => {
    expect(reservedNameViolations([{ name: "security" }, { name: "style" }], [])).toEqual(["security", "style"]);
  });
});

describe("annotateNameCollisions (#662)", () => {
  it("marks only reserved names", () => {
    const out = annotateNameCollisions([agent({ id: "a", name: "bug" }), agent({ id: "b", name: "perf" }), agent({ id: "c", name: "Bug" })]);
    expect(out.map((a) => "nameCollision" in a)).toEqual([true, false, false]);
    expect(out[0].nameCollision).toBe(true);
  });
});
