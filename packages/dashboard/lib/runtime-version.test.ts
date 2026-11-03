import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { logRuntimeVersion } from "./runtime-version";

// #779 — the only way to observe which Node serves Amplify SSR is this line in
// the compute logs, so it must fire on the Node runtime and only there.
describe("logRuntimeVersion", () => {
  const original = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = original;
  });

  const capture = () => {
    const lines: string[] = [];
    logRuntimeVersion((l) => lines.push(l));
    return lines;
  };

  it("logs process.version once on the nodejs runtime", () => {
    process.env.NEXT_RUNTIME = "nodejs";
    expect(capture()).toEqual([`[mergewatch] dashboard server runtime: node ${process.version}`]);
  });

  it("logs nothing on the edge runtime", () => {
    process.env.NEXT_RUNTIME = "edge";
    expect(capture()).toEqual([]);
  });

  it("logs nothing when NEXT_RUNTIME is unset (not a Next server)", () => {
    delete process.env.NEXT_RUNTIME;
    expect(capture()).toEqual([]);
  });

  it("is wired into Next's instrumentation register()", () => {
    const src = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export function register\(\)\s*\{\s*logRuntimeVersion\(\);/);
  });
});
