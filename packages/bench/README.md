# @mergewatch/bench

Offline benchmark harness (#699). Runs a corpus of diffs through
`runReviewPipeline` and grades the findings against known ground truth.

It is the shared dependency for #314 (withmartian), #610 (OpenSSF) and #700
(escape replay). It deliberately ships **no corpus** — each consuming ticket
brings its own.

## Why this needs no GitHub App

The pipeline takes a diff, a context object and an `ILLMProvider`
(`packages/core/src/agents/reviewer.ts:3204`). It needs no Octokit, no PR and
no installation, and the billing gate (`billingCheck`,
`packages/billing/src/billing-check.ts:55`) is unreachable from it — `core`
has no dependency on `@mergewatch/billing` at all. So a benchmark needs no
benchmark org, no App installation, no open non-draft PRs and no
`FREE_REVIEW_LIMIT` headroom. The only real gate is LLM spend.

## Two places an offline run is NOT production, and what we do about it

**1. The skip layer.** `shouldSkipPR` and `shouldSkipByRules` live in core but
are only ever called from the Lambda handler (`review-agent.ts:636`) and the
Express processor (`review-processor.ts:483`) — never from the pipeline.
`maxFiles`, `skipDrafts`, `ignoreLabels` and `autoReview` all live in
`shouldSkipByRules`. **This harness applies both**, records the skip kind, and
scores a skipped case as **zero recall**, because that is what production
does: a skipped PR contributes no comments, so it is a recall failure and not
a "correctly declined to review". Without this, no arm can honestly be
labelled "shipped defaults".

**2. Grounding is silent when it fails.** `file-fetcher.ts:67` is a bare
`catch {}`, so a 403 secondary-rate-limit, a 404 on a deleted fork and a file
over 1MB are indistinguishable from "no such file" — a run can report itself
grounded while having fetched nothing. So `bench-result.json` records fetch
**outcomes** (`attempted` / `succeeded` / `failed`) plus `filesFetched`, a
count a wrongly-set boolean cannot fake. Budget for rate limits: roughly 80
`getContent` calls per case, against a PAT's 5,000/hour.

## Usage

```bash
# From the repo root. Corpus paths are REPO-ROOT-RELATIVE, because
# `pnpm --filter` runs with cwd at the package directory.
pnpm --filter @mergewatch/bench run bench -- \
  --corpus packages/bench/fixtures/smoke.json \
  --stub \
  --expect-precision 1.0 --expect-recall 0.5 --expect-f1 0.6666666666666666
```

| Flag | Meaning |
|---|---|
| `--corpus <path>` | Manifest, repo-root-relative. Required. |
| `--stub` | Run against the scripted stub. Zero cost, no network, no AWS. |
| `--max-spend-usd <n>` | Run budget. Enforced **pre-flight, per case**. |
| `--arm <name>` | Recorded in the artifact. |
| `--out <path>` | Write `bench-result.json`. |
| `--expect-precision/-recall/-f1 <n>` | Exit non-zero unless the metric matches to 4dp. |
| `--no-require-model-echo` | Allow a provider that does not report its model. |

A real-provider run is intentionally **not wired here**: it spends money, so
each consuming ticket wires it after an explicit spend approval.

## Manifest format

```jsonc
{
  "name": "bench-smoke",
  "lineTolerance": 2,            // lines of slack when matching a finding
  "cases": [
    {
      "id": "catch-sql-injection",
      "repo": "owner/name",      // public repo, for grounding
      "prNumber": 101,           // the REAL upstream PR number, never 0 —
                                 // it renders into every agent prompt
      "headRef": "<sha>",        // grounding ref
      "diffPath": "diffs/x.diff",// relative to the manifest
      "changedFileCount": 60,    // optional; defaults to files in the diff
      "isDraft": false,
      "labels": [],
      "groundTruth": [
        {
          "id": "gt-sqli",
          "file": "src/db.ts",
          "line": 3,
          "cause": "User input concatenated into SQL",   // for the report
          "causeKeywords": ["sql injection"],            // THE MATCH KEY
          "severity": "critical"
        }
      ],
      "stubFindings": [ /* --stub runs only; see below */ ]
    }
  ]
}
```

### Manifests are validated, not cast

`validateManifest` checks the shape at load time and fails with the offending
field path. This is not defensive boilerplate — the failures it catches are
silent ones that produce a *wrong benchmark* rather than a crash. Dropping
just `lineTolerance` from the smoke corpus:

```
without validation:  precision 0.0000  recall 0.0000  f1 0.0000   (exit 0, "clean run")
with validation:     bench: Invalid corpus manifest at lineTolerance:
                     expected a finite number, got undefined        (exit 2)
```

`undefined` tolerance makes every `Math.abs(delta) <= undefined` comparison
false, so nothing ever location-matches and recall is 0 on a corpus that
looks fine. Empty `causeKeywords` does the same to the cause check,
downgrading every catch to right-line-wrong-reason. Each `diffPath` is also
contained to the corpus directory, since the manifest is the untrusted part —
containing `--corpus` but not the paths inside it would be a gap.

### The match key

A finding is credited only if it matches **both**:

1. **Location** — same file, within `lineTolerance` lines.
2. **Cause** — its title+description contains one of `causeKeywords`
   (lowercased, whole-token; a multi-word keyword needs every token).

Location without cause is **`right-line-wrong-reason`**, which is *not* a
catch. `causeKeywords` is an explicit per-case contract rather than a cause
taxonomy inferred from the finding, because `OrchestratedFinding` carries only
title/description/category/evidence — a grader that inferred the cause would
be asserting the constant it had just computed, and its test could not fail.

### Counting, with the denominators stated

```
TP = ground truths graded `caught`
FN = ground truths graded `missed` OR `right-line-wrong-reason`
FP = findings not credited as a TP for any ground truth
```

A right-line-wrong-reason finding therefore costs twice: it fails its ground
truth *and* counts against precision. That is deliberate — it reported
something that is not the real defect.

### `stubFindings`

What a `--stub` run should emit for that case. This is what makes the smoke
corpus a real control: `smoke.json` has one case whose stub findings match its
ground truth (positive control) and one with none (negative control), so
precision/recall/F1 are fixed by the corpus and the run can fail. A stub
returning `[]` for everything would grade "cleanly" as all-misses and exit 0.

The stub **fabricates token usage on a priced model id on purpose**. A
usage-less stub reports `estimatedCostUsd = 0`, and then the spend cap can
never fire and its test cannot fail.

## Design notes worth knowing before changing it

- **The spend cap lives in the harness, not the pipeline.** `TokenAccumulator`
  is built *inside* `runReviewPipeline` (`reviewer.ts:3232`) and surfaces only
  through the returned totals, so there is no mid-run hook: from the return
  value you can only abort *between* cases, by which point the first case is
  already paid for. The cap therefore projects a case's cost from its diff
  size and refuses to invoke at all — which is the only way
  `--max-spend-usd 0` can mean "spend nothing".
- **A `null` `estimatedCostUsd` fails the run.** `estimateTotalCost` returns
  null if *any* model is unpriced (`token-accumulator.ts:78`), so treating it
  as zero would let the cap silently stop enforcing on LiteLLM, Ollama or an
  unlisted alias.
- **Model attribution checks both models.** The pipeline uses `modelId` for
  the finding agents and `lightModelId` for the cheaper passes, so every id
  the provider echoes must be one of the two requested. `#699` added an
  optional `modelId` to `LLMInvokeResult`, populated by the Anthropic and
  Bedrock providers from their own response bodies. `aws lambda
  get-function-configuration` verifies nothing on this path — the injected
  provider governs the run, not the deployed function.

## Known overlap

The fixtures repo grades E2E runs with its own `grade-run.mjs`. This is a
**second** grader, and the two do not share a definition of a "match": this
one grades findings against a corpus's ground truth, that one grades fixture
expectations against a live review. They answer different questions, so they
are kept separate deliberately rather than by omission — but if they ever
appear to disagree about the same run, that is a bug in one of them.
