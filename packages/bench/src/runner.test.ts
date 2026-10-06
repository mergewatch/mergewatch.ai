import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@mergewatch/core';
import type { ILLMProvider } from '@mergewatch/core';
import { parseChangedFiles, parseRepo, runBench } from './runner.js';
import { createCaseStub } from './stub.js';
import {
  ModelEchoMismatchError,
  RecordingProvider,
  SpendCapExceededError,
  UnpricedModelError,
  projectCaseCostUsd,
} from './provider.js';
import { buildGrounding, disabledGrounding } from './grounding.js';
import type { BenchCase, BenchManifest } from './types.js';

const SQLI_DIFF = `diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,3 +1,4 @@
 export function lookup(id: string) {
-  return db.query('SELECT 1', [id]);
+  return db.query('SELECT * FROM users WHERE id = ' + id);
 }
`;

function caseWithCatch(over: Partial<BenchCase> = {}): BenchCase {
  return {
    id: 'catch',
    repo: 'mergewatch/bench-smoke',
    prNumber: 101,
    headRef: 'deadbeef',
    diffPath: 'sqli.diff',
    groundTruth: [
      {
        id: 'gt-sqli',
        file: 'src/db.ts',
        line: 3,
        cause: 'concatenated SQL',
        causeKeywords: ['sql injection'],
      },
    ],
    stubFindings: [
      {
        file: 'src/db.ts',
        line: 3,
        severity: 'info',
        title: 'SQL injection via string concatenation',
        description: 'The id is concatenated into the query.',
      },
    ],
    ...over,
  };
}

function manifest(cases: BenchCase[]): BenchManifest {
  return { name: 'test', lineTolerance: 2, cases };
}

const readDiff = async () => SQLI_DIFF;

describe('parseChangedFiles', () => {
  it('reads paths from +++ b/ headers', () => {
    expect(parseChangedFiles(SQLI_DIFF)).toEqual(['src/db.ts']);
  });

  it('ignores /dev/null for a deleted file', () => {
    expect(parseChangedFiles('--- a/x.ts\n+++ b//dev/null\n')).toEqual([]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseChangedFiles('')).toEqual([]);
  });
});

describe('parseRepo', () => {
  it('splits owner/name', () => {
    expect(parseRepo('mergewatch/bench')).toEqual({ owner: 'mergewatch', name: 'bench' });
  });

  it.each(['owner', 'owner/', '/name', 'a/b/c', ''])(
    'fails loudly on malformed input: %o',
    (bad) => {
      // Yielding undefined would point the grounding fetch at a malformed
      // target, which reads back as "file not found" — a silent miss.
      expect(() => parseRepo(bad)).toThrow(/must be "owner\/name"/);
    },
  );
});

describe('spend accumulation', () => {
  it('accumulates a genuine zero rather than skipping it on a truthy test', async () => {
    // A skipped case reports exactly 0. The total must still be well-defined.
    const bigDiff = Array.from(
      { length: 60 },
      (_, i) => `diff --git a/src/m${i}.ts b/src/m${i}.ts\n--- a/src/m${i}.ts\n+++ b/src/m${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    ).join('');
    const result = await runBench({
      manifest: manifest([caseWithCatch({ id: 'skipped' })]),
      readDiff: async () => bigDiff,
      llm: (c) => createCaseStub(c),
    });
    expect(result.cases[0].estimatedCostUsd).toBe(0);
    expect(result.totals.spendUsd).toBe(0);
  });
});

describe('runBench — end to end on a stub', () => {
  it('grades a scripted catch and a scripted miss to exact metrics', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch(), caseWithCatch({ id: 'miss', stubFindings: [] })]),
      readDiff,
      llm: (c) => createCaseStub(c),
    });

    // TP 1 (the scripted catch), FN 1 (the scripted miss), FP 0.
    expect(result.totals.truePositives).toBe(1);
    expect(result.totals.falseNegatives).toBe(1);
    expect(result.totals.falsePositives).toBe(0);
    expect(result.totals.precision).toBe(1);
    expect(result.totals.recall).toBe(0.5);
    expect(result.totals.f1).toBeCloseTo(0.6666666666666666, 10);
    expect(result.totals.casesGraded).toBe(2);
    expect(result.totals.casesSkipped).toBe(0);
  });

  it('spends a non-zero amount, because the stub fabricates usage', async () => {
    // A usage-less stub would report 0 and make the cap untestable.
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
    });
    expect(result.totals.spendUsd).toBeGreaterThan(0);
    expect(result.cases[0].estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('the skip layer', () => {
  /** 60 changed .ts files — over the default maxFiles of 50. */
  const bigDiff = Array.from(
    { length: 60 },
    (_, i) =>
      `diff --git a/src/mod${i}.ts b/src/mod${i}.ts\n--- a/src/mod${i}.ts\n+++ b/src/mod${i}.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n`,
  ).join('');

  it('skips on maxFiles and scores the case as zero recall', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch({ id: 'too-big' })]),
      readDiff: async () => bigDiff,
      llm: (c) => createCaseStub(c),
    });

    expect(result.cases[0].skip).toBe('maxFiles');
    expect(result.totals.casesSkipped).toBe(1);
    expect(result.totals.casesGraded).toBe(0);
    // The case HAD stubFindings that would have matched. The skip layer
    // suppressed them, so recall is 0 — exactly as production behaves, where
    // a skipped PR contributes no comments.
    expect(result.totals.recall).toBe(0);
    expect(result.totals.truePositives).toBe(0);
    expect(result.totals.falseNegatives).toBe(1);
  });

  it('does not invoke the provider for a skipped case', async () => {
    const stub = createCaseStub(caseWithCatch());
    await runBench({
      manifest: manifest([caseWithCatch({ id: 'too-big' })]),
      readDiff: async () => bigDiff,
      llm: stub,
    });
    expect(stub.invocations).toBe(0);
  });

  it('skips a draft when skipDrafts is on, and does not when it is off', async () => {
    const draft = caseWithCatch({ isDraft: true });
    const on = await runBench({ manifest: manifest([draft]), readDiff, llm: (c) => createCaseStub(c) });
    expect(on.cases[0].skip).toBe('draft');

    const off = await runBench({
      manifest: manifest([draft]),
      readDiff,
      llm: (c) => createCaseStub(c),
      config: { rules: { ...DEFAULT_CONFIG.rules, skipDrafts: false } },
    });
    expect(off.cases[0].skip).toBeUndefined();
  });

  it('skips a docs-only diff as trivial', async () => {
    const docs = '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n';
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff: async () => docs,
      llm: (c) => createCaseStub(c),
    });
    expect(result.cases[0].skip).toBe('trivial');
  });
});

describe('the spend cap', () => {
  it('refuses to invoke anything when the cap is 0', async () => {
    const stub = createCaseStub(caseWithCatch());
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: stub,
        maxSpendUsd: 0,
      }),
    ).rejects.toThrow(SpendCapExceededError);

    // The whole point of a PRE-FLIGHT cap: nothing was spent, because
    // nothing was called. A cap checked after the pipeline returns could
    // not make this assertion.
    expect(stub.invocations).toBe(0);
  });

  it('names the cap and the projection in the message', async () => {
    await expect(
      runBench({ manifest: manifest([caseWithCatch()]), readDiff, llm: (c) => createCaseStub(c), maxSpendUsd: 0 }),
    ).rejects.toThrow(/cap \$0\.0000.*projected at \$\d/s);
  });

  it('allows a run that fits inside a generous cap', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
      maxSpendUsd: 1000,
    });
    expect(result.totals.casesGraded).toBe(1);
  });

  it('refuses pre-flight when the LIGHT model is unpriced, before invoking anything', async () => {
    // The hole this closes: a priced main model and an unpriced light model
    // used to pass pre-flight, run the pipeline, spend, and only then fail.
    const stub = createCaseStub(caseWithCatch());
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: stub,
        config: { lightModel: 'not-a-real-light-model' },
        maxSpendUsd: 1000,
      }),
    ).rejects.toThrow(UnpricedModelError);
    expect(stub.invocations).toBe(0);
  });

  it('names both models when either is unpriced', async () => {
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: (c) => createCaseStub(c),
        config: { lightModel: 'not-a-real-light-model' },
        maxSpendUsd: 1000,
      }),
    ).rejects.toThrow(/not-a-real-light-model/);
  });

  it('projects a cost that grows with diff size', () => {
    const small = projectCaseCostUsd('a'.repeat(100), DEFAULT_CONFIG.model);
    const large = projectCaseCostUsd('a'.repeat(100_000), DEFAULT_CONFIG.model);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large!).toBeGreaterThan(small!);
  });

  it('returns null when the model has no pricing', () => {
    expect(projectCaseCostUsd('abc', 'not-a-real-model-id')).toBeNull();
  });

  it('fails loudly on an unpriced model rather than reading it as free', async () => {
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: (c) => createCaseStub(c),
        config: { model: 'not-a-real-model-id' },
        maxSpendUsd: 10,
      }),
    ).rejects.toThrow(UnpricedModelError);
  });
});

describe('model attribution', () => {
  it('accepts both the main and the light model', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
    });
    // The pipeline uses two models; both are legitimately echoed.
    expect(result.cases[0].reportedModels).toContain(DEFAULT_CONFIG.model);
    expect(result.cases[0].requestedModels).toEqual([
      DEFAULT_CONFIG.model,
      DEFAULT_CONFIG.lightModel,
    ]);
  });

  it('fails when the provider reports a model that was never requested', async () => {
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: (c) => createCaseStub(c, { reportModelAs: 'some-other-model' }),
      }),
    ).rejects.toThrow(ModelEchoMismatchError);
  });

  it('fails when the provider reports no model at all', async () => {
    await expect(
      runBench({
        manifest: manifest([caseWithCatch()]),
        readDiff,
        llm: (c) => createCaseStub(c, { omitModelEcho: true }),
      }),
    ).rejects.toThrow(/reported no model id at all/);
  });

  it('can be relaxed for a provider that does not echo', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c, { omitModelEcho: true }),
      requireModelEcho: false,
    });
    expect(result.cases[0].reportedModels).toEqual([]);
  });
});

describe('RecordingProvider', () => {
  it('counts invocations and de-duplicates reported models', async () => {
    const inner: ILLMProvider = {
      invoke: async (modelId) => ({ text: '{}', modelId }),
    };
    const rec = new RecordingProvider(inner);
    await rec.invoke('m1', 'p');
    await rec.invoke('m1', 'p');
    await rec.invoke('m2', 'p');
    expect(rec.invocations).toBe(3);
    expect(rec.reportedModels).toEqual(['m1', 'm2']);
  });

  it('raises core\'s silent-fallback error when the inner provider has no structured path', async () => {
    const rec = new RecordingProvider({ invoke: async () => 'x' });
    // Must be StructuredOutputUnsupportedError, which core swallows quietly;
    // a plain Error makes core log a stack trace on every orchestrator call.
    await expect(rec.invokeStructured('m', 'p', {})).rejects.toThrow(
      /Structured output not supported/,
    );
  });

  it('records the model from a structured invocation', async () => {
    const rec = new RecordingProvider({
      invoke: async () => 'x',
      invokeStructured: async (modelId) => ({ object: {}, modelId }),
    });
    await rec.invokeStructured('m-structured', 'p', {});
    expect(rec.reportedModels).toEqual(['m-structured']);
  });
});

describe('grounding reports outcomes, not a boolean', () => {
  it('counts a successful fetch and the file it returned', async () => {
    const getContent = vi.fn().mockResolvedValue({ data: { content: 'YWJj' } });
    const g = buildGrounding({
      octokit: { repos: { getContent } },
      owner: 'o',
      repo: 'r',
      ref: 'sha',
    });
    await g.options.octokit.repos.getContent({ owner: 'o', repo: 'r', path: 'a.ts', ref: 'sha' });

    expect(g.report).toMatchObject({
      enabled: true,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      filesFetched: 1,
    });
  });

  it('distinguishes a FAILED fetch from a successful one, and re-throws', async () => {
    const getContent = vi.fn().mockRejectedValue(new Error('403 secondary rate limit'));
    const g = buildGrounding({
      octokit: { repos: { getContent } },
      owner: 'o',
      repo: 'r',
      ref: 'sha',
    });
    await expect(
      g.options.octokit.repos.getContent({ owner: 'o', repo: 'r', path: 'a.ts', ref: 'sha' }),
    ).rejects.toThrow('403');

    // This is the whole point: core's file-fetcher swallows the error, so
    // without this counter a rate-limited run reports itself grounded.
    expect(g.report.attempted).toBe(1);
    expect(g.report.failed).toBe(1);
    expect(g.report.succeeded).toBe(0);
    expect(g.report.filesFetched).toBe(0);
  });

  it('does not count a 200 that carried no file content', async () => {
    // A directory listing, or a file over 1MB: a success that grounds nothing.
    const getContent = vi.fn().mockResolvedValue({ data: {} });
    const g = buildGrounding({
      octokit: { repos: { getContent } },
      owner: 'o',
      repo: 'r',
      ref: 'sha',
    });
    await g.options.octokit.repos.getContent({ owner: 'o', repo: 'r', path: 'd', ref: 'sha' });
    expect(g.report.succeeded).toBe(1);
    expect(g.report.filesFetched).toBe(0);
  });

  it('carries the configured context and round limits', () => {
    const g = buildGrounding({
      octokit: { repos: { getContent: vi.fn() } },
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      maxContextKB: 128,
      maxRounds: 3,
    });
    expect(g.options.maxContextKB).toBe(128);
    expect(g.options.maxRounds).toBe(3);
  });

  it('reports a grounding-off run as zero files fetched', async () => {
    expect(disabledGrounding()).toEqual({
      enabled: false,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      filesFetched: 0,
    });

    // And an actual ungrounded run says the same thing.
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
    });
    expect(result.cases[0].grounding.enabled).toBe(false);
    expect(result.cases[0].grounding.filesFetched).toBe(0);
  });

  it('enables grounding when an octokit is supplied', async () => {
    const getContent = vi.fn().mockResolvedValue({ data: { content: 'YWJj' } });
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
      octokit: { repos: { getContent } },
    });
    expect(result.cases[0].grounding.enabled).toBe(true);
  });
});

describe('the artifact', () => {
  it('records the corpus, arm, commit and per-case rows', async () => {
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: (c) => createCaseStub(c),
      arm: 'arm-a',
      commitSha: 'abc1234',
    });
    expect(result.corpus).toBe('test');
    expect(result.arm).toBe('arm-a');
    expect(result.commitSha).toBe('abc1234');
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].id).toBe('catch');
    expect(result.cases[0].findingCount).toBeGreaterThan(0);
    expect(new Date(result.startedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(result.finishedAt).toString()).not.toBe('Invalid Date');
  });

  it('captures startedAt BEFORE the run, not in the return statement', async () => {
    // A case whose provider is slow enough that an end-captured timestamp
    // would be measurably later than the real start.
    const slowStub = (c: BenchCase) => {
      const inner = createCaseStub(c);
      return {
        invoke: async (m: string, p: Parameters<typeof inner.invoke>[1]) => {
          await new Promise((r) => setTimeout(r, 2));
          return inner.invoke(m, p);
        },
      };
    };
    const before = Date.now();
    const result = await runBench({
      manifest: manifest([caseWithCatch()]),
      readDiff,
      llm: slowStub,
    });
    const started = new Date(result.startedAt).getTime();
    const finished = new Date(result.finishedAt).getTime();

    expect(started).toBeGreaterThanOrEqual(before - 1);
    expect(finished).toBeGreaterThanOrEqual(started);
    // The run took real time, so an end-captured startedAt would equal
    // finishedAt. They must differ.
    expect(finished).toBeGreaterThan(started);
  });
});
