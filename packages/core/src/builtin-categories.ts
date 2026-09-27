/**
 * #662 — categories of the six built-in finding agents, and so the names a
 * custom agent may not take: a custom `security` agent used to erase the
 * built-in security findings. A leaf module so the yml parser (github/client)
 * and the gate can share it without importing each other.
 */
export const BUILTIN_FINDING_CATEGORIES: ReadonlySet<string> = new Set([
  'security', 'bug', 'style', 'error-handling', 'test-coverage', 'comment-accuracy',
]);

/** Is `name` reserved? Exact, case-sensitive, after trimming. */
export function isReservedAgentName(name: string): boolean {
  return BUILTIN_FINDING_CATEGORIES.has(name.trim());
}
