import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #660 — no test spawns a subprocess without a timeout.
 *
 * `spawnSync` blocks the event loop, so vitest's timeout cannot interrupt it:
 * a hung child hangs the file, and a slow one fails as "Test timed out in
 * 5000ms", which says nothing about the code under test. Every spawn goes
 * through `test-support/subprocess.ts`, which bounds the child, and every file
 * using it raises its per-test ceiling above the child's.
 *
 * Enforced here rather than by review because the failure is intermittent:
 * an unbounded spawn passes on a quiet machine and flakes on a loaded runner,
 * long after the PR that added it.
 */
const PACKAGES = resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', 'dist', '.next', 'coverage']);
// Split so this file does not match its own rule.
const SPAWN_MODULE = 'child_' + 'process';
const HELPER = /test-support\/subprocess['"]/;
const SET_CONFIG = /vi\.setConfig\(\s*\{\s*testTimeout:\s*SUBPROCESS_TEST_TIMEOUT_MS\s*\}\s*\)/;

export function violations(file: string, src: string): string[] {
  const found: string[] = [];
  if (src.includes(SPAWN_MODULE)) {
    found.push(`${file}: imports ${SPAWN_MODULE} directly; use test-support/subprocess`);
  }
  if (HELPER.test(src) && !SET_CONFIG.test(src)) {
    found.push(`${file}: uses the subprocess helper without vi.setConfig({ testTimeout: SUBPROCESS_TEST_TIMEOUT_MS })`);
  }
  return found;
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('#660 — subprocess hygiene', () => {
  it('no test file spawns without the bounded helper', () => {
    const all = testFiles(PACKAGES).flatMap((p) =>
      violations(relative(PACKAGES, p), readFileSync(p, 'utf8')),
    );
    expect(all).toEqual([]);
  });

  it('flags a file that uses the helper without raising its test timeout', () => {
    const src = "import { runBounded } from './test-support/subprocess';\n";
    expect(violations('x.test.ts', src)).toEqual([
      'x.test.ts: uses the subprocess helper without vi.setConfig({ testTimeout: SUBPROCESS_TEST_TIMEOUT_MS })',
    ]);
  });

  it('accepts a file that uses the helper and raises its test timeout', () => {
    const src = [
      "import { runBounded, SUBPROCESS_TEST_TIMEOUT_MS } from './test-support/subprocess';",
      'vi.setConfig({ testTimeout: SUBPROCESS_TEST_TIMEOUT_MS });',
    ].join('\n');
    expect(violations('x.test.ts', src)).toEqual([]);
  });

  it('flags a direct spawn import', () => {
    expect(violations('y.test.ts', `import { spawnSync } from 'node:${SPAWN_MODULE}';`)).toHaveLength(1);
  });
});
