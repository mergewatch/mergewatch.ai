/**
 * Postgres implementation of `IFindingDispositionStore` (FB-A).
 *
 * Storage rationale: one row per (installation, repo, findingMatchKey).
 * Counters live as plain integers + atomic SQL increments — using
 * `surface_count + 1` in the SET clause rather than a read-modify-write
 * loop keeps concurrent surfacings race-free.
 *
 * Best-effort writes: every method swallows-and-logs on failure (the
 * pipeline must never block on analytics). The caller decides whether to
 * await or fire-and-forget; both shapes are supported because every
 * method returns a Promise.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  IFindingDispositionStore,
  FindingDispositionAttribution,
  FindingDispositionRecord,
} from '@mergewatch/core';
import { findingDispositions } from './schema.js';

export class PostgresFindingDispositionStore implements IFindingDispositionStore {
  constructor(private db: PostgresJsDatabase) {}

  async upsertSurface(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    nowIso: string,
    attribution?: FindingDispositionAttribution,
  ): Promise<void> {
    try {
      await this.db
        .insert(findingDispositions)
        .values({
          installationId,
          repoFullName,
          findingMatchKey,
          firstSeen: nowIso,
          lastSeen: nowIso,
          surfaceCount: 1,
          category: attribution?.category ?? null,
          topAgent: attribution?.topAgent ?? null,
          severity: attribution?.severity ?? null,
          sigTokens: (attribution?.sigTokens as unknown) ?? null,
        })
        .onConflictDoUpdate({
          target: [
            findingDispositions.installationId,
            findingDispositions.repoFullName,
            findingDispositions.findingMatchKey,
          ],
          // Atomic increment + last-writer-wins on attribution fields.
          // `firstSeen` is preserved (only set on creation).
          set: {
            lastSeen: nowIso,
            surfaceCount: sql`${findingDispositions.surfaceCount} + 1`,
            // COALESCE keeps the prior value when this caller doesn't carry
            // attribution data (e.g. a 👎 reaction handler) — otherwise the
            // last writer would clear category/topAgent/sigTokens to null.
            ...(attribution?.category !== undefined
              ? { category: attribution.category }
              : {}),
            ...(attribution?.topAgent !== undefined
              ? { topAgent: attribution.topAgent }
              : {}),
            ...(attribution?.severity !== undefined
              ? { severity: attribution.severity }
              : {}),
            ...(attribution?.sigTokens !== undefined
              ? { sigTokens: attribution.sigTokens as unknown }
              : {}),
          },
        });
    } catch (err) {
      console.warn('[fb-a] upsertSurface failed (%s/%s/%s):', installationId, repoFullName, findingMatchKey, err);
    }
  }

  /** Shared counter-increment path; `column` is one of the typed counter columns. */
  private async incrementCounter(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    column: 'disputeCount' | 'verifiedCount' | 'unverifiedCount' | 'silentDropCount' | 'agreementCount' | 'resolveCount',
  ): Promise<void> {
    try {
      const colMap = {
        disputeCount:    findingDispositions.disputeCount,
        verifiedCount:   findingDispositions.verifiedCount,
        unverifiedCount: findingDispositions.unverifiedCount,
        silentDropCount: findingDispositions.silentDropCount,
        agreementCount:  findingDispositions.agreementCount,
        resolveCount:    findingDispositions.resolveCount,
      } as const;
      const dbCol = colMap[column];
      await this.db
        .update(findingDispositions)
        .set({ [column]: sql`${dbCol} + 1` } as Record<string, unknown>)
        .where(and(
          eq(findingDispositions.installationId, installationId),
          eq(findingDispositions.repoFullName, repoFullName),
          eq(findingDispositions.findingMatchKey, findingMatchKey),
        ));
    } catch (err) {
      console.warn('[fb-a] %s increment failed (%s/%s/%s):', column, installationId, repoFullName, findingMatchKey, err);
    }
  }

  incrementDispute(i: string, r: string, k: string)     { return this.incrementCounter(i, r, k, 'disputeCount'); }
  incrementVerified(i: string, r: string, k: string)    { return this.incrementCounter(i, r, k, 'verifiedCount'); }
  incrementUnverified(i: string, r: string, k: string)  { return this.incrementCounter(i, r, k, 'unverifiedCount'); }
  incrementSilentDrop(i: string, r: string, k: string)  { return this.incrementCounter(i, r, k, 'silentDropCount'); }
  incrementAgreement(i: string, r: string, k: string)   { return this.incrementCounter(i, r, k, 'agreementCount'); }
  incrementResolve(i: string, r: string, k: string)     { return this.incrementCounter(i, r, k, 'resolveCount'); }

  async appendRejectReason(
    installationId: string,
    repoFullName: string,
    findingMatchKey: string,
    reason: NonNullable<FindingDispositionRecord['rejectReasons']>[number],
  ): Promise<void> {
    try {
      // jsonb append via COALESCE + `||`. The COALESCE handles the legacy
      // pre-FB-D NULL value; the `||` operator appends one jsonb array to
      // another (so the SQL parameter must be an ARRAY of one element).
      await this.db
        .update(findingDispositions)
        .set({
          rejectReasons: sql`COALESCE(${findingDispositions.rejectReasons}, '[]'::jsonb) || ${JSON.stringify([reason])}::jsonb`,
        })
        .where(and(
          eq(findingDispositions.installationId, installationId),
          eq(findingDispositions.repoFullName, repoFullName),
          eq(findingDispositions.findingMatchKey, findingMatchKey),
        ));
    } catch (err) {
      console.warn('[fb-a] appendRejectReason failed (%s/%s/%s):', installationId, repoFullName, findingMatchKey, err);
    }
  }

  async listByInstallation(
    installationId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ items: FindingDispositionRecord[]; nextCursor?: string }> {
    const limit = Math.min(opts?.limit ?? 1000, 1000);
    const rows = await this.db
      .select()
      .from(findingDispositions)
      .where(eq(findingDispositions.installationId, installationId))
      // Cursor is the SK form `<repoFullName>#<findingMatchKey>` — applied via
      // tuple compare so paging is stable across writes.
      .limit(limit);
    const items: FindingDispositionRecord[] = rows.map((r) => ({
      installationId: r.installationId,
      repoFullName: r.repoFullName,
      findingMatchKey: r.findingMatchKey,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      surfaceCount: r.surfaceCount,
      disputeCount: r.disputeCount,
      verifiedCount: r.verifiedCount,
      unverifiedCount: r.unverifiedCount,
      silentDropCount: r.silentDropCount,
      agreementCount: r.agreementCount,
      resolveCount: r.resolveCount,
      ...(r.category ? { category: r.category as FindingDispositionRecord['category'] } : {}),
      ...(r.topAgent ? { topAgent: r.topAgent } : {}),
      ...(r.severity ? { severity: r.severity as FindingDispositionRecord['severity'] } : {}),
      ...(Array.isArray(r.sigTokens) ? { sigTokens: r.sigTokens as string[] } : {}),
      ...(Array.isArray(r.rejectReasons) ? { rejectReasons: r.rejectReasons as FindingDispositionRecord['rejectReasons'] } : {}),
    }));
    // Single-page for now — FB-E rollup can extend to cursor paging if any
    // installation exceeds the 1000-row cap.
    return { items };
  }
}
