import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeConfig } from './config/defaults.js';
import { parseRepoConfigYaml, syncSafetyLabel } from './github/client.js';
import { REVIEW_TRIGGERING_ACTIONS } from './types/github.js';

/** #720 — `safetyScore.label` keeps one `safety:<band>` label on the PR. */
const merged = (yml: string) => mergeConfig(parseRepoConfigYaml(yml) ?? {});

describe('safetyScore.label — config (#720)', () => {
  it('label: true merges cleanly; absent merges to false', () => {
    const c = merged('safetyScore:\n  enabled: true\n  label: true\n');
    expect(c.safetyScoreErrors).toBeUndefined();
    expect(c.safetyScore.label).toBe(true);
    expect(merged('safetyScore:\n  enabled: true\n').safetyScore.label).toBe(false);
  });

  it('label: "yes" gives exactly one error, about the type', () => {
    const c = merged('safetyScore:\n  enabled: true\n  label: "yes"\n');
    expect(c.safetyScoreErrors).toHaveLength(1);
    expect(c.safetyScoreErrors![0]).toMatch(/^safetyScore\.label: must be true or false/);
    expect(c.safetyScore.enabled).toBe(false);
  });
});

/** An octokit whose issue-label calls are spies; `labels` is the PR's current set. */
function octokitWith(labels: string[], over: Record<string, unknown> = {}) {
  const issues = {
    listLabelsOnIssue: vi.fn().mockResolvedValue({ data: labels.map((name) => ({ name })) }),
    createLabel: vi.fn().mockResolvedValue({}),
    addLabels: vi.fn().mockResolvedValue({}),
    removeLabel: vi.fn().mockResolvedValue({}),
    ...over,
  };
  return { octokit: { issues } as any, issues };
}
const removed = (issues: ReturnType<typeof octokitWith>['issues']) => issues.removeLabel.mock.calls.map((c) => c[0].name);

describe('syncSafetyLabel (#720)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('swaps safety:safe for safety:risky and never touches another label', async () => {
    const { octokit, issues } = octokitWith(['bug', 'safety:safe']);
    await syncSafetyLabel(octokit, 'o', 'r', 7, 'risky');
    expect(removed(issues)).toEqual(['safety:safe']);
    expect(issues.addLabels).toHaveBeenCalledTimes(1);
    expect(issues.addLabels.mock.calls[0][0]).toMatchObject({ issue_number: 7, labels: ['safety:risky'] });
    expect(issues.createLabel.mock.calls[0][0]).toMatchObject({ name: 'safety:risky', color: 'cf222e' });
  });

  it('band null removes only the safety label', async () => {
    const { octokit, issues } = octokitWith(['safety:caution', 'x']);
    await syncSafetyLabel(octokit, 'o', 'r', 7, null);
    expect(removed(issues)).toEqual(['safety:caution']);
    expect(issues.addLabels).not.toHaveBeenCalled();
  });

  it('already labelled with the right band: no calls beyond the read', async () => {
    const { octokit, issues } = octokitWith(['safety:caution']);
    await syncSafetyLabel(octokit, 'o', 'r', 7, 'caution');
    expect(issues.addLabels).not.toHaveBeenCalled();
    expect(issues.removeLabel).not.toHaveBeenCalled();
    expect(issues.createLabel).not.toHaveBeenCalled();
  });

  it('createLabel 422 (already exists) still adds the label', async () => {
    const exists = Object.assign(new Error('Validation Failed'), { status: 422 });
    const { octokit, issues } = octokitWith([], { createLabel: vi.fn().mockRejectedValue(exists) });
    await syncSafetyLabel(octokit, 'o', 'r', 7, 'safe');
    expect(issues.addLabels.mock.calls[0][0]).toMatchObject({ labels: ['safety:safe'] });
  });

  it('a failed label read resolves, logs, and makes no other call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { octokit, issues } = octokitWith([], { listLabelsOnIssue: vi.fn().mockRejectedValue(new Error('403')) });
    await expect(syncSafetyLabel(octokit, 'o', 'r', 7, 'risky')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(issues.addLabels).not.toHaveBeenCalled();
    expect(issues.removeLabel).not.toHaveBeenCalled();
    expect(issues.createLabel).not.toHaveBeenCalled();
  });

  it('a failed add or remove never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { octokit } = octokitWith(['safety:safe'], {
      addLabels: vi.fn().mockRejectedValue(new Error('boom')),
      removeLabel: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(syncSafetyLabel(octokit, 'o', 'r', 7, 'risky')).resolves.toBeUndefined();
  });
});

describe('labels cannot loop reviews (#720)', () => {
  it('(pin) a labeled event is not a review-triggering action', () => {
    expect(REVIEW_TRIGGERING_ACTIONS).not.toContain('labeled');
  });
});
