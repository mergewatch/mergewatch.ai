import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * #601 — guards on the subscription-drift check itself.
 *
 * The check compares two lists that live in different systems: the `case`
 * labels `webhook.ts` dispatches on, and the events the App is actually
 * subscribed to. Only the first is in this repo.
 *
 * That asymmetry is the whole value, and it is the thing most likely to be
 * quietly removed. A version comparing the dispatch cases to a hardcoded list
 * in this repo would pass today — while `check_suite` and `installation` are
 * dispatched and unsubscribed in production — and would catch nothing ever.
 * These tests exist to make that regression loud.
 */
const REPO = resolve(__dirname, '../../..');
const SCRIPT = join(REPO, 'scripts/check-app-subscriptions.mjs');
const src = readFileSync(SCRIPT, 'utf8');

describe('subscription drift — the check reads LIVE state, not the repo', () => {
  it('asks GitHub what the App is subscribed to', () => {
    // If this ever becomes a constant in the repo, the check is theatre.
    expect(src).toContain('https://api.github.com/app');
    expect(src).toMatch(/app\.events/);
  });

  it('authenticates as the App, which is the only way to read its events', () => {
    expect(src).toContain('RSA-SHA256');
    expect(src).toMatch(/github-private-key/);
  });

  it('derives the dispatched list from webhook.ts rather than restating it', () => {
    expect(src).toContain('packages/lambda/src/handlers/webhook.ts');
    expect(src).toMatch(/case "\(\[a-z_\]\+\)":/);
  });

  it('has no hardcoded expected-events list to compare against', () => {
    // The failure mode this file exists to prevent: a literal array of event
    // names that makes the check self-referential.
    const literals = src.match(/'(check_suite|installation|pull_request)'/g) ?? [];
    // The only permitted mention is inside the documented other-channel map.
    const inExemption = src.slice(src.indexOf('OTHER_CHANNEL'), src.indexOf('/* ── compare'));
    for (const lit of literals) {
      expect(inExemption.includes(lit), `${lit} appears outside the exemption map`).toBe(true);
    }
  });
});

describe('subscription drift — outcomes stay distinguishable', () => {
  it('exits 2 when it cannot check, and says that is not a pass', () => {
    const r = spawnSync('node', [SCRIPT, '--stage', 'definitely-not-a-stage'], {
      cwd: REPO, encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/not a pass/i);
  });

  it('treats only missing subscriptions as drift, not extra ones', () => {
    // A subscribed event we do not handle is answered 200 and ignored. Calling
    // that drift would make the check red for a non-defect, and a permanently
    // red check is one people stop reading.
    expect(src).toMatch(/harmless/);
    expect(src).toMatch(/missing\s*=\s*dispatched\.filter/);
  });

  it('every other-channel exemption carries a reason', () => {
    const map = src.slice(src.indexOf('const OTHER_CHANNEL'), src.indexOf('/* ── compare'));
    const entries = [...map.matchAll(/\['([a-z_]+)',\s*'([^']+)'\]/g)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, event, reason] of entries) {
      expect(reason.length, `${event} exemption has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('subscription drift — wired where it will actually be seen', () => {
  const wf = yaml.load(
    readFileSync(join(REPO, '.github/workflows/release-gate.yml'), 'utf8'),
  ) as any;
  const step = wf.jobs.audit.steps.find((s: any) =>
    typeof s.name === 'string' && s.name.includes('subscription drift'));

  it('runs in the release gate, before a release is cut', () => {
    expect(step, 'no subscription-drift step in the audit job').toBeTruthy();
    expect(JSON.stringify(step)).toContain('check-app-subscriptions.mjs');
  });

  it('reports without blocking, and says which of the three outcomes it saw', () => {
    expect(step['continue-on-error']).toBe(true);
    const run = step.run as string;
    for (const s of ['Every event', 'Drift', 'Could not check']) expect(run).toContain(s);
  });
});
