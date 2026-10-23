/**
 * #718 — pure helpers for the Org Safety Areas API: payload validation and
 * audit stamping. Dependency-free so they are unit-testable without the route.
 */

import { ORG_SAFETY_AREA_CAP, type OrgSafetyArea } from "@mergewatch/core";

/** A scope is `{mode:'all'}` or `{mode:'selected', repos: string[]}`; anything else is rejected. */
function isValidScope(v: unknown): boolean {
  if (v === undefined) return true; // sanitize defaults it to all repos
  if (!v || typeof v !== "object") return false;
  const s = v as { mode?: unknown; repos?: unknown };
  if (s.mode === "all") return true;
  return s.mode === "selected" && Array.isArray(s.repos) && s.repos.every((r) => typeof r === "string");
}

/**
 * Validate a PUT body. Returns the 400 message, or null when valid. The
 * per-area rules are applied by `sanitizeOrgSafetyAreas` afterwards; this
 * rejects what sanitizing would otherwise hide: too many areas, or a scope
 * that would silently widen to all repos.
 */
export function safetyAreasValidationError(body: unknown): string | null {
  const areas = (body as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(areas)) return "Missing areas[]";
  if (areas.length > ORG_SAFETY_AREA_CAP) return `At most ${ORG_SAFETY_AREA_CAP} safety areas`;
  for (const a of areas) {
    if (!a || typeof a !== "object" || !isValidScope((a as { scope?: unknown }).scope)) {
      return "Invalid scope: use {mode: 'all'} or {mode: 'selected', repos: [...]}";
    }
  }
  return null;
}

/** Stable fields that, when changed, count as an edit for audit purposes. */
function contentKey(a: OrgSafetyArea): string {
  return JSON.stringify({
    name: a.name ?? null,
    patterns: a.patterns ?? null,
    level: a.level ?? null,
    notes: a.notes ?? null,
    enabled: a.enabled,
    scope: a.scope,
  });
}

/**
 * Assign ids to new areas and stamp `updatedAt` / `updatedBy` on created or
 * changed ones; unchanged areas keep their audit metadata (the same approach
 * as custom agents' `stampAudit`). `genId` is injectable for tests.
 */
export function stampSafetyAreasAudit(
  incoming: OrgSafetyArea[],
  existing: OrgSafetyArea[],
  editor: string,
  now: string,
  genId: () => string = () => globalThis.crypto.randomUUID(),
): OrgSafetyArea[] {
  const byId = new Map(existing.map((a) => [a.id, a]));
  return incoming.map((a) => {
    const id = a.id || genId();
    const prior = byId.get(id);
    const changed = !prior || contentKey(prior) !== contentKey(a);
    return changed
      ? { ...a, id, updatedAt: now, updatedBy: editor }
      : { ...a, id, updatedAt: prior.updatedAt, updatedBy: prior.updatedBy };
  });
}
