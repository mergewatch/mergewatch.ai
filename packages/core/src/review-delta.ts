/**
 * Computes the delta between two reviews of the same PR,
 * showing which issues were resolved, which are new, and which persist.
 */

export interface FindingLike {
  file: string;
  line: number;
  title: string;
  /**
   * Stable cross-commit identity (W9): normalized cited code. When present
   * on both sides it is preferred over the title for matching, so a finding
   * whose wording the LLM reworded across commits is recognised as the same
   * issue instead of being reported as both "resolved" and "new".
   */
  fingerprint?: string;
}

export interface ReviewDelta {
  /** Number of issues from the previous review that are no longer present */
  resolvedCount: number;
  /** Number of new issues not in the previous review */
  newCount: number;
  /** Number of issues carried over unchanged from the previous review */
  carriedOverCount: number;
  /**
   * Findings from the previous review that are no longer reported — the
   * orchestrator either dropped them as resolved or the diff itself no
   * longer triggers them. Preserved here so the review comment can list
   * them in a collapsed "Previously reported" section for audit.
   */
  resolved: FindingLike[];
  /** New findings present on this commit but not in the previous review. */
  new: FindingLike[];
  /** Findings present in both the previous and current review. */
  carriedOver: FindingLike[];
}

/**
 * Normalize a cited code line into a stable fingerprint payload: collapse all
 * whitespace, trim, cap length. Case is preserved (code is case-sensitive).
 * Returns '' for blank/comment-only input so callers can decline to fingerprint
 * (a bare `}` or `// note` is not a distinctive enough anchor).
 */
export function fingerprintFromCode(codeLine: string | undefined): string {
  if (!codeLine) return '';
  const norm = codeLine.replace(/\s+/g, ' ').trim();
  // Strip a leading line-comment marker so a finding doesn't get a different
  // identity just because a trailing comment was added/removed on its line.
  const codeOnly = norm.replace(/\s*\/\/.*$/, '').trim();
  const sig = codeOnly.length >= 6 ? codeOnly : norm;
  if (sig.replace(/[^A-Za-z0-9]/g, '').length < 4) return ''; // too generic (`}`, `});`, …)
  return sig.slice(0, 200);
}

/**
 * The set of identity keys a finding can match on (W9 union-matching):
 *   - title key: `file::T::<title>` — always present (legacy / back-compat).
 *   - fingerprint key: `file::F::<code>` — present only when the finding
 *     carries a code fingerprint.
 *
 * Two findings are "the same issue" if ANY of their keys coincide. Using the
 * union (rather than fingerprint-only) means this can only ever *reduce*
 * spurious resolved/new churn, never introduce it: a reworded finding on
 * unchanged code matches via the fingerprint key; a pre-W9 stored finding
 * with no fingerprint still matches via the title key.
 */
export function findingMatchKeys(f: FindingLike): string[] {
  const keys = [`${f.file}::T::${f.title}`];
  if (f.fingerprint) keys.push(`${f.file}::F::${f.fingerprint}`);
  return keys;
}

/**
 * Compute the delta between current findings and previous findings.
 * Returns null if there are no previous findings to compare against.
 *
 * Matching is union-based (see findingMatchKeys): a current finding is
 * "carried over" if it shares any identity key with some previous finding;
 * a previous finding is "resolved" only if NONE of its keys appear in the
 * current set. This kills the whack-a-mole where a code edit shifts lines
 * and the LLM rewords the title, making one unchanged issue show up as both
 * "✅ resolved" and "🆕 new" in the same comment.
 */
export function computeReviewDelta(
  currentFindings: FindingLike[],
  previousFindings: FindingLike[] | undefined | null,
): ReviewDelta | null {
  if (!previousFindings || previousFindings.length === 0) {
    return null;
  }

  const prevKeys = new Set<string>();
  for (const f of previousFindings) for (const k of findingMatchKeys(f)) prevKeys.add(k);
  const currKeys = new Set<string>();
  for (const f of currentFindings) for (const k of findingMatchKeys(f)) currKeys.add(k);

  const matchesAny = (f: FindingLike, against: Set<string>) =>
    findingMatchKeys(f).some((k) => against.has(k));

  const resolved = previousFindings.filter((f) => !matchesAny(f, currKeys));
  const carriedOver = currentFindings.filter((f) => matchesAny(f, prevKeys));
  const added = currentFindings.filter((f) => !matchesAny(f, prevKeys));

  return {
    resolvedCount: resolved.length,
    newCount: added.length,
    carriedOverCount: carriedOver.length,
    resolved,
    new: added,
    carriedOver,
  };
}
