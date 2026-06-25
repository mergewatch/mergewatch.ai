import { describe, it, expect } from 'vitest';
import { sanitizeOrgCustomAgents } from './org-agents.js';
import type { OrgCustomAgent } from './types/db.js';

function valid(over: Partial<OrgCustomAgent> = {}): OrgCustomAgent {
  return {
    id: 'a1',
    name: 'No console.log',
    prompt: 'Flag any console.log in production code.',
    severityDefault: 'warning',
    enforcement: 'advisory',
    enabled: true,
    scope: { mode: 'all' },
    updatedAt: '2026-06-25T00:00:00.000Z',
    updatedBy: 'octocat',
    ...over,
  };
}

describe('sanitizeOrgCustomAgents', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeOrgCustomAgents(null)).toEqual([]);
    expect(sanitizeOrgCustomAgents(undefined)).toEqual([]);
    expect(sanitizeOrgCustomAgents('nope')).toEqual([]);
    expect(sanitizeOrgCustomAgents({})).toEqual([]);
  });

  it('passes a valid agent through unchanged', () => {
    const a = valid();
    expect(sanitizeOrgCustomAgents([a])).toEqual([a]);
  });

  it('drops entries missing id / name / prompt', () => {
    expect(sanitizeOrgCustomAgents([valid({ id: '' })])).toEqual([]);
    expect(sanitizeOrgCustomAgents([valid({ name: '   ' })])).toEqual([]);
    expect(sanitizeOrgCustomAgents([{ ...valid(), prompt: undefined }])).toEqual([]);
    expect(sanitizeOrgCustomAgents([null, 42, 'x'])).toEqual([]);
  });

  it('trims id / name / prompt', () => {
    const [a] = sanitizeOrgCustomAgents([valid({ id: ' a1 ', name: ' N ', prompt: ' p ' })]);
    expect(a).toMatchObject({ id: 'a1', name: 'N', prompt: 'p' });
  });

  it('clamps invalid severity → warning and invalid enforcement → advisory', () => {
    const [a] = sanitizeOrgCustomAgents([
      valid({ severityDefault: 'huge' as any, enforcement: 'mandatory' as any }),
    ]);
    expect(a.severityDefault).toBe('warning');
    expect(a.enforcement).toBe('advisory');
  });

  it('keeps valid severity + enforcement values', () => {
    const [a] = sanitizeOrgCustomAgents([valid({ severityDefault: 'critical', enforcement: 'blocking' })]);
    expect(a.severityDefault).toBe('critical');
    expect(a.enforcement).toBe('blocking');
  });

  it('defaults enabled to true, but respects explicit false', () => {
    expect(sanitizeOrgCustomAgents([{ ...valid(), enabled: undefined }])[0].enabled).toBe(true);
    expect(sanitizeOrgCustomAgents([valid({ enabled: false })])[0].enabled).toBe(false);
  });

  it('normalises scope: defaults to all, keeps a selected allowlist', () => {
    expect(sanitizeOrgCustomAgents([{ ...valid(), scope: undefined }])[0].scope).toEqual({ mode: 'all' });
    expect(sanitizeOrgCustomAgents([valid({ scope: { mode: 'bogus' } as any })])[0].scope).toEqual({ mode: 'all' });
    expect(
      sanitizeOrgCustomAgents([valid({ scope: { mode: 'selected', repos: ['o/a', '', 'o/b', 7 as any] } })])[0].scope,
    ).toEqual({ mode: 'selected', repos: ['o/a', 'o/b'] });
  });

  it('normalises targeting: lowercases languages, drops blanks, omits when empty', () => {
    const [a] = sanitizeOrgCustomAgents([
      valid({ targeting: { pathGlobs: ['src/**', ''], languages: ['TypeScript', ' ', 'Go'] } as any }),
    ]);
    expect(a.targeting).toEqual({ pathGlobs: ['src/**'], languages: ['typescript', 'go'] });

    const [b] = sanitizeOrgCustomAgents([valid({ targeting: { pathGlobs: [], languages: [] } as any })]);
    expect(b.targeting).toBeUndefined();
  });

  it('defaults missing audit metadata to empty strings', () => {
    const [a] = sanitizeOrgCustomAgents([{ ...valid(), updatedAt: undefined, updatedBy: undefined }]);
    expect(a.updatedAt).toBe('');
    expect(a.updatedBy).toBe('');
  });
});
