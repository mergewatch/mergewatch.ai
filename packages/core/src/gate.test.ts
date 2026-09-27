import { describe, it, expect } from 'vitest';
import {
  buildMergeGate, buildCheckOutcome, reviewEventForGate, formatGateLog,
  ORG_BLOCKED_TITLE_PREFIX, REVIEW_FAILED_CHECK_TITLE, type MergeGate, type GateFinding,
} from './gate.js';

/**
 * #662 — the merge gate, tested as the one definition both runtimes read.
 *
 * The server tests (review-processor.test.ts) hand the processor a gate that
 * contradicts its findings, to prove the output follows the gate. These are
 * their twins: the same titles and summaries, derived here from findings.
 */
const crit = (over: Partial<GateFinding> = {}): GateFinding => ({ severity: 'critical', ...over });
const org = (enforcement: 'advisory' | 'blocking', agent = 'no-todo') => ({ kind: 'org' as const, agent, enforcement });
const repo = (agent = 'house-rule') => ({ kind: 'repo' as const, agent });

const invariants = (g: MergeGate, criticals: number) => {
  expect(g.fails).toBe(g.blockingCriticalCount > 0);
  // Every orgBlockedBy agent is there because of a blocking finding.
  expect(g.orgBlockedBy.length).toBeLessThanOrEqual(g.blockingCriticalCount);
  expect(g.blockingCriticalCount + g.advisoryCriticalCount + g.unverifiedCriticalCount).toBe(criticals);
};

describe('buildMergeGate — one bucket per critical', () => {
  const table: Array<[string, GateFinding, Partial<MergeGate>]> = [
    ['verified built-in fails', crit({ verification: 'verified' }), { fails: true, blockingCriticalCount: 1 }],
    ['untagged built-in fails', crit(), { fails: true, blockingCriticalCount: 1 }],
    ['unverified built-in passes (#240)', crit({ verification: 'unverified' }), { fails: false, unverifiedCriticalCount: 1 }],
    ['untagged repo agent fails', crit({ source: repo() }), { fails: true, blockingCriticalCount: 1 }],
    ['advisory org passes', crit({ source: org('advisory') }), { fails: false, advisoryCriticalCount: 1 }],
    ['verified blocking org fails and names the agent',
      crit({ source: org('blocking'), verification: 'verified' }),
      { fails: true, blockingCriticalCount: 1, orgBlockedBy: ['no-todo'] }],
    ['inconclusive blocking org fails closed (#382)',
      crit({ source: org('blocking'), verification: 'unverified', verificationOutcome: 'inconclusive' }),
      { fails: true, blockingCriticalCount: 1, orgBlockedBy: ['no-todo'] }],
    ['refuted blocking org passes, counted as refuted',
      crit({ source: org('blocking'), verification: 'unverified', verificationOutcome: 'refuted' }),
      { fails: false, unverifiedCriticalCount: 1, refutedOrgBlockingCount: 1 }],
  ];
  for (const [name, f, want] of table) {
    it(name, () => {
      const g = buildMergeGate([f]);
      expect(g).toMatchObject(want);
      invariants(g, 1);
    });
  }

  it('ignores warnings and info', () => {
    const g = buildMergeGate([{ severity: 'warning' }, { severity: 'info', source: org('blocking') }]);
    expect(g).toEqual(buildMergeGate([]));
    invariants(g, 0);
  });

  it('orgBlockedBy and authorWaivedBlocking are distinct and sorted', () => {
    const g = buildMergeGate(
      [crit({ source: org('blocking', 'zeta') }), crit({ source: org('blocking', 'alpha') }), crit({ source: org('blocking', 'zeta') })],
      [crit({ source: org('blocking', 'omega') }), crit({ source: org('blocking', 'beta') }), crit({ source: org('advisory', 'adv') })],
    );
    expect(g.orgBlockedBy).toEqual(['alpha', 'zeta']);
    expect(g.authorWaivedBlocking).toEqual(['beta', 'omega']);
    invariants(g, 3);
  });

  it('every field is present, and none is undefined', () => {
    const g = buildMergeGate([]);
    expect(Object.keys(g).sort()).toEqual([
      'advisoryCriticalCount', 'authorWaivedBlocking', 'blockingCriticalCount', 'fails',
      'orgBlockedBy', 'refutedOrgBlockingCount', 'unverifiedCriticalCount',
    ]);
    expect(Object.values(g).some((v) => v === undefined)).toBe(false);
  });

  it('formatGateLog is one exact line, with empty lists rendered empty', () => {
    expect(formatGateLog(buildMergeGate([]))).toBe(
      '[gate] fails=false blocking=0 advisory=0 unverified=0 refutedOrgBlocking=0 orgBlockedBy= waived=',
    );
    expect(formatGateLog(buildMergeGate(
      [crit({ source: org('blocking') }), crit({ source: org('blocking', 'b') })],
      [crit({ source: org('blocking', 'w') })],
    ))).toBe('[gate] fails=true blocking=2 advisory=0 unverified=0 refutedOrgBlocking=0 orgBlockedBy=b,no-todo waived=w');
  });
});

describe('buildCheckOutcome', () => {
  const base = { mergeScore: 1, findingCount: 0, warningCount: 0, infoCount: 0 };

  it('summary parts in order: critical, advisory, unverified, warning, info, blocked, waived, ignored', () => {
    const gate: MergeGate = {
      fails: true, blockingCriticalCount: 1, advisoryCriticalCount: 2, unverifiedCriticalCount: 3,
      orgBlockedBy: ['a', 'b'], refutedOrgBlockingCount: 0, authorWaivedBlocking: ['w'],
    };
    const out = buildCheckOutcome(gate, {
      ...base, findingCount: 10, warningCount: 4, infoCount: 5, rejectedCustomAgents: ['security', 'bug'],
    });
    expect(out.summary).toBe('Found: 1 critical, 2 advisory, 3 unverified, 4 warning, 5 info, '
      + 'blocked by org agent: a, b, waived by author: w, ignored custom agents (reserved names): security, bug');
    expect(out.conclusion).toBe('failure');
    expect(out.title).toBe('1/5 — Blocked by org agent: a, b');
  });

  it('zero counts with a waiver still says what happened', () => {
    const gate = buildMergeGate([], [crit({ source: org('blocking') })]);
    expect(buildCheckOutcome(gate, base).summary).toBe('Found: waived by author: no-todo');
  });

  it('nothing to report → the clean summary', () => {
    expect(buildCheckOutcome(buildMergeGate([]), base).summary).toBe('No issues detected in this PR.');
  });

  // Twins of the server tests that now read a contradicting gate.
  it('two blocking criticals → failure, "2 critical issues found"', () => {
    const out = buildCheckOutcome(buildMergeGate([crit(), crit()]), { ...base, findingCount: 2 });
    expect(out).toEqual({ conclusion: 'failure', title: '1/5 — 2 critical issues found', summary: 'Found: 2 critical' });
  });

  it('one blocking critical → singular "issue"', () => {
    expect(buildCheckOutcome(buildMergeGate([crit()]), { ...base, mergeScore: 2, findingCount: 1 }).title)
      .toBe('2/5 — 1 critical issue found');
  });

  it('warnings and info only → success, "(no blocking critical)"', () => {
    const out = buildCheckOutcome(buildMergeGate([{ severity: 'warning' }, { severity: 'info' }]),
      { ...base, mergeScore: 4, findingCount: 2, warningCount: 1, infoCount: 1 });
    expect(out).toEqual({
      conclusion: 'success', title: '4/5 — 2 findings (no blocking critical)', summary: 'Found: 1 warning, 1 info',
    });
  });

  it('no findings → "Looks good to me"', () => {
    const out = buildCheckOutcome(buildMergeGate([]), { ...base, mergeScore: 5 });
    expect(out).toEqual({ conclusion: 'success', title: '5/5 — Looks good to me', summary: 'No issues detected in this PR.' });
  });

  it('verified + unverified → fails on one, discloses the other', () => {
    const out = buildCheckOutcome(buildMergeGate([crit({ verification: 'verified' }), crit({ verification: 'unverified' })]),
      { ...base, mergeScore: 2, findingCount: 2 });
    expect(out.conclusion).toBe('failure');
    expect(out.title).toBe('2/5 — 1 critical issue found');
    expect(out.summary).toBe('Found: 1 critical, 1 unverified');
  });
});

describe('reviewEventForGate', () => {
  const clean = buildMergeGate([]);
  const blocked = buildMergeGate([crit({ source: org('blocking') })]);
  const refuted = buildMergeGate([crit({ source: org('blocking'), verificationOutcome: 'refuted', verification: 'unverified' })]);
  const failsNoOrg = buildMergeGate([crit()]);
  const byScore: Record<number, string> = { 1: 'REQUEST_CHANGES', 2: 'REQUEST_CHANGES', 3: 'COMMENT', 4: 'APPROVE', 5: 'APPROVE' };

  for (const score of [1, 2, 3, 4, 5]) {
    it(`score ${score}: org-blocked → REQUEST_CHANGES whatever the score`, () => {
      expect(reviewEventForGate(blocked, score)).toBe('REQUEST_CHANGES');
    });
    it(`score ${score}: refuted blocking critical never APPROVEs`, () => {
      expect(reviewEventForGate(refuted, score)).toBe(byScore[score] === 'APPROVE' ? 'COMMENT' : byScore[score]);
    });
    it(`score ${score}: clean gate → the score's event`, () => {
      expect(reviewEventForGate(clean, score)).toBe(byScore[score]);
    });
    it(`score ${score}: failing gate without an org block → the score's event (#640 changes this)`, () => {
      expect(reviewEventForGate(failsNoOrg, score)).toBe(byScore[score]);
    });
  }
});

describe('title constants', () => {
  it('match the literals main writes', () => {
    expect(ORG_BLOCKED_TITLE_PREFIX).toBe('Blocked by org agent');
    expect(REVIEW_FAILED_CHECK_TITLE).toBe('Review failed');
    // buildCheckTitle renders the prefix it names.
    expect(buildCheckOutcome(buildMergeGate([crit({ source: org('blocking') })]), {
      findingCount: 1, warningCount: 0, infoCount: 0,
    }).title.startsWith(ORG_BLOCKED_TITLE_PREFIX)).toBe(true);
  });
});
