import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #664 — the Lambda handler has no unit harness for a full review, so its
 * wiring is pinned by source: it must use core's helpers, and must not keep
 * the patterns that read an agent or store failure as "nothing to report".
 */
describe('review-agent.ts — #664 wiring (source scan)', () => {
  const src = readFileSync(join(__dirname, 'review-agent.ts'), 'utf8');

  it('reads priors and silence through core', () => {
    expect(src).toContain('runtimePriorView(');
    expect(src).toContain('shouldStaySilent(');
    expect(src).toContain('agentFailures: result.agentFailures');
  });

  it('does not swallow an org-agent store error', () => {
    // One level of nested parens: the call is `.getCustomAgents(String(installationId))`.
    expect(src).not.toMatch(/\.getCustomAgents\((?:[^()]|\([^()]*\))*\)\s*\.catch/);
  });

  it('does not decide silence inline', () => {
    expect(src).not.toMatch(/postSummaryOnClean\s*===\s*false/);
  });
});
