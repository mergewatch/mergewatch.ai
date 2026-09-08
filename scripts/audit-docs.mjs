#!/usr/bin/env node
/**
 * Pre-release factual audit of README.md and docs-site/ (#576).
 *
 * The EXPENSIVE half of the docs audit. scripts/check-docs-structure.mjs
 * answers "does this resolve"; this answers "is this TRUE", which is the
 * question that actually drifts. `maxFindings` was documented correctly for
 * months while being silently unenforced — no structural check could ever
 * have caught that, because the sentence was well-formed and its target
 * existed. Only reading the prose against the code finds that class.
 *
 * How it works, per page:
 *   1. Pull the identifiers the page CLAIMS things about (backticked spans).
 *   2. Grep the real source for each one and attach what it finds.
 *   3. Ask the model to check the prose against that evidence, not against
 *      its own memory of how the product probably works.
 *
 * Step 2 is the whole design. An auditor given only the page will confabulate
 * agreement; an auditor given the page plus the code that implements it is
 * doing the same grounded comparison the review pipeline does on a diff.
 *
 * Exit codes — these are the point, not an afterthought:
 *   0  audited, no findings
 *   1  audited, findings present     → blocks the release, human adjudicates
 *   2  COULD NOT RUN                 → must never be read as clean
 *
 * #576 requires those three to stay distinguishable. Every gate lesson in
 * this repo is a variant of "nobody checked" and "checked and clean" being
 * rendered the same way.
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = resolve(dirname(process.argv[1]), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);

const LIMIT = Number(arg('--pages', '0')) || 0;
const OUT = arg('--out', '');
const CONCURRENCY = Number(arg('--concurrency', '5'));
const DRY = has('--dry-run');
const MODEL = arg('--model', process.env.AUDIT_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');

/** Anything that stops the audit from being an audit exits 2, never 0. */
function cannotRun(msg) {
  console.error(`\n✗ AUDIT DID NOT RUN — ${msg}`);
  console.error('  This is NOT a clean result. The docs were not checked.');
  process.exit(2);
}

/* ────────────────── ground truth, extracted deterministically ────────────── */

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

async function buildFactSheet() {
  const facts = [];

  // Config defaults come from the module the product actually reads, not a
  // regex over it — a doc table is worth checking against the real value.
  try {
    const core = await import(`file://${join(REPO, 'packages/core/dist/index.js')}`);
    const cfg = core.DEFAULT_CONFIG;
    if (!cfg) throw new Error('DEFAULT_CONFIG missing from @mergewatch/core');
    const flat = Object.entries(cfg)
      .map(([k, v]) => `  ${k} = ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
      .join('\n');
    facts.push(`## Real DEFAULT_CONFIG (packages/core/src/config/defaults.ts)\n${flat}`);
  } catch (e) {
    cannotRun(`could not load DEFAULT_CONFIG (${e.message}). Run \`pnpm run build\` first.`);
  }

  // Webhook events actually dispatched.
  const wh = join(REPO, 'packages/lambda/src/handlers/webhook.ts');
  if (existsSync(wh)) {
    const evts = [...readFileSync(wh, 'utf8').matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
    facts.push(`## Webhook events the product handles (webhook.ts dispatch)\n  ${[...new Set(evts)].join(', ')}`);
  }

  // Provider packages that exist.
  const pkgs = readdirSync(join(REPO, 'packages')).filter((p) => p.startsWith('llm-'));
  facts.push(`## LLM provider packages that exist\n  ${pkgs.join(', ')}`);

  // Scripts that exist, so a doc referencing a removed one is catchable.
  facts.push(`## Files in scripts/\n  ${readdirSync(join(REPO, 'scripts')).join(', ')}`);

  return facts.join('\n\n');
}

/* ────────────────── per-page retrieval: ground claims in real code ───────── */

const SRC = walk(join(REPO, 'packages'))
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('.test.'))
  .concat(walk(join(REPO, 'scripts')))
  .concat([join(REPO, 'infra/template.yaml')].filter(existsSync));

/** Identifiers a page makes claims about — the things worth grounding. */
function identifiers(text) {
  const ids = new Set();
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_.\-/]{2,60})`/g)) {
    const t = m[1];
    if (/^(https?|the|and|or|true|false|null)$/i.test(t)) continue;
    ids.add(t);
  }
  return [...ids].slice(0, 40);
}

/** grep the real source for an identifier; return a few anchoring lines. */
function evidenceFor(id, budget = 3) {
  const out = [];
  let rg;
  try {
    rg = execFileSync(
      'grep',
      ['-rn', '--include=*.ts', '--include=*.yaml', '--include=*.yml', '--include=*.mjs', '-F', id, 'packages', 'scripts', 'infra'],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 8e6, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return out; // grep exits 1 on no match — absence is itself a signal
  }
  for (const line of rg.split('\n')) {
    if (!line || line.includes('.test.')) continue;
    if (out.length >= budget) break;
    out.push(line.slice(0, 240));
  }
  return out;
}

function contextFor(pageText) {
  const blocks = [];
  let grounded = 0;
  for (const id of identifiers(pageText)) {
    const ev = evidenceFor(id);
    if (ev.length) {
      grounded++;
      blocks.push(`### \`${id}\` — found in source\n${ev.join('\n')}`);
    } else {
      blocks.push(`### \`${id}\` — NOT FOUND anywhere in packages/, scripts/ or infra/`);
    }
  }
  return { text: blocks.join('\n\n').slice(0, 24000), grounded, total: blocks.length };
}

/* ────────────────── the audit prompt ────────────────────────────────────── */

const SYSTEM = `You audit product documentation against the source code that implements it.

You will be given (a) extracted ground truth about the product, (b) grep evidence from the real
source for the identifiers this page mentions, and (c) one documentation page.

Report ONLY claims you can check against the evidence provided. Your own beliefs about how such a
product usually works are NOT evidence. If the evidence does not settle a claim, it belongs in
"unverifiable" — not in findings.

Report a finding when the page:
  - states a default, level, name or behaviour that contradicts the ground truth
  - describes something the evidence shows does not exist
  - claims an absolute ("never", "always", "cannot", "all") that the evidence contradicts or qualifies
  - contradicts itself elsewhere on the same page

Do NOT report: wording you would phrase differently, missing content you merely expect, style,
tone, marketing claims, or anything about the future. An audit that reports taste is one that
gets switched off.

Severity: "critical" only for a claim that would cause a reader to misconfigure the product or
misjudge its security posture. "warning" for a claim that is wrong but harmless. "info" for
incompleteness worth noting.`;

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          quote: { type: 'string', description: 'the exact sentence from the page that is wrong' },
          problem: { type: 'string', description: 'what it says vs what the evidence shows' },
          evidence: { type: 'string', description: 'the specific ground-truth line that settles it' },
        },
        required: ['severity', 'quote', 'problem', 'evidence'],
      },
    },
    unverifiable: {
      type: 'array',
      items: { type: 'string' },
      description: 'claims on this page that the provided evidence could not settle either way',
    },
  },
  required: ['findings', 'unverifiable'],
};

/* ────────────────── run ─────────────────────────────────────────────────── */

const pages = [
  ...(existsSync(join(REPO, 'README.md')) ? ['README.md'] : []),
  ...walk(join(REPO, 'docs-site')).filter((f) => f.endsWith('.mdx')).map((f) => relative(REPO, f)),
].slice(0, LIMIT || undefined);

if (!pages.length) cannotRun('no pages found to audit');

const factSheet = await buildFactSheet();

if (DRY) {
  const c = contextFor(readFileSync(join(REPO, pages[0]), 'utf8'));
  console.log(`Would audit ${pages.length} page(s) with model ${MODEL}.`);
  console.log(`Fact sheet: ${factSheet.length} chars.`);
  console.log(`Sample page ${pages[0]}: ${c.total} identifiers, ${c.grounded} grounded in source.`);
  process.exit(0);
}

let provider;
try {
  const { BedrockLLMProvider } = await import(`file://${join(REPO, 'packages/llm-bedrock/dist/index.js')}`);
  provider = new BedrockLLMProvider(process.env.AWS_REGION);
} catch (e) {
  cannotRun(`could not construct the Bedrock provider: ${e.message}`);
}

let inTok = 0, outTok = 0;
const results = [];
const failures = [];

async function auditPage(page) {
  const text = readFileSync(join(REPO, page), 'utf8');
  const ctx = contextFor(text);
  // Ordered least- to most-volatile so the fact sheet is a stable cache prefix
  // across all 64 calls (#489). The page itself changes every call.
  const segments = [
    { id: 'audit-facts', stability: 'static', text: `${SYSTEM}\n\n# Ground truth\n\n${factSheet}\n\n` },
    { id: 'page-evidence', stability: 'per-call', text: `# Source evidence for this page\n\n${ctx.text}\n\n# Page: ${page}\n\n${text.slice(0, 40000)}\n\nAudit this page.` },
  ];
  const r = await provider.invokeStructured(MODEL, segments, SCHEMA, 4096);
  inTok += r.usage?.inputTokens ?? 0;
  outTok += r.usage?.outputTokens ?? 0;
  return { page, ...r.value, grounded: ctx.grounded, identifiers: ctx.total };
}

const queue = [...pages];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const page = queue.shift();
      try {
        const r = await auditPage(page);
        results.push(r);
        const n = r.findings.length;
        process.stderr.write(`  ${n ? '✗' : '·'} ${page}${n ? ` — ${n} finding(s)` : ''}\n`);
      } catch (e) {
        failures.push({ page, error: e.message });
        process.stderr.write(`  ! ${page} — ${e.message}\n`);
      }
    }
  }),
);

/* ────────────────── report ──────────────────────────────────────────────── */

// A page that errored was NOT audited. Counting it as clean is the exact
// failure this script's exit codes exist to prevent, so it degrades the whole
// run to "did not run" rather than quietly shrinking the denominator.
const findings = results.flatMap((r) => r.findings.map((f) => ({ ...f, page: r.page })));
const rank = { critical: 0, warning: 1, info: 2 };
findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

let cost = 0;
try {
  const core = await import(`file://${join(REPO, 'packages/core/dist/index.js')}`);
  cost = core.estimateCost(MODEL, inTok, outTok) ?? 0;
} catch { /* cost is reporting only */ }

const lines = [];
lines.push('# Pre-release documentation audit');
lines.push('');
lines.push(`Audited **${results.length}/${pages.length}** page(s) against the codebase using \`${MODEL}\`.`);
lines.push(`Tokens: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out · est. **$${cost.toFixed(2)}**`);
lines.push('');

if (failures.length) {
  lines.push(`## ⚠️ ${failures.length} page(s) could not be audited`);
  lines.push('');
  lines.push('These pages were **not checked**. Treat this run as incomplete.');
  lines.push('');
  for (const f of failures) lines.push(`- \`${f.page}\` — ${f.error}`);
  lines.push('');
}

if (!findings.length) {
  lines.push('## ✅ No findings');
  lines.push('');
  lines.push('Every claim the evidence could settle agreed with the code.');
} else {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  lines.push(`## ${crit ? '🔴' : '🟡'} ${findings.length} finding(s)${crit ? ` — ${crit} critical` : ''}`);
  lines.push('');
  for (const f of findings) {
    const icon = { critical: '🔴', warning: '🟡', info: 'ℹ️' }[f.severity];
    lines.push(`### ${icon} \`${f.page}\``);
    lines.push('');
    lines.push(`> ${f.quote.replace(/\n/g, ' ')}`);
    lines.push('');
    lines.push(`**Problem:** ${f.problem}`);
    lines.push(`**Evidence:** ${f.evidence}`);
    lines.push('');
  }
}

// #576: "It must state what it could not check." A green audit that hides its
// blind spots is worth less than a red one that names them.
const unver = results.flatMap((r) => r.unverifiable.map((u) => ({ page: r.page, u })));
lines.push('## What this audit did NOT verify');
lines.push('');
lines.push('- **Prose quality, tone, positioning and marketing claims** — deliberately out of scope.');
lines.push('- **Claims about future behaviour** ("we will never…") — not checkable against code.');
lines.push('- **Screenshots** — no image is compared against the UI it depicts.');
lines.push('- **Runnability** — commands and examples are not executed.');
lines.push(`- **Ungrounded identifiers** — claims whose subject appears nowhere in the source are reported, but a claim about behaviour spread across many files may exceed the evidence gathered for it.`);
if (unver.length) {
  lines.push('');
  lines.push(`The model flagged ${unver.length} specific claim(s) it could not settle:`);
  lines.push('');
  for (const { page, u } of unver.slice(0, 40)) lines.push(`- \`${page}\` — ${u}`);
  if (unver.length > 40) lines.push(`- …and ${unver.length - 40} more.`);
}
lines.push('');

const report = lines.join('\n');
if (OUT) writeFileSync(OUT, report);
console.log(report);

if (failures.length) {
  console.error(`\n✗ ${failures.length} page(s) failed to audit — the run is incomplete.`);
  process.exit(2);
}
process.exit(findings.length ? 1 : 0);
