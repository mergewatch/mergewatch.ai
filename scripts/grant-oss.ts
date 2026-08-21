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
 * Usage — repo-scoped grants (#261):
 *   scripts/grant-oss.ts <owner/repo>[,<owner/repo>…] --stage dev|prod [options]
 *   scripts/grant-oss.ts --add <owner/repo>     --stage …
 *   scripts/grant-oss.ts --remove <owner/repo>  --stage …
 *
 * Usage — org-scoped grants (#409), covering every PUBLIC repo in the org:
 *   scripts/grant-oss.ts --org <org-login> --stage …
 *
 * Usage — pre-approval (#409), for an org that has NOT installed yet:
 *   scripts/grant-oss.ts --preapprove <org-login> --stage …
 *   scripts/grant-oss.ts --list-preapprovals --stage …
 *
 * Usage — lifecycle, against either a repo or an org:
 *   scripts/grant-oss.ts --revoke  <owner/repo> --stage …
 *   scripts/grant-oss.ts --revoke  --org <org-login> --stage …
 *   scripts/grant-oss.ts --inspect <owner/repo> --stage …
 *   scripts/grant-oss.ts --inspect --org <org-login> --stage …
 *
 * Options:
 *   --stage dev|prod   REQUIRED. No default — a grant must never land in the
 *                      wrong environment because someone forgot a flag.
 *   --cap <cents>      Monthly fair-use ceiling (default 2000 = $20).
 *   --months <n>       Grant term (default 12).
 *   --ttl-days <n>     Pre-approval lifetime before it goes stale (default 90).
 *   --note "<text>"    Provenance: application reference, project, approver.
 *   --yes              Skip the confirmation prompt (for scripted use).
 *
 * Prerequisites:
 *   - AWS credentials for the `mergewatch` profile, with SSM read on the
 *     GitHub App parameters and write access to the installations table.
 *   - For everything EXCEPT `--preapprove`: the maintainer has already
 *     installed the GitHub App (that is what creates the installation a grant
 *     attaches to). `--preapprove` exists precisely for the case where they
 *     have not.
 * =============================================================================
 */

import { createInterface } from 'node:readline/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

const PROFILE = 'mergewatch';
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const SETTINGS_SK = '#SETTINGS';

/**
 * Mirrors of `@mergewatch/billing`'s constants and pre-approval row shape.
 *
 * Duplicated deliberately: workspace packages do not resolve from the repo
 * root, so this script can only import hoisted third-party deps (the AWS SDK,
 * Octokit) — never `@mergewatch/*`. `DEFAULT_CAP_CENTS` and
 * `DEFAULT_TERM_MONTHS` were already duplicated here for the same reason.
 *
 * Source of truth: `packages/billing/src/constants.ts` and
 * `packages/billing/src/oss-preapproval.ts`. Keep them in step.
 */
const DEFAULT_CAP_CENTS = 2000;
const DEFAULT_TERM_MONTHS = 12;
const DEFAULT_PREAPPROVAL_TTL_DAYS = 90;
const PREAPPROVAL_PK = '#PENDING-OSS';

// --- Arg parsing -------------------------------------------------------------

interface Args {
  /** owner/repo targets. Empty for org-targeted and pre-approval modes. */
  repos: string[];
  /** Org (or user) login, for `--org` / `--preapprove`. */
  orgLogin?: string;
  stage: string;
  mode: 'grant' | 'org' | 'preapprove' | 'list-preapprovals'
      | 'add' | 'remove' | 'revoke' | 'inspect';
  capCents: number;
  months: number;
  ttlDays: number;
  note?: string;
  yes: boolean;
}

/**
 * Value of `--flag <value>`, or undefined.
 *
 * A following token that itself starts with `--` is NOT a value: that is what
 * makes `--revoke --org acme` parse as "revoke, targeting an org" rather than
 * silently trying to revoke a repository literally named `--org`.
 */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

function parseArgs(argv: string[]): Args {
  const stage = flag(argv, '--stage');
  if (!stage || !['dev', 'prod'].includes(stage)) {
    fail(
      'Refusing to run without an explicit --stage dev|prod.\n'
      + 'This writes to a live table; defaulting the environment is how a grant\n'
      + 'lands in the wrong one.',
    );
  }

  const orgLogin = flag(argv, '--org');
  const preapproveLogin = flag(argv, '--preapprove');

  // Positional repo args: anything that isn't a flag and looks like owner/repo.
  // Values consumed by flags are excluded so `--note "a/b"` isn't read as a repo.
  const consumed = new Set<string>();
  for (const f of ['--stage', '--org', '--preapprove', '--add', '--remove',
                   '--revoke', '--inspect', '--cap', '--months', '--ttl-days', '--note']) {
    const v = flag(argv, f);
    if (v !== undefined) consumed.add(v);
  }
  const positionalRepos = argv.filter(
    (a) => !a.startsWith('--') && a.includes('/') && !consumed.has(a),
  );

  let mode: Args['mode'];
  let repoArg: string | undefined;

  if (argv.includes('--list-preapprovals')) {
    mode = 'list-preapprovals';
  } else if (argv.includes('--preapprove')) {
    mode = 'preapprove';
    if (!preapproveLogin) fail('--preapprove needs an org login, e.g. --preapprove acme-corp');
  } else if (argv.includes('--inspect')) {
    mode = 'inspect';
    repoArg = flag(argv, '--inspect');
  } else if (argv.includes('--revoke')) {
    mode = 'revoke';
    repoArg = flag(argv, '--revoke');
  } else if (argv.includes('--add')) {
    mode = 'add';
    repoArg = flag(argv, '--add');
  } else if (argv.includes('--remove')) {
    mode = 'remove';
    repoArg = flag(argv, '--remove');
  } else if (orgLogin) {
    mode = 'org';
  } else {
    mode = 'grant';
    repoArg = positionalRepos[0];
  }

  // An org login and a repo list mean two different coverage models. Guessing
  // which one the operator meant is exactly the kind of silent wrong answer a
  // grant script must never give.
  const repoTargets = repoArg ?? (mode === 'grant' ? undefined : positionalRepos[0]);
  if (orgLogin && repoTargets && mode !== 'inspect' && mode !== 'revoke') {
    fail(
      `--org ${orgLogin} covers every public repo in the org, but you also named\n`
      + `repositories (${repoTargets}). Pick one: --org for org-wide, or a repo list\n`
      + 'for named repos only.',
    );
  }
  if (mode === 'org' && positionalRepos.length) {
    fail(
      `--org ${orgLogin} covers every public repo in the org, but you also named\n`
      + `repositories (${positionalRepos.join(', ')}). Pick one.`,
    );
  }

  const needsTarget = ['grant', 'add', 'remove', 'revoke', 'inspect'].includes(mode);
  if (needsTarget && !repoTargets && !orgLogin) {
    fail('No target given. Expected owner/repo, or --org <org-login>.');
  }

  const repos = repoTargets
    ? repoTargets.split(',').map((r) => r.trim()).filter(Boolean)
    : [];
  for (const r of repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(r)) fail(`Not an owner/repo: ${r}`);
  }

  const login = mode === 'preapprove' ? preapproveLogin : orgLogin;
  if (login && /[/\s]/.test(login)) {
    fail(`Not an org login: ${login} (did you mean a repository? drop --org)`);
  }

  const capCents = Number(flag(argv, '--cap') ?? DEFAULT_CAP_CENTS);
  const months = Number(flag(argv, '--months') ?? DEFAULT_TERM_MONTHS);
  const ttlDays = Number(flag(argv, '--ttl-days') ?? DEFAULT_PREAPPROVAL_TTL_DAYS);
  // A zero or negative cap is almost certainly a typo, and it produces a grant
  // that is active but sponsors nothing — the most confusing possible state for
  // a maintainer. Reject it here rather than letting it reach the row.
  if (!Number.isFinite(capCents) || capCents <= 0) {
    fail(`--cap must be a positive number of cents (got ${flag(argv, '--cap')}). Use --revoke to end a grant.`);
  }
  if (!Number.isFinite(months) || months <= 0) {
    fail(`--months must be a positive number (got ${flag(argv, '--months')}).`);
  }
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    fail(`--ttl-days must be a positive number (got ${flag(argv, '--ttl-days')}).`);
  }

  return {
    repos,
    orgLogin: login,
    stage: stage!,
    mode,
    capCents,
    months,
    ttlDays,
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

interface OrgInstallation {
  installationId: string;
  account: { id: number; login: string };
  targetType: string;
}

/**
 * Look up an installation by account login, distinguishing "not installed"
 * from "could not tell".
 *
 * `GET /orgs/{org}/installation` and `GET /users/{username}/installation` are
 * both App-JWT-only, same as the per-repo lookup. An org login is tried first
 * because that is the overwhelmingly common case; a personal account falls
 * through to the user endpoint.
 *
 * Returns null ONLY when GitHub answered 404 on both — that is the real "no
 * installation" signal. Any other failure (5xx, rate limit, network) aborts
 * rather than being swallowed: treating a transient error as "not installed"
 * would let `--preapprove` write a row for an org that IS installed, and such a
 * row can never be claimed because `installation.created` has already fired.
 * Nobody would notice until someone ran `--list-preapprovals`.
 */
async function findInstallationByLogin(
  gh: GitHubClients,
  login: string,
): Promise<OrgInstallation | null> {
  const attempts: { label: string; run: () => Promise<{ data: { id: number; account: unknown; target_type: string } }> }[] = [
    { label: `orgs/${login}/installation`, run: () => gh.jwt.apps.getOrgInstallation({ org: login }) as never },
    { label: `users/${login}/installation`, run: () => gh.jwt.apps.getUserInstallation({ username: login }) as never },
  ];

  for (const { label, run } of attempts) {
    try {
      const { data } = await run();
      const account = data.account as { id: number; login: string } | null;
      if (!account) {
        fail(`Installation ${data.id} for ${login} has no account attached — cannot grant.`);
      }
      return {
        installationId: String(data.id),
        account: { id: account!.id, login: account!.login },
        targetType: data.target_type,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) continue;
      fail(
        `Could not determine whether ${login} has installed the App.\n`
        + `GET ${label} returned ${status ?? 'an error'}: ${(err as Error).message}\n\n`
        + 'Refusing to guess. Treating this as "not installed" would write a\n'
        + 'pre-approval that can never be claimed; treating it as "installed"\n'
        + 'would refuse a legitimate one. Retry once GitHub is responding.',
      );
    }
  }

  return null;
}

/** As above, but for modes that require an existing installation. */
async function resolveOrgInstallation(gh: GitHubClients, login: string): Promise<OrgInstallation> {
  const found = await findInstallationByLogin(gh, login);
  if (found) return found;

  fail(
    `The MergeWatch App is not installed on ${login} (or it does not exist).\n`
    + 'If they have not installed it yet, that is what --preapprove is for:\n'
    + `  scripts/grant-oss.ts --preapprove ${login} --stage <stage>`,
  );
}

// --- DynamoDB -----------------------------------------------------------------

const table = (stage: string) => process.env.INSTALLATIONS_TABLE ?? `mergewatch-installations-${stage}`;

interface OssGrantRepo { id: number; fullName: string }

interface GrantFields {
  ossGrantScope?: 'repos' | 'org';
  ossGrantAccount?: { id: number; login: string };
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
  fields: Required<Pick<GrantFields, 'ossGrantExpiresAt' | 'ossMonthlyCapCents'>>
    & Pick<GrantFields, 'ossGrantRepos' | 'ossGrantScope' | 'ossGrantAccount'
                      | 'ossGrantedAt' | 'ossGrantNote'>,
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

/**
 * Pending pre-approval row. Mirrors `OssPreapproval` in
 * `packages/billing/src/oss-preapproval.ts` — see the note on the constants
 * above for why it is duplicated rather than imported.
 *
 * `repoFullName` is the table's sort key, not a repository: it holds the
 * lowercased org login.
 */
interface PreapprovalRow {
  installationId: string;
  repoFullName: string;
  orgLogin: string;
  capCents: number;
  months: number;
  note?: string;
  preapprovedAt: string;
  preapprovalExpiresAt: string;
  claimedAt?: string;
  claimedInstallationId?: string;
  expiredAt?: string;
}

const normalizeLogin = (login: string) => login.trim().toLowerCase();

async function readPreapproval(stage: string, login: string): Promise<PreapprovalRow | null> {
  const res = await dynamo.send(new GetCommand({
    TableName: table(stage),
    Key: { installationId: PREAPPROVAL_PK, repoFullName: normalizeLogin(login) },
  }));
  return (res.Item as PreapprovalRow | undefined) ?? null;
}

async function listPreapprovals(stage: string): Promise<PreapprovalRow[]> {
  const out: PreapprovalRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await dynamo.send(new QueryCommand({
      TableName: table(stage),
      KeyConditionExpression: 'installationId = :pk',
      ExpressionAttributeValues: { ':pk': PREAPPROVAL_PK },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...((res.Items ?? []) as PreapprovalRow[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

async function writePreapproval(stage: string, row: PreapprovalRow): Promise<void> {
  await dynamo.send(new PutCommand({ TableName: table(stage), Item: row }));
}

/** A TTL is a duration, so plain millisecond arithmetic — never local-time setDate. */
const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

/** Calendar months in UTC, so a grant's expiry doesn't depend on the operator's timezone. */
function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// --- Presentation --------------------------------------------------------------

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function renderGrant(grant: GrantFields, installationId: string): void {
  const repos = grant.ossGrantRepos ?? [];
  const expires = grant.ossGrantExpiresAt;
  const scope = grant.ossGrantScope ?? 'repos';
  // An org-scoped grant needs no repo list; a repos-scoped one is nothing
  // without it. Mirrors evaluateOssGrant so --inspect can't claim a grant is
  // active that the gate would refuse.
  const hasCoverage = scope === 'org' || repos.length > 0;
  const active = !!expires && Date.parse(expires) > Date.now() && hasCoverage;

  console.log(`\nInstallation ${installationId}`);
  console.log(`  Status        ${active ? '✓ active' : '✗ no active grant'}`);
  if (!expires && repos.length === 0 && scope === 'repos') return;

  console.log(`  Scope         ${scope === 'org' ? 'org — every PUBLIC repo in the installation' : 'repos — only those named below'}`);
  if (grant.ossGrantAccount) {
    console.log(`  Account       ${grant.ossGrantAccount.login} (id ${grant.ossGrantAccount.id})`);
  }
  if (scope === 'repos') {
    console.log(`  Covered repos ${repos.length ? repos.map((r) => `${r.fullName} (id ${r.id})`).join('\n                ') : '(none)'}`);
  } else if (repos.length) {
    // Left over from an earlier repos-scoped grant. The gate ignores it, and
    // saying so beats letting an operator think coverage is narrower than it is.
    console.log(`  Stale list    ${repos.length} repo(s) from a previous grant — IGNORED under org scope`);
  }
  console.log(`  Expires       ${expires ?? '(unset)'}`);
  console.log(`  Granted       ${grant.ossGrantedAt ?? '(unknown)'}`);
  console.log(`  Note          ${grant.ossGrantNote ?? '(none)'}`);
  console.log(`  Monthly cap   ${grant.ossMonthlyCapCents != null ? usd(grant.ossMonthlyCapCents) : '(uncapped)'}`);
  console.log(`  This period   ${grant.ossPeriod ?? '(none)'} — ${usd(grant.ossSponsoredCentsThisPeriod ?? 0)} sponsored`);
  console.log(`  Lifetime      ${usd(grant.ossSponsoredCentsLifetime ?? 0)} sponsored`);
}

/** One-line state for a pending pre-approval. */
function preapprovalState(row: PreapprovalRow): string {
  if (row.claimedAt) return `claimed ${row.claimedAt} by installation ${row.claimedInstallationId}`;
  if (Date.parse(row.preapprovalExpiresAt) <= Date.now()) {
    return `EXPIRED ${row.preapprovalExpiresAt}${row.expiredAt ? ` (noticed ${row.expiredAt})` : ''}`;
  }
  return `pending — expires ${row.preapprovalExpiresAt}`;
}

function renderPreapproval(row: PreapprovalRow): void {
  console.log(`\n  Pre-approval  ${row.orgLogin}`);
  console.log(`    State       ${preapprovalState(row)}`);
  console.log(`    Approved    ${row.preapprovedAt}`);
  console.log(`    Cap / term  ${usd(row.capCents)}/month · ${row.months} months`);
  console.log(`    Note        ${row.note ?? '(none)'}`);
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

  // --- Pre-approval modes: no installation involved -------------------------

  if (args.mode === 'list-preapprovals') {
    const rows = await listPreapprovals(args.stage);
    if (!rows.length) {
      console.log(`\nNo pre-approvals on ${args.stage}.\n`);
      return;
    }
    console.log(`\n── PRE-APPROVALS · stage=${args.stage} ──`);
    for (const row of rows) renderPreapproval(row);
    console.log();
    return;
  }

  const gh = await githubClients(args.stage);

  if (args.mode === 'preapprove') {
    const login = args.orgLogin!;

    // If they are already installed, a pre-approval would sit unclaimed
    // forever: `installation.created` has already fired and will not fire
    // again. Point at the mode that actually does something.
    const existingInstall = await findInstallationByLogin(gh, login);
    if (existingInstall) {
      const alreadyInstalled = existingInstall.installationId;
      fail(
        `${login} has ALREADY installed the App (installation ${alreadyInstalled}).\n`
        + 'A pre-approval is only claimed on installation.created, so this one would\n'
        + 'never fire. Grant them directly instead:\n'
        + `  scripts/grant-oss.ts --org ${login} --stage ${args.stage}`,
      );
    }

    const existing = await readPreapproval(args.stage, login);
    if (existing) {
      console.log(`\nAn existing pre-approval for ${login}:`);
      renderPreapproval(existing);
      if (existing.claimedAt) {
        console.log('\n  ⚠ Overwriting a CLAIMED pre-approval resets it to pending. The grant');
        console.log('    already written to the installation is NOT affected.');
      }
    }

    const now = new Date();
    const row: PreapprovalRow = {
      installationId: PREAPPROVAL_PK,
      repoFullName: normalizeLogin(login),
      orgLogin: login.trim(),
      capCents: args.capCents,
      months: args.months,
      ...(args.note ? { note: args.note } : {}),
      preapprovedAt: now.toISOString(),
      preapprovalExpiresAt: addDays(now, args.ttlDays).toISOString(),
    };

    console.log(`\n── PRE-APPROVE · stage=${args.stage} ──`);
    console.log(`  Org          ${row.orgLogin} (key: ${row.repoFullName})`);
    console.log(`  On install   an ORG-scoped grant covering every PUBLIC repo`);
    console.log(`  Monthly cap  ${usd(row.capCents)} · term ${row.months} months from the claim`);
    console.log(`  Stale after  ${row.preapprovalExpiresAt} (${args.ttlDays} days)`);
    if (row.note) console.log(`  Note         ${row.note}`);
    console.log('\n  Matched on the org LOGIN, not a numeric id — a rename before they');
    console.log('  install means this silently will not fire.');

    if (!(await confirm('\nProceed?', args.yes))) {
      console.log('Aborted. Nothing written.\n');
      return;
    }
    await writePreapproval(args.stage, row);
    console.log('\n✓ Written.');
    renderPreapproval((await readPreapproval(args.stage, login))!);
    console.log();
    return;
  }

  // --- Everything else targets an existing installation ---------------------

  let installationId: string;
  let account: { id: number; login: string } | undefined;
  let resolved: ResolvedRepo[] = [];

  if (args.orgLogin && args.repos.length === 0) {
    const org = await resolveOrgInstallation(gh, args.orgLogin);
    installationId = org.installationId;
    account = org.account;
    console.log(`✓ ${org.account.login} — ${org.targetType}, installation ${org.installationId}`);
  } else {
    resolved = await Promise.all(args.repos.map((r) => resolveRepo(gh, r)));

    // One grant lives on one installation. Mixing repos from different
    // installations into a single invocation would silently write only one.
    const installationIds = [...new Set(resolved.map((r) => r.installationId))];
    if (installationIds.length > 1) {
      fail(
        `Those repos belong to different installations (${installationIds.join(', ')}).\n`
        + 'Grants are per-installation — run the script once per installation.',
      );
    }
    installationId = installationIds[0];
  }

  const existing = await readGrant(args.stage, installationId);

  if (args.mode === 'inspect') {
    renderGrant(existing, installationId);
    const login = args.orgLogin ?? existing.ossGrantAccount?.login;
    if (login) {
      const pending = await readPreapproval(args.stage, login);
      if (pending) renderPreapproval(pending);
    }
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
  const revoking = args.mode === 'revoke';
  const orgScoped = args.mode === 'org';
  let next: OssGrantRepo[] = [];

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
    case 'org':
    case 'revoke':
      next = current;
      break;
  }

  const expiresAt = revoking
    ? new Date(Date.now() - 1000).toISOString()
    : addMonths(new Date(), args.months).toISOString();

  // Blast radius: what this covers, and — just as important — what in the same
  // installation it does not, so an accidental omission is visible before the write.
  const allRepos = await installationRepos(args.stage, installationId);
  const coveredNames = new Set(next.map((r) => r.fullName));
  const uncovered = allRepos.filter((n) => !coveredNames.has(n));

  console.log(`\n── ${args.mode.toUpperCase()} · stage=${args.stage} · installation ${installationId} ──`);
  if (revoking) {
    console.log(`  Revoking the grant (expiry set to the past). Reviews fall back to the`);
    console.log(`  standard free-tier/balance gate — they are not blocked outright.`);
    if ((existing.ossGrantScope ?? 'repos') === 'org') {
      console.log(`  This was an ORG-scoped grant covering every public repo.`);
    }
  } else if (orgScoped) {
    console.log(`  Will sponsor EVERY PUBLIC repo in this installation, including ones`);
    console.log(`  created later. Private repos are never sponsored.`);
    console.log(`  Public repos known right now:`);
    if (allRepos.length) {
      for (const n of allRepos) console.log(`    • ${n}`);
    } else {
      console.log(`    (none recorded yet — coverage is still org-wide)`);
    }
    if (current.length) {
      console.log(`  A previous repos-scoped list of ${current.length} repo(s) will be left in`);
      console.log(`  place but IGNORED by the gate.`);
    }
    console.log(`  Monthly cap  ${usd(args.capCents)} (shared across the whole org)`);
    console.log(`  Expires      ${expiresAt}`);
    if (args.note) console.log(`  Note         ${args.note}`);
    console.log('\n  ⚠ Open-core check: if any PUBLIC repo here is commercial rather than');
    console.log('    open source, use a named repo list instead of --org.');
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

  if (!next.length && !revoking && !orgScoped) {
    fail('That would leave the grant with no repositories. Use --revoke to end it instead.');
  }

  if (!(await confirm('\nProceed?', args.yes))) {
    console.log('Aborted. Nothing written.\n');
    return;
  }

  await writeGrant(args.stage, installationId, {
    // Scope is written explicitly by every mode that changes coverage, so
    // narrowing actually narrows: a repo list left `ossGrantScope: 'org'` in
    // place (every claimed pre-approval sets it) would be silently ignored by
    // the gate, and the operator would believe they had restricted an org-wide
    // grant to a handful of repos.
    //
    // Revoking is the exception — it leaves scope alone, because the expiry is
    // what ends a grant and rewriting scope here would quietly change what a
    // later renewal covers.
    ...(revoking ? {} : { ossGrantScope: orgScoped ? ('org' as const) : ('repos' as const) }),
    ...(orgScoped && account ? { ossGrantAccount: account } : {}),
    ...(orgScoped ? {} : { ossGrantRepos: next }),
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
