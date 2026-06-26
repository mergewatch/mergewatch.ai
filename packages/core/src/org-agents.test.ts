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

import {
  agentAppliesToRepo,
  agentMatchesTargeting,
  selectOrgAgentsForReview,
  unionCustomAgents,
  blockingCriticalAgents,
} from './org-agents.js';

describe('agentAppliesToRepo', () => {
  it('mode:all matches any repo', () => {
    expect(agentAppliesToRepo(valid({ scope: { mode: 'all' } }), 'o/anything')).toBe(true);
  });
  it('mode:selected matches only listed repos', () => {
    const a = valid({ scope: { mode: 'selected', repos: ['o/a', 'o/b'] } });
    expect(agentAppliesToRepo(a, 'o/a')).toBe(true);
    expect(agentAppliesToRepo(a, 'o/c')).toBe(false);
  });
});

describe('agentMatchesTargeting', () => {
  const ctx = { changedFiles: ['src/api/users.ts', 'README.md'], languages: ['typescript'] };
  it('no targeting → always matches', () => {
    expect(agentMatchesTargeting(valid(), ctx)).toBe(true);
  });
  it('path globs: matches when a changed file matches', () => {
    expect(agentMatchesTargeting(valid({ targeting: { pathGlobs: ['src/api/**'] } }), ctx)).toBe(true);
    expect(agentMatchesTargeting(valid({ targeting: { pathGlobs: ['infra/**'] } }), ctx)).toBe(false);
  });
  it('languages: matches case-insensitively', () => {
    expect(agentMatchesTargeting(valid({ targeting: { languages: ['TypeScript'] } }), ctx)).toBe(true);
    expect(agentMatchesTargeting(valid({ targeting: { languages: ['go'] } }), ctx)).toBe(false);
  });
  it('path AND language both required when both set', () => {
    const a = valid({ targeting: { pathGlobs: ['src/api/**'], languages: ['go'] } });
    expect(agentMatchesTargeting(a, ctx)).toBe(false); // path matches, language doesn't
  });
});

describe('selectOrgAgentsForReview', () => {
  it('keeps enabled + in-scope + targeting-matching agents', () => {
    const agents = [
      valid({ id: '1', name: 'on-all' }),
      valid({ id: '2', name: 'disabled', enabled: false }),
      valid({ id: '3', name: 'other-repo', scope: { mode: 'selected', repos: ['o/other'] } }),
      valid({ id: '4', name: 'go-only', targeting: { languages: ['go'] } }),
    ];
    const selected = selectOrgAgentsForReview(agents, {
      repoFullName: 'o/repo',
      changedFiles: ['src/x.ts'],
      languages: ['typescript'],
    });
    expect(selected.map((a) => a.name)).toEqual(['on-all']);
  });
});

describe('unionCustomAgents', () => {
  it('org agents + repo-only agents; org wins on name collision', () => {
    const org = [valid({ name: 'shared', prompt: 'ORG' }), valid({ id: '2', name: 'org-only' })];
    const repo = [
      { name: 'shared', prompt: 'REPO', severityDefault: 'info' as const, enabled: true },
      { name: 'repo-only', prompt: 'r', severityDefault: 'info' as const, enabled: true },
    ];
    const out = unionCustomAgents(org, repo);
    expect(out.map((a) => a.name).sort()).toEqual(['org-only', 'repo-only', 'shared']);
    // org wins: the 'shared' entry uses the org prompt
    expect(out.find((a) => a.name === 'shared')!.prompt).toBe('ORG');
  });
  it('handles undefined repo agents', () => {
    expect(unionCustomAgents([valid({ name: 'a' })], undefined).map((a) => a.name)).toEqual(['a']);
  });
});

describe('blockingCriticalAgents', () => {
  const agents = [
    valid({ name: 'block-me', enforcement: 'blocking' }),
    valid({ id: '2', name: 'advise-me', enforcement: 'advisory' }),
  ];
  it('fires for a blocking agent with a critical finding', () => {
    const findings = [{ severity: 'critical', category: 'block-me' }];
    expect(blockingCriticalAgents(agents, findings)).toEqual(['block-me']);
  });
  it('ignores non-critical findings from a blocking agent', () => {
    expect(blockingCriticalAgents(agents, [{ severity: 'warning', category: 'block-me' }])).toEqual([]);
  });
  it('ignores critical findings from an advisory agent', () => {
    expect(blockingCriticalAgents(agents, [{ severity: 'critical', category: 'advise-me' }])).toEqual([]);
  });
  it('dedupes multiple criticals from the same blocking agent', () => {
    const findings = [
      { severity: 'critical', category: 'block-me' },
      { severity: 'critical', category: 'block-me' },
    ];
    expect(blockingCriticalAgents(agents, findings)).toEqual(['block-me']);
  });
});

import { languagesFromFiles } from './org-agents.js';

describe('languagesFromFiles', () => {
  it('maps common extensions to languages, deduped', () => {
    expect(languagesFromFiles(['src/a.ts', 'src/b.tsx', 'x.go']).sort()).toEqual(['go', 'typescript']);
  });
  it('ignores extensionless / unknown files', () => {
    expect(languagesFromFiles(['Makefile', 'LICENSE', 'weird.xyz'])).toEqual([]);
  });
  it('returns [] for no files', () => {
    expect(languagesFromFiles([])).toEqual([]);
  });
  it('is case-insensitive on the extension', () => {
    expect(languagesFromFiles(['A.TS', 'B.Py'])).toEqual(['typescript', 'python']);
  });
});
