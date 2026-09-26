/**
 * #657 — the shared "Re-run" decision.
 *
 * Falsifiability note: these are **(new code)** tests. `decideCheckSuiteRereview`
 * does not exist on `main`, so on `main` this file fails to import — which
 * proves nothing about behaviour. What they pin is the decision's contract,
 * which both webhooks now depend on; the two behavioural regressions (the
 * Express dispatcher ignoring `check_suite`, and a re-run job with no check-run
 * key) are shown failing on `main` in the server's own test files.
 */
import { describe, it, expect, vi } from 'vitest';
import { decideCheckSuiteRereview } from './check-suite-rereview.js';
import { checkRunName } from '../stage.js';
import type { CheckSuiteEvent } from '../types/github.js';

function makeSuiteEvent(overrides: {
  action?: CheckSuiteEvent['action'];
  pullRequests?: CheckSuiteEvent['check_suite']['pull_requests'];
  installation?: CheckSuiteEvent['installation'];
  headSha?: string;
} = {}): CheckSuiteEvent {
  const repo = {
    id: 1,
    name: 'repo',
    full_name: 'octo/repo',
    owner: { login: 'octo', id: 1, avatar_url: '', type: 'User' as const },
    private: false,
    html_url: '',
    default_branch: 'main',
  };
  const prRef = {
    number: 42,
    head: { label: 'octo:feat', ref: 'feat', sha: 'abc123', repo },
    base: { label: 'octo:main', ref: 'main', sha: 'def456', repo },
  };
  return {
    action: overrides.action ?? 'rerequested',
    check_suite: {
      id: 7001,
      head_sha: overrides.headSha ?? 'abc123',
      status: 'completed',
      conclusion: 'failure',
      app: { id: 42, slug: 'mergewatch-ai', name: 'MergeWatch' },
      pull_requests: overrides.pullRequests ?? [prRef],
    },
    repository: repo,
    installation: 'installation' in overrides ? overrides.installation : { id: 999 },
    sender: { login: 'alice', id: 1, avatar_url: '', type: 'User' },
  };
}

describe('decideCheckSuiteRereview (#657)', () => {
  it('re-reviews the attached PR when our check run is on the suite head', async () => {
    const listCheckRunNames = vi.fn().mockResolvedValue([checkRunName(), 'CodeQL']);

    const decision = await decideCheckSuiteRereview(makeSuiteEvent(), { listCheckRunNames });

    expect(decision).toEqual({
      rereview: true,
      installationId: 999,
      prNumber: 42,
      headSha: 'abc123',
    });
    // The lookup is filtered by name rather than paging every run on the
    // commit: a MergeWatch run on page two reads exactly like "not ours".
    expect(listCheckRunNames).toHaveBeenCalledWith('abc123', checkRunName());
  });

  it('skips a suite that belongs to another app', async () => {
    // A suite carries no `name`, so the identity rule is applied one level down.
    const decision = await decideCheckSuiteRereview(makeSuiteEvent(), {
      listCheckRunNames: vi.fn().mockResolvedValue(['CodeQL', 'Build & Test']),
    });

    expect(decision.rereview).toBe(false);
    expect((decision as { reason: string }).reason).toMatch(/not ours/);
  });

  it('fails CLOSED when the ownership lookup throws', async () => {
    // A missed re-run is recoverable by pushing a commit. Reviewing another
    // tool's suite spends real money on work nobody asked for.
    const decision = await decideCheckSuiteRereview(makeSuiteEvent(), {
      listCheckRunNames: vi.fn().mockRejectedValue(new Error('503 from GitHub')),
    });

    expect(decision.rereview).toBe(false);
    expect((decision as { reason: string }).reason).toContain('503 from GitHub');
    // A click that produced nothing must leave a trace — the silence is the bug.
    expect((decision as { notable: boolean }).notable).toBe(true);
  });

  it('skips a suite with no attached PR, and says so', async () => {
    const listCheckRunNames = vi.fn();
    const decision = await decideCheckSuiteRereview(makeSuiteEvent({ pullRequests: [] }), {
      listCheckRunNames,
    });

    expect(decision.rereview).toBe(false);
    expect((decision as { reason: string }).reason).toContain('no attached PR');
    // No ownership call: nothing to review, so nothing to verify.
    expect(listCheckRunNames).not.toHaveBeenCalled();
  });

  it('skips every action other than rerequested, without any I/O', async () => {
    // `requested` fires on every push and `completed` on every suite finishing;
    // acting on either would double every review on the repo.
    for (const action of ['requested', 'completed'] as const) {
      const listCheckRunNames = vi.fn();
      const decision = await decideCheckSuiteRereview(makeSuiteEvent({ action }), {
        listCheckRunNames,
      });

      expect(decision.rereview, action).toBe(false);
      expect((decision as { reason: string }).reason).toContain(action);
      // Routine: `requested` fires on every push, so a caller that logged this
      // would warn once per push forever.
      expect((decision as { notable: boolean }).notable, action).toBe(false);
      // The callback may resolve an installation client, so a `requested` suite
      // reaching it would be a token exchange on every push.
      expect(listCheckRunNames, action).not.toHaveBeenCalled();
    }
  });

  it('skips an event with no installation id', async () => {
    const decision = await decideCheckSuiteRereview(makeSuiteEvent({ installation: undefined }), {
      listCheckRunNames: vi.fn().mockResolvedValue([checkRunName()]),
    });

    expect(decision.rereview).toBe(false);
    expect((decision as { reason: string }).reason).toContain('installation id');
  });

  it('matches the stage-scoped run name, so dev does not act on prod suites', async () => {
    // #416 — prod's run is named "MergeWatch Review"; dev's is
    // "MergeWatch Review (dev)". A dev stage seeing only prod's run must skip.
    const onlyProdRun = vi.fn().mockResolvedValue([checkRunName()]);
    expect((await decideCheckSuiteRereview(makeSuiteEvent(), {
      stage: 'dev', listCheckRunNames: onlyProdRun,
    })).rereview).toBe(false);
    expect(onlyProdRun).toHaveBeenCalledWith('abc123', 'MergeWatch Review (dev)');

    const devRun = vi.fn().mockResolvedValue([checkRunName('dev')]);
    expect((await decideCheckSuiteRereview(makeSuiteEvent(), {
      stage: 'dev', listCheckRunNames: devRun,
    })).rereview).toBe(true);
  });
});
