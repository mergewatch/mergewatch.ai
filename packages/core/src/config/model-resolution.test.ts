/**
 * #264 — the precedence that was silently wrong on SaaS for months.
 *
 * The regression these guard against: `.mergewatch.yml` `model:` documented as
 * functional but never read, and a merged-config value accidentally overriding
 * the deploy-time default for every repository at once.
 */
import { describe, it, expect } from 'vitest';
import { resolveReviewModelId } from './model-resolution';

const FALLBACK = 'us.anthropic.claude-opus-4-6-v1';
const DEPLOY = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const REPO = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const INSTALL = 'us.anthropic.claude-opus-4-8-v1';

describe('resolveReviewModelId', () => {
  it('uses the deploy default when nothing else is set', () => {
    expect(resolveReviewModelId({ deployDefault: DEPLOY, fallback: FALLBACK }))
      .toEqual({ modelId: DEPLOY, source: 'deploy-default' });
  });

  it('honors `model:` from .mergewatch.yml over the deploy default', () => {
    // The bug: this returned the deploy default, so a documented per-repo
    // setting did nothing.
    expect(resolveReviewModelId({
      repoConfigModel: REPO,
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: REPO, source: 'repo-config' });
  });

  it('lets an installation override beat the repo config', () => {
    expect(resolveReviewModelId({
      installationModelId: INSTALL,
      repoConfigModel: REPO,
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: INSTALL, source: 'installation' });
  });

  it('falls back when the deploy default is unset', () => {
    expect(resolveReviewModelId({ fallback: FALLBACK }))
      .toEqual({ modelId: FALLBACK, source: 'fallback' });
  });

  it('treats an empty `model:` as unset rather than resolving to an empty id', () => {
    // `model:` with nothing after it parses as an empty string; sending that to
    // Bedrock is a confusing runtime error rather than a config no-op.
    expect(resolveReviewModelId({
      repoConfigModel: '',
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: DEPLOY, source: 'deploy-default' });
  });

  it('treats a whitespace-only `model:` as unset', () => {
    expect(resolveReviewModelId({
      repoConfigModel: '   ',
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: DEPLOY, source: 'deploy-default' });
  });

  it('trims a padded value rather than passing the padding through', () => {
    expect(resolveReviewModelId({
      repoConfigModel: `  ${REPO}  `,
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: REPO, source: 'repo-config' });
  });

  it('skips an empty installation override and uses the repo config', () => {
    expect(resolveReviewModelId({
      installationModelId: '',
      repoConfigModel: REPO,
      deployDefault: DEPLOY,
      fallback: FALLBACK,
    })).toEqual({ modelId: REPO, source: 'repo-config' });
  });

  it('reports the winning source so an unexpected model is traceable', () => {
    // The #264 investigation cost real time precisely because nothing said
    // where the running model came from.
    const sources = [
      resolveReviewModelId({ installationModelId: INSTALL, fallback: FALLBACK }).source,
      resolveReviewModelId({ repoConfigModel: REPO, fallback: FALLBACK }).source,
      resolveReviewModelId({ deployDefault: DEPLOY, fallback: FALLBACK }).source,
      resolveReviewModelId({ fallback: FALLBACK }).source,
    ];
    expect(sources).toEqual(['installation', 'repo-config', 'deploy-default', 'fallback']);
  });
});
