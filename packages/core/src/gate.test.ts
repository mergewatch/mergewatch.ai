import { describe, it, expect } from 'vitest';
import {
  buildMergeGate, buildCheckOutcome, reviewEventForGate, formatGateLog,
  ORG_BLOCKED_TITLE_PREFIX, REVIEW_FAILED_CHECK_TITLE, AGENT_FAILED_TITLE_PREFIX, emptyGate,
  REVIEW_FAILED_PREFIX, reviewFailedCheckOutput,
  failedAgentPriors, runtimePriorView, shouldStaySilent,
  type MergeGate, type GateFinding, type CustomAgentFailure,
} from './gate.js';
import { escapeUserContent } from './comment-formatter.js';
import { mergeScoreToReviewEvent, withdrawnThreadKey } from './github/client.js';

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
  // #664 amends #662's first invariant: a failed gating agent also fails it.
  expect(g.fails).toBe(g.blockingCriticalCount > 0 || g.failedGatingAgents.length > 0);
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
      'advisoryCriticalCount', 'authorWaivedBlocking', 'blockingCriticalCount',
      'failedAdvisoryAgents', 'failedGatingAgents', 'fails',
      'orgBlockedBy', 'refutedOrgBlockingCount', 'unverifiedCriticalCount',
    ]);
    expect(g).toEqual(emptyGate());
    expect(Object.values(g).some((v) => v === undefined)).toBe(false);
  });

  it('formatGateLog is one exact line, with empty lists rendered empty', () => {
    expect(formatGateLog(buildMergeGate([]))).toBe(
      '[gate] fails=false blocking=0 advisory=0 unverified=0 refutedOrgBlocking=0 orgBlockedBy= waived= failedGating= failedAdvisory=',
    );
    expect(formatGateLog(buildMergeGate(
      [crit({ source: org('blocking') }), crit({ source: org('blocking', 'b') })],
      [crit({ source: org('blocking', 'w') })],
    ))).toBe('[gate] fails=true blocking=2 advisory=0 unverified=0 refutedOrgBlocking=0 orgBlockedBy=b,no-todo waived=w'
      + ' failedGating= failedAdvisory=');
  });
});

describe('buildCheckOutcome', () => {
  const base = { mergeScore: 1, findingCount: 0, warningCount: 0, infoCount: 0 };

  it('summary parts in order: critical, advisory, unverified, warning, info, blocked, waived, ignored', () => {
    const gate: MergeGate = {
      ...emptyGate(),
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

// ─── #664 — a failing custom agent fails the gate closed ───────────────────

const G: CustomAgentFailure = { agent: 'no-todo', source: { kind: 'org', agent: 'no-todo', enforcement: 'blocking' }, reason: 'error' };
const fail = (agent: string, over: Partial<CustomAgentFailure> = {}): CustomAgentFailure =>
  ({ agent, source: { kind: 'org', agent, enforcement: 'blocking' }, reason: 'error', ...over });
const advisoryFail = (agent: string): CustomAgentFailure =>
  ({ agent, source: { kind: 'org', agent, enforcement: 'advisory' }, reason: 'error' });

describe('#664 — buildMergeGate with agent failures', () => {
  it('a failed gating agent fails the gate and is in no bucket', () => {
    const g = buildMergeGate([], [], [G]);
    expect(g).toEqual({ ...emptyGate(), fails: true, failedGatingAgents: ['no-todo'] });
    invariants(g, 0);
  });

  it('a failed repo agent gates; a failed advisory org agent does not', () => {
    const repo = buildMergeGate([], [], [{ agent: 'house-rule', source: { kind: 'repo', agent: 'house-rule' }, reason: 'degenerate' }]);
    expect(repo).toMatchObject({ fails: true, failedGatingAgents: ['house-rule'] });
    const adv = buildMergeGate([], [], [advisoryFail('style-guide')]);
    expect(adv).toEqual({ ...emptyGate(), failedAdvisoryAgents: ['style-guide'] });
    invariants(repo, 0);
    invariants(adv, 0);
  });

  it('a malformed source fails closed: it gates', () => {
    const odd = { agent: 'odd', source: { kind: 'team', agent: 'odd' }, reason: 'error' } as unknown as CustomAgentFailure;
    const noEnforcement = { agent: 'bare', source: { kind: 'org', agent: 'bare' }, reason: 'error' } as unknown as CustomAgentFailure;
    expect(buildMergeGate([], [], [odd, noEnforcement])).toMatchObject({ fails: true, failedGatingAgents: ['bare', 'odd'], failedAdvisoryAgents: [] });
  });

  it('failure lists are distinct and sorted, and a failed agent is never in orgBlockedBy', () => {
    const g = buildMergeGate([crit({ source: org('blocking', 'x') })], [], [fail('zeta'), fail('alpha'), fail('zeta'), advisoryFail('b'), advisoryFail('a')]);
    expect(g.failedGatingAgents).toEqual(['alpha', 'zeta']);
    expect(g.failedAdvisoryAgents).toEqual(['a', 'b']);
    expect(g.orgBlockedBy).toEqual(['x']);
    invariants(g, 1);
  });

  it('formatGateLog ends with the failure lists', () => {
    expect(formatGateLog(buildMergeGate([], [], [G]))).toBe(
      '[gate] fails=true blocking=0 advisory=0 unverified=0 refutedOrgBlocking=0 orgBlockedBy= waived= failedGating=no-todo failedAdvisory=',
    );
  });
});

describe('#664 — buildCheckOutcome with agent failures', () => {
  const base = { mergeScore: 5, findingCount: 0, warningCount: 0, infoCount: 0 };
  const out = (failures: CustomAgentFailure[], over: Partial<typeof base> = {}, findings: GateFinding[] = []) =>
    buildCheckOutcome(buildMergeGate(findings, [], failures), { ...base, ...over, agentFailures: failures });

  it('(pin) [] or omitted agentFailures gives #662\'s output on every row', () => {
    const rows: Array<[GateFinding[], Partial<typeof base>]> = [
      [[], {}], [[crit()], { mergeScore: 2, findingCount: 1 }],
      [[{ severity: 'warning' }], { mergeScore: 4, findingCount: 1, warningCount: 1 }],
      [[crit({ source: org('blocking') })], { mergeScore: 1, findingCount: 1 }],
      [[crit({ source: org('advisory') })], { mergeScore: 4, findingCount: 1 }],
    ];
    for (const [findings, over] of rows) {
      const gate = buildMergeGate(findings);
      const omitted = buildCheckOutcome(gate, { ...base, ...over });
      expect(buildCheckOutcome(gate, { ...base, ...over, agentFailures: [] })).toEqual(omitted);
      expect(omitted.summary).not.toMatch(/custom agent|agents that ran/i);
    }
    expect(buildCheckOutcome(buildMergeGate([]), base).summary).toBe('No issues detected in this PR.');
  });

  it('G, 0 findings, score 5 → failure titled with the agent', () => {
    expect(out([G])).toMatchObject({ conclusion: 'failure', title: `5/5 — ${AGENT_FAILED_TITLE_PREFIX}: no-todo` });
  });

  it('G → the exact summary', () => {
    expect(out([G]).summary).toBe(
      'No findings from the agents that ran.\n\n'
      + 'A custom agent failed, so its policy was not evaluated and this check fails: no\\-todo (org, blocking).\n\n'
      + 'Re-run the check to retry.',
    );
  });

  const long = 'a-very-long-agent-name-that-goes-well-past-forty-characters!';
  it('four gating failures: three raw names in the title (long one truncated), then "and 1 more"', () => {
    expect(long).toHaveLength(60);
    const o = out([fail('b-one'), fail('c-two'), fail(long), fail('z-four')]);
    const cut = `${long.slice(0, 39)}…`;
    expect(o.title).toBe(`5/5 — Custom agent failed: ${cut}, b-one, c-two and 1 more`);
  });

  it('the summary names every failure, escaped and truncated, with no cap', () => {
    const o = out([fail('b-one'), fail('c-two'), fail(long), fail('z-four')]);
    expect(o.summary).toContain(`${escapeUserContent(`${long.slice(0, 39)}…`)} (org, blocking)`);
    expect(o.summary).toContain('4 custom agents failed, so their policies were not evaluated and this check fails: ');
    expect(o.summary).toContain(`${escapeUserContent('z-four')} (org, blocking)`);
  });

  it('an unparseable answer → the prompt-and-model retry', () => {
    expect(out([{ ...G, reason: 'unparseable' }]).summary.endsWith("Re-run; if it persists, check the agent's prompt and model.")).toBe(true);
  });

  it('advisory failure only → success, disclosed, no gating sentence', () => {
    const o = out([advisoryFail('style-guide')]);
    expect(o.conclusion).toBe('success');
    expect(o.title).toBe('5/5 — Looks good to me');
    expect(o.summary).toBe('No findings from the agents that ran.\n\nAdvisory org agent failed (does not affect this check): style\\-guide (org, advisory).');
  });

  it('title precedence: org block, then criticals, then the failure', () => {
    expect(out([G], { mergeScore: 1, findingCount: 1 }, [crit({ source: org('blocking', 'other') })]).title)
      .toBe('1/5 — Blocked by org agent: other');
    expect(out([G], { mergeScore: 2, findingCount: 1 }, [crit()]).title).toBe('2/5 — 1 critical issue found');
    expect(out([G], { mergeScore: 4, findingCount: 1, warningCount: 1 }, [{ severity: 'warning' }]).title)
      .toBe('4/5 — Custom agent failed: no-todo');
  });

  it('with findings, the Found line leads and the failure follows', () => {
    const o = out([G], { mergeScore: 4, findingCount: 1, warningCount: 1 }, [{ severity: 'warning' }]);
    expect(o.summary.split('\n\n')[0]).toBe('Found: 1 warning');
  });
});

describe('#664 — reviewEventForGate with a failed gating agent', () => {
  const failed = buildMergeGate([], [], [G]);
  for (const score of [4, 5]) {
    it(`score ${score} → COMMENT, never APPROVE`, () => {
      expect(reviewEventForGate(failed, score)).toBe('COMMENT');
    });
  }
  it('(pin) scores 1-2 → REQUEST_CHANGES, 3 → COMMENT', () => {
    expect([1, 2, 3].map((s) => reviewEventForGate(failed, s))).toEqual(['REQUEST_CHANGES', 'REQUEST_CHANGES', 'COMMENT']);
  });
  it('(pin) an advisory failure leaves the score\'s event', () => {
    const adv = buildMergeGate([], [], [advisoryFail('a')]);
    for (const s of [1, 2, 3, 4, 5]) expect(reviewEventForGate(adv, s)).toBe(mergeScoreToReviewEvent(s));
  });
  it('(pin) org block + failure → REQUEST_CHANGES, org-block title', () => {
    const g = buildMergeGate([crit({ source: org('blocking', 'other') })], [], [G]);
    expect(reviewEventForGate(g, 5)).toBe('REQUEST_CHANGES');
    expect(buildCheckOutcome(g, { mergeScore: 5, findingCount: 1, warningCount: 0, infoCount: 0, agentFailures: [G] }).title)
      .toBe('5/5 — Blocked by org agent: other');
  });
});

describe('#664 — priors of failed agents', () => {
  const P = { title: 'PRIOR', category: 'no-todo', severity: 'critical', file: 'foo.ts', line: 3 };

  it('matches a sourced prior by kind and name, whatever its enforcement', () => {
    const sourced = { ...P, source: { kind: 'org' as const, agent: 'no-todo', enforcement: 'advisory' as const } };
    expect(failedAgentPriors([sourced], [G])).toEqual([sourced]);
  });
  it('matches a legacy prior by category', () => {
    expect(failedAgentPriors([P], [G])).toEqual([P]);
  });
  it('never matches a legacy prior filed under a built-in category', () => {
    const sec = { ...P, category: 'security' };
    expect(failedAgentPriors([sec], [fail('security')])).toEqual([]);
  });
  it('a repo failure does not withhold an org agent\'s sourced prior of the same name', () => {
    const orgPrior = { ...P, source: { kind: 'org' as const, agent: 'no-todo', enforcement: 'blocking' as const } };
    expect(failedAgentPriors([orgPrior], [{ agent: 'no-todo', source: { kind: 'repo', agent: 'no-todo' }, reason: 'error' }])).toEqual([]);
  });
  it('runtimePriorView withholds them and keeps their thread keys', () => {
    const other = { ...P, title: 'Other', category: 'bug' };
    expect(runtimePriorView([P, other], [G])).toEqual({ priors: [other], withheldThreadKeys: [withdrawnThreadKey('foo.ts', 'PRIOR')] });
    expect(runtimePriorView(undefined, [G])).toEqual({ priors: [], withheldThreadKeys: [] });
  });
});

describe('#664 — shouldStaySilent', () => {
  const clean = { findingCount: 0, agentFailures: [], postSummaryOnClean: false, existingCommentId: undefined };
  it('(pin) #350: silent only when clean, opted out, and no comment exists', () => {
    expect(shouldStaySilent(clean)).toBe(true);
    expect(shouldStaySilent({ ...clean, findingCount: 1 })).toBe(false);
    expect(shouldStaySilent({ ...clean, postSummaryOnClean: true })).toBe(false);
    expect(shouldStaySilent({ ...clean, postSummaryOnClean: undefined })).toBe(false);
    expect(shouldStaySilent({ ...clean, existingCommentId: 7 })).toBe(false);
  });
  it('a gating failure breaks the silence; an advisory one does not', () => {
    expect(shouldStaySilent({ ...clean, agentFailures: [G] })).toBe(false);
    expect(shouldStaySilent({ ...clean, agentFailures: [advisoryFail('a')] })).toBe(true);
  });
});

describe('#659 — reviewFailedCheckOutput', () => {
  it('an Error → the title constant and the prefixed message', () => {
    expect(reviewFailedCheckOutput(new Error('x'))).toEqual({ title: REVIEW_FAILED_CHECK_TITLE, summary: `${REVIEW_FAILED_PREFIX}x` });
  });
  it('a non-Error throw → "Unknown error"', () => {
    expect(reviewFailedCheckOutput('boom').summary).toBe(`${REVIEW_FAILED_PREFIX}Unknown error`);
    expect(reviewFailedCheckOutput(undefined).summary).toBe(`${REVIEW_FAILED_PREFIX}Unknown error`);
  });
  it('(pin) the prefix is the literal the grader keys on', () => {
    expect(REVIEW_FAILED_PREFIX).toBe('MergeWatch encountered an error: ');
  });
});
