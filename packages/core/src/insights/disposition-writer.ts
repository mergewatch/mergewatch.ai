/**
 * FB-A / FB-B — write fan-out for FindingDispositionRecord.
 *
 * Both handlers (server + lambda) call the same helpers below after the
 * review pipeline runs and after triage / inline-resolve persists, so the
 * counter semantics stay identical across deployment shapes.
 *
 * Best-effort by design: every helper catches and logs (the store
 * implementations also catch internally — this is belt-and-braces). A
 * disposition write must never block a review.
 *
 * Idempotency: counters are monotonic; each helper call corresponds to one
 * "event". Callers should not loop the same event with the same key set.
 */

import type { IFindingDispositionStore } from '../storage/types.js';
import type { OrchestratedFinding, PreviousFinding } from '../agents/reviewer.js';
import { findingMatchKeys, fingerprintFromCode } from '../review-delta.js';
import { extractSignificantTokens } from '../finding-clustering.js';

/**
 * FB-A — record one surfacing per finding. Writes one upsertSurface call per
 * key returned by `findingMatchKeys(finding)` (typically 2: a title key
 * plus a fingerprint key when one is available). The cluster step in FB-E
 * merges sibling rows by sigTokens overlap.
 *
 * Also writes the W2 verification counter when the finding carries a
 * `verification` tag (`verified` → incrementVerified; `unverified` →
 * incrementUnverified). The same fan-out per match-key.
 */
export async function recordFindingSurfacings(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  findings: OrchestratedFinding[],
  nowIso: string,
): Promise<void> {
  if (!store || installationId == null) return;
  const inst = String(installationId);
  for (const f of findings) {
    const keys = findingMatchKeys(f);
    const attribution = {
      // OrchestratedFinding's `category` field carries values like
      // 'security' / 'bug' / 'style' / etc. as set by the agent prompts.
      // Pass it through verbatim; the store accepts the wider union and
      // narrows via the `FindingDispositionRecord['category']` type at
      // read time.
      ...(f.category ? { category: f.category as never } : {}),
      // Best-effort token bag — falls back to title-only if description
      // is empty. extractSignificantTokens strips stop-words for us; the
      // Array.from + slice trims to a reasonable cap (W10 clusters are
      // tight, more than ~16 tokens is just noise).
      sigTokens: Array.from(extractSignificantTokens(`${f.title} ${f.description ?? ''}`)).slice(0, 16),
    };
    for (const key of keys) {
      // Fire-and-await; per-call error swallow lives inside the store. We
      // sequence (not Promise.all) so a single store hiccup doesn't bury
      // the rest of the writes in one rejected promise.
      try {
        await store.upsertSurface(inst, repoFullName, key, nowIso, attribution);
        if (f.verification === 'verified') {
          await store.incrementVerified(inst, repoFullName, key);
        } else if (f.verification === 'unverified') {
          await store.incrementUnverified(inst, repoFullName, key);
        }
      } catch (err) {
        // Defense in depth — the store layer already catches; this is the
        // umbrella around the entire (upsert + verify) sequence for this key.
        console.warn('[fb-a] recordFindingSurfacings: write failed for %s', key, err);
      }
    }
  }
}

/**
 * FB-A — record one dispute per key. Used for both:
 *   • W3 disputedKeys (from `## mergewatch triage` mapping)
 *   • FP-F inline-resolve match keys
 *
 * Idempotency note: this MAY double-count when the same dispute arrives via
 * two channels (e.g. author rebutted via triage AND clicked /resolve on
 * the inline thread). We accept the rare double-count rather than maintain
 * an event-source table to dedupe — analytically a "double-disputed"
 * finding is still a strong FP signal, so the bias is in the safe direction.
 */
export async function recordDisputes(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  matchKeys: readonly string[],
): Promise<void> {
  if (!store || installationId == null || matchKeys.length === 0) return;
  const inst = String(installationId);
  for (const key of matchKeys) {
    try {
      await store.incrementDispute(inst, repoFullName, key);
    } catch (err) {
      console.warn('[fb-a] recordDisputes: write failed for %s', key, err);
    }
  }
}

// ─── FB-B — quiet-drop derived counter ─────────────────────────────────────

/**
 * Detect quiet drops: findings that were present in the prior review,
 * are NOT present in the current review, AND whose cited code was not
 * changed by this PR. A strong implicit FP signal — the orchestrator
 * looked at the same code with the same prior context and chose to
 * drop the finding without the code itself moving.
 *
 * Definition of "code didn't change" — the prior finding's `line` is NOT
 * in `changedLines.get(file)`. We deliberately don't require the file to
 * be in the diff at all; even on a re-review of an unchanged file the
 * orchestrator has the previous finding in its prompt via
 * `buildPreviousFindingsBlock` and choosing to drop it counts.
 *
 * Returns the subset of `priorFindings` that meet all three conditions.
 * Stable per-finding identity uses `findingMatchKeys` (title key always,
 * fingerprint key when available) — same as W3 / FP-F.
 */
export function detectQuietDrops(
  currentFindings: readonly OrchestratedFinding[],
  priorFindings: readonly PreviousFinding[],
  changedLines: Map<string, Set<number>> | undefined,
): PreviousFinding[] {
  if (priorFindings.length === 0) return [];
  // Defensive: when the pipeline didn't return changedLines (older mocks,
  // legacy callers), conservatively report NO quiet drops. Better to under-
  // count silentDrop signal than to false-positive on a "this finding
  // vanished" without proof the cited code was untouched.
  if (!changedLines) return [];

  // Build a set of EVERY key any current finding carries, so the resolved-
  // set check below uses the same union-matching W3 / FP-F use.
  const currentKeySet = new Set<string>();
  for (const f of currentFindings) {
    for (const k of findingMatchKeys(f)) currentKeySet.add(k);
  }

  const quietDrops: PreviousFinding[] = [];
  for (const p of priorFindings) {
    const priorKeys = findingMatchKeys(p);
    // Still present (under any of its keys)? Not a drop at all.
    if (priorKeys.some((k) => currentKeySet.has(k))) continue;

    // Was the cited code touched on this commit? If yes → legitimate
    // resolve via code change. If no → quiet drop.
    const fileChanges = changedLines.get(p.file);
    const lineChanged = fileChanges?.has(p.line) ?? false;
    if (lineChanged) continue;

    quietDrops.push(p);
  }
  return quietDrops;
}

/**
 * FB-B — record one silentDropCount increment per match key of each quiet-
 * dropped finding.
 */
export async function recordQuietDrops(
  store: IFindingDispositionStore | undefined,
  installationId: string | number | undefined,
  repoFullName: string,
  quietDrops: readonly PreviousFinding[],
): Promise<void> {
  if (!store || installationId == null || quietDrops.length === 0) return;
  const inst = String(installationId);
  for (const p of quietDrops) {
    for (const key of findingMatchKeys(p)) {
      try {
        await store.incrementSilentDrop(inst, repoFullName, key);
      } catch (err) {
        console.warn('[fb-b] recordQuietDrops: write failed for %s', key, err);
      }
    }
  }
}

// Re-exported so external callers don't need to dip into review-delta.js
// just to inspect the same helper the writers use.
export { fingerprintFromCode };
