import { describe, it, expect } from "vitest";
import { DEFAULT_INSTALLATION_SETTINGS } from "@mergewatch/core";
import { readFileSync } from "node:fs";
import { settingsValidationError } from "./settings-validation";

/** A body the dashboard's own form would send. */
const valid = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_INSTALLATION_SETTINGS, ...over });

describe("settingsValidationError — approve (#706)", () => {
  it("rejects a body missing approve: DynamoDB rewrites the whole #SETTINGS map", () => {
    const { approve: _omit, ...missing } = valid();
    expect(settingsValidationError(missing)).toMatch(/approve/);
  });

  it("rejects a non-boolean approve", () => {
    for (const approve of ["true", 1, null]) {
      expect(settingsValidationError(valid({ approve }))).toMatch(/approve/);
    }
  });

  it("accepts true and false", () => {
    expect(settingsValidationError(valid({ approve: true }))).toBeNull();
    expect(settingsValidationError(valid({ approve: false }))).toBeNull();
  });
});

describe("settingsValidationError — existing rules", () => {
  it("rejects a missing body", () => {
    expect(settingsValidationError(undefined)).toBe("Missing settings");
  });
  it("rejects an unknown severityThreshold", () => {
    expect(settingsValidationError(valid({ severityThreshold: "Max" }))).toBe("Invalid severityThreshold");
  });
  it("rejects maxComments outside 1-50", () => {
    expect(settingsValidationError(valid({ maxComments: 0 }))).toBe("maxComments must be 1-50");
    expect(settingsValidationError(valid({ maxComments: 51 }))).toBe("maxComments must be 1-50");
  });
  it("rejects customInstructions over 1000 chars", () => {
    expect(settingsValidationError(valid({ customInstructions: "x".repeat(1001) }))).toBe("customInstructions too long");
  });
});

describe("settingsValidationError — safetyScore (#714)", () => {
  it("rejects a body missing safetyScore: it would be erased on save", () => {
    const { safetyScore: _omit, ...missing } = valid();
    expect(settingsValidationError(missing)).toMatch(/safetyScore/);
  });

  it("rejects safetyScore: {} and a non-boolean enabled", () => {
    expect(settingsValidationError(valid({ safetyScore: {} }))).toMatch(/safetyScore/);
    for (const enabled of ["true", 1, null]) {
      expect(settingsValidationError(valid({ safetyScore: { enabled } }))).toMatch(/safetyScore/);
    }
  });

  it("accepts enabled true and false, alongside approve", () => {
    expect(settingsValidationError(valid({ safetyScore: { enabled: true }, approve: true }))).toBeNull();
    expect(settingsValidationError(valid({ safetyScore: { enabled: false } }))).toBeNull();
  });
});

// The route must call the shared policy, not keep a second, divergent copy.
describe("PUT /api/settings uses the shared policy", () => {
  const route = readFileSync(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  it("calls settingsValidationError and has no inline rule left", () => {
    expect(route).toContain("settingsValidationError(");
    expect(route).not.toContain('"Invalid severityThreshold"');
  });
});
