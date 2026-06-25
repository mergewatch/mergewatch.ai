/**
 * #235 — Org Custom Agents: pure helpers shared by the storage layer (defensive
 * read of the stored blob), the dashboard API (validate an incoming payload),
 * and the review runtime (Phase 2 adds scope/targeting predicates here).
 *
 * Dependency-free + total so every branch is unit-testable.
 */

import type {
  OrgCustomAgent,
  OrgAgentScope,
  OrgAgentEnforcement,
} from './types/db.js';

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
