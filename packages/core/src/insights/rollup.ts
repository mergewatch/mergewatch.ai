/**
 * FB-E — aggregate FindingDispositionRecord rows into an
 * `InstallationFPInsight` rollup per rolling window.
 *
 * Pure function: takes already-fetched records + a window length, returns
 * the typed insight. Doesn't touch storage, doesn't touch time directly
 * (window bounds are passed in as ISO strings). Testable without any
 * mocking beyond seed data.
 */

import type { FindingDispositionRecord, InstallationFPInsight } from '../types/db.js';
import { periodDayKey } from '../types/db.js';

/** Rolling window definitions: ISO 8601 duration → milliseconds. */
export const WINDOW_LENGTH_MS: Record<InstallationFPInsight['window'], number> = {
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

/** Cap on `topClusters[]` per insight. Keeps rollups small and the
 *  dashboard render snappy; FB-H surfaces top-10 anyway. */
const TOP_CLUSTERS_LIMIT = 10;

/**
 * Compute one rolling-window insight from a set of disposition records.
 *
 *   1. Compute each record's IN-WINDOW contribution (#334) and keep only
 *      records with any in-window activity.
 *   2. Sum the global counters.
 *   3. Bucket by `category` and by `repoFullName`.
 *   4. Cluster by shared significant tokens (union-find on sigToken
 *      overlap) and pick top-N by `surfaceCount × disputeRate`.
 *
 * Defensive defaults — rates are 0 when surfaceCount is 0; missing
 * sigTokens skip the cluster step but still feed the totals.
 *
 * #334 — the window bounds not just WHICH records count but HOW MUCH of
 * each record counts. The previous version filtered by `lastSeen` and then
 * summed lifetime counters, so one still-active long-lived finding injected
 * its entire history into every window and all three windows converged
 * toward all-time totals. Per-record windowing now guarantees
 * 7d ≤ 30d ≤ 90d on any dataset.
 */
export function buildInsightFromDispositions(
  installationId: string,
  window: InstallationFPInsight['window'],
  windowEndIso: string,
  records: readonly FindingDispositionRecord[],
): InstallationFPInsight {
  const windowEndMs = new Date(windowEndIso).getTime();
  const windowStartMs = windowEndMs - WINDOW_LENGTH_MS[window];
  const windowStartIso = new Date(windowStartMs).toISOString();

  // #334 — windowed view: substitute each record's counters with its
  // in-window contribution and keep only records that actually had activity
  // inside the window. Downstream (totals, per-* buckets, clusters) reads
  // the substituted counters, so every derived number is window-bounded.
  // Inclusion follows activity rather than `lastSeen`, which also captures
  // a dispute/agreement landing after the finding's last surfacing.
  const inWindow: FindingDispositionRecord[] = [];
  for (const r of records) {
    const w = windowedCounts(r, windowStartMs, windowEndMs);
    if (w.surfaced + w.disputes + w.silentDrops + w.agreements === 0) continue;
    // Only the four counters the insight derives from are substituted; the
    // remaining lifetime fields ride along unread.
    inWindow.push({
      ...r,
      surfaceCount: w.surfaced,
      disputeCount: w.disputes,
      silentDropCount: w.silentDrops,
      agreementCount: w.agreements,
    });
  }

  // Global counters.
  let totalFindingsSurfaced = 0;
  let totalDisputes = 0;
  let totalSilentDrops = 0;
  let totalAgreements = 0;
  for (const r of inWindow) {
    totalFindingsSurfaced += r.surfaceCount;
    totalDisputes        += r.disputeCount;
    totalSilentDrops     += r.silentDropCount;
    totalAgreements      += r.agreementCount;
  }
  const disputeRate = totalFindingsSurfaced > 0 ? totalDisputes / totalFindingsSurfaced : 0;

  // Per-category, per-severity, and per-repo buckets. perSeverity is the
  // FB-I addition — drives the severity-shopping detector chart (warnings
  // dispute-rate vs criticals dispute-rate). Same shape as perCategory so
  // the dashboard can reuse the rendering primitives.
  const perCategory: Record<string, { surfaced: number; disputed: number; rate: number }> = {};
  const perSeverity: Record<string, { surfaced: number; disputed: number; rate: number }> = {};
  const perRepo:     Record<string, { surfaced: number; disputed: number; rate: number }> = {};
  for (const r of inWindow) {
    const cat = r.category ?? 'uncategorized';
    if (!perCategory[cat]) perCategory[cat] = { surfaced: 0, disputed: 0, rate: 0 };
    perCategory[cat].surfaced += r.surfaceCount;
    perCategory[cat].disputed += r.disputeCount;

    // FB-I — pre-FB-I records (no severity column) land in 'uncategorized'
    // so the bucket totals match perCategory's behaviour. Once severity
    // backfills naturally via subsequent surfacings, the bucket shrinks.
    const sev = r.severity ?? 'uncategorized';
    if (!perSeverity[sev]) perSeverity[sev] = { surfaced: 0, disputed: 0, rate: 0 };
    perSeverity[sev].surfaced += r.surfaceCount;
    perSeverity[sev].disputed += r.disputeCount;

    if (!perRepo[r.repoFullName]) perRepo[r.repoFullName] = { surfaced: 0, disputed: 0, rate: 0 };
    perRepo[r.repoFullName].surfaced += r.surfaceCount;
    perRepo[r.repoFullName].disputed += r.disputeCount;
  }
  for (const bucket of Object.values(perCategory)) {
    bucket.rate = bucket.surfaced > 0 ? bucket.disputed / bucket.surfaced : 0;
  }
  for (const bucket of Object.values(perSeverity)) {
    bucket.rate = bucket.surfaced > 0 ? bucket.disputed / bucket.surfaced : 0;
  }
  for (const bucket of Object.values(perRepo)) {
    bucket.rate = bucket.surfaced > 0 ? bucket.disputed / bucket.surfaced : 0;
  }

  // Top clusters — group records by shared sigToken overlap.
  const topClusters = clusterRecordsBySigTokens(inWindow).slice(0, TOP_CLUSTERS_LIMIT);

  return {
    installationId,
    window,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    generatedAt: windowEndIso,
    totalFindingsSurfaced,
    totalDisputes,
    disputeRate,
    totalSilentDrops,
    totalAgreements,
    perCategory,
    perSeverity,
    perRepo,
    topClusters,
  };
}

// ─── Internal: #334 per-record windowing ────────────────────────────────────

/** One record's contribution to a window — the four counters the insight derives from. */
interface WindowedCounts {
  surfaced: number;
  disputes: number;
  silentDrops: number;
  agreements: number;
}

/**
 * How much of `r`'s activity falls inside [windowStart, windowEnd].
 *
 * Two regimes:
 *   • `firstSeen` inside the window — the record's whole lifetime is
 *     in-window, so the lifetime counters are exact. This also keeps recent
 *     findings fully counted even when they predate the period buckets
 *     shipping (#334 stage 1).
 *   • `firstSeen` before the window — only the per-day buckets overlapping
 *     the window count. Records written before buckets existed contribute
 *     nothing here (an honest undercount that self-heals within one
 *     window-length of stage 1 deploying — see the #334 backfill plan).
 *
 * Buckets are whole UTC days; a bucket on the window's start day is included
 * wholesale (bounded overcount of < 1 day of activity, in exchange for never
 * splitting a day the data can't split). Day keys are `YYYY-MM-DD`, so plain
 * string comparison is chronological.
 */
function windowedCounts(
  r: FindingDispositionRecord,
  windowStartMs: number,
  windowEndMs: number,
): WindowedCounts {
  const counts: WindowedCounts = { surfaced: 0, disputes: 0, silentDrops: 0, agreements: 0 };
  const firstSeenMs = new Date(r.firstSeen).getTime();
  if (firstSeenMs > windowEndMs) return counts;

  if (firstSeenMs >= windowStartMs) {
    counts.surfaced    = r.surfaceCount;
    counts.disputes    = r.disputeCount;
    counts.silentDrops = r.silentDropCount;
    counts.agreements  = r.agreementCount;
    return counts;
  }

  if (!r.periodCounts) return counts;
  const startDay = periodDayKey(new Date(windowStartMs).toISOString());
  const endDay   = periodDayKey(new Date(windowEndMs).toISOString());
  for (const [day, bucket] of Object.entries(r.periodCounts)) {
    if (day < startDay || day > endDay) continue;
    counts.surfaced    += bucket.surface    ?? 0;
    counts.disputes    += bucket.dispute    ?? 0;
    counts.silentDrops += bucket.silentDrop ?? 0;
    counts.agreements  += bucket.agreement  ?? 0;
  }
  return counts;
}

// ─── Internal: clustering ────────────────────────────────────────────────────

interface ClusterMember {
  rec: FindingDispositionRecord;
  tokens: Set<string>;
}

interface RawCluster {
  members: ClusterMember[];
}

/**
 * Group disposition records into clusters of "the same finding shape".
 * Two records are in the same cluster when their sigToken bags share at
 * least one token (Jaccard > 0 over significant tokens). Implemented as a
 * disjoint-set union-find over the records list.
 *
 * Records without sigTokens are skipped entirely — they don't participate
 * in clusters (no signal to group on) but they DO still contribute to
 * the global + per-category + per-repo totals above.
 *
 * Output is sorted by `disputeRate × surfaceCount` desc so the dashboard
 * top-N renders the highest-leverage items first.
 */
function clusterRecordsBySigTokens(
  records: readonly FindingDispositionRecord[],
): InstallationFPInsight['topClusters'] {
  const members: ClusterMember[] = [];
  for (const r of records) {
    if (!r.sigTokens || r.sigTokens.length === 0) continue;
    members.push({ rec: r, tokens: new Set(r.sigTokens) });
  }
  if (members.length === 0) return [];

  // Union-find by shared significant token. We pre-index records by
  // each token they carry — when two records share a token they're
  // unioned. O(N · K) where K is the avg sigTokens-per-record cap (16).
  const parent: number[] = members.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const tokenIndex = new Map<string, number[]>();
  for (let i = 0; i < members.length; i++) {
    for (const t of members[i].tokens) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t)!.push(i);
    }
  }
  for (const idxs of tokenIndex.values()) {
    for (let j = 1; j < idxs.length; j++) {
      union(idxs[0], idxs[j]);
    }
  }

  // Group by root.
  const byRoot = new Map<number, RawCluster>();
  for (let i = 0; i < members.length; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, { members: [] });
    byRoot.get(root)!.members.push(members[i]);
  }

  // Synthesize the public cluster shape: representative title (the
  // highest-surfacing member's title — extracted from the match key) +
  // union of sigTokens + summed counts.
  const clusters: InstallationFPInsight['topClusters'] = [];
  for (const c of byRoot.values()) {
    let surfaceCount = 0;
    let disputeCount = 0;
    const tokens = new Set<string>();
    let topMember = c.members[0];
    for (const m of c.members) {
      surfaceCount += m.rec.surfaceCount;
      disputeCount += m.rec.disputeCount;
      for (const t of m.tokens) tokens.add(t);
      if (m.rec.surfaceCount > topMember.rec.surfaceCount) topMember = m;
    }
    clusters.push({
      sigTokens: Array.from(tokens).sort(),
      representativeTitle: extractTitleFromMatchKey(topMember.rec.findingMatchKey),
      surfaceCount,
      disputeCount,
      rate: surfaceCount > 0 ? disputeCount / surfaceCount : 0,
    });
  }

  // Sort by leverage: disputeRate × surfaceCount.
  clusters.sort((a, b) => (b.rate * b.surfaceCount) - (a.rate * a.surfaceCount));
  return clusters;
}

/**
 * Pull a human-readable title out of a `file::T::<title>` match key.
 * For `file::F::<fingerprint>` keys we don't have a title, so fall back
 * to the file path — better than an opaque fingerprint hash on the dashboard.
 */
function extractTitleFromMatchKey(key: string): string {
  // Format is `<file>::T::<title>` or `<file>::F::<fingerprint>`.
  const titleSep = '::T::';
  const fpSep    = '::F::';
  const tIdx = key.indexOf(titleSep);
  if (tIdx >= 0) return key.slice(tIdx + titleSep.length);
  const fIdx = key.indexOf(fpSep);
  if (fIdx >= 0) return key.slice(0, fIdx); // fall back to file path
  return key;
}
