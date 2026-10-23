/**
 * #718 — org safety areas: the defensive read of a stored/posted blob, repo
 * selection, and the mapping onto a pipeline `SafetyArea`. Total and pure,
 * like org-agents.ts.
 */
import type { OrgSafetyArea } from './types/db.js';
import { SAFETY_LEVELS, type SafetyArea, type SafetyLevel } from './config/defaults.js';
import { parseSafetyArea } from './config/safety-score.js';
import { sanitizeScope } from './org-agents.js';

/**
 * Coerce untrusted input into well-formed `OrgSafetyArea[]`. An unknown
 * `level` is clamped to absent; an entry that then fails the repo-area rules
 * (#711 — e.g. neither `patterns` nor `notes`) is dropped. `enabled`
 * defaults to true, scope to all repos. Never throws.
 */
export function sanitizeOrgSafetyAreas(raw: unknown): OrgSafetyArea[] {
  if (!Array.isArray(raw)) return [];
  const out: OrgSafetyArea[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    if (!id) continue;
    // Only the area's own fields go through the repo-area validator.
    const fields: Record<string, unknown> = {};
    for (const k of ['name', 'patterns', 'notes'] as const) if (a[k] !== undefined) fields[k] = a[k];
    if (SAFETY_LEVELS.includes(a.level as SafetyLevel)) fields.level = a.level;
    const area = parseSafetyArea(fields, 'area', []);
    if (!area) continue;
    out.push({
      id,
      ...area,
      enabled: a.enabled !== false,
      scope: sanitizeScope(a.scope),
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
      updatedBy: typeof a.updatedBy === 'string' ? a.updatedBy : '',
    });
  }
  return out;
}

/** The org areas that apply to this repo: enabled and in scope. */
export function selectOrgSafetyAreas(areas: OrgSafetyArea[], repoFullName: string): OrgSafetyArea[] {
  return areas.filter((a) => a.enabled && (a.scope.mode === 'all' || a.scope.repos.includes(repoFullName)));
}

/** Map an org area onto the pipeline's area shape, tagged `source: 'org'`. */
export function toSafetyArea(a: OrgSafetyArea): SafetyArea {
  return {
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.patterns !== undefined ? { patterns: a.patterns } : {}),
    ...(a.level !== undefined ? { level: a.level } : {}),
    ...(a.notes !== undefined ? { notes: a.notes } : {}),
    source: 'org',
  };
}

/**
 * Org areas first, then the repo's. Riskiest-wins matching (#712) means the
 * order never lets a repo weaken an org area; it only decides which of two
 * equally risky areas is named first.
 */
export function unionSafetyAreas(orgAreas: OrgSafetyArea[], repoAreas: SafetyArea[]): SafetyArea[] {
  return [...orgAreas.map(toSafetyArea), ...repoAreas];
}
