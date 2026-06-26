/**
 * #235 — pure helpers for the Org Custom Agents API. Kept dependency-free so
 * the audit-stamping logic is unit-testable without mocking the route.
 */

import type { OrgCustomAgent } from "@mergewatch/core";

/** Stable fields that, when changed, count as an "edit" for audit purposes. */
export function contentKey(a: OrgCustomAgent): string {
  return JSON.stringify({
    name: a.name,
    prompt: a.prompt,
    severityDefault: a.severityDefault,
    enforcement: a.enforcement,
    enabled: a.enabled,
    scope: a.scope,
    targeting: a.targeting ?? null,
  });
}

/**
 * Assign ids to new agents and stamp `updatedAt` / `updatedBy` on created or
 * changed agents; preserve prior audit metadata for unchanged agents — so
 * "last edited by" reflects the actual last editor of THAT agent, not whoever
 * saved the set. `genId` is injectable for deterministic tests.
 */
export function stampAudit(
  incoming: OrgCustomAgent[],
  existing: OrgCustomAgent[],
  editor: string,
  now: string,
  genId: () => string = () => globalThis.crypto.randomUUID(),
): OrgCustomAgent[] {
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
