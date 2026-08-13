#!/usr/bin/env npx tsx
/**
 * =============================================================================
 * MergeWatch OSS Program — grant management (#261)
 * =============================================================================
 *
 * Writes the sponsored-review entitlement for approved open-source
 * repositories. This is the ONLY thing that writes OSS grant fields; there is
 * no admin API route and no dashboard granting UI, by design. The `#SETTINGS`
 * row is therefore the sole record of who was granted what and why, which is
 * what `--note` and `--inspect` exist for.
 *
 * Usage:
 *   scripts/grant-oss.ts <owner/repo>[,<owner/repo>…] --stage dev|prod [options]
 *   scripts/grant-oss.ts --add <owner/repo>     --stage …
 *   scripts/grant-oss.ts --remove <owner/repo>  --stage …
 *   scripts/grant-oss.ts --revoke <owner/repo>  --stage …
 *   scripts/grant-oss.ts --inspect <owner/repo> --stage …
 *
 * Options:
 *   --stage dev|prod   REQUIRED. No default — a grant must never land in the
 *                      wrong environment because someone forgot a flag.
 *   --cap <cents>      Monthly fair-use ceiling (default 2000 = $20).
 *   --months <n>       Grant term (default 12).
 *   --note "<text>"    Provenance: application reference, project, approver.
 *   --yes              Skip the confirmation prompt (for scripted use).
 *
 * Prerequisites:
 *   - AWS credentials for the `mergewatch` profile, with SSM read on the
 *     GitHub App parameters and write access to the installations table.
 *   - The maintainer has already installed the GitHub App on the repository
 *     (that is what creates the installation this grant attaches to).
 * =============================================================================
 */

import { createInterface } from 'node:readline/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

const PROFILE = 'mergewatch';
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const SETTINGS_SK = '#SETTINGS';
const DEFAULT_CAP_CENTS = 2000;
const DEFAULT_TERM_MONTHS = 12;

// --- Arg parsing -------------------------------------------------------------

interface Args {
  repos: string[];
  stage: string;
  mode: 'grant' | 'add' | 'remove' | 'revoke' | 'inspect';
  capCents: number;
  months: number;
  note?: string;
  yes: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function parseArgs(argv: string[]): Args {
  const modes = [
    ['--add', 'add'],
    ['--remove', 'remove'],
    ['--revoke', 'revoke'],
    ['--inspect', 'inspect'],
  ] as const;

  let mode: Args['mode'] = 'grant';
  let repoArg: string | undefined;

  for (const [f, m] of modes) {
    const v = flag(argv, f);
    if (v !== undefined) {
      mode = m;
      repoArg = v;
      break;
    }
  }
  if (mode === 'grant') repoArg = argv.find((a) => !a.startsWith('--') && a.includes('/'));

  const stage = flag(argv, '--stage');
  if (!stage || !['dev', 'prod'].includes(stage)) {
    fail(
      'Refusing to run without an explicit --stage dev|prod.\n'
      + 'This writes to a live table; defaulting the environment is how a grant\n'
      + 'lands in the wrong one.',
    );
  }
  if (!repoArg) fail('No repository given. Expected owner/repo.');

  const repos = repoArg!.split(',').map((r) => r.trim()).filter(Boolean);
  for (const r of repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(r)) fail(`Not an owner/repo: ${r}`);
  }

  const capCents = Number(flag(argv, '--cap') ?? DEFAULT_CAP_CENTS);
  const months = Number(flag(argv, '--months') ?? DEFAULT_TERM_MONTHS);
  // A zero or negative cap is almost certainly a typo, and it produces a grant
  // that is active but sponsors nothing — the most confusing possible state for
  // a maintainer. Reject it here rather than letting it reach the row.
  if (!Number.isFinite(capCents) || capCents <= 0) {
    fail(`--cap must be a positive number of cents (got ${flag(argv, '--cap')}). Use --revoke to end a grant.`);
  }
  if (!Number.isFinite(months) || months <= 0) {
    fail(`--months must be a positive number (got ${flag(argv, '--months')}).`);
  }

  return {
    repos,
    stage: stage!,
    mode,
    capCents,
    months,
    note: flag(argv, '--note'),
    yes: argv.includes('--yes'),
  };
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- AWS + GitHub clients -----------------------------------------------------

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ profile: PROFILE, region: REGION }));
const ssm = new SSMClient({ profile: PROFILE, region: REGION });

async function ssmParam(name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) fail(`SSM parameter ${name} is empty or missing.`);
  return value!;
}

/**
 * Two Octokit flavors are needed, because they can reach different endpoints.
 *
 * A GitHub **App JWT** can call `GET /repos/{owner}/{repo}/installation` — the
 * repo→installation lookup this whole script hinges on, and the reason this
 * isn't a `gh api` one-liner (`gh` authenticates as a user and cannot reach
 * it). But a JWT cannot read repository content endpoints.
 *
 * An **installation token** can call `GET /repos/{owner}/{repo}` for the id,
 * visibility, and activity signals. So: JWT resolves the installation, then an
 * installation client reads the repo.
 */
async function githubClients(stage: string) {
  const [appIdRaw, privateKey] = await Promise.all([
    ssmParam(`/mergewatch/${stage}/github-app-id`),
    ssmParam(`/mergewatch/${stage}/github-private-key`),
  ]);
  const appId = Number(appIdRaw);

  const auth = createAppAuth({ appId, privateKey });
  const { token: jwt } = await auth({ type: 'app' });

  return {
    jwt: new Octokit({ auth: jwt }),
    forInstallation: (installationId: number) =>
      new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
      }),
  };
}

type GitHubClients = Awaited<ReturnType<typeof githubClients>>;

// --- Repo + installation resolution -------------------------------------------

interface ResolvedRepo {
  id: number;
  fullName: string;
  isPublic: boolean;
  pushedAt: string | null;
  openIssues: number;
  installationId: string;
}

async function resolveRepo(gh: GitHubClients, fullName: string): Promise<ResolvedRepo> {
  const [owner, repo] = fullName.split('/');

  // 1. JWT: which installation owns this repo?
  let installationId: number;
  try {
    const inst = await gh.jwt.apps.getRepoInstallation({ owner, repo });
    installationId = inst.data.id;
  } catch (err) {
    fail(
      `The MergeWatch App is not installed on ${fullName} (or it does not exist).\n`
      + 'Ask the maintainer to install it first — the installation is what a grant\n'
      + `attaches to. GitHub said: ${(err as Error).message}`,
    );
  }

  // 2. Installation token: read the repo itself.
  let data;
  try {
    ({ data } = await gh.forInstallation(installationId!).repos.get({ owner, repo }));
  } catch (err) {
    fail(`Could not read ${fullName}: ${(err as Error).message}`);
  }

  return {
    id: data!.id,
    fullName: data!.full_name,
    isPublic: !data!.private,
    pushedAt: data!.pushed_at ?? null,
    openIssues: data!.open_issues_count ?? 0,
    installationId: String(installationId!),
  };
}

// --- DynamoDB -----------------------------------------------------------------

const table = (stage: string) => process.env.INSTALLATIONS_TABLE ?? `mergewatch-installations-${stage}`;

interface OssGrantRepo { id: number; fullName: string }

interface GrantFields {
  ossGrantRepos?: OssGrantRepo[];
  ossGrantExpiresAt?: string;
  ossGrantedAt?: string;
  ossGrantNote?: string;
  ossMonthlyCapCents?: number;
  ossPeriod?: string;
  ossSponsoredCentsThisPeriod?: number;
  ossSponsoredCentsLifetime?: number;
}

async function readGrant(stage: string, installationId: string): Promise<GrantFields> {
  const res = await dynamo.send(new GetCommand({
    TableName: table(stage),
    Key: { installationId, repoFullName: SETTINGS_SK },
  }));
  return (res.Item as GrantFields) ?? {};
}

/** Every repo row under this installation — the blast-radius view. */
async function installationRepos(stage: string, installationId: string): Promise<string[]> {
  const out: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await dynamo.send(new QueryCommand({
      TableName: table(stage),
      KeyConditionExpression: 'installationId = :id',
      ExpressionAttributeValues: { ':id': installationId },
      ProjectionExpression: 'repoFullName',
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res.Items ?? []) {
      const name = (item as { repoFullName: string }).repoFullName;
      if (!name.startsWith('#')) out.push(name);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.sort();
}

async function writeGrant(
  stage: string,
  installationId: string,
  fields: Required<Pick<GrantFields, 'ossGrantRepos' | 'ossGrantExpiresAt' | 'ossMonthlyCapCents'>>
    & Pick<GrantFields, 'ossGrantedAt' | 'ossGrantNote'>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await dynamo.send(new UpdateCommand({
    TableName: table(stage),
    Key: { installationId, repoFullName: SETTINGS_SK },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// --- Presentation --------------------------------------------------------------

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function renderGrant(grant: GrantFields, installationId: string): void {
  const repos = grant.ossGrantRepos ?? [];
  const expires = grant.ossGrantExpiresAt;
  const active = !!expires && Date.parse(expires) > Date.now() && repos.length > 0;

  console.log(`\nInstallation ${installationId}`);
  console.log(`  Status        ${active ? '✓ active' : '✗ no active grant'}`);
  if (!expires && repos.length === 0) return;

  console.log(`  Covered repos ${repos.length ? repos.map((r) => `${r.fullName} (id ${r.id})`).join('\n                ') : '(none)'}`);
  console.log(`  Expires       ${expires ?? '(unset)'}`);
  console.log(`  Granted       ${grant.ossGrantedAt ?? '(unknown)'}`);
  console.log(`  Note          ${grant.ossGrantNote ?? '(none)'}`);
  console.log(`  Monthly cap   ${grant.ossMonthlyCapCents != null ? usd(grant.ossMonthlyCapCents) : '(uncapped)'}`);
  console.log(`  This period   ${grant.ossPeriod ?? '(none)'} — ${usd(grant.ossSponsoredCentsThisPeriod ?? 0)} sponsored`);
  console.log(`  Lifetime      ${usd(grant.ossSponsoredCentsLifetime ?? 0)} sponsored`);
}

async function confirm(question: string, skip: boolean): Promise<boolean> {
  if (skip) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

// --- Main ----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gh = await githubClients(args.stage);

  const resolved = await Promise.all(args.repos.map((r) => resolveRepo(gh, r)));

  // One grant lives on one installation. Mixing repos from different
  // installations into a single invocation would silently write only one.
  const installationIds = [...new Set(resolved.map((r) => r.installationId))];
  if (installationIds.length > 1) {
    fail(
      `Those repos belong to different installations (${installationIds.join(', ')}).\n`
      + 'Grants are per-installation — run the script once per installation.',
    );
  }
  const installationId = installationIds[0];
  const existing = await readGrant(args.stage, installationId);

  if (args.mode === 'inspect') {
    renderGrant(existing, installationId);
    console.log();
    return;
  }

  // Eligibility: public repos only. Checked here as a courtesy to the operator;
  // the gate re-checks visibility live on every review, which is what actually
  // stops a repo flipped private later from staying sponsored.
  if (args.mode === 'grant' || args.mode === 'add') {
    for (const r of resolved) {
      if (!r.isPublic) fail(`${r.fullName} is private. The OSS Program covers public repositories only.`);
      console.log(`✓ ${r.fullName} — public, last pushed ${r.pushedAt ?? 'unknown'}, ${r.openIssues} open issues`);
    }
  }

  const current = existing.ossGrantRepos ?? [];
  let next: OssGrantRepo[];
  switch (args.mode) {
    case 'grant':
      next = resolved.map((r) => ({ id: r.id, fullName: r.fullName }));
      break;
    case 'add':
      next = [...current.filter((c) => !resolved.some((r) => r.id === c.id)),
              ...resolved.map((r) => ({ id: r.id, fullName: r.fullName }))];
      break;
    case 'remove':
      next = current.filter((c) => !resolved.some((r) => r.id === c.id));
      break;
    case 'revoke':
      next = current;
      break;
  }

  const revoking = args.mode === 'revoke';
  const expiresAt = revoking
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(new Date().setMonth(new Date().getMonth() + args.months)).toISOString();

  // Blast radius: what this covers, and — just as important — what in the same
  // installation it does not, so an accidental omission is visible before the write.
  const allRepos = await installationRepos(args.stage, installationId);
  const coveredNames = new Set(next.map((r) => r.fullName));
  const uncovered = allRepos.filter((n) => !coveredNames.has(n));

  console.log(`\n── ${args.mode.toUpperCase()} · stage=${args.stage} · installation ${installationId} ──`);
  if (revoking) {
    console.log(`  Revoking the grant (expiry set to the past). Reviews fall back to the`);
    console.log(`  standard free-tier/balance gate — they are not blocked outright.`);
  } else {
    console.log(`  Will sponsor ${next.length} repo(s):`);
    for (const r of next) console.log(`    • ${r.fullName} (id ${r.id})`);
    if (uncovered.length) {
      console.log(`  NOT covered in this installation:`);
      for (const n of uncovered) console.log(`    · ${n}`);
    }
    console.log(`  Monthly cap  ${usd(args.capCents)} (shared across the repos above)`);
    console.log(`  Expires      ${expiresAt}`);
    if (args.note) console.log(`  Note         ${args.note}`);
  }

  if (!next.length && !revoking) {
    fail('That would leave the grant with no repositories. Use --revoke to end it instead.');
  }

  if (!(await confirm('\nProceed?', args.yes))) {
    console.log('Aborted. Nothing written.\n');
    return;
  }

  await writeGrant(args.stage, installationId, {
    ossGrantRepos: next,
    ossGrantExpiresAt: expiresAt,
    ossMonthlyCapCents: args.capCents,
    ossGrantedAt: new Date().toISOString(),
    ...(args.note ? { ossGrantNote: args.note } : {}),
  });

  console.log('\n✓ Written.');
  renderGrant(await readGrant(args.stage, installationId), installationId);
  console.log();
}

main().catch((err) => {
  console.error('\n✗ Failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
