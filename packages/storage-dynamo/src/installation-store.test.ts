import { describe, it, expect, vi } from 'vitest';
import { DynamoInstallationStore } from './installation-store';
import type { OrgCustomAgent } from '@mergewatch/core';

function clientReturning(response: any) {
  return { send: vi.fn().mockResolvedValue(response) } as any;
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

describe('DynamoInstallationStore — org custom agents (#235)', () => {
  it('getCustomAgents reads the #AGENTS sentinel row', async () => {
    const client = clientReturning({ Item: { agents: [agent()] } });
    const store = new DynamoInstallationStore(client, 'tbl');
    const result = await store.getCustomAgents('42');
    expect(result).toEqual([agent()]);
    const sent = client.send.mock.calls[0][0];
    expect(sent.input.Key).toEqual({ installationId: '42', repoFullName: '#AGENTS' });
  });

  it('getCustomAgents returns [] when the row is missing', async () => {
    const store = new DynamoInstallationStore(clientReturning({}), 'tbl');
    expect(await store.getCustomAgents('42')).toEqual([]);
  });

  it('#664 — getCustomAgents rejects on a client error, rather than reading as no agents', async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error('boom')) } as any;
    const store = new DynamoInstallationStore(client, 'tbl');
    await expect(store.getCustomAgents('42')).rejects.toThrow('boom');
  });

  it('getCustomAgents sanitizes a malformed stored blob', async () => {
    const client = clientReturning({ Item: { agents: [agent(), { id: '' }, 'junk'] } });
    const store = new DynamoInstallationStore(client, 'tbl');
    expect(await store.getCustomAgents('42')).toEqual([agent()]);
  });

  it('upsertCustomAgents writes the #AGENTS row with sanitized agents', async () => {
    const client = clientReturning(undefined);
    const store = new DynamoInstallationStore(client, 'tbl');
    await store.upsertCustomAgents('42', [agent(), { id: '' } as any]);
    const sent = client.send.mock.calls[0][0];
    expect(sent.input.Item.installationId).toBe('42');
    expect(sent.input.Item.repoFullName).toBe('#AGENTS');
    expect(sent.input.Item.agents).toEqual([agent()]); // junk dropped
  });
});

describe('DynamoInstallationStore — approve (#706)', () => {
  it('getSettings on a #SETTINGS row saved before approve existed returns approve: false', async () => {
    const client = clientReturning({ Item: { settings: { severityThreshold: 'Med', maxComments: 5 } } });
    const settings = await new DynamoInstallationStore(client, 'tbl').getSettings('42');
    expect(settings.approve).toBe(false);
    expect(settings.severityThreshold).toBe('Med');
  });

  it('getSettings returns a saved approve: true', async () => {
    const client = clientReturning({ Item: { settings: { approve: true } } });
    expect((await new DynamoInstallationStore(client, 'tbl').getSettings('42')).approve).toBe(true);
  });
});

describe('DynamoInstallationStore — safetyScore (#711)', () => {
  it('a #SETTINGS row saved before #711 reads safetyScore: { enabled: false }', async () => {
    const client = clientReturning({ Item: { settings: { severityThreshold: 'Med', approve: true } } });
    expect((await new DynamoInstallationStore(client, 'tbl').getSettings('42')).safetyScore).toEqual({ enabled: false });
  });

  it('getSettings returns a saved safetyScore: { enabled: true }', async () => {
    const client = clientReturning({ Item: { settings: { safetyScore: { enabled: true } } } });
    expect((await new DynamoInstallationStore(client, 'tbl').getSettings('42')).safetyScore).toEqual({ enabled: true });
  });
});

describe('DynamoInstallationStore — org safety areas (#718)', () => {
  it('getSafetyAreas reads the #SAFETY_AREAS sentinel row', async () => {
    const client = clientReturning({ Item: { areas: [{ id: 'a', patterns: ['p/**'], level: 'risky' }] } });
    const areas = await new DynamoInstallationStore(client, 'tbl').getSafetyAreas('42');
    expect(client.send.mock.calls[0][0].input.Key).toEqual({ installationId: '42', repoFullName: '#SAFETY_AREAS' });
    expect(areas).toMatchObject([{ id: 'a', patterns: ['p/**'], level: 'risky', enabled: true }]);
  });

  it('a missing row is []', async () => {
    expect(await new DynamoInstallationStore(clientReturning({}), 'tbl').getSafetyAreas('42')).toEqual([]);
  });

  it('a read error is thrown, not read as no areas', async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error('boom')) } as any;
    await expect(new DynamoInstallationStore(client, 'tbl').getSafetyAreas('42')).rejects.toThrow('boom');
  });
});
