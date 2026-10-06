#!/usr/bin/env tsx
/**
 * #699 — `bench` entry point.
 *
 * Corpus paths are REPO-ROOT-RELATIVE, deliberately: `pnpm --filter
 * @mergewatch/bench run bench` executes with cwd at the package directory,
 * so a path that looked right on the command line would otherwise resolve
 * somewhere else in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { resolveInCorpus, validateManifest } from './manifest.js';
import { runBench } from './runner.js';
import { createCaseStub } from './stub.js';
import type { BenchManifest, BenchResult } from './types.js';

/** Walk up until the workspace root (the directory with pnpm-workspace.yaml). */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find pnpm-workspace.yaml above ${startDir}`);
}

/**
 * Resolve a path and refuse to leave the repo.
 *
 * Less about an attacker than about a misconfigured CI invocation: a wrong
 * `--corpus` would silently read some other file, parse it as a manifest and
 * bake whatever it found into a published artifact. A benchmark that can read
 * outside its own corpus cannot vouch for what it measured.
 */
export function resolveInRepo(repoRoot: string, candidate: string, flag: string): string {
  const resolved = resolve(repoRoot, candidate);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
    throw new Error(`${flag} must stay inside the repo: "${candidate}" resolves to ${resolved}`);
  }
  return resolved;
}

interface Args {
  corpus?: string;
  stub: boolean;
  maxSpendUsd?: number;
  arm?: string;
  out?: string;
  requireModelEcho: boolean;
  expect: { precision?: number; recall?: number; f1?: number };
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { stub: false, requireModelEcho: true, expect: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    // pnpm forwards the `--` separator through to argv, so a documented
    // `pnpm --filter ... run bench -- --corpus x` arrives with a bare `--`.
    if (a === '--') continue;
    if (a === '--corpus') args.corpus = next();
    else if (a === '--stub') args.stub = true;
    else if (a === '--max-spend-usd') args.maxSpendUsd = Number(next());
    else if (a === '--arm') args.arm = next();
    else if (a === '--out') args.out = next();
    else if (a === '--no-require-model-echo') args.requireModelEcho = false;
    else if (a === '--expect-precision') args.expect.precision = Number(next());
    else if (a === '--expect-recall') args.expect.recall = Number(next());
    else if (a === '--expect-f1') args.expect.f1 = Number(next());
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Compare near-exactly (1e-9). An expectation is a hand-computed value, so it
 * should match the computed metric and not merely round to it: at a looser
 * tolerance, 0.5001 and 0.5 compare equal and the assertion stops being able
 * to fail. Pass the full-precision value, as the README does.
 */
export function assertExpectations(
  result: BenchResult,
  expect: Args['expect'],
): string[] {
  const failures: string[] = [];
  const check = (name: 'precision' | 'recall' | 'f1') => {
    const want = expect[name];
    if (want === undefined) return;
    const got = result.totals[name];
    if (Math.abs(got - want) > 1e-9) {
      failures.push(`${name}: expected ${want}, got ${got.toFixed(6)}`);
    }
  };
  check('precision');
  check('recall');
  check('f1');
  return failures;
}

function summarize(r: BenchResult): string {
  const lines = [
    `corpus: ${r.corpus}${r.arm ? `  arm: ${r.arm}` : ''}`,
    `precision ${r.totals.precision.toFixed(4)}  recall ${r.totals.recall.toFixed(4)}  f1 ${r.totals.f1.toFixed(4)}`,
    `TP ${r.totals.truePositives}  FP ${r.totals.falsePositives}  FN ${r.totals.falseNegatives}`,
    `cases attempted ${r.totals.casesAttempted}  graded ${r.totals.casesGraded}  skipped ${r.totals.casesSkipped}`,
    `spend $${r.totals.spendUsd.toFixed(4)}`,
    '',
    'case                            outcome        grounding(att/ok/fail/files)  model',
  ];
  for (const c of r.cases) {
    const outcomes = c.skip
      ? `skip:${c.skip}`
      : c.grade.groundTruths.map((g) => g.outcome).join(',') || 'no-ground-truth';
    const g = c.grounding;
    lines.push(
      `${c.id.padEnd(31)} ${outcomes.padEnd(14)} ${`${g.attempted}/${g.succeeded}/${g.failed}/${g.filesFetched}`.padEnd(29)} ${c.reportedModels.join(',') || '(none)'}`,
    );
  }
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.corpus) {
    console.error('bench: --corpus <repo-root-relative path> is required');
    return 2;
  }
  const repoRoot = findRepoRoot(process.cwd());
  let corpusPath: string;
  try {
    corpusPath = resolveInRepo(repoRoot, args.corpus, '--corpus');
  } catch (err) {
    console.error(`bench: ${(err as Error).message}`);
    return 2;
  }
  const manifestDir = dirname(corpusPath);
  let manifest: BenchManifest;
  try {
    // Validated, not cast: a manifest missing `lineTolerance` would make
    // every location comparison false and publish a silent recall of 0.
    manifest = validateManifest(JSON.parse(readFileSync(corpusPath, 'utf-8')), manifestDir);
  } catch (err) {
    console.error(`bench: ${(err as Error).message}`);
    return 2;
  }

  if (!args.stub) {
    console.error(
      'bench: only --stub runs are supported today. A real provider run spends ' +
        'money, so it is wired per consuming ticket (#314, #610, #700) after an ' +
        'explicit spend approval.',
    );
    return 2;
  }

  let commitSha: string | undefined;
  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    commitSha = undefined;
  }

  let result: BenchResult;
  try {
    result = await runBench({
      manifest,
      readDiff: async (p) => readFileSync(resolveInCorpus(manifestDir, p), 'utf-8'),
      llm: (bcase) => createCaseStub(bcase),
      arm: args.arm,
      commitSha,
      maxSpendUsd: args.maxSpendUsd,
      requireModelEcho: args.requireModelEcho,
    });
  } catch (err) {
    console.error(`bench: ${(err as Error).message}`);
    return 1;
  }

  console.log(summarize(result));

  if (args.out) {
    let outPath: string;
    try {
      outPath = resolveInRepo(repoRoot, args.out, '--out');
    } catch (err) {
      console.error(`bench: ${(err as Error).message}`);
      return 2;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${args.out}`);
  }

  const failures = assertExpectations(result, args.expect);
  if (failures.length > 0) {
    console.error(`\nbench: expectations not met:\n  ${failures.join('\n  ')}`);
    return 1;
  }
  return 0;
}

/* c8 ignore start -- process shell, exercised via `pnpm run bench` */
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
/* c8 ignore stop */
