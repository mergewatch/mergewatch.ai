import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * #576 — the structural half of the pre-release docs audit.
 *
 * Same shape as release-gate.test.ts: assert the properties that carry the
 * reasoning. The property that matters most here is that the checker can
 * FAIL. A docs check that always passes is worse than none, because it makes
 * "nobody looked" and "looked and it was fine" render identically — the exact
 * confusion #576 was filed to remove. So every check class gets a negative
 * test, not just a happy-path one.
 */
const REPO = resolve(__dirname, '../../..');
const SCRIPT = join(REPO, 'scripts/check-docs-structure.mjs');

const run = (cwd: string) => {
  const r = spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/** A minimal but VALID docs tree, so each test perturbs exactly one thing. */
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-struct-'));
  const page = (slug: string, body = '') => {
    const p = join(dir, 'docs-site', `${slug}.mdx`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `---\ntitle: "T"\ndescription: "D"\n---\n\n${body}\n`);
  };
  page('a/one', 'See [two](/a/two).');
  page('a/two');
  writeFileSync(
    join(dir, 'docs-site', 'docs.json'),
    JSON.stringify({ navigation: [{ group: 'G', pages: ['a/one', 'a/two'] }] }),
  );
  return dir;
}

const edit = (dir: string, slug: string, fn: (s: string) => string) => {
  const p = join(dir, 'docs-site', `${slug}.mdx`);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
};

describe('docs structure checker — the checked-in docs are clean', () => {
  it('passes on the real docs-site, so a red run means a real regression', () => {
    const { code, out } = run(REPO);
    expect(out).toContain('Structural checks clean');
    expect(code).toBe(0);
  });

  it('says out loud that a clean structural run proves nothing about accuracy', () => {
    // Without this line the green check reads as "the docs are correct", which
    // is the illusion #576 exists to remove. The agent audit judges truth.
    expect(run(REPO).out).toMatch(/says nothing about whether the content is accurate/i);
  });
});

describe('docs structure checker — every check class can actually fail', () => {
  let dir: string;
  beforeAll(() => { dir = scaffold(); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the scaffold itself is clean, so each failure below is the edit', () => {
    expect(run(dir).code).toBe(0);
  });

  it('flags an internal link that resolves to no page', () => {
    const d = scaffold();
    edit(d, 'a/one', (s) => `${s}\n[dead](/a/nope)\n`);
    const { code, out } = run(d);
    expect(out).toMatch(/link to "\/a\/nope" resolves to no page/);
    expect(code).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it('does not flag a link to a shipped non-page asset', () => {
    // A link to a PDF, spec or download is valid and must not be reported as
    // broken. A structural check that cries wolf is one someone switches off.
    const d = scaffold();
    mkdirSync(join(d, 'docs-site/files'), { recursive: true });
    writeFileSync(join(d, 'docs-site/files/spec.pdf'), 'x');
    edit(d, 'a/one', (s) => `${s}\n[spec](/files/spec.pdf)\n`);
    const { code, out } = run(d);
    expect(out).not.toMatch(/resolves to no page/);
    expect(code).toBe(0);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags a page that exists but is unreachable from the nav', () => {
    const d = scaffold();
    writeFileSync(join(d, 'docs-site/a/ghost.mdx'), '---\ntitle: "T"\ndescription: "D"\n---\n');
    expect(run(d).out).toMatch(/ghost\.mdx: page exists but is unreachable/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags nav entries whose page was deleted', () => {
    const d = scaffold();
    rmSync(join(d, 'docs-site/a/two.mdx'));
    expect(run(d).out).toMatch(/nav lists "a\/two" but no such page exists/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags missing frontmatter keys', () => {
    const d = scaffold();
    edit(d, 'a/two', (s) => s.replace('description:', 'xdescription:'));
    expect(run(d).out).toMatch(/frontmatter missing "description"/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags an <img> pointing at a missing file', () => {
    const d = scaffold();
    edit(d, 'a/two', (s) => `${s}\n<img src="/images/gone.png" />\n`);
    expect(run(d).out).toMatch(/references missing "\/images\/gone\.png"/);
    rmSync(d, { recursive: true, force: true });
  });

  it('flags an image no page references, which is how a stale screenshot lingers', () => {
    // This is the check that caught the five orphaned permission screenshots
    // when the permissions table stopped embedding them.
    const d = scaffold();
    mkdirSync(join(d, 'docs-site/images'), { recursive: true });
    writeFileSync(join(d, 'docs-site/images/orphan.png'), 'x');
    expect(run(d).out).toMatch(/orphan\.png: image is not referenced/);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('docs structure checker — "could not run" is distinguishable from "clean"', () => {
  it('exits 2, not 0, when there is no docs-site to check', () => {
    // Exit 0 here would let a checkout problem read as a clean audit.
    const d = mkdtempSync(join(tmpdir(), 'docs-empty-'));
    const { code, out } = run(d);
    expect(code).toBe(2);
    expect(out).not.toMatch(/clean/);
    rmSync(d, { recursive: true, force: true });
  });

  it('exits 2 when docs.json is missing rather than reporting zero nav findings', () => {
    const d = scaffold();
    rmSync(join(d, 'docs-site/docs.json'));
    expect(run(d).code).toBe(2);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('docs structure checker — wired into per-PR CI', () => {
  const wf = yaml.load(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8')) as any;

  it('runs on pull requests', () => {
    expect(JSON.stringify(wf.jobs.docs)).toContain('check-docs-structure.mjs');
    expect(wf.on.pull_request).toBeTruthy();
  });

  it('is its own job, so a docs failure is not reported as a build failure', () => {
    expect(wf.jobs.docs).toBeTruthy();
    // Assert the build job is present by its real key BEFORE asserting what it
    // does not contain. Renaming it would otherwise leave the second assertion
    // inspecting `undefined`, which passes for the wrong reason — the failure
    // mode this whole file exists to rule out.
    expect(wf.jobs.test, 'the Build & Test job key changed — update this test').toBeTruthy();
    expect(JSON.stringify(wf.jobs.test)).not.toContain('check-docs-structure');
  });
});
