/**
 * #235 — Org Custom Agents: pure helpers shared by the storage layer (defensive
 * read of the stored blob), the dashboard API (validate an incoming payload),
 * and the review runtime (Phase 2 adds scope/targeting predicates here).
 *
 * Dependency-free + total so every branch is unit-testable.
 */

import { minimatch } from 'minimatch';
import type {
  OrgCustomAgent,
  OrgAgentScope,
  OrgAgentEnforcement,
} from './types/db.js';
import type { CustomAgentDef } from './config/defaults.js';

const SEVERITIES = new Set(['info', 'warning', 'critical']);
const ENFORCEMENTS = new Set<OrgAgentEnforcement>(['advisory', 'blocking']);

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

function sanitizeScope(v: unknown): OrgAgentScope {
  if (v && typeof v === 'object' && (v as { mode?: unknown }).mode === 'selected') {
    return { mode: 'selected', repos: asStringArray((v as { repos?: unknown }).repos) };
  }
  return { mode: 'all' };
}

/**
 * Coerce untrusted input (a dashboard payload or a stored JSON blob) into a
 * well-formed `OrgCustomAgent[]`. Drops entries missing a usable id / name /
 * prompt; clamps enums to valid values (severity → `warning`, enforcement →
 * `advisory`); defaults `enabled` to true; normalises scope + targeting
 * (languages lowercased, empty targeting omitted). Never throws.
 */
export function sanitizeOrgCustomAgents(raw: unknown): OrgCustomAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: OrgCustomAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;

    const id = typeof a.id === 'string' ? a.id.trim() : '';
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    if (!id || !name || !prompt) continue;

    const severityDefault = SEVERITIES.has(a.severityDefault as string)
      ? (a.severityDefault as OrgCustomAgent['severityDefault'])
      : 'warning';
    const enforcement = ENFORCEMENTS.has(a.enforcement as OrgAgentEnforcement)
      ? (a.enforcement as OrgAgentEnforcement)
      : 'advisory';

    const targetingRaw =
      a.targeting && typeof a.targeting === 'object' ? (a.targeting as Record<string, unknown>) : undefined;
    const pathGlobs = targetingRaw ? asStringArray(targetingRaw.pathGlobs) : [];
    const languages = targetingRaw ? asStringArray(targetingRaw.languages).map((l) => l.toLowerCase()) : [];
    const targeting =
      pathGlobs.length || languages.length
        ? {
            ...(pathGlobs.length ? { pathGlobs } : {}),
            ...(languages.length ? { languages } : {}),
          }
        : undefined;

    out.push({
      id,
      name,
      prompt,
      severityDefault,
      enforcement,
      enabled: a.enabled !== false, // default true
      scope: sanitizeScope(a.scope),
      ...(targeting ? { targeting } : {}),
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
      updatedBy: typeof a.updatedBy === 'string' ? a.updatedBy : '',
    });
  }
  return out;
}

// ─── Runtime selection + enforcement (#235, PR 2) ───────────────────────────

/** Diff context an org agent's targeting is evaluated against. */
export interface ReviewTargetingContext {
  repoFullName: string;
  /** Paths changed by the PR (repo-relative). */
  changedFiles: string[];
  /** Languages the PR touches (case-insensitive). */
  languages: string[];
}

/** Whether an agent's repo scope includes `repoFullName`. */
export function agentAppliesToRepo(agent: OrgCustomAgent, repoFullName: string): boolean {
  if (agent.scope.mode === 'all') return true;
  return agent.scope.repos.includes(repoFullName);
}

/**
 * Whether the diff matches the agent's optional path/language targeting. Empty
 * (or absent) targeting always matches. Path globs use minimatch (same matcher
 * as excludePatterns); a match on ANY changed file / ANY language is enough.
 */
export function agentMatchesTargeting(
  agent: OrgCustomAgent,
  ctx: { changedFiles: string[]; languages: string[] },
): boolean {
  const t = agent.targeting;
  if (!t) return true;
  if (t.pathGlobs && t.pathGlobs.length > 0) {
    const anyPath = ctx.changedFiles.some(
      (file) => typeof file === 'string' && t.pathGlobs!.some((g) => minimatch(file, g)),
    );
    if (!anyPath) return false;
  }
  if (t.languages && t.languages.length > 0) {
    const langs = new Set(ctx.languages.map((l) => l.toLowerCase()));
    if (!t.languages.some((l) => langs.has(l.toLowerCase()))) return false;
  }
  return true;
}

/** Org agents that should run for this review: enabled ∩ in-scope ∩ targeting-match. */
export function selectOrgAgentsForReview(
  agents: OrgCustomAgent[],
  ctx: ReviewTargetingContext,
): OrgCustomAgent[] {
  return agents.filter(
    (a) => a.enabled && agentAppliesToRepo(a, ctx.repoFullName) && agentMatchesTargeting(a, ctx),
  );
}

/** Map an org agent onto the pipeline's per-repo `CustomAgentDef` shape. */
export function toCustomAgentDef(a: OrgCustomAgent): CustomAgentDef {
  return { name: a.name, prompt: a.prompt, severityDefault: a.severityDefault, enabled: true };
}

/**
 * Union the (already-selected) org agents with a repo's `.mergewatch.yml`
 * customAgents. Org agents always run; repo agents run in addition EXCEPT when
 * they collide on name with an org agent — org wins, so a repo can add but not
 * shadow/remove an org definition.
 */
export function unionCustomAgents(
  orgAgents: OrgCustomAgent[],
  repoAgents: CustomAgentDef[] | undefined,
): CustomAgentDef[] {
  const orgNames = new Set(orgAgents.map((a) => a.name));
  const repoOnly = (repoAgents ?? []).filter((r) => !orgNames.has(r.name));
  return [...orgAgents.map(toCustomAgentDef), ...repoOnly];
}

/** Minimal finding shape the gate reads. */
type GateFinding = { severity: string; category: string };

/**
 * Names of *blocking* org agents that produced a **critical** finding in this
 * review — the merge gate fires when this is non-empty. Custom-agent findings
 * carry `category === agent.name` (see reviewer tagging), so we match on that.
 */
export function blockingCriticalAgents(orgAgents: OrgCustomAgent[], findings: GateFinding[]): string[] {
  const blocking = new Set(orgAgents.filter((a) => a.enforcement === 'blocking').map((a) => a.name));
  const triggered = new Set<string>();
  for (const f of findings) {
    if (f.severity === 'critical' && blocking.has(f.category)) triggered.add(f.category);
  }
  return [...triggered];
}

/** Extension → coarse language name (lowercased). Covers the common cases. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', php: 'php', scala: 'scala', sh: 'shell', bash: 'shell',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json', md: 'markdown',
  html: 'html', css: 'css', scss: 'css', less: 'css',
};

/**
 * Coarse set of languages a PR touches, derived from changed-file extensions
 * (lowercased, deduped). Used to evaluate an org agent's `targeting.languages`.
 */
export function languagesFromFiles(files: string[]): string[] {
  const langs = new Set<string>();
  for (const f of files) {
    if (typeof f !== 'string') continue; // defensive: only operate on path strings
    const dot = f.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = f.slice(dot + 1).toLowerCase();
    const lang = EXT_TO_LANGUAGE[ext];
    if (lang) langs.add(lang);
  }
  return [...langs];
}
