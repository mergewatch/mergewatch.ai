import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// A failed GET must never look like stored data. Settings answered a failed
// read with 200 + DEFAULT_INSTALLATION_SETTINGS and custom agents with
// 200 + `agents: []`; the editor rendered those as the saved state, and the
// next save replaced the real settings / wiped every org agent. Same defect
// #718's review fixed for safety areas. No route or component harness exists
// in the dashboard, so both halves are pinned by source (as safety-areas.test).
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const getHandler = (route: string) =>
  route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));

describe("/api/settings GET", () => {
  const get = getHandler(src("../app/api/settings/route.ts"));

  it("never answers a failure with the default settings", () => {
    expect(get).not.toMatch(/DEFAULT_INSTALLATION_SETTINGS/);
  });

  it("logs a failed store read and answers 500", () => {
    const readCatch = get.slice(get.lastIndexOf("} catch"));
    expect(readCatch).toMatch(/console\.error\(/);
    expect(readCatch).toMatch(/status: 500/);
  });
});

describe("/api/custom-agents GET", () => {
  const get = getHandler(src("../app/api/custom-agents/route.ts"));

  it("logs a failed store read and answers 500, not 200 with agents: []", () => {
    const readCatch = get.slice(get.lastIndexOf("} catch"));
    expect(readCatch).toMatch(/console\.error\(/);
    expect(readCatch).toMatch(/status: 500/);
    expect(readCatch).not.toMatch(/agents: \[\]/);
  });
});

describe("the editors refuse to edit or save after a failed load", () => {
  for (const file of ["SettingsForm.tsx", "CustomAgentsManager.tsx"]) {
    it(file, () => {
      const c = src(`../components/${file}`);
      expect(c).toMatch(/setLoadFailed\(true\)/);
      expect(c).toMatch(/if \(loadFailed\)/);
    });
  }
});
