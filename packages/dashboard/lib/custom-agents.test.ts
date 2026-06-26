import { describe, it, expect } from "vitest";
import { stampAudit, contentKey } from "./custom-agents";
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
