#!/usr/bin/env node
/**
 * #722 — do the pricing and context-window tables still cover every Bedrock
 * Anthropic inference profile AWS offers?
 *
 * `DEFAULT_PRICING` and `CONTEXT_WINDOWS` are keyed by inference-profile id.
 * An id that is in neither prices at null, and a null-cost review is not
 * billed at all. AWS adds profiles without telling anyone, so the tables drift
 * silently.
 *
 * The tables are checked against a committed snapshot by a unit test
 * (`profiles-coverage.test.ts`). This script checks the snapshot against AWS:
 * ACTIVE Anthropic profiles in us-west-2, minus any whose base model has
 * reached end of life (`get-foundation-model` refuses those, and
 * `list-foundation-models` omits them, while the profiles stay ACTIVE).
 *
 *   node scripts/check-bedrock-profiles.mjs                 compare to the snapshot
 *   node scripts/check-bedrock-profiles.mjs --write         regenerate the snapshot
 *   node scripts/check-bedrock-profiles.mjs --snapshot <p>  compare to another file
 *
 * Exit 0 = snapshot matches AWS.
 * Exit 1 = drift (the ids are named).
 * Exit 2 = could not check (any AWS error other than EOL, or zero profiles) —
 *          never silence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Hardcoded: the snapshot describes one region, and comparing it to another
// region's list would report drift that is not drift.
const REGION = 'us-west-2';
const REPO = resolve(dirname(process.argv[1]), '..');
const argv = process.argv.slice(2);

const cannotCheck = (msg) => {
  console.error(`\n✗ COULD NOT CHECK — ${msg}`);
  console.error('  This is not a pass. The profiles were not compared.');
  process.exit(2);
};

// A flag with no value is a usage error, not drift: left to throw, node would
// exit 1 and the release gate would report it as ⚠️ drift.
const arg = (n, d) => {
  const i = argv.indexOf(n);
  if (i === -1) return d;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) cannotCheck(`${n} needs a value`);
  return v;
};
const WRITE = argv.includes('--write');
const SNAPSHOT = resolve(arg('--snapshot', resolve(REPO, 'packages/core/src/llm/bedrock-profiles.us-west-2.json')));

function bedrock(args) {
  return JSON.parse(execFileSync('aws', ['bedrock', ...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A hung call would stall the release gate; a timeout throws, and every
    // caller turns a throw into exit 2.
    timeout: 60_000,
  }));
}
const stderrOf = (e) => String(e.stderr || e.message);

/* ── ACTIVE Anthropic profiles ───────────────────────────────────────────── */
let summaries;
try {
  summaries = bedrock(['list-inference-profiles']).inferenceProfileSummaries ?? [];
} catch (e) {
  cannotCheck(`list-inference-profiles failed: ${stderrOf(e).trim()}`);
}
const active = summaries.filter((p) => p.status === 'ACTIVE' && /^[a-z]+\.anthropic\./.test(p.inferenceProfileId));
if (!active.length) cannotCheck('list-inference-profiles returned no ACTIVE Anthropic profiles — refusing to report that as drift');

/* ── drop profiles whose base model is end-of-life ───────────────────────── */
const baseOf = (p) => {
  const arn = p.models?.[0]?.modelArn ?? '';
  const id = arn.split('foundation-model/')[1];
  // The id becomes a CLI argument, so it must look like a model id and not a flag.
  if (!id || !/^[a-z][\w.-]*(:[\w.-]+)*$/i.test(id)) {
    cannotCheck(`profile ${p.inferenceProfileId} has no usable foundation-model ARN: ${arn}`);
  }
  return id;
};
const eol = new Map();
for (const base of new Set(active.map(baseOf))) {
  try {
    bedrock(['get-foundation-model', '--model-identifier', base]);
    eol.set(base, false);
  } catch (e) {
    // Only the EOL refusal is an answer. Anything else (no credentials, access
    // denied, throttling) means we do not know, and guessing either way would
    // make the result a lie.
    if (/end of its life/i.test(stderrOf(e))) eol.set(base, true);
    else cannotCheck(`get-foundation-model ${base} failed: ${stderrOf(e).trim()}`);
  }
}
const live = active.filter((p) => !eol.get(baseOf(p))).map((p) => p.inferenceProfileId).sort();
const retired = active.filter((p) => eol.get(baseOf(p))).map((p) => p.inferenceProfileId).sort();

console.log(`Region ${REGION}: ${active.length} ACTIVE Anthropic profiles, ${retired.length} on an end-of-life base model, ${live.length} live.`);
for (const id of retired) console.log(`  ignored (base model EOL): ${id}`);

if (WRITE) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(live, null, 2)}\n`);
  console.log(`\nWrote ${live.length} ids to ${SNAPSHOT}`);
  process.exit(0);
}

/* ── compare ─────────────────────────────────────────────────────────────── */
let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  if (!Array.isArray(snapshot)) throw new Error('not a JSON array');
} catch (e) {
  cannotCheck(`cannot read snapshot ${SNAPSHOT}: ${e.message}`);
}
const added = live.filter((id) => !snapshot.includes(id));
const gone = snapshot.filter((id) => !live.includes(id));

if (!added.length && !gone.length) {
  console.log(`\n✓ The snapshot matches AWS (${live.length} profiles).`);
  process.exit(0);
}

console.log('\n✗ DRIFT — the snapshot no longer matches AWS:\n');
for (const id of added) console.log(`    + ${id}   (live, not in the snapshot)`);
for (const id of gone) console.log(`    - ${id}   (in the snapshot, not live)`);
console.log('\n  Regenerate with `node scripts/check-bedrock-profiles.mjs --write`, then');
console.log('  price and window every new id: profiles-coverage.test.ts will name them.');
process.exit(1);
