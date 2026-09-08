import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * #576 — the factual half of the pre-release docs audit.
 *
 * The invariants worth protecting are not "does it call the model". They are
 * the three the issue names: it must be able to fail, "clean" and "did not
 * run" must not look alike, and it must say what it could not check. Each is
 * one edit away from being lost, and losing any of them turns the audit into
 * the rubber stamp it was built to replace.
 */
const REPO = resolve(__dirname, '../../..');
const SCRIPT = join(REPO, 'scripts/audit-docs.mjs');
const wf = yaml.load(readFileSync(join(REPO, '.github/workflows/release-gate.yml'), 'utf8')) as any;
const auditStep = JSON.stringify(wf.jobs.audit);

describe('docs audit — wired so a human sees it before the tag', () => {
  it('blocks the release by gating the human approval, not by running after it', () => {
    // If `verify` stops needing `audit`, the approver signs off without ever
    // seeing the findings and the audit becomes decoration.
    expect(wf.jobs.verify.needs).toEqual(expect.arrayContaining(['audit']));
  });

  it('still cannot reach the tag without the human', () => {
    expect(wf.jobs.release.needs).toEqual(expect.arrayContaining(['verify']));
  });

  it('audits the prepared commit, not whatever main happens to be', () => {
    // The gate's core invariant is that what was checked is what gets tagged.
    expect(wf.jobs.audit.needs).toBe('prepare');
    expect(auditStep).toContain('needs.prepare.outputs.sha');
  });

  it('does not take the fixtures concurrency lock', () => {
    // The audit touches no fixtures. Holding that lock would stall every
    // merge's E2E gate for the length of a 64-page audit.
    expect(wf.jobs.audit.concurrency).toBeUndefined();
    expect(auditStep).not.toContain('e2e-fixtures');
  });

  it('has the OIDC permission its Bedrock calls need', () => {
    expect(wf.permissions['id-token']).toBe('write');
  });
});

describe('docs audit — the three outcomes stay distinguishable', () => {
  it('maps each exit code to its own status rather than pass/fail', () => {
    for (const s of ['status=clean', 'status=findings', 'status=failed']) {
      expect(auditStep).toContain(s);
    }
  });

  it('fails the job when the audit could not run', () => {
    // Exit >= 2 means the docs were never checked. Letting that through as a
    // pass is the precise failure every gate in this repo is shaped against.
    expect(auditStep).toMatch(/rc.*-ge.*2/s);
    expect(auditStep).toContain('could not run');
  });

  it('does NOT fail the job merely for having findings', () => {
    // Findings must reach a human. If they failed the job, `verify` would
    // never run and the only way to ship a known-and-accepted finding would
    // be to disable the audit.
    expect(auditStep).not.toMatch(/-ge\s*1\b/);
    expect(auditStep).not.toMatch(/-eq\s*1\b/);
    // and the threshold that DOES fail is 2, not 1
    expect(auditStep).toMatch(/-ge\s*2\b/);
  });

  it('tells the approver which of the three states they are looking at', () => {
    const verify = JSON.stringify(wf.jobs.verify);
    expect(verify).toContain('AUDIT_STATUS');
    expect(verify).toMatch(/did not complete/i);
    expect(verify).toMatch(/not a clean result/i);
  });
});

describe('docs audit — the script itself', () => {
  it('dry-runs without calling the model, and reports its grounding', () => {
    const r = spawnSync('node', [SCRIPT, '--dry-run'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Would audit \d+ page\(s\)/);
    // Grounding is the design: an auditor given only the page confabulates.
    expect(r.stdout).toMatch(/\d+ identifiers, \d+ grounded in source/);
  });

  it('exits 2 — not 0 — when it cannot load the built config', () => {
    // A missing build means no ground truth. Reporting "no findings" then
    // would be an audit that checked nothing and said everything was fine.
    const dir = mkdtempSync(join(tmpdir(), 'audit-nobuild-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs-site'), { recursive: true });
    writeFileSync(join(dir, 'docs-site/x.mdx'), '---\ntitle: "T"\ndescription: "D"\n---\n');
    copyFileSync(SCRIPT, join(dir, 'scripts/audit-docs.mjs'));
    const r = spawnSync('node', [join(dir, 'scripts/audit-docs.mjs')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/AUDIT DID NOT RUN/);
    expect(r.stderr).toMatch(/NOT a clean result/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names its own blind spots in the report template', () => {
    // #576: "It must state what it could not check." A green audit that hides
    // its blind spots is worth less than a red one that names them.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('What this audit did NOT verify');
    for (const blind of ['Screenshots', 'Runnability', 'tone, positioning']) {
      expect(src).toContain(blind);
    }
  });

  it('refuses to report a partial run as complete', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Pages that errored are not silently dropped from the denominator.
    expect(src).toMatch(/failures\.length[\s\S]{0,200}exit\(2\)/);
  });

  it('verifies findings by trying to refute them before reporting any', () => {
    // Measured on the first full run: 11 of 13 criticals were findings whose
    // own evidence did not contradict the text. Instructing the first pass not
    // to do that helped and did not fix it — the same place the review
    // pipeline landed before W2. The refute pass took precision from ~15% to
    // ~80% on the same corpus.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('VERIFY_SYSTEM');
    expect(src).toMatch(/Default to refuted when you are unsure/);
  });

  it('drops a finding whose verification errored rather than promoting it', () => {
    // A verifier that throws leaves the finding UNPROVEN. Keeping it would
    // report an unverified claim as confirmed — the inverse of the audit's
    // whole purpose.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/catch\s*\{[^}]*refuted\+\+/);
  });

  it('reports how many findings were refuted, not just what survived', () => {
    // A reader who sees 5 findings should know whether 5 or 50 were raised.
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/refuted.*\*\*.*upheld/s);
  });

  it('instructs the model that its own priors are not evidence', () => {
    // The failure mode of an LLM auditor is agreeing with plausible prose.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/beliefs about how such a\s*\n?\s*\*?\s*product usually works are NOT evidence/);
  });
});
