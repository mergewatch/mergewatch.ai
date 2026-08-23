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
| **Determinism is a requirement — of results, not of the path** | Retrieval must be a pure function of `(commit, diff, config)`: the same `read_file` or `search` against the same SHA always returns the same bytes. The model-driven *sequence* of calls is not deterministic and cannot be made so; refined 2026-08-23 to auditability for that half — see §3 "Reproducibility". A gate that cannot explain what it looked at is not a gate. |
| **Honest coverage + score clamping** | Whatever is dropped must be stated, and the score must not overclaim. A 5/5 on a partially-reviewed diff is worse than today's hard failure, because a hard failure at least signals something went wrong. Precedent: #385 all-clear contradiction, W7 clamping on unverified criticals. |
| **Batching / chunked multi-pass: rejected** | Budgeting, not retrieval. See above. |
| **Agents call tools; they are not handed a payload** | Cramming context does not scale at any window size. Settled 2026-08-22; mechanics settled 2026-08-23 — see §3. |
| **First two tools: `search` and `read_file`** | Settled 2026-08-23. `search` (ripgrep) answers the question that catches real bugs — "who calls this changed function". Ranged `read_file` makes a huge file cost only the part that matters. |
| **One bare mirror per repo, one DETACHED worktree per review** | How concurrent PRs on one repo share a corpus. Verified: three worktrees at three different commits from one mirror, simultaneously. |
| **Always `--detach` at a SHA, never a branch name** | `git worktree add` **refuses** a branch already checked out elsewhere (`fatal: 'main' is already used by worktree at …`). Two PRs from one branch, or a re-review racing the original, would collide. |
| **`search` and `read_file` read the WORKTREE, not git objects** | `git grep <sha>` works without a checkout, but on a blobless clone it must fetch every blob to search them — defeating the partial clone entirely. Materialise the tree once, then search it for free. |
| **Clone per review; no mirror, no EFS** | Settled 2026-08-23 by measurement — see below. EFS deferred to future work. |
| **Reuse the loop runtime (Vercel AI SDK), behind `ILLMProvider`** | The bespoke `for` loop in `agentic-fetcher.ts` has no reason to exist. Adopted as a new `invokeWithTools` method so the provider seam survives instead of being replaced. Verified 2026-08-23 to cover Bedrock, Anthropic and OpenAI-compatible. |
| **Tool definitions live in `packages/mcp`** | `@modelcontextprotocol/sdk` is already a dependency. One definition, two consumers: the review pipeline internally, Claude Code / Cursor externally. |
| **Ollama keeps its direct path and degrades to `requestFiles`** | No official AI SDK provider; the two community ones have documented tool-call reliability problems. `llm-ollama` already uses Ollama-native `format: schema`. Trading that for a flaky third party is a regression on the air-gapped path. |
| **Schema-carried request stays as the fallback rung** | Not legacy. It is what keeps Ollama — and any weak upstream behind LiteLLM — working at all. |
| **Symlink containment gates everything** | A PR can add `docs/notes -> /etc`; `read_file("docs/notes/passwd")` has no `..`, is not absolute, and escapes the worktree. `sanitizeFilePath` is sufficient against the GitHub API and insufficient against a checkout. |
| **Truncation is always reported, never silent** | A capped `search` that looks complete makes the model read absent matches as evidence. Same failure class as #401. |
| **Auditability, not determinism, for the call sequence** | Tool results are deterministic given a fixed checkout; the model-driven *sequence* is not. Record the transcript per agent so a disputed verdict is diagnosable. |

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

### 3. ~~Tool set and loop mechanics~~ — settled 2026-08-23

**Settled (2026-08-22): agents make tool calls against the checkout rather than receiving a pre-assembled payload.** Cramming everything into context does not scale and never will; the agent asks for what it needs.

This is the same conclusion the architecture forces from the other direction — if the corpus is a checkout, the natural interface to it is tools, not serialization.

#### Correction to the 2026-08-22 framing

The open question was recorded as *"native tool use vs the existing `requestFiles` protocol, complicated by #390 already using forced tool use for the output schema."* **That conflict does not exist.** #390 put `requestFiles` *inside* the single forced `emit_result` tool's schema (`packages/core/src/agents/schemas.ts:40`), so there is exactly one tool, always forced, and the retrieval request rides in its output. Nothing to reconcile — it is the extension point.

A second conflation was in the same framing: portability was used to argue against native tool use *and* against reusing a loop runtime. It only supports the first. Those are separate layers and they get separate answers.

#### Three layers, three answers

| Layer | Decision | Why |
|---|---|---|
| **Loop driver** | Reuse — Vercel AI SDK, adopted *behind* `ILLMProvider` as a new `invokeWithTools` | The `for` loop in `agentic-fetcher.ts` has no defensible reason to be bespoke. AI SDK is the only runtime spanning all four providers. |
| **Tool definitions** | Reuse our own MCP server (`packages/mcp`) | `@modelcontextprotocol/sdk` is already a dependency. One definition, two consumers: the review pipeline internally, and Claude Code / Cursor externally. |
| **Wire format** | Keep schema-carried `requestFiles`, as the fallback rung | Not legacy. It is what keeps Ollama working — see the carve-out below. |

Adopting the AI SDK *behind* `ILLMProvider` is the load-bearing detail. `ILLMProvider` and the four `llm-*` packages **are** the seam the SDK would otherwise replace; adding one method preserves the seam instead of re-plumbing the monorepo to obtain a loop.

Runtimes considered and rejected:

- **Claude Agent SDK** — closest fit on paper: ships Grep/Read/Glob over a working directory, which is literally the tool set spec'd below, plus loop and compaction. Anthropic/Bedrock/Vertex only, so self-hosted-on-Ollama and LiteLLM-to-GPT stop working. Constraint, not preference.
- **Anthropic Tool Runner** (`client.beta.messages.tool_runner`) — same portability break, smaller payoff.

#### Verification of the AI SDK assumption (2026-08-23)

The recommendation rests entirely on AI SDK provider coverage, so it was checked before being recorded rather than after.

| Provider | Tool calling | Verdict |
|---|---|---|
| `@ai-sdk/amazon-bedrock` (official) | ✓ tool usage + object generation for Claude | SaaS path fine. Docs table lists only Claude 3.x — stale, and the Bedrock Converse tool-use mechanism is model-agnostic for Claude, but **smoke-test Sonnet 4.5/4.6 rather than assume**. |
| `@ai-sdk/anthropic` (official) | ✓ | Self-hosted default fine. |
| `@ai-sdk/openai-compatible` (official) | ✓ tool calling; structured output when `supportsStructuredOutputs` is set | LiteLLM path fine. Capability is explicitly "provider-dependent" — the SDK re-presents the upstream unevenness `litellm-provider.ts:59` already documents (`strict: false`), it does not fix it. Parity, not regression. |
| **Ollama** | **No official provider** | **The finding that changes the plan.** |

**Structured output and tool calling do compose** in one `generateText` call via `Output.object()` — the docs call it a key advantage. One gotcha, and it maps directly onto our round budget: *generating the structured output counts as a step*, so `stopWhen` must budget tool steps **plus** the final output step. `stopWhen` / `isStepCount` / `hasToolCall` / `prepareStep` and the default 20-step limit are the same dial as `maxFileRequestRounds`.

#### The Ollama carve-out

Ollama has **no official AI SDK provider** — two competing community ones, and the AI SDK's own docs recommend `ai-sdk-ollama` over `ollama-ai-provider-v2` specifically *"when you need reliable tool calling with guaranteed complete responses,"* which concedes the alternative has empty-response problems during tool use.

Meanwhile `packages/llm-ollama` talks to Ollama's **native** `/api/chat` with `format: schema` — Ollama's own structured-output mechanism, direct, no third party. Adopting the AI SDK there would trade a working direct integration for a community dependency with documented tool-call flakiness.

**Decision:** Ollama keeps its existing direct path and degrades to the schema-carried `requestFiles` rung. Ollama is already marked experimental in `CLAUDE.md`; the air-gapped path gets working-but-simpler retrieval rather than a flaky loop. This is the concrete reason the wire format stays — not a hand-wave about portability.

#### Loop mechanics

**Batched per round, not one call per turn.** The model asks for several searches and reads in one round; they execute in parallel and re-invoke once. The round trip is the expensive unit — each one re-invokes a growing prompt — so fewer, fatter rounds beat many thin ones. Cost: the model cannot condition search #2 on search #1 *within* a round. That is what rounds are for, and search→read is naturally two.

**Round budget.** `maxFileRequestRounds` is **1** today (`defaults.ts:250`) — enough to fetch files the diff names, not enough for search→read→finalize. Default to **3** when a worktree is present; keep 1 for the API-fetch path.

**Exhaustion — keep the existing behavior, it is already right.** On rounds or budget running out, re-invoke with *"budget exhausted, finalize with what you have."* The agent always produces findings; it never fails. The message must be **explicit in the prompt**: a model that believes another round is coming will hedge instead of concluding.

**Truncation must be loud.** `search("function")` on a large repo has thousands of hits. Cap results, but always report the cap — *"47 of 3,214 matches shown, refine your pattern."* Silent truncation is worse than no search: the model reads absent matches as evidence and concludes wrongly. Same failure class as #401, where degenerate output passed as real findings.

**Appends stay append-only.** Each round appends to the end; the prefix — system prompt, conventions, PR metadata, diff — stays byte-stable. That is what keeps prefix caching alive across rounds, and it is why the stable/volatile prompt restructure in *Immediate work* is a prerequisite rather than a nice-to-have.

#### Must land first — the symlink escape

`sanitizeFilePath` (`agentic-fetcher.ts:58`) rejects `..`, absolute paths, and null bytes. That is sufficient against the GitHub API, which resolves paths against a repo tree. **Against a real checkout it is not.** A PR can add:

```
docs/notes -> /etc
```

and `read_file("docs/notes/passwd")` contains no `..`, is not absolute, and escapes the worktree. We would be checking out attacker-controlled content and reading paths through it.

Required before any tool touches a worktree:

- join → `realpath` → verify the result is still under the worktree root
- skip symlinks during `search`
- clone hardening: `--no-recurse-submodules`, hooks disabled, `protocol.ext.allow=never`

The corpus is untrusted content by definition. This is the one item that gates the rest.

#### Tool set

- **`search(pattern, glob?)`** — ripgrep. **First two.**
- **`read_file(path, range?)`** — ranged. **First two.**
- `blame(path, lines)` and `log(path | -L range)` — structured history queries, high-signal here and cost nothing.
- `list_files(glob)` — orientation.
- `find_callers(symbol)` — search-backed initially; tree-sitter later if exactness matters.

#### Deferred on purpose — cross-agent sharing

8 agents × 3 rounds = 24 invocations of a growing prompt. The **filesystem** layer shares trivially: same container, same worktree, one read cache. The **token** layer does not — each agent pays for its own copy of what it read.

The fix would be a *scout pass*: one cheap call picks a context bundle, appended identically to all 8 prompts, turning N×M retrieval into 1×M and making the block a shared cacheable prefix. It costs per-agent specificity — security wants auth middleware, style wants lint config.

**Not decided now.** Ship per-agent rounds with the transcript recorded, then measure actual overlap. Same stance as the corpus decision: start narrow, let data pick the next move.

#### Reproducibility — record the transcript

The call sequence is model-driven and therefore not deterministic. Neither was the verdict. What a gate owes is **auditability, not determinism**.

Record per agent, into the review record's diagnostics: searches issued, files and ranges read, bytes consumed, rounds used, and why it stopped (finalized / rounds / budget). A disputed 2/5 then becomes diagnosable — *"the security agent never read the auth middleware"* is an answer; *"the model decided"* is not.

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

Turn this into a phased plan (`docs/feat/…plan.md`). Only open question 1 (runtime shape) remains, and it does not block phase 1.

Ordering is forced by the security item: **symlink containment lands before any tool reads a worktree.** After that, `invokeWithTools` behind `ILLMProvider`, then `search` + `read_file` as MCP tool definitions, then raise the round default to 3. The "immediate work" table is safe to start now.
