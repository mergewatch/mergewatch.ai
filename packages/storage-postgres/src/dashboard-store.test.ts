import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_INSTALLATION_SETTINGS } from '@mergewatch/core';
import { PostgresDashboardInstallationStore } from './dashboard-store';

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
