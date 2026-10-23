#!/usr/bin/env node
/**
 * #721 — does a Bedrock model actually work for a review, before any deploy
 * default points at it?
 *
 * Every field can read green and the model still fail: Sonnet 5 once returned
 * AccessDenied with all of them set (infra/params/prod.env). So the proof of
 * access is a real call through the built `BedrockLLMProvider`, using the
 * prompts and schemas a review sends — a toy prompt that names the tool can
 * pass while production does not.
 *
 *   AWS_PROFILE=mergewatch node scripts/probe-bedrock-model.mjs <modelId>
 *
 * Calls (all at 4096 max tokens, under $0.50 in total):
 *   1 plain text call;
 *   3 structured calls with the real security-agent prompt over the committed
 *     fixture diff, and AGENT_FINDINGS_SCHEMA;
 *   1 structured call with the real orchestrator prompt and ORCHESTRATOR_SCHEMA.
 * The prompts and schemas are captured from `runSecurityAgent` /
 * `runOrchestratorAgent` themselves, so they cannot drift from production.
 *
 * THE AGREEMENT GATE. A first invoke of a third-party model auto-accepts its
 * Marketplace agreement, and the credentials an agent runs with are allowed
 * to. Accepting it is a human's decision. So before anything is invoked, this
 * script asks `get-foundation-model-availability` and stops unless the
 * agreement already reads AVAILABLE.
 *
 * Exit 0 = every call passed. One JSON record per call is printed.
 * Exit 1 = a call failed: an error, empty plain text, no tool_use, a
 *          stop_reason other than end_turn/tool_use, or a reported model that
 *          is missing or is not the requested one.
 * Exit 2 = usage error, or the build is missing.
 * Exit 3 = the agreement gate is not passed (or could not be read). Nothing
 *          was invoked.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGION = 'us-west-2';
const MAX_TOKENS = 4096;
const STRUCTURED_REPEATS = 3;
const OK_STOPS = new Set(['end_turn', 'tool_use']);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = resolve(REPO, 'scripts/fixtures/probe-bedrock-model.diff');

/** `us.anthropic.claude-x` → `claude-x`: the form the response body echoes. */
export const normalizeModelId = (id) =>
  id.replace(/^(?:us|global|eu|apac)\./, '').replace(/^anthropic\./, '');

/**
 * Whether the echoed model is the requested one. A bare prefix is not enough:
 * `claude-sonnet-5-5` starts with `claude-sonnet-5`. Only a date, a `-vN` or a
 * `:N` suffix may follow.
 */
export const isRequestedModel = (reported, requested) => {
  const r = normalizeModelId(reported);
  const want = normalizeModelId(requested);
  return r.startsWith(want) && /^(?:$|-\d{8}|-v\d|:)/.test(r.slice(want.length));
};

/** `us.anthropic.claude-x` → `anthropic.claude-x`: the agreement's model id. */
export const baseModelId = (id) => id.replace(/^(?:us|global|eu|apac)\./, '');

/** Reads the agreement status with the AWS CLI. Never invokes the model. */
export function cliAvailability(modelId) {
  const out = execFileSync('aws', [
    'bedrock', 'get-foundation-model-availability',
    '--model-id', baseModelId(modelId),
    '--region', REGION, '--output', 'json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

/**
 * Captures the exact (prompt, schema, sampling) a review sends, by running the
 * real agent functions against a provider that records instead of calling out.
 */
export async function captureReviewCalls(core, modelId, diff) {
  const seen = [];
  const recorder = (object) => ({
    async invoke() { throw new Error('probe capture: the text path must not be reached'); },
    async invokeStructured(_m, prompt, schema, _t, sampling) {
      seen.push({ prompt, schema, sampling });
      return { object };
    },
  });
  const context = { owner: 'mergewatch', repo: 'probe', prNumber: 1, prTitle: 'Probe', prBody: 'Bedrock model probe (#721).' };
  await core.runSecurityAgent(diff, context, modelId, recorder({ findings: [] }));
  const security = seen.pop();
  const finding = {
    file: 'src/users.ts', line: 5, severity: 'critical', confidence: 95,
    title: 'SQL injection in findUser',
    description: 'The name is interpolated into the SQL string.',
    suggestion: 'Use a parameterized query.',
  };
  await core.runOrchestratorAgent(
    [{ category: 'security', findings: [finding] }], modelId, 25,
    recorder({ findings: [], mergeScore: 5, mergeScoreReason: 'capture' }),
  );
  const orchestrator = seen.pop();
  if (!security || !orchestrator) throw new Error('probe capture: an agent did not use the structured path');
  return { security, orchestrator };
}

/**
 * Wraps the provider's send so the raw body (block types) can be recorded.
 * A provider without that hook (a test fake) records `blockTypes: null`.
 */
function observe(provider) {
  let last = null;
  const send = provider.sendWithSignatureRecovery;
  if (typeof send === 'function') {
    provider.sendWithSignatureRecovery = async (command) => {
      const r = await send.call(provider, command);
      try { last = JSON.parse(new TextDecoder().decode(r.body)); } catch { last = null; }
      return r;
    };
  }
  return () => { const v = last; last = null; return v; };
}

/**
 * Runs the probe. Everything with a side effect is injected, so it can be
 * tested without AWS. `provider` and `core` are async loaders, called only
 * after the gate passes. Returns the exit code.
 */
export async function runProbe({ modelId, availability, provider, core, diff, out = console.log, err = console.error }) {
  if (!modelId) { err('usage: node scripts/probe-bedrock-model.mjs <modelId>'); return 2; }

  // ── the agreement gate, before anything is invoked ──────────────────────
  let status;
  try {
    status = (await availability(modelId))?.agreementAvailability?.status;
  } catch (e) {
    err(`✗ GATE NOT CHECKED — get-foundation-model-availability failed: ${String(e.stderr || e.message).trim()}`);
    err('  Nothing was invoked.');
    return 3;
  }
  if (status !== 'AVAILABLE') {
    err(`✗ GATE NOT PASSED — agreementAvailability for ${baseModelId(modelId)} is ${status ?? 'missing'}, not AVAILABLE.`);
    err('  A person must accept the model agreement first. Nothing was invoked.');
    return 3;
  }

  const llm = await provider();
  const lastRaw = observe(llm);
  const want = normalizeModelId(modelId);
  const { security, orchestrator } = await captureReviewCalls(await core(), modelId, diff);

  const calls = [
    { name: 'plain', run: () => llm.invoke(modelId, 'Reply with the single word OK.', MAX_TOKENS) },
    ...Array.from({ length: STRUCTURED_REPEATS }, (_, i) => ({
      name: `security-${i + 1}`,
      structured: true,
      run: () => llm.invokeStructured(modelId, security.prompt, security.schema, MAX_TOKENS, security.sampling),
    })),
    {
      name: 'orchestrator',
      structured: true,
      run: () => llm.invokeStructured(modelId, orchestrator.prompt, orchestrator.schema, MAX_TOKENS, orchestrator.sampling),
    },
  ];

  let failed = 0;
  for (const call of calls) {
    const record = { call: call.name, requestedModel: modelId };
    const problems = [];
    try {
      const r = await call.run();
      const raw = lastRaw();
      Object.assign(record, {
        reportedModel: r.modelId ?? null,
        stopReason: r.stopReason ?? null,
        blockTypes: Array.isArray(raw?.content) ? raw.content.map((b) => b.type) : null,
        usage: r.usage ?? null,
      });
      if (!call.structured && !(typeof r.text === 'string' && r.text.trim())) problems.push('empty plain text');
      if (call.structured && r.object === undefined) problems.push('no tool_use');
      if (!OK_STOPS.has(r.stopReason)) problems.push(`stop_reason ${r.stopReason}`);
      if (!r.modelId) problems.push('no model reported');
      else if (!isRequestedModel(r.modelId, modelId)) problems.push(`reported ${r.modelId}, wanted ${want}`);
    } catch (e) {
      // The provider throws when a structured call returns no tool_use.
      problems.push(`error: ${e.message}`);
    }
    record.ok = problems.length === 0;
    if (problems.length) { record.problems = problems; failed++; }
    out(JSON.stringify(record));
  }

  if (failed) { err(`\n✗ ${failed} of ${calls.length} calls failed on ${modelId}.`); return 1; }
  out(`\n✓ All ${calls.length} calls passed on ${modelId}.`);
  return 0;
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const modelId = process.argv[2];
  // Loaded lazily, AFTER the gate: an exit-3 run never even loads the SDK.
  const load = (pkg) => import(pathToFileURL(resolve(REPO, `packages/${pkg}/dist/index.js`)).href);
  const provider = async () => new (await load('llm-bedrock')).BedrockLLMProvider(REGION);
  const core = () => load('core');
  let code;
  try {
    code = await runProbe({
      modelId,
      availability: cliAvailability,
      provider,
      core,
      diff: readFileSync(FIXTURE, 'utf8'),
    });
  } catch (e) {
    console.error(`✗ ${e.message}${/Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message) ? ' — run `pnpm run build` first' : ''}`);
    code = /Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message) ? 2 : 1;
  }
  process.exit(code);
}
