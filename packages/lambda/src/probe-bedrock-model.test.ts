/**
 * #721 — guards on `scripts/probe-bedrock-model.mjs`.
 *
 * The probe is the proof that a model works before a deploy default points at
 * it, and it is also the one thing that could accept a Marketplace agreement
 * by accident: a first invoke auto-accepts, and the credentials an agent runs
 * with are allowed to. So the gate is tested first and hardest, and nothing in
 * this file ever reaches AWS: the CLI is a stub first on PATH, credentials are
 * nulled, and every in-process provider is a fake.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as core from '@mergewatch/core';
import { runBounded, SUBPROCESS_TEST_TIMEOUT_MS } from './test-support/subprocess';

vi.setConfig({ testTimeout: SUBPROCESS_TEST_TIMEOUT_MS });

const REPO = resolve(__dirname, '../../..');
const SCRIPT = join(REPO, 'scripts/probe-bedrock-model.mjs');
const SONNET_55 = 'us.anthropic.claude-sonnet-5-5';

// Imported through a variable: the script is plain .mjs with no declarations.
let probe: any;
beforeAll(async () => {
  const url = pathToFileURL(SCRIPT).href;
  probe = await import(/* @vite-ignore */ url);
});

/* ── the agreement gate, through the real CLI path ─────────────────────── */
describe('probe — exit 3 when the agreement is not AVAILABLE (stubbed aws CLI)', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'probe-aws-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runWithStub(stubBody: string) {
    const log = join(dir, 'aws-calls.log');
    rmSync(log, { force: true });
    writeFileSync(join(dir, 'aws'), `#!/bin/sh\necho "$@" >> "${log}"\n${stubBody}\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      // Belt and braces: even if the script reached the SDK, it has nothing
      // real to sign with.
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_ACCESS_KEY_ID: 'probe-test-not-a-key',
      AWS_SECRET_ACCESS_KEY: 'probe-test-not-a-secret',
      AWS_EC2_METADATA_DISABLED: 'true',
    };
    delete env.AWS_PROFILE;
    delete env.AWS_SESSION_TOKEN;
    const r = runBounded('node', [SCRIPT, SONNET_55], { cwd: REPO, env });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  }

  it('NOT_AVAILABLE → exit 3, one availability call, and nothing invoked', () => {
    const r = runWithStub(`cat <<'JSON'
{"modelId":"anthropic.claude-sonnet-5-5","agreementAvailability":{"status":"NOT_AVAILABLE"},"authorizationStatus":"AUTHORIZED","entitlementAvailability":"AVAILABLE","regionAvailability":"AVAILABLE"}
JSON`);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/GATE NOT PASSED/);
    expect(r.stderr).toMatch(/NOT_AVAILABLE/);
    expect(r.stderr).toMatch(/Nothing was invoked/);
    // The only AWS call was the read-only availability check, on the base id.
    expect(r.calls).toEqual([
      'bedrock get-foundation-model-availability --model-id anthropic.claude-sonnet-5-5 --region us-west-2 --output json',
    ]);
    // No call record was printed: no call was made.
    expect(r.stdout).not.toMatch(/"call"/);
  });

  it('a CLI failure is not a pass either → exit 3', () => {
    const r = runWithStub('echo "stub aws: no credentials" >&2\nexit 255');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/GATE NOT CHECKED/);
    expect(r.stderr).toMatch(/stub aws/);
    expect(r.stdout).not.toMatch(/"call"/);
  });

  it('no model id → exit 2, and the CLI is never called', () => {
    const r = runBounded('node', [SCRIPT], { cwd: REPO });
    expect(r.status).toBe(2);
  });
});

/* ── in-process, with injected fakes ───────────────────────────────────── */
type Call = { kind: 'invoke' | 'structured'; modelId: string; prompt: unknown; schema?: any; maxTokens?: number };

function fakeProvider(opts: {
  reportedModel?: string | null;
  plainText?: string;
  stopReason?: string;
  structuredThrows?: boolean;
} = {}) {
  const calls: Call[] = [];
  const model = opts.reportedModel === undefined ? 'claude-sonnet-5-5' : opts.reportedModel ?? undefined;
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  return {
    calls,
    async invoke(modelId: string, prompt: unknown, maxTokens?: number) {
      calls.push({ kind: 'invoke', modelId, prompt, maxTokens });
      return { text: opts.plainText ?? 'OK', usage, stopReason: opts.stopReason ?? 'end_turn', modelId: model };
    },
    async invokeStructured(modelId: string, prompt: unknown, schema: object, maxTokens?: number) {
      calls.push({ kind: 'structured', modelId, prompt, schema, maxTokens });
      if (opts.structuredThrows) throw new Error('Structured invocation returned no tool_use block (stop_reason: end_turn)');
      return { object: { findings: [] }, usage, stopReason: opts.stopReason ?? 'tool_use', modelId: model };
    },
  };
}

async function run(provider: ReturnType<typeof fakeProvider>, status = 'AVAILABLE', modelId = SONNET_55) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await probe.runProbe({
    modelId,
    availability: async () => ({ agreementAvailability: { status } }),
    provider: async () => provider,
    core: async () => core,
    diff: readFileSync(probe.FIXTURE, 'utf8'),
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  });
  const records = out.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  return { code, out, err, records };
}

describe('probe — runProbe with injected fakes', () => {
  it('NOT_AVAILABLE → exit 3 and the provider and core are never even loaded', async () => {
    let loaded = 0;
    const code = await probe.runProbe({
      modelId: SONNET_55,
      availability: async () => ({ agreementAvailability: { status: 'NOT_AVAILABLE' } }),
      provider: async () => { loaded++; return fakeProvider(); },
      core: async () => { loaded++; return core; },
      diff: '',
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(3);
    expect(loaded).toBe(0);
  });

  it('a missing agreement status is not AVAILABLE → exit 3', async () => {
    const p = fakeProvider();
    const code = await probe.runProbe({
      modelId: SONNET_55, availability: async () => ({}), provider: async () => p,
      core: async () => core, diff: '', out: () => {}, err: () => {},
    });
    expect(code).toBe(3);
    expect(p.calls).toHaveLength(0);
  });

  it('a well-behaved model → exit 0 over 1 plain + 3 security + 1 orchestrator calls at 4096', async () => {
    const p = fakeProvider();
    const r = await run(p);
    expect(r.code).toBe(0);
    expect(p.calls.map((c) => c.kind)).toEqual(['invoke', 'structured', 'structured', 'structured', 'structured']);
    expect(p.calls.every((c) => c.maxTokens === 4096 && c.modelId === SONNET_55)).toBe(true);
    expect(r.records).toHaveLength(5);
    expect(r.records[0]).toMatchObject({
      call: 'plain', requestedModel: SONNET_55, reportedModel: 'claude-sonnet-5-5', stopReason: 'end_turn', ok: true,
    });
  });

  it('the structured calls carry the REAL review prompts and schemas, not a toy prompt', async () => {
    const p = fakeProvider();
    await run(p);
    const [, sec1, sec2, sec3, orch] = p.calls;
    const secText = core.renderPrompt(sec1.prompt as never);
    expect(secText).toContain("db.query(`SELECT * FROM users WHERE name = '${name}'`)"); // the fixture diff
    expect(core.renderPrompt(sec2.prompt as never)).toBe(secText);
    expect(core.renderPrompt(sec3.prompt as never)).toBe(secText);
    // AGENT_FINDINGS_SCHEMA: findings + the folded-in requestFiles field.
    expect(Object.keys(sec1.schema.properties)).toEqual(expect.arrayContaining(['findings', 'requestFiles']));
    // ORCHESTRATOR_SCHEMA: the merge score.
    expect(Object.keys(orch.schema.properties)).toEqual(expect.arrayContaining(['findings', 'mergeScore']));
    expect(core.renderPrompt(orch.prompt as never)).toContain('SQL injection in findUser');
  });

  it('the fixture is a committed ~20-line diff', () => {
    const lines = readFileSync(probe.FIXTURE, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^diff --git /);
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(30);
  });

  describe('each failure mode exits 1', () => {
    it('empty plain text', async () => {
      const r = await run(fakeProvider({ plainText: '  ' }));
      expect(r.code).toBe(1);
      expect(r.records[0].problems).toContain('empty plain text');
    });

    it('a structured call with no tool_use (the provider throws)', async () => {
      const r = await run(fakeProvider({ structuredThrows: true }));
      expect(r.code).toBe(1);
      expect(r.records.slice(1).every((x: any) => x.ok === false && /no tool_use/.test(x.problems[0]))).toBe(true);
    });

    it('a stop_reason other than end_turn / tool_use', async () => {
      const r = await run(fakeProvider({ stopReason: 'max_tokens' }));
      expect(r.code).toBe(1);
      expect(r.records[0].problems).toContain('stop_reason max_tokens');
    });

    it('a refusal', async () => {
      const r = await run(fakeProvider({ stopReason: 'refusal' }));
      expect(r.code).toBe(1);
    });

    it('a missing model echo is a failure, not a pass', async () => {
      const r = await run(fakeProvider({ reportedModel: null }));
      expect(r.code).toBe(1);
      expect(r.records[0].reportedModel).toBeNull();
      expect(r.records[0].problems).toContain('no model reported');
    });

    it('a different reported model', async () => {
      const r = await run(fakeProvider({ reportedModel: 'claude-sonnet-4-6' }));
      expect(r.code).toBe(1);
      expect(r.records[0].problems[0]).toMatch(/reported claude-sonnet-4-6, wanted claude-sonnet-5-5/);
    });
  });

  it('the model check normalises the region and anthropic prefixes on both sides', async () => {
    for (const reported of ['claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6']) {
      const r = await run(fakeProvider({ reportedModel: reported }), 'AVAILABLE', 'us.anthropic.claude-sonnet-4-6');
      expect(r.code, reported).toBe(0);
    }
    expect(probe.normalizeModelId('global.anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(probe.baseModelId('us.anthropic.claude-sonnet-5-5')).toBe('anthropic.claude-sonnet-5-5');
  });
});
