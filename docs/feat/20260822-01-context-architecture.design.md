# Context architecture — retrieval over a git checkout

**Status:** Design in progress — **not yet a plan**. No approval sought, no code written.

**Tracking:** grew out of #423. Related: #414 (the model swap that surfaced it).

> **Resuming this?** Read "Where we landed" and "Still open" first. Everything above them is the reasoning that got there — worth reading before reopening a settled decision, because most of them were settled by data rather than preference.

---

## Why this exists

#423: large PRs hard-fail with `MergeWatch encountered an error: Input is too long for requested model.` Observed on `santthosh/orca#116` and `#117`, prod, 2026-08-22.

The immediate cause is a regression from #414 (default model `us.anthropic.claude-opus-4-6-v1` → `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, a 1M → 200K context window with no input guard anywhere in the review path).

But the conversation started at "how do we fix this" and ended somewhere else, because of two pieces of data.

### Data point 1 — the reported bug is not a context-size problem

`orca#117` diff composition:

```
711,765 bytes total
571,826  80%  packages/web/tsconfig.tsbuildinfo   ← a build artifact
139,939  20%  everything else (31 files of real code + docs)
```

Default `excludePatterns` (`packages/core/src/config/defaults.ts:207`) covers `**/*.lock`, `**/package-lock.json`, `**/yarn.lock`, `**/*.min.js`, `**/*.min.css`, `**/dist/**`, `**/build/**`, `**/node_modules/**` — **not `*.tsbuildinfo`**.

Drop that one file and the diff is ~35K tokens, which fits Sonnet 4.5's 200K with 165K to spare. **The PR would have reviewed fine on the model we already shipped.** One generated file consumed 80% of the context budget.

### Data point 2 — the future problem is a different problem

The stated direction is to feed in full git history, the whole codebase, and more. At that point the available context is permanently ~1000× any window (a 10MB repo is ~2.5M tokens; history is larger). Sonnet 4.6's 1M doesn't help and neither would 10M.

So the question stops being *"what do I cut to fit?"* and becomes *"what do I go get?"*

| | Budgeting | Retrieval |
|---|---|---|
| Input | a payload you already have | a corpus you query |
| Failure mode | truncation, silent loss | missed relevance |
| Scales to | one window | unbounded |

**This is why batching/chunking was proposed and then dropped.** It is budgeting. It buys one order of magnitude and then becomes dead weight. Do not re-propose it without a new argument.

---

## How the design evolved

Preserved because the discarded branches carry the reasoning.

1. **Layered budgeting** — exclude artifacts, pre-flight token estimate, progressive shedding, chunked multi-pass, honest coverage reporting. *Partly survives* — the first two and the last are still right, but as pieces of a selection layer, not as the architecture.

2. **One file at a time** (proposed by santthosh). Correct instinct — bound the input rather than raise the ceiling. Refined rather than accepted: strict per-file is 8 agents × 31 files = **248 LLM calls** for `orca#117` (today: ~8–16), a 15–30× cost multiplier, and it structurally destroys cross-file findings, which are the differentiator (fixtures E2E-26 `call-site-snap`, E2E-81 `file-request-budget`; `codebaseAwareness` and `invokeWithFileFetching` exist to pull related files *in*). Bin-packing by locality was the counter-proposal.

3. **Build a symbol/AST index** — content-addressed by blob SHA, assembled per PR head, queried for `who calls this`. Chosen over embeddings because a validation gate wants exact structural answers, not plausible neighbours; because it needs no model, no network, and works air-gapped; and because embeddings drift with model changes.

4. **Use a git checkout as the index** (proposed by santthosh). **This is where we landed.** It dissolves most of layer 3: git already *is* a content-addressed store, and `git clone --filter=blob:none` already *is* lazy retrieval. Reimplementing that in DynamoDB was the wrong instinct.

---

## Where we landed

### The architecture

Clone the repo at the PR head and let agents query it with real tools, instead of assembling a payload.

```
corpus       git checkout at PR head (blobless partial clone)
                ↓
selection    the diff is the QUERY, not the context
             rg / git log -L / git blame / tree-sitter on demand
                ↓
assembly     stable prefix (system, conventions, repo profile)
             ┃ cache breakpoint ┃
             volatile suffix (diff, question)
                ↓
top-up       bounded agentic fetch — already exists
                ↓
provenance   record what was actually in context, per review
```

### Settled, with rationale

| Decision | Why |
|---|---|
| **Git checkout is the corpus** | Git is already content-addressed and incremental. No index schema, no dual DynamoDB/Postgres implementation, no hop-depth decision, no staleness class of bug. |
| **Blobless partial clone** (`--filter=blob:none`) | Full tree structure immediately, file contents on demand. Lazy retrieval, implemented by git, battle-tested. |
| **Per PR head, not repo head** | A PR branches from `main@X` while `main` moved to `Y`. Retrieval against the wrong tree gives *plausible* wrong answers about who calls what — the worst failure kind. |
| **Structural queries, not embeddings** | `rg`, `git log -L`, `git blame`, tree-sitter. Exact, deterministic, free, air-gapped. Embeddings are a SaaS-only additive layer *if ever* — core retrieval must never depend on them or the two deployments diverge in quality. |
| **Async indexing/clone, queued not blocking** | On a miss: blocking adds unbounded latency; proceeding degraded is silent quality variance. Queue until ready — the SQS path from #355 already parks and retries reviews. |
| **Self-hosted parity is required** | Air-gapped is explicitly supported (why the Ollama provider exists). This rules out hosted embedding APIs, managed vector stores, and S3-only artifacts. It is what made the checkout approach obviously right rather than merely elegant. |
| **Self-hosted needs a disk volume, not blob storage** | A bare mirror per repo + `git worktree` per review, updated with `git fetch`. Docker Compose already has volumes. Smaller ask than S3-compatible storage. |
| **Determinism is a requirement** | Retrieval must be a pure function of `(commit, diff, config)`. A gate that is not reproducible is not a gate. |
| **Honest coverage + score clamping** | Whatever is dropped must be stated, and the score must not overclaim. A 5/5 on a partially-reviewed diff is worse than today's hard failure, because a hard failure at least signals something went wrong. Precedent: #385 all-clear contradiction, W7 clamping on unverified criticals. |
| **Batching / chunked multi-pass: rejected** | Budgeting, not retrieval. See above. |
| **Agents call tools; they are not handed a payload** | Cramming context does not scale at any window size. Settled 2026-08-22. The tool set itself is still open — see "Still open" §3. |
| **First two tools: `search` and `read_file`** | Settled 2026-08-23. `search` (ripgrep) answers the question that catches real bugs — "who calls this changed function". Ranged `read_file` makes a huge file cost only the part that matters. |
| **One bare mirror per repo, one DETACHED worktree per review** | How concurrent PRs on one repo share a corpus. Verified: three worktrees at three different commits from one mirror, simultaneously. |
| **Always `--detach` at a SHA, never a branch name** | `git worktree add` **refuses** a branch already checked out elsewhere (`fatal: 'main' is already used by worktree at …`). Two PRs from one branch, or a re-review racing the original, would collide. |
| **`search` and `read_file` read the WORKTREE, not git objects** | `git grep <sha>` works without a checkout, but on a blobless clone it must fetch every blob to search them — defeating the partial clone entirely. Materialise the tree once, then search it for free. |
| **Clone per review; no mirror, no EFS** | Settled 2026-08-23 by measurement — see below. EFS deferred to future work. |

### Two things that must be designed in, not retrofitted

**Prompt structure.** Today the entire prompt is a single flat user message:

```ts
// packages/llm-bedrock/src/bedrock-provider.ts — buildAnthropicBody
messages: [{ role: 'user', content: prompt }]
```

There is **no prompt caching anywhere** in the codebase (`grep cache_control|cachePoint|ephemeral` → nothing). Uncached large context is economically impossible — 8 agents × every review × full price. Caching is prefix-match, so **ordering is an architectural constraint**: stable → semi-stable → volatile, with the breakpoint after the corpus slice and before the diff. Cache reads run ~0.1×, which is the difference between "we can't afford to include the module" and "include it for nearly free."

*Unverified:* prompt-caching support on our Bedrock InvokeModel path. Needs a live check before being relied on.

**Context provenance.** With retrieval, *"what did you actually look at?"* is the central trust question — and it is the same thing the strategy docs sell as provenance for the validation-gate positioning. Record per review: which files, which history, which symbols, at which commit.

---

## Still open

### 1. Runtime shape — the one real cost of the checkout approach

```
review-agent-prod:  1024 MB · 300s timeout · 512 MB /tmp · PackageType: Zip
```

**There is no `git` binary in a Zip-packaged Node Lambda.**

| Option | Trade |
|---|---|
| **Container-image Lambda** *(leaning)* | Keeps all SQS/event wiring; git in the image; `/tmp` to 10 GB; timeout to 900s. Smallest disruption — a `PackageType` change plus `EphemeralStorage`/`Timeout` bumps. |
| Fargate/ECS | No 15-minute ceiling, persistent local cache, real disk. Bigger change; re-plumb the queue consumer. Graceful next step if reviews outgrow 15 min. |
| isomorphic-git (pure JS) | No packaging change, but you lose `rg`/`blame` as subprocesses — which is most of the point. |

### 2. ~~Cache strategy~~ — settled 2026-08-23: clone per review

Measured blobless clone + checkout, cold, no cache:

| repo | clone | checkout | **total** | materialised | files |
|---|---|---|---|---|---|
| `mergewatch/fixtures` | 1.3s | 1.1s | **2.4s** | 2 MB | 324 |
| `mergewatch/mergewatch.ai` | 1.2s | 1.5s | **2.7s** | 12 MB | 567 |
| `facebook/react` | 7.7s | 4.4s | **12.1s** | 120 MB | 7,202 |

A 7,200-file repo costs 12 seconds against reviews that already take 30–90s. That is noise, and it removes the entire caching question from the critical path.

**The ladder, stopping at the first rung that works:**

1. **Clone per review** ← start here. Zero infra, zero networking change, trivially correct, no concurrency or staleness questions.
2. **Container-image Lambda with a large `/tmp`.** Warm containers reuse a mirror opportunistically, cold ones re-clone. Costs nothing extra, needs no VPC — and the container image is already the leading answer for getting a `git` binary at all.
3. **EFS** — deferred to future work.

**Why EFS is deferred, not chosen.** Mounting EFS requires the Lambda to be in a VPC, and the review agent is not in one today (`VpcConfig: { SubnetIds: [], VpcId: "" }`). It talks to GitHub's API, Bedrock, SSM, SQS and nine DynamoDB tables — a VPC Lambda has no internet access by default, so this would mean a NAT gateway (~$32/month before data processing) or interface endpoints for Bedrock/SSM/SQS, plus VPC cold-start penalties. That is a re-architecture of the review path's networking, with new monthly spend and new failure modes, in exchange for caching something that costs 12 seconds.

Revisit only if a real monorepo makes clone time hurt. `facebook/react` did not.

*Caveat: measured from a developer machine. Lambda's egress to GitHub should be comparable, but the numbers are indicative rather than a Lambda benchmark.*

### 3. Tool set and loop mechanics ← **where the conversation stopped**

**Settled (2026-08-22): agents make tool calls against the checkout rather than receiving a pre-assembled payload.** Cramming everything into context does not scale and never will; the agent asks for what it needs.

This is the same conclusion the architecture forces from the other direction — if the corpus is a checkout, the natural interface to it is tools, not serialization.

**What exists already:** `packages/core/src/context/agentic-fetcher.ts` implements a bespoke fetch loop — the agent returns a `requestFiles` field in its structured output (#390) and the caller fetches and re-invokes, bounded by `maxFetchRounds` and `maxContextKB`. That is a hand-rolled precursor to tool use with the right *shape* but the wrong *mechanism*.

**Still open:**

- **Native tool use vs the existing `requestFiles` protocol.** Native tool calling is the standard mechanism and composes better; but note #390 already uses forced tool use to constrain the *output* schema, so a retrieval-tools + forced-output-tool conversation needs a deliberate design rather than an incremental patch.
- **The tool set.** Candidates, roughly in value order for a validation gate:
  - **`search(pattern, glob?)`** — ripgrep. **Settled as one of the first two.**
  - **`read_file(path, range?)`** — ranged. **Settled as one of the first two.**
  - `blame(path, lines)` and `log(path | -L range)` — the structured history queries that are high-signal here and cost nothing.
  - `list_files(glob)` — orientation.
  - `find_callers(symbol)` — could be search-backed initially; tree-sitter later if exactness matters.
- **Budget shape.** Per-agent call ceiling, wall-clock ceiling, or token ceiling — and what happens on exhaustion (degrade honestly vs fail).
- **Sharing across the 8 agents.** They will fetch overlapping files. A per-review cache is obvious; whether agents should *see each other's* retrievals is not.
- **Determinism.** Tool results are deterministic given a fixed checkout, but the *sequence* of calls is model-driven. Whether that satisfies the reproducibility requirement for a gate needs an explicit answer — possibly "record the transcript" rather than "guarantee identical paths".

### 4. ~~Monorepo worst case~~ — partially answered 2026-08-23

`facebook/react` (7,202 files, 120 MB materialised) clones blobless and checks out in **12.1s**. Not a problem at that scale.

Still open at the extreme: a 100k-file monorepo. The trend is favourable but unmeasured, and the fallback if it bites is rung 2 (warm `/tmp` mirror), not EFS.

---

## Immediate work — useful regardless of how the above resolves

None of this is a bandaid; each is the first piece of the selection layer.

| Work | Why it survives the architecture |
|---|---|
| Add `*.tsbuildinfo` etc. to default `excludePatterns`, plus a size/shape heuristic | First rule of selection: never spend budget on zero-signal content. A list always misses the next artifact, so pair it with a heuristic. Fixes #423 today. |
| Pre-flight token budget derived from the configured model's window | The budget primitive every later layer needs. Requires a model→context-window table — same shape and home as the existing model→pricing table. |
| Honest coverage reporting + score clamping | More necessary under retrieval, not less. |
| Restructure the prompt into stable/volatile with a cache breakpoint | Prerequisite for large context being affordable; pure cost saving even today. |
| Move default to `us.anthropic.claude-sonnet-4-6` | Already priced in `packages/core/src/llm/pricing.ts` (`$3.30/$16.50` on the `us.` profile) and already handled by `acceptsSamplingParams`. 1M context at Sonnet-tier pricing restores what #414 silently lost. **Headroom, not the fix.** Needs the same live-invoke verification #414 did (plain + forced-tool) before touching `infra/params/*.env`. |

---

## Grounding data

Measured during the discussion; recorded so a fresh session need not re-derive.

| Fact | Value |
|---|---|
| `orca#117` diff | 711,765 bytes (~178K tokens) |
| — `tsconfig.tsbuildinfo` | 571,826 bytes, 80% of the diff |
| — everything else | 139,939 bytes (~35K tokens) — fits 200K comfortably |
| `orca#115` (reviewed fine) | 12.5 KB diff |
| Opus 4.6 context | 1M tokens |
| Sonnet 4.5 context | 200K tokens |
| Sonnet 4.6 context | 1M tokens, Sonnet-tier price |
| Agents per review | 8 (security, bugs, style, summary, diagram, errorHandling, testCoverage, commentAccuracy) |
| `maxFiles` | 50 — `orca#117` had 31, so it did not trip |
| `maxContextKB` | 256 — governs *related-file context*, not the diff |
| Prompt caching | none anywhere |
| Prompt shape | single flat user message |
| Input-size guard | none — the diff is passed through unbounded |
| review-agent Lambda | 1024 MB · 300s · 512 MB `/tmp` · Zip |
| Failure log signature | agentic fetch → no-context fallback → structured → text path, all `Input is too long`, then hard failure. All 8 agents identically. |
| `orca` model line | `[model] santthosh/orca#117 using us.anthropic.claude-sonnet-4-5-20250929-v1:0 (source=deploy-default)` — no repo pin, so **every repo without one is exposed** |

## Key file paths

- `packages/core/src/config/defaults.ts` — `excludePatterns` (207), `maxFiles` (64), `maxContextKB` (224)
- `packages/core/src/agents/reviewer.ts` — pipeline, `invokeWithFileFetching` import (49)
- `packages/core/src/context/agentic-fetcher.ts` — existing agentic retrieval loop
- `packages/llm-bedrock/src/bedrock-provider.ts` — `buildAnthropicBody` (77), `acceptsSamplingParams` (72)
- `packages/core/src/llm/pricing.ts` — model→price table; natural home for model→context-window
- `packages/core/src/skip-logic.ts` — `SKIP_PATTERNS`, the existing "some PRs aren't worth reviewing" precedent
- `infra/template.yaml` — review-agent Lambda config
- `infra/params/{dev,prod}.env` — the model line, and the rule that it is never flipped without a live invoke

## Next step

Turn this into a phased plan (`docs/feat/…plan.md`) once open questions 1 and 3 are decided. Phase 1 is the "immediate work" table, which is safe to start before the architecture is settled.
