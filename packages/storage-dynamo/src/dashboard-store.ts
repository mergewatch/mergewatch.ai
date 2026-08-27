/**
 * DynamoDB implementation of IDashboardStore.
 *
 * Logic extracted from dashboard API routes (packages/dashboard/app/api/).
 * This is a code move — same DynamoDB queries, now behind the dashboard interface.
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  IDashboardStore,
  IDashboardInstallationStore,
  IDashboardReviewStore,
  PaginatedResult,
  ReviewStats,
  RepoStats,
  InstallationItem,
  InstallationSettings,
  ReviewItem,
  OrgCustomAgent,
  ReviewTraceItem,
} from '@mergewatch/core';
import { DEFAULT_INSTALLATION_SETTINGS as DEFAULTS, sanitizeOrgCustomAgents, usableOutcomes, TraceStorageNotConfiguredError } from '@mergewatch/core';

// ─── Installation store ─────────────────────────────────────────────────────

class DynamoDashboardInstallationStore implements IDashboardInstallationStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async listByInstallation(installationId: string): Promise<InstallationItem[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'installationId = :iid',
        ExpressionAttributeValues: { ':iid': installationId },
      }),
    );
    // Filter out the sentinel rows (#SETTINGS, #AGENTS) — they aren't repos.
    return ((result.Items ?? []) as InstallationItem[]).filter(
      (item) => item.repoFullName !== '#SETTINGS' && item.repoFullName !== '#AGENTS',
    );
  }

  async getSettings(installationId: string): Promise<InstallationSettings> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { installationId, repoFullName: '#SETTINGS' },
        }),
      );

      const saved = (result.Item?.settings ?? {}) as Partial<InstallationSettings>;
      return {
        ...DEFAULTS,
        ...saved,
        commentTypes: { ...DEFAULTS.commentTypes, ...(saved.commentTypes ?? {}) },
        summary: { ...DEFAULTS.summary, ...(saved.summary ?? {}) },
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  async updateSettings(installationId: string, settings: InstallationSettings): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { installationId, repoFullName: '#SETTINGS' },
        UpdateExpression: 'SET settings = :settings, updatedAt = :now',
        ExpressionAttributeValues: {
          ':settings': settings,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  async getCustomAgents(installationId: string): Promise<OrgCustomAgent[]> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { installationId, repoFullName: '#AGENTS' },
        }),
      );
      return sanitizeOrgCustomAgents(result.Item?.agents);
    } catch (err) {
      console.error('[dashboard-store] getCustomAgents failed:', err);
      return [];
    }
  }

  async updateCustomAgents(installationId: string, agents: OrgCustomAgent[]): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          installationId,
          repoFullName: '#AGENTS',
          agents: sanitizeOrgCustomAgents(agents),
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

}

// ─── Review store ───────────────────────────────────────────────────────────

/**
 * #335 — GSI on the reviews table: PK repoFullName, SK createdAt
 * (infra/template.yaml). The base table's sort key (prNumberCommitSha,
 * "42#abc123") orders by PR-number STRING, so a descending base-table query
 * walks "9#…" > "42#…" > "100#…" — not time. This index is what makes
 * time-ordered listing possible.
 */
export const REVIEWS_BY_CREATED_AT_INDEX = 'ByRepoCreatedAt';

/**
 * Safety bound on the per-repo status-filter paging loop below. Only the
 * status filter can force extra pages (dates live in the key condition), so
 * in practice one page suffices; this caps a pathological repo where nearly
 * every read item is filtered out.
 */
const MAX_QUERY_PAGES_PER_REPO = 10;

/**
 * v2 cursor (#335): per-repo resume position = the GSI key of the last item
 * this page RETURNED for that repo (repoFullName + createdAt + the base-table
 * key, which is what a GSI ExclusiveStartKey requires). Anchoring the cursor
 * on returned — not fetched — items means rows that were read but dropped by
 * the global limit are re-fetched on the next page instead of silently lost
 * (the v1 cursor stored the raw LastEvaluatedKey, which had already advanced
 * past them). `exhausted` lists repos whose streams ran dry with every
 * fetched row returned.
 */
interface ListReviewsCursorV2 {
  v: 2;
  keys: Record<string, Record<string, unknown>>;
  exhausted: string[];
}

/** What one repo's in-flight query contributed to a `listReviews` page. */
interface RepoFetchResult {
  repoFullName: string;
  items: Record<string, unknown>[];
  /** Raw LastEvaluatedKey when the query stopped with more index left. */
  lastEvaluatedKey?: Record<string, unknown>;
}

export class DynamoDashboardReviewStore implements IDashboardReviewStore {
  /**
   * Sticky flag — set on the first "index does not exist" error so a stack
   * deployed without the #335 GSI (phase 2 code ahead of phase 1 infra)
   * degrades to the legacy base-table path once, not on every request.
   */
  private gsiUnavailable = false;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    /**
     * #472 — the filter-trace table (#471). Optional here so a deployment
     * provisioned before #471 still serves the rest of the dashboard.
     *
     * #494 — when it is unset, getReviewTrace THROWS rather than reporting
     * "no trace". Reporting no trace was a lie the reader could not detect:
     * it is the same answer a review with nothing filtered produces, so a
     * misconfiguration read as a clean result. Everything else on the
     * dashboard still works; only the trail fails, and it fails visibly.
     */
    private readonly tracesTable?: string,
  ) {}

  async listReviews(
    repos: string[],
    limit: number,
    cursor?: string,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>> {
    let decoded: Record<string, unknown> | undefined;
    if (cursor) {
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      } catch {
        // Invalid cursor — start fresh
      }
    }

    // A v1 cursor is mid-flight through the legacy path — finish the
    // pagination sequence there (its keys are base-table positions that the
    // GSI cannot resume from). New sequences start on the GSI.
    if (this.gsiUnavailable || (decoded && decoded.v !== 2)) {
      return this.listReviewsLegacy(repos, limit, decoded as never, status, startDate, endDate);
    }

    const cursorState: ListReviewsCursorV2 =
      decoded && decoded.v === 2
        ? (decoded as unknown as ListReviewsCursorV2)
        : { v: 2, keys: {}, exhausted: [] };

    try {
      return await this.listReviewsByCreatedAt(repos, limit, cursorState, status, startDate, endDate);
    } catch (err: unknown) {
      // "index does not exist" → the stack predates the #335 GSI. Degrade to
      // the legacy path (known #335 defects and all — still better than a
      // hard 500) and stop retrying the index. Anything else is a real error.
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      const message = err instanceof Error ? err.message : String(err);
      const indexMissing =
        (name === 'ValidationException' || name === 'ResourceNotFoundException') &&
        /index/i.test(message);
      if (!indexMissing) throw err;
      this.gsiUnavailable = true;
      console.warn(
        '[dashboard-store] %s index not found on %s — falling back to base-table listReviews (deploy the #335 GSI to restore time-ordered listing)',
        REVIEWS_BY_CREATED_AT_INDEX, this.tableName,
      );
      // Restart the sequence: a v2 cursor cannot resume a base-table query.
      return this.listReviewsLegacy(repos, limit, undefined, status, startDate, endDate);
    }
  }

  /**
   * #335 — time-ordered listing over the ByRepoCreatedAt GSI.
   *
   *   • Ordering: ScanIndexForward=false over createdAt — true reverse
   *     chronological, independent of PR numbers (defect 1).
   *   • Dates: bounds live in the KeyConditionExpression, so `Limit` applies
   *     to MATCHING items — a narrow range can no longer discard matching
   *     rows that sat beyond the first unfiltered page (defect 3).
   *   • Limit: bounds the merged result; each repo reads at most `limit`
   *     matching items per page (the price of per-repo partitions — computing
   *     the global newest-N needs up to N candidates per repo), and the v2
   *     cursor re-fetches anything the global slice dropped (defect 2).
   *
   * Repos fan out in parallel (same shape as getReviewStats below).
   */
  private async listReviewsByCreatedAt(
    repos: string[],
    limit: number,
    cursorState: ListReviewsCursorV2,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>> {
    const results = await Promise.all(
      repos
        .filter((repoFullName) => !cursorState.exhausted.includes(repoFullName))
        .map((repoFullName) =>
          this.queryRepoByCreatedAt(repoFullName, limit, cursorState.keys[repoFullName], status, startDate, endDate),
        ),
    );

    // Merge and order the candidate streams. createdAt is the real sort key;
    // the base-table key breaks ties deterministically.
    const allReviews = results.flatMap((r) => r.items);
    allReviews.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
      String(b.prNumberCommitSha ?? '').localeCompare(String(a.prNumberCommitSha ?? '')),
    );
    const paged = allReviews.slice(0, limit) as unknown as ReviewItem[];

    // Per-repo resume positions anchored on RETURNED items (see the v2
    // cursor contract above).
    const returnedCount = new Map<string, number>();
    const lastReturned = new Map<string, Record<string, unknown>>();
    for (const item of paged as unknown as Record<string, unknown>[]) {
      const repo = String(item.repoFullName);
      returnedCount.set(repo, (returnedCount.get(repo) ?? 0) + 1);
      lastReturned.set(repo, item);
    }

    const nextCursorState: ListReviewsCursorV2 = {
      v: 2,
      keys: {},
      exhausted: [...cursorState.exhausted],
    };
    for (const r of results) {
      const returned = returnedCount.get(r.repoFullName) ?? 0;
      const dropped = r.items.length - returned;
      if (dropped === 0 && !r.lastEvaluatedKey) {
        // Stream ran dry and everything it produced went out this page.
        nextCursorState.exhausted.push(r.repoFullName);
        continue;
      }
      const anchor = lastReturned.get(r.repoFullName);
      if (anchor) {
        // Resume strictly after the last returned item. A GSI
        // ExclusiveStartKey carries the index keys plus the base-table key.
        nextCursorState.keys[r.repoFullName] = {
          repoFullName: anchor.repoFullName,
          createdAt: anchor.createdAt,
          prNumberCommitSha: anchor.prNumberCommitSha,
        };
      } else if (r.lastEvaluatedKey && dropped === 0) {
        // Nothing fetched survived the status filter this page — continue
        // from where the query stopped reading.
        nextCursorState.keys[r.repoFullName] = r.lastEvaluatedKey;
      } else {
        // Items were fetched but none returned (all dropped by the global
        // slice) — keep the incoming position so they're re-fetched.
        const incoming = cursorState.keys[r.repoFullName];
        if (incoming) nextCursorState.keys[r.repoFullName] = incoming;
        // No incoming key means this repo restarts from the top next page —
        // correct, since none of its rows have been returned yet.
      }
    }

    const hasMore = nextCursorState.exhausted.length < repos.length;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify(nextCursorState)).toString('base64url')
      : null;

    return { items: paged, nextCursor };
  }

  /** One repo's page: query the GSI, paging past status-filter losses until
   *  `limit` matching items, the stream runs dry, or the page cap trips. */
  private async queryRepoByCreatedAt(
    repoFullName: string,
    limit: number,
    exclusiveStartKey: Record<string, unknown> | undefined,
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<RepoFetchResult> {
    const values: Record<string, unknown> = { ':repo': repoFullName };
    let keyCondition = 'repoFullName = :repo';
    if (startDate && endDate) {
      keyCondition += ' AND createdAt BETWEEN :startDate AND :endDate';
      values[':startDate'] = startDate;
      values[':endDate'] = endDate;
    } else if (startDate) {
      keyCondition += ' AND createdAt >= :startDate';
      values[':startDate'] = startDate;
    } else if (endDate) {
      keyCondition += ' AND createdAt <= :endDate';
      values[':endDate'] = endDate;
    }

    const params: Record<string, unknown> = {
      TableName: this.tableName,
      IndexName: REVIEWS_BY_CREATED_AT_INDEX,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      Limit: limit,
    };
    if (status) {
      params.FilterExpression = '#s = :status';
      params.ExpressionAttributeNames = { '#s': 'status' };
      values[':status'] = status === 'completed' ? 'complete' : status;
    }

    const items: Record<string, unknown>[] = [];
    let startKey = exclusiveStartKey;
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES_PER_REPO; page++) {
      const result = await this.client.send(new QueryCommand({
        ...params,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      } as any));
      items.push(...(result.Items ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!lastEvaluatedKey || items.length >= limit) break;
      startKey = lastEvaluatedKey;
    }
    return { repoFullName, items, ...(lastEvaluatedKey ? { lastEvaluatedKey } : {}) };
  }

  /**
   * Pre-#335 base-table implementation, kept verbatim as the fallback for
   * stacks where the ByRepoCreatedAt GSI is not deployed yet and for
   * finishing pagination sequences started on v1 cursors. Known defects
   * (#335): PR-number-string candidate order, per-repo Limit, Limit applied
   * before FilterExpression.
   */
  private async listReviewsLegacy(
    repos: string[],
    limit: number,
    decodedCursor?: { keys: Record<string, Record<string, unknown>>; exhausted: string[] },
    status?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PaginatedResult<ReviewItem>> {
    const cursorState: {
      keys: Record<string, Record<string, unknown>>;
      exhausted: string[];
    } = decodedCursor && decodedCursor.keys && decodedCursor.exhausted
      ? { keys: decodedCursor.keys, exhausted: decodedCursor.exhausted }
      : { keys: {}, exhausted: [] };

    const allReviews: Record<string, unknown>[] = [];
    const nextCursorState: typeof cursorState = {
      keys: {},
      exhausted: [...cursorState.exhausted],
    };

    for (const repoFullName of repos) {
      if (cursorState.exhausted.includes(repoFullName)) continue;

      const params: Record<string, unknown> = {
        TableName: this.tableName,
        KeyConditionExpression: 'repoFullName = :repo',
        ExpressionAttributeValues: { ':repo': repoFullName } as Record<string, unknown>,
        ScanIndexForward: false,
        Limit: limit,
      };

      const filterParts: string[] = [];

      if (status) {
        filterParts.push('#s = :status');
        if (!params.ExpressionAttributeNames) params.ExpressionAttributeNames = {};
        (params.ExpressionAttributeNames as Record<string, string>)['#s'] = 'status';
        (params.ExpressionAttributeValues as Record<string, unknown>)[':status'] =
          status === 'completed' ? 'complete' : status;
      }

      if (startDate) {
        filterParts.push('createdAt >= :startDate');
        (params.ExpressionAttributeValues as Record<string, unknown>)[':startDate'] = startDate;
      }
      if (endDate) {
        filterParts.push('createdAt <= :endDate');
        (params.ExpressionAttributeValues as Record<string, unknown>)[':endDate'] = endDate;
      }

      if (filterParts.length > 0) {
        params.FilterExpression = filterParts.join(' AND ');
      }

      if (cursorState.keys[repoFullName]) {
        params.ExclusiveStartKey = cursorState.keys[repoFullName];
      }

      const result = await this.client.send(new QueryCommand(params as any));
      allReviews.push(...(result.Items ?? []));

      if (result.LastEvaluatedKey) {
        nextCursorState.keys[repoFullName] = result.LastEvaluatedKey as Record<string, unknown>;
      } else {
        nextCursorState.exhausted.push(repoFullName);
      }
    }

    // Sort all results by createdAt descending
    allReviews.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );

    const paged = allReviews.slice(0, limit) as unknown as ReviewItem[];

    const hasMore =
      allReviews.length > limit ||
      Object.keys(nextCursorState.keys).length > 0 ||
      nextCursorState.exhausted.length < repos.length;

    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify(nextCursorState)).toString('base64url')
      : null;

    return { items: paged, nextCursor };
  }

  async getReview(repoFullName: string, prNumberCommitSha: string): Promise<ReviewItem | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { repoFullName, prNumberCommitSha },
      }),
    );
    return (result.Item as ReviewItem) ?? null;
  }

  async getReviewTrace(
    repoFullName: string,
    prNumberCommitSha: string,
  ): Promise<ReviewTraceItem | null> {
    if (!this.tracesTable) {
      // Logged as well as thrown: the throw reaches the reader as "could not
      // be loaded", but an operator needs to find the cause without reading
      // the source. This is the signal that was missing for the whole of #494.
      console.error(
        '[trace] no trace table configured — the decision trail cannot be served. ' +
        'Set DYNAMODB_TABLE_REVIEW_TRACES and declare it in the next.config.js env block.',
      );
      throw new TraceStorageNotConfiguredError();
    }
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tracesTable,
        Key: { repoFullName, prNumberCommitSha },
      }),
    );
    const item = result.Item as ReviewTraceItem | undefined;
    // Same boundary check the trace store itself uses (#480 review): the
    // consumer iterates `outcomes`, so a malformed row must not reach it.
    if (!item || !Array.isArray(item.outcomes)) return null;
    // #482 review — the ELEMENTS are unvalidated too. The renderer calls
    // `e.agents.join(...)`, which throws on a row missing that field.
    const { outcomes, total } = usableOutcomes(item.outcomes);
    const lost = total - outcomes.length;
    return {
      ...item,
      outcomes,
      // A partial trail must not read as complete.
      ...(item.truncated || lost > 0 ? { truncated: true } : {}),
      ...(item.totalOutcomes != null
        ? { totalOutcomes: item.totalOutcomes }
        : lost > 0 ? { totalOutcomes: total } : {}),
    };
  }

  async updateFeedback(
    repoFullName: string,
    prNumberCommitSha: string,
    feedback: 'up' | 'down' | null,
  ): Promise<void> {
    if (feedback === null) {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { repoFullName, prNumberCommitSha },
          UpdateExpression: 'REMOVE feedback',
        }),
      );
    } else {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { repoFullName, prNumberCommitSha },
          UpdateExpression: 'SET feedback = :fb',
          ExpressionAttributeValues: { ':fb': feedback },
        }),
      );
    }
  }

  async getReviewStats(repos: string[]): Promise<ReviewStats> {
    let total = 0;
    let completed = 0;
    let findings = 0;

    const promises = repos.map(async (repoFullName) => {
      try {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'repoFullName = :repo',
            ExpressionAttributeValues: { ':repo': repoFullName },
            ProjectionExpression: '#s, findingCount',
            ExpressionAttributeNames: { '#s': 'status' },
          }),
        );
        for (const item of result.Items ?? []) {
          total++;
          if (item.status === 'complete') completed++;
          if (typeof item.findingCount === 'number') findings += item.findingCount;
        }
      } catch {
        // skip
      }
    });
    await Promise.all(promises);

    return { total, completed, findings };
  }

  async getRepoStats(repos: string[]): Promise<Map<string, RepoStats>> {
    const statsMap = new Map<string, RepoStats>();

    const promises = repos.map(async (repoFullName) => {
      try {
        const result = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'repoFullName = :repo',
            ExpressionAttributeValues: { ':repo': repoFullName },
            ScanIndexForward: false,
            Limit: 100,
          }),
        );

        let reviewCount = 0;
        let issueCount = 0;
        let lastReviewedAt: string | null = null;

        for (const item of result.Items ?? []) {
          if (item.status === 'complete') {
            reviewCount++;
            if (!lastReviewedAt) {
              lastReviewedAt =
                (item.completedAt as string) ?? (item.createdAt as string) ?? null;
            }
            const fc = item.findingCount;
            if (typeof fc === 'number') issueCount += fc;
          }
        }

        if (reviewCount > 0) {
          statsMap.set(repoFullName, { reviewCount, issueCount, lastReviewedAt });
        }
      } catch {
        // skip
      }
    });

    await Promise.all(promises);
    return statsMap;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface DynamoDashboardStoreOptions {
  installationsTable: string;
  reviewsTable: string;
  region?: string;
  /**
   * FB-F..FB-J — optional. When set, the dashboard store exposes an
   * `fpInsights` member backed by the named table. When unset the
   * dashboard chart routes render zero-state (no table provisioned).
   */
  fpInsightsTable?: string;
  /**
   * #195 Phase 5 — optional. When set, the dashboard store exposes a
   * `satisfaction` member backed by the named table (NPS read/write). When
   * unset the NPS route reports "ineligible" and never prompts.
   */
  satisfactionTable?: string;
  /**
   * #472 — the #471 filter-trace table. Unset on a deployment provisioned
   * before #471; the trail panel then says no trace was recorded rather
   * than rendering an empty trail, which would read as "nothing was
   * filtered".
   */
  reviewTracesTable?: string;
}

export function createDynamoDashboardStore(options: DynamoDashboardStoreOptions): IDashboardStore {
  // Lazy-import to avoid pulling AWS SDK at module scope for non-DynamoDB callers.
  // The client is created once per factory call.
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  const { DynamoFPInsightStore } = require('./fp-insight-store.js');
  const { DynamoSatisfactionStore } = require('./satisfaction-store.js');

  const raw = new DynamoDBClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });

  // FB-F..FB-J — the FP insight store implements both the pipeline
  // `IFPInsightStore` (upsert / get) AND the dashboard surface
  // (listByInstallation), so we just hand the same instance to the
  // dashboard layer. The dashboard only calls listByInstallation —
  // upsert is never exercised from this path.
  const fpInsights = options.fpInsightsTable
    ? new DynamoFPInsightStore(client, options.fpInsightsTable)
    : undefined;

  // #195 Phase 5 — the satisfaction store implements the full pipeline
  // `ISatisfactionStore`; the dashboard only calls getNpsResponse /
  // recordNpsResponse (the `IDashboardSatisfactionStore` subset).
  const satisfaction = options.satisfactionTable
    ? new DynamoSatisfactionStore(client, options.satisfactionTable)
    : undefined;

  return {
    installations: new DynamoDashboardInstallationStore(client, options.installationsTable),
    reviews: new DynamoDashboardReviewStore(client, options.reviewsTable, options.reviewTracesTable),
    ...(fpInsights ? { fpInsights } : {}),
    ...(satisfaction ? { satisfaction } : {}),
  };
}
