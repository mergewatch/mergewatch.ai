import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_INSTALLATION_SETTINGS } from '@mergewatch/core';
import { PostgresDashboardInstallationStore, PostgresDashboardReviewStore } from './dashboard-store';

/** Drizzle chain mock (mirrors installation-store.test). */
function chain(result: any) {
  const p: any = {
    select: vi.fn(() => p),
    from: vi.fn(() => p),
    where: vi.fn(() => p),
    limit: vi.fn(() => Promise.resolve(result)),
    insert: vi.fn(() => p),
    values: vi.fn(() => p),
    onConflictDoUpdate: vi.fn(() => Promise.resolve(result)),
  };
  return p;
}

describe('PostgresDashboardInstallationStore — approve (#706)', () => {
  it('updateSettings writes approve on insert and on conflict', async () => {
    const db = chain(undefined);
    await new PostgresDashboardInstallationStore(db).updateSettings('42', { ...DEFAULT_INSTALLATION_SETTINGS, approve: true });
    expect(db.values.mock.calls[0][0]).toMatchObject({ installationId: '42', approve: true });
    expect(db.onConflictDoUpdate.mock.calls[0][0].set).toMatchObject({ approve: true });
  });

  it('getSettings reads it back', async () => {
    const db = chain([{ ...DEFAULT_INSTALLATION_SETTINGS, installationId: '42', approve: true }]);
    expect((await new PostgresDashboardInstallationStore(db).getSettings('42')).approve).toBe(true);
  });

  it('getSettings with no settings row → approve: false', async () => {
    expect((await new PostgresDashboardInstallationStore(chain([])).getSettings('42')).approve).toBe(false);
  });
});

describe('PostgresDashboardInstallationStore — safetyScore (#711)', () => {
  it('updateSettings writes safetyScore on insert and on conflict', async () => {
    const db = chain(undefined);
    await new PostgresDashboardInstallationStore(db).updateSettings('42', { ...DEFAULT_INSTALLATION_SETTINGS, safetyScore: { enabled: true } });
    expect(db.values.mock.calls[0][0]).toMatchObject({ installationId: '42', safetyScore: { enabled: true } });
    expect(db.onConflictDoUpdate.mock.calls[0][0].set).toMatchObject({ safetyScore: { enabled: true } });
  });

  it('getSettings reads it back', async () => {
    const db = chain([{ ...DEFAULT_INSTALLATION_SETTINGS, installationId: '42', safetyScore: { enabled: true } }]);
    expect((await new PostgresDashboardInstallationStore(db).getSettings('42')).safetyScore).toEqual({ enabled: true });
  });

  it('a row without it reads { enabled: false }', async () => {
    const { safetyScore: _, ...old } = DEFAULT_INSTALLATION_SETTINGS;
    const db = chain([{ ...old, installationId: '42' }]);
    expect((await new PostgresDashboardInstallationStore(db).getSettings('42')).safetyScore).toEqual({ enabled: false });
  });
});

describe('PostgresDashboardInstallationStore — org safety areas (#718)', () => {
  const area = { id: 'a', patterns: ['p/**'], level: 'risky' as const, enabled: true, scope: { mode: 'all' as const }, updatedAt: 't', updatedBy: 'u' };

  it('a fresh row gets core defaults, not the column defaults (maxComments 10, confidenceScore false)', async () => {
    const db = chain(undefined);
    await new PostgresDashboardInstallationStore(db).updateSafetyAreas('42', [area]);
    const values = db.values.mock.calls[0][0];
    expect(values).toMatchObject({ installationId: '42', maxComments: 10, safetyAreas: [area] });
    expect(values.summary.confidenceScore).toBe(false);
    expect(db.onConflictDoUpdate.mock.calls[0][0].set).toEqual({ safetyAreas: [area] });
  });

  it('getSafetyAreas maps the column; a missing row is []', async () => {
    expect(await new PostgresDashboardInstallationStore(chain([{ safetyAreas: [area] }])).getSafetyAreas('42')).toEqual([area]);
    expect(await new PostgresDashboardInstallationStore(chain([])).getSafetyAreas('42')).toEqual([]);
  });

  it('the safety_areas column exists in the real schema', async () => {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { installationSettings } = await import('./schema.js');
    expect(drizzle.mock().update(installationSettings).set({ safetyAreas: [] } as any).toSQL().sql).toContain('"safety_areas"');
  });
});

describe('PostgresDashboardReviewStore — safety feedback (#716)', () => {
  it('rowToReviewItem returns safetyFeedback from a row that has it', async () => {
    const entry = { band: 'risky', user: 'alice', at: 't' };
    const db = chain([{ repoFullName: 'o/r', prNumberCommitSha: '42#a', status: 'complete', createdAt: 't', safetyFeedback: [entry] }]);
    expect((await new PostgresDashboardReviewStore(db).getReview('o/r', '42#a'))?.safetyFeedback).toEqual([entry]);
  });
});
