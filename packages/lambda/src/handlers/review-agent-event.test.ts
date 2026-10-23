import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { payloadFromEvent, attemptFromEvent, rateLimitedCheckSummary } from './review-agent-event.js';

const job = { installationId: 1, owner: 'octo', repo: 'repo', prNumber: 7, mode: 'review' as const };

describe('payloadFromEvent (#355)', () => {
  it('passes a direct-invoke payload through untouched', () => {
    expect(payloadFromEvent(job as any)).toEqual(job);
  });

  it('unwraps a single SQS record body', () => {
    expect(payloadFromEvent({ Records: [{ body: JSON.stringify(job) }] })).toEqual(job);
  });

  it('fails loudly on batch-size drift instead of silently dropping PRs', () => {
    expect(() => payloadFromEvent({ Records: [] })).toThrow('Expected exactly 1 SQS record');
    expect(() => payloadFromEvent({
      Records: [{ body: JSON.stringify(job) }, { body: JSON.stringify(job) }],
    })).toThrow('got 2');
  });

  it('throws on an unparseable record body (goes to redrive, then DLQ)', () => {
    expect(() => payloadFromEvent({ Records: [{ body: 'not-json' }] })).toThrow();
  });
});

describe('attemptFromEvent (#370)', () => {
  it('reads the SQS ApproximateReceiveCount', () => {
    expect(attemptFromEvent({
      Records: [{ body: JSON.stringify(job), attributes: { ApproximateReceiveCount: '2' } }],
    })).toBe(2);
  });

  it('defaults to 1 for direct invokes and missing/garbage attributes', () => {
    expect(attemptFromEvent(job as any)).toBe(1);
    expect(attemptFromEvent({ Records: [{ body: '{}' }] })).toBe(1);
    expect(attemptFromEvent({
      Records: [{ body: '{}', attributes: { ApproximateReceiveCount: 'NaN' } }],
    })).toBe(1);
  });
});

describe('rateLimitedCheckSummary (#370)', () => {
  it('carries attempt, parked-at time, retry expectations, and the DLQ end-state', () => {
    const s = rateLimitedCheckSummary(2, '2026-08-18T01:35:13.000Z');
    expect(s).toContain('Attempt 2 of 3');
    expect(s).toContain('parked at 2026-08-18T01:35:13.000Z');
    expect(s).toContain('retries automatically');
    expect(s).toContain('dead-lettered');
  });

  it('promises automatic redrive, not manual operator rescue (#398)', () => {
    // The DLQ used to be a terminal resting place that only an operator could
    // empty; the sweeper made that copy a lie.
    const s = rateLimitedCheckSummary(3, '2026-08-19T19:31:56.000Z');
    expect(s).toContain('automatically re-driven');
    expect(s).not.toContain('operator redrive');
  });
});

// ---------------------------------------------------------------------------
// #639 — every check-run write in the review agent goes through ONE writer
// ---------------------------------------------------------------------------

describe('the review agent has a single check-run write path (#639)', () => {
  // There is no handler harness for review-agent.ts (it wires a dozen AWS and
  // GitHub clients at module scope), so the guard is a source scan. It is not a
  // substitute for behavioural coverage — client.test.ts owns that — but it is
  // what stops the next call site from quietly reintroducing the bug: a bare
  // createCheckRun does not carry the re-run key, so its write lands on the
  // PREVIOUS review's completed run and branch protection keeps the old verdict.
  const src = readFileSync(
    new URL('./review-agent.ts', import.meta.url),
    'utf8',
  );

  it('binds exactly one writer, to the PR head it actually reviews', () => {
    expect(src.match(/makeCheckRunWriter\(/g)).toHaveLength(1);
    // prContext.headSha, not event.headSha: a key looked up against the event's
    // (possibly older) SHA finds nothing and creates a spurious run.
        // Whitespace-insensitive: the previous regex pinned an exact multi-line
    // layout, so any formatter reflowing the argument object would fail this
    // test for a reason unrelated to what it checks.
    for (const tok of ['makeCheckRunWriter', 'octokit', 'owner', 'repo',
                       'headSha', 'stage: STAGE', 'checkRunKey: event.checkRunKey']) {
      expect(src).toContain(tok);
    }
  });

  it('no call site bypasses it — zero direct createCheckRun calls remain', () => {
    // Every one of the eight writes (skip, billing block, in-progress, rules
    // skip, over-budget, completion, throttle-parked, failure) must route
    // through the writer.
    expect(src).not.toMatch(/\bcreateCheckRun\(/);
    expect(src.match(/\bwriteCheckRun\(/g)).toHaveLength(7);
    // The eighth is the billing block, which hands the writer to @mergewatch/billing.
    expect(src).toMatch(/postBlockedCheckRun\([^)]*blockVariant, \{\s*\n\s*stage: STAGE, write: writeCheckRun,/);
  });
});

/**
 * #662 — the Lambda handler reads the gate from the pipeline. It has no
 * handler-level harness, so the guard is a source scan: none of the inline
 * gate computations may come back, and the core derivations must be used.
 */
/**
 * #707 — both runtimes dismiss through the one core entry point, so neither can
 * re-introduce the `commentId` guard that skipped dismissal on silent PRs.
 */
describe('both runtimes dismiss through dismissOwnStaleReviews (#707)', () => {
  for (const [name, url] of [
    ['review-agent.ts', new URL('./review-agent.ts', import.meta.url)],
    ['review-processor.ts', new URL('../../../server/src/review-processor.ts', import.meta.url)],
  ] as const) {
    it(name, () => {
      const src = readFileSync(url, 'utf8');
      expect(src, `${name} lacks dismissOwnStaleReviews(`).toContain('dismissOwnStaleReviews(');
      for (const banned of ['resolveAppLogin(', 'dismissStaleReviews(']) {
        expect(src, `${name} still contains ${banned}`).not.toContain(banned);
      }
    });
  }
});

/**
 * #706 — approve comes only from the default branch. Both runtimes resolve it
 * through core's `resolveApproveForRepo`, which takes no ref; a runtime that
 * read `config.approve` (merged from the PR head) would let a PR approve itself.
 */
describe('both runtimes resolve approve through resolveApproveForRepo (#706)', () => {
  for (const [name, url] of [
    ['review-agent.ts', new URL('./review-agent.ts', import.meta.url)],
    ['review-processor.ts', new URL('../../../server/src/review-processor.ts', import.meta.url)],
  ] as const) {
    it(name, () => {
      const src = readFileSync(url, 'utf8');
      for (const required of ['resolveApproveForRepo(', 'shouldSubmitFormalReview(']) {
        expect(src, `${name} lacks ${required}`).toContain(required);
      }
      expect(src, `${name} still calls resolveApprove(`).not.toContain('resolveApprove(');
      // Deliberately any `.approve` read, not just `config.approve`: the merged
      // config, the settings row and any alias of either are all ways around
      // the default-branch-only resolver. `\b` lets `.approved` etc. through.
      expect(src, `${name} reads .approve directly`).not.toMatch(/\.approve\b/);
    });
  }
});

describe('review-agent.ts derives the gate outputs from core (#662)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');

  it('no inline gate', () => {
    for (const banned of ['countBlockingCriticals(', 'blockingCriticalAgents(', 'advisoryOrgAgentNames',
      'mergeScoreToReviewEvent(', "title: 'Review failed'"]) {
      expect(src, `review-agent.ts still contains ${banned}`).not.toContain(banned);
    }
  });

  it('uses the core gate derivations', () => {
    for (const required of ['buildCheckOutcome(', 'reviewEventForGate(', 'formatGateLog(']) {
      expect(src, `review-agent.ts lacks ${required}`).toContain(required);
    }
    // #659 will move the catch to reviewFailedCheckOutput(error); either names the title.
    expect(src).toMatch(/REVIEW_FAILED_CHECK_TITLE|reviewFailedCheckOutput\(/);
  });
});

// #711 — the Lambda has no processor-level harness, so the wiring the server's
// precedence tests exercise is pinned here by source: the dashboard switch is
// read with `=== true`, the safety block comes from a separate default-branch
// read, and the merged value reaches the pipeline.
describe('the review agent reads the safety score from the default branch (#711)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');

  it('wires the dashboard switch, the default-branch read and the pipeline option', () => {
    for (const required of [
      '...settingsOverrides.safetyScore',
      'safetyScore?.enabled === true',
      'fetchRepoConfigResult(octokit, owner, repo)',
      'safetyScore: runtimeConfig.safetyScore',
    ]) {
      expect(src, `review-agent.ts lacks ${required}`).toContain(required);
    }
  });
});

// #713 — the server's wiring is exercised in review-processor.test.ts; the
// Lambda has no harness, so its two call sites are pinned by source.
describe('the review agent renders and persists the safety score (#713)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');

  it('passes the result and the config errors to the comment', () => {
    expect(src).toContain('safety: result.safety ?');
    expect(src).toContain('safetyConfigErrors: runtimeConfig.safetyScoreErrors');
  });

  it("stores the band inside the single 'complete' updateStatus call", () => {
    const start = src.indexOf("updateStatus(repoFullName, prNumberCommitSha, 'complete'");
    expect(start).toBeGreaterThan(-1);
    const call = src.slice(start, src.indexOf('});', start));
    expect(call).toContain('safetyBand: result.safety.band');
    expect(src.split("'complete', {").length - 1).toBe(1);
  });
});

// #717 — the base-root listing for the uncovered-folder check, pinned by source.
describe('the review agent lists the base root for uncovered folders (#717)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');
  it('lists the base root and hands baseRootDirs to the pipeline', () => {
    expect(src).toContain('repos.getContent(');
    expect(src).toContain('baseRootDirs');
    expect(src).toContain("path: '', ref: prContext.baseBranch");
  });
});

// #718 — org safety areas, pinned by source: selected per repo, and the
// store is read only inside the safetyScore.enabled branch.
describe('the review agent unions org safety areas (#718)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');
  it('selects org areas, and reads them only when the score is on', () => {
    expect(src).toContain('selectOrgSafetyAreas(');
    expect(src.split('getSafetyAreas(').length - 1).toBe(1);
    expect(src).toMatch(/if \(runtimeConfig\.safetyScore\.enabled\) \{\s*try \{\s*const orgSafetyAreas = selectOrgSafetyAreas\(await installationStore\.getSafetyAreas\(/);
  });
});

// #720 — the label sync after the comment, pinned by source.
describe('the review agent syncs the safety label (#720)', () => {
  const src = readFileSync(new URL('./review-agent.ts', import.meta.url), 'utf8');
  it('calls syncSafetyLabel only when label is on', () => {
    expect(src).toContain('syncSafetyLabel(');
    expect(src).toMatch(/if \(runtimeConfig\.safetyScore\.enabled && runtimeConfig\.safetyScore\.label\) \{\s*await syncSafetyLabel\(/);
  });
});
