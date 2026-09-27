/**
 * #235 — pure helpers for the Org Custom Agents API. Kept dependency-free so
 * the audit-stamping logic is unit-testable without mocking the route.
 */

import { isReservedAgentName, type OrgCustomAgent } from "@mergewatch/core";

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

/**
 * #662 — names of incoming agents that take a built-in finding category
 * (`security`, `bug`, …). Such an agent's findings were indistinguishable
 * from the built-in agent's, so new ones are refused. An agent already stored
 * under that id and name keeps running (it is flagged instead, see
 * `annotateNameCollisions`), so a save that leaves it untouched still works.
 *
 * Reads the RAW request body, before `sanitizeOrgCustomAgents`, so the error
 * can name what the admin typed. Matching is on the trimmed name, and exact.
 */
export function reservedNameViolations(raw: unknown[], existing: OrgCustomAgent[]): string[] {
  const stored = new Set(existing.map((a) => `${a.id}\u0000${a.name.trim()}`));
  const out: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof name !== "string" || !isReservedAgentName(name)) continue;
    const trimmed = name.trim();
    if (typeof id === "string" && id && stored.has(`${id}\u0000${trimmed}`)) continue;
    out.push(trimmed);
  }
  return out;
}

/** #662 — mark stored agents whose name collides with a built-in category. */
export function annotateNameCollisions(
  agents: OrgCustomAgent[],
): Array<OrgCustomAgent & { nameCollision?: true }> {
  return agents.map((a) => (isReservedAgentName(a.name) ? { ...a, nameCollision: true as const } : a));
}
