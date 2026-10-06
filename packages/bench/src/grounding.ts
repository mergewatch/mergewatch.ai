/**
 * #699 — grounding for an offline run, with the fetch outcomes made visible.
 *
 * `FileFetchOptions` is coupled to Octokit, not to an App installation — the
 * only GitHub call in the whole fetch path is `octokit.repos.getContent`
 * (`packages/core/src/context/file-fetcher.ts:43`) — so a read-only PAT, or
 * even an unauthenticated client, works against a public repo.
 *
 * The problem is that `file-fetcher.ts:67` is a bare `catch {}`. A 403
 * secondary-rate-limit, a 404 on a deleted fork and a file over 1MB are all
 * indistinguishable from "no such file", so a run can report itself grounded
 * while having fetched nothing at all. At ~80 getContent calls per case,
 * 50 cases sits near a PAT's 5,000/hr primary limit and the secondary limits
 * bite first — silently.
 *
 * Hence: wrap the client, count what actually happened, and report outcomes
 * plus a file count rather than a boolean. `grounding.enabled` is a claim;
 * `grounding.filesFetched` is evidence.
 */
import type { FileFetchOptions } from '@mergewatch/core';
import type { GroundingReport } from './types.js';

/** The one method core's fetch path calls. */
export interface MinimalOctokit {
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<unknown>;
  };
}

export interface GroundingHandle {
  /** Pass as `groundingFetch` (and `fileFetchOptions`) to the pipeline. */
  options: FileFetchOptions;
  /** Live counters; read after the pipeline returns. */
  report: GroundingReport;
}

/** Report for a case that ran with no grounding at all. */
export function disabledGrounding(): GroundingReport {
  return { enabled: false, attempted: 0, succeeded: 0, failed: 0, filesFetched: 0 };
}

/**
 * Wrap a client so every `repos.getContent` is counted as attempted, and
 * then as succeeded or failed. Errors are re-thrown unchanged so core's own
 * skip-silently behaviour is preserved exactly — this observes the path, it
 * does not alter it.
 */
export function buildGrounding(params: {
  octokit: MinimalOctokit;
  owner: string;
  repo: string;
  ref: string;
  maxContextKB?: number;
  maxRounds?: number;
}): GroundingHandle {
  const report: GroundingReport = {
    enabled: true,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    filesFetched: 0,
  };

  const inner = params.octokit;
  const recording: MinimalOctokit = {
    repos: {
      async getContent(args) {
        report.attempted++;
        try {
          const res = await inner.repos.getContent(args);
          report.succeeded++;
          // Count only responses that actually carried file content. GitHub
          // returns a directory listing, or omits `content` for files over
          // 1MB — both are 200s that ground nothing.
          const data = (res as { data?: { content?: unknown } } | undefined)?.data;
          if (data && typeof data.content === 'string' && data.content.length > 0) {
            report.filesFetched++;
          }
          return res;
        } catch (err) {
          report.failed++;
          throw err;
        }
      },
    },
  };

  return {
    options: {
      // Cast: FileFetchOptions wants the full Octokit type, but the fetch
      // path only ever reaches repos.getContent (file-fetcher.ts:43).
      octokit: recording as unknown as FileFetchOptions['octokit'],
      owner: params.owner,
      repo: params.repo,
      ref: params.ref,
      maxContextKB: params.maxContextKB ?? 256,
      maxRounds: params.maxRounds ?? 1,
    },
    report,
  };
}
