/**
 * W10 — finding consolidation.
 *
 * The multi-agent pipeline can emit several findings about ONE underlying
 * concern from different angles. Canonical example: voice-bot PR #37
 * surfaced (a) "SQL injection risk in dynamic VALUES clause" at line 150,
 * (b) "Type assertion without runtime validation" at line 82, and (c)
 * "Untrusted JSON parsing from S3 without validation" at line 130 — three
 * separate findings, one root cause ("validate the parsed S3 chunk file
 * structure"). The reader sees three rows in the "Requires your attention"
 * table where they should see one.
 *
 * This module clusters such fragments into a single finding carrying the
 * strongest severity and a "Related concerns clustered into this finding"
 * block listing the absorbed siblings. The user still has full audit
 * (every framing is preserved in the merged finding's body); they just
 * don't have to triage each angle separately.
 *
 * Conservative direction: over-clustering would hide distinct issues
 * under one heading, which is worse than the noise it eliminates. The
 * defaults below require (a) the SAME file, (b) lines within a bounded
 * range, AND (c) at least one shared "significant" token across the
 * combined title+description text. Clusters bigger than the cap are
 * rejected as likely false positives — preferred output for a 6-finding
 * "cluster" is six separate findings, not one suspicious super-finding.
 */

/** Minimal shape of a finding this module consumes. */
export interface ClusterableFinding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
}

const SEVERITY_RANK: Record<ClusterableFinding['severity'], number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Stop words + generic finding-prose words that carry no semantic weight
 * for clustering. A finding title using only these is essentially
 * unconstrained and would over-cluster against anything else.
 */
const W10_STOP_WORDS = new Set<string>([
  // Common English stop words.
  'about', 'after', 'again', 'against', 'because', 'before', 'being', 'below',
  'between', 'could', 'might', 'should', 'their', 'there', 'these', 'those',
  'where', 'which', 'while', 'with', 'within', 'without',
  // Generic finding-prose vocabulary that says nothing specific.
  'issue', 'issues', 'potential', 'concern', 'concerns', 'missing', 'lacking',
  'lacks', 'lacks', 'risk', 'risks', 'consider', 'consideration', 'recommend',
  'recommendation', 'recommended', 'suggest', 'suggested', 'suggestion',
  'review', 'reviewed', 'finding', 'findings', 'problem', 'problems',
  'function', 'method', 'value', 'values', 'variable', 'variables', 'class',
  'object', 'objects', 'argument', 'arguments', 'parameter', 'parameters',
  'change', 'changes', 'changed', 'check', 'checked', 'checks',
]);

/**
 * Extract the "significant" tokens from a string: lowercase alphanumeric
 * words ≥ 5 chars, minus the stop-word list. Length-5 is a deliberate
 * floor — shorter tokens ("test", "code", "type") are too generic for
 * Jaccard-style overlap to mean anything.
 */
export function extractSignificantTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 5 && !W10_STOP_WORDS.has(t));
  return new Set(tokens);
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const t of a) if (b.has(t)) count++;
  return count;
}

export interface ClusterOptions {
  /**
   * Maximum line distance (inclusive) at which two findings on the same
   * file may cluster. Lines further apart than this are treated as
   * structurally distinct code regions — never merged even if their
   * titles look related. Default 50.
   */
  maxLineSpan?: number;
  /**
   * Minimum number of shared significant tokens for two findings to be
   * considered the same underlying concern. Default 1 — enough to catch
   * "validation"-themed siblings (#37) without merging arbitrary pairs.
   */
  minTokenOverlap?: number;
  /**
   * Reject clusters whose member count exceeds this cap. A 6-way cluster
   * is more likely a false positive (the heuristic over-grouped) than a
   * real "one concern, six angles" case. Default 5.
   */
  maxClusterSize?: number;
}

function clusterPair(
  a: ClusterableFinding,
  b: ClusterableFinding,
  tokensA: Set<string>,
  tokensB: Set<string>,
  opts: Required<ClusterOptions>,
): boolean {
  if (a.file !== b.file) return false;
  if (Math.abs(a.line - b.line) > opts.maxLineSpan) return false;
  return sharedTokenCount(tokensA, tokensB) >= opts.minTokenOverlap;
}

/**
 * Cluster fragmented findings about the same code region into one finding
 * per cluster. Pure function — no I/O, no LLM. Conservative by design:
 *   - requires same file AND bounded line distance AND ≥1 shared token,
 *   - uses transitive union-find so A↔B↔C (with no direct A↔C edge)
 *     still groups into one cluster,
 *   - rejects clusters larger than `maxClusterSize` as likely false
 *     positives (preserving original findings unchanged).
 *
 * Returns the post-cluster finding set plus the count of findings
 * "absorbed" into other clusters (so the pipeline can roll it into
 * `suppressedCount` for the rendered "Suppressed N" line).
 */
export function clusterFindings<T extends ClusterableFinding>(
  findings: T[],
  options: ClusterOptions = {},
): { findings: T[]; clusteredCount: number } {
  const opts: Required<ClusterOptions> = {
    maxLineSpan: options.maxLineSpan ?? 50,
    minTokenOverlap: options.minTokenOverlap ?? 1,
    maxClusterSize: options.maxClusterSize ?? 5,
  };

  if (findings.length < 2) return { findings, clusteredCount: 0 };

  // Pre-extract token sets — repeated tokenization is by far the hot path.
  const tokenSets = findings.map((f) =>
    extractSignificantTokens(`${f.title} ${f.description}`),
  );

  // Union-find / DSU over finding indices.
  const parent = findings.map((_, i) => i);
  const find = (x: number): number => {
    if (parent[x] === x) return x;
    parent[x] = find(parent[x]);
    return parent[x];
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // O(n²) over findings — n is small (post-orchestrator findings is
  // typically <30; the orchestrator caps at maxFindings ≤ 25).
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (clusterPair(findings[i], findings[j], tokenSets[i], tokenSets[j], opts)) {
        union(i, j);
      }
    }
  }

  // Bucket by root.
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const r = find(i);
    const arr = buckets.get(r) ?? [];
    arr.push(i);
    buckets.set(r, arr);
  }

  const result: T[] = [];
  let clusteredCount = 0;

  for (const indices of buckets.values()) {
    if (indices.length === 1) {
      result.push(findings[indices[0]]);
      continue;
    }
    // Cap: a too-large cluster is more likely heuristic over-reach than a
    // real one-concern-many-angles case. Output the members verbatim.
    if (indices.length > opts.maxClusterSize) {
      for (const i of indices) result.push(findings[i]);
      continue;
    }
    // Merge. Strongest severity becomes the primary; within the same
    // severity, lower line wins (the earliest-cited member anchors the
    // merged finding).
    const members = indices.map((i) => findings[i]);
    members.sort((a, b) => {
      const dRank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return dRank !== 0 ? dRank : a.line - b.line;
    });
    const primary = members[0];
    const others = members.slice(1);
    const relatedList = others
      .map((o) => `- \`${o.file}:${o.line}\` (${o.severity}) — ${o.title}`)
      .join('\n');
    const merged: T = {
      ...primary,
      title: `${primary.title} — and ${others.length} related concern${others.length === 1 ? '' : 's'}`,
      description: `${primary.description}\n\n**Related concerns clustered into this finding (W10):**\n${relatedList}`,
    };
    result.push(merged);
    clusteredCount += others.length;
  }

  return { findings: result, clusteredCount };
}
