import { describe, it, expect, vi } from 'vitest';
import { PostgresInstallationStore } from './installation-store';
import { installationSettings } from './schema';
import type { OrgCustomAgent } from '@mergewatch/core';

/** Drizzle chain mock (mirrors review-cost-store.test). */
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

function agent(over: Partial<OrgCustomAgent> = {}): OrgCustomAgent {
  return {
    id: 'a1',
    name: 'No console.log',
    prompt: 'Flag console.log.',
    severityDefault: 'warning',
    enforcement: 'advisory',
    enabled: true,
    scope: { mode: 'all' },
    updatedAt: 'iso',
    updatedBy: 'octocat',
    ...over,
  };
}

describe('PostgresInstallationStore — org custom agents (#235)', () => {
  it('getCustomAgents reads + sanitizes the custom_agents column', async () => {
    const db: any = chain([{ customAgents: [agent(), { id: '' }, 'junk'] }]);
    const store = new PostgresInstallationStore(db);
    expect(await store.getCustomAgents('42')).toEqual([agent()]);
    expect(db.select).toHaveBeenCalled();
  });

  it('getCustomAgents returns [] when no settings row exists', async () => {
    const store = new PostgresInstallationStore(chain([]));
    expect(await store.getCustomAgents('42')).toEqual([]);
  });

  it('upsertCustomAgents inserts/updates the settings row with sanitized agents', async () => {
    const db: any = chain(undefined);
    const store = new PostgresInstallationStore(db);
    await store.upsertCustomAgents('42', [agent(), { id: '' } as any]);
    expect(db.insert).toHaveBeenCalledWith(installationSettings);
    expect(db.values).toHaveBeenCalledWith({ installationId: '42', customAgents: [agent()] });
    expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { customAgents: [agent()] } }),
    );
  });
});
