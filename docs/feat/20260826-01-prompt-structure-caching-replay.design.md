# Prompt structure, caching, and replay

**Status:** Design — sequence approved 2026-08-26, not yet a plan. No code written.

**Tracking:** grew out of "e2e is expensive, can we replay saved LLM responses?" Related: #445 (the E2E gate), #264/#268 (model pinning).

> **Resuming this?** The four phases and their required order are the deliverable. The three findings above them are why the order is not negotiable — read those before reordering anything.

---

## Why this exists

The question was narrow: e2e runs cost real money, the fixture PRs are deterministic, so can we record LLM responses once and replay them?

Yes. But three findings along the way turned out to share one root cause, and fixing that root cause is worth more than the thing we set out to fix.

### Finding 1 — the e2e bill is not somewhere we can wrap it

The gate opens real PRs in `mergewatch/fixtures` against the **deployed dev Lambda**, which hardcodes its provider at module scope:

```ts
const llm = new BedrockLLMProvider();   // packages/lambda/src/handlers/review-agent.ts:149
```

A cassette layer only reduces that bill if it ships *inside the deployed artifact* — the same artifact that serves production. One misconfigured env var and production reviews are served from stale recordings: silent, catastrophic, and the exact failure class this repo keeps getting bitten by.

So replay cannot be bolted onto the existing gate. Most scenarios have to move out of the deployed path entirely — which is fine, because most of them were never testing the deployment.

### Finding 2 — we do not cache prompts, and cannot

```ts
messages: [{ role: 'user', content: prompt }]   // packages/llm-bedrock/src/bedrock-provider.ts:87
```

There is **no `system` field**. Template, conventions, PR context, diff, and fetched file contents are concatenated into a single user message, and `cache_control` appears in none of the four providers.

This is not a deliberate trade-off. It is a shape that makes the decision impossible to express.

### Finding 3 — prompts are not deterministic

```ts
`Current date: ${new Date().toLocaleDateString('en-US', {...})}`   // packages/core/src/agents/reviewer.ts:213
```

A daily timestamp sits in every agent prompt, ahead of the diff. It invalidates any prompt cache once a day, and it would invalidate an entire cassette corpus every midnight.

### The root cause

**`buildPrompt` returns a `string`.**

A flat string cannot express which of its parts are stable. Prompt caching needs that to place breakpoints. Cassette keys need it to stay valid across unrelated edits. Blast-radius detection needs it to scope re-recording. Three problems, one missing distinction.

---

## The structure

```ts
type PromptStability =
  | 'static'    // frozen in source: directives, agent templates
  | 'per-repo'  // conventions, tone, custom rules
  | 'per-pr'    // PR context, diff
  | 'per-call'; // fetched files, the finding under verification, previous findings

type PromptSegment = {
  id: string;
  text: string;
  stability: PromptStability;
};
```

`buildPrompt` returns `PromptSegment[]`. `ILLMProvider` takes segments instead of a string and decides how to render them per provider.

All three problems then reduce to the same operation:

| Need | Falls out as |
|---|---|
| Prompt caching | a `cache_control` breakpoint at each stability boundary |
| Cassette keys | hash of segment ids + per-segment content hashes, with volatile segments excluded **by declaration** rather than by hoping |
| Blast radius | the `static` segments' hash *is* the prompt lockfile; a conventions edit moves only `per-repo` hashes |

One ordering discipline, three payoffs. That is the whole argument for doing this as one change.

---

## Why the order has to change, not just gain breakpoints

Today's assembly (`buildPrompt`, `reviewer.ts:194`) is genuinely interleaved:

```
agent template → tone → conventions → agent-mode → file-request instruction
→ intent-claims directive → PR context (incl. the date) → diff
```

Static content (`INTENT_CLAIMS_DIRECTIVE`, `FILE_REQUEST_INSTRUCTION`) sits *after* per-repo content, and the volatile date sits *before* the diff. There is no single point where a breakpoint helps.

Target:

```
system:    static directives → conventions [break] → PR context + diff [break]
messages:  agent-specific template + agent-mode → fetched files
```

The inversion is what makes **one cache write serve all six agents** — today each agent's distinct template sits in front of the shared diff, so the six share no cacheable prefix at all.

It also happens to match standard prompting guidance (long context first, the specific instruction last), which is a decent signal that the current order is accretion rather than a considered choice.

### Where the money actually is

**The verifier, by a wide margin.** `verifyFindings` (`reviewer.ts:2075`) sends `promptHead + finding + FULL FILE CONTENT`, once per critical and warning, with the file content **last**. Ten findings in one file re-send that whole file ten times at full price. Put the file above the finding and `(head + file)` caches across every finding in that file.

**Agentic file fetching.** Round 2's prompt is literally round 1's prompt plus the fetched files — an exact prefix extension, structurally ideal for caching, currently impossible.

**The six parallel agents.** Same diff, six times. `AGENT_CONCURRENCY = 3` means two waves seconds apart, well inside even the default 5-minute TTL.

Cache reads run ~10% of input cost, and diff + file contents dominate input tokens. This cuts **production** cost on every review, permanently — a larger prize than the e2e bill that started the conversation.

---

## Sequencing — required, not preferred

**Restructure prompts → add caching → build cassettes → move fixtures onto cassettes.**

The binding constraint is between phases 1 and 3: cassette keys derive from segment structure. Build the corpus against flat-string hashes and the restructure invalidates every cassette on the day it lands. Doing it in this order means the corpus is born against the final shape.

Caching sits second because it is cheap once segments exist, it validates the stability labels against reality (a mislabeled segment shows up immediately as a zero cache-hit rate), and it pays for itself before the slower replay work lands.

---

## Phase 1 — prompt segments

- `buildPrompt` and the verifier/orchestrator prompt builders return `PromptSegment[]`
- `ILLMProvider.invoke` / `invokeStructured` take segments; each provider renders them
- Ordering lint: segments must be non-decreasing in volatility. A `static` segment after a `per-pr` one fails the build
- Delete the `Current date:` line (see Still open)
- **`applyConfidenceFloor` becomes a segment transform, not a regex over the whole prompt.** Today it rewrites the assembled string (`reviewer.ts`, the `floorLlm` decorator). Left as-is, any repo setting a non-default `minConfidence` silently breaks prefix stability — a cache miss and a cassette miss with no visible cause
- The four-layer decorator chain in `runReviewPipeline` (tracking → capped → confidence-floor → truncation-retry) all wraps `invoke(m, prompt: string, …)` and has to move with it

No behaviour change. Rendered output should be byte-identical apart from the deleted date and the reordering, and that is the test.

## Phase 2 — caching

- `cache_control` breakpoints at stability boundaries, max 4 per request
- Reorder the verifier prompt so file content precedes the finding
- **`TokenAccumulator` gains cached vs. uncached input tracking** — without it every cost figure silently overstates, including the ones in the PR comment
- Assert `cache_read_input_tokens > 0` across the six agents in a test; a zero means a silent invalidator got in
- Bedrock is partner-priced — verify against Bedrock's own pricing, not first-party rates

**`cache_control` never enters core.** Core emits segments with stability labels; each provider decides what to do with them. This is the split `ILLMProvider` already exists to make:

| Provider | What segments buy |
|---|---|
| Bedrock / Anthropic | explicit `cache_control` breakpoints at stability boundaries |
| OpenAI-compatible (litellm) | no cache API to call — prefix caching is automatic, so stable-first ordering earns the discount for free |
| Ollama | nothing; segments render and concatenate as today — no loss |
| Others via litellm | explicit cache APIs with differing shapes; opt in per-provider later |

The segment model is worth doing even for a provider that cannot cache at all, because the other two payoffs — deterministic cassette keys and blast-radius scoping — are entirely provider-independent.

## Phase 3 — cassettes

- `@mergewatch/llm-replay` implementing `ILLMProvider` — just another provider alongside ollama and litellm, so no test-only code lands in core
- Key: segment-hash tuple + `modelId` + schema + sampling. `invoke` and `invokeStructured` keyed separately
- **Record the full result, not the text.** The pipeline branches on `stopReason === 'max_tokens'` for the #382/#390 truncation retry, and `TokenAccumulator` reads token counts. A text-only cassette makes the retry path untestable and silently changes behaviour
- **A miss fails loudly** with the key, a prompt preview, and the re-record command. Never fall through to live (unbounded spend) and never stub (coverage illusion)
- Unused cassettes fail too — stale entries otherwise accumulate and mask deleted coverage
- Content-addressed storage: index in git, blobs elsewhere. **An empty cassette diff proves a prompt change was behaviour-neutral**, which auto-accepts the common refactor case with zero human attention
- Prompt lockfile of `static` segment hashes, verified in CI — same pattern as `migrations:check`

## Phase 4 — fixtures on cassettes

Split the suite by what it actually proves:

**Tier 1 — replayed pipeline e2e.** Saved diff + config + cassette → `runReviewPipeline` → `formatReviewComment` → assert against `expect.json`. In-process, effectively free, runs on **every PR** rather than only on deploys. That is a coverage gain, not only a cost cut.

**Tier 2 — live integration e2e.** Webhook signatures, SSM auth, check runs, comment upsert, inline comments, storage round-trip. A handful of fixtures, live, for what only a deployment can prove.

Three scenario states, not two: `PASS` / `FAIL` / **`STALE`** (cassette predates the current prompt; scenario not run). Staleness must be visible and bounded — never silent.

### The recapture job

One job, three triggers: a **new fixture** with no cassette records on first run; a **changed prompt** re-records only what its blast radius invalidates; a **nightly sample** runs live to catch model drift the cassettes would otherwise hide.

All three record. **None of them accept.** On a prompt PR, CI posts the blast radius and estimated cost *before* spending, re-records, re-runs the graded assertions, and posts the **outcome diff** — "E2E-29 lost its clustering row", "E2E-18a went 1/5 → 3/5". Merging is what accepts.

That inversion is the whole safety property: automated recapture that also auto-accepted would be a gate that passes by construction.

---

## What this does not solve

**Replay tests the pipeline's handling of a response. It never tests the model.** After a prompt edit and re-record, the cassette contains whatever the model now says, so the test passes *by construction*. Replay structurally cannot detect "this prompt change made the model worse."

Two things keep that from becoming a fourth gap that looks like coverage:

1. `expect.json` assertions strong enough that a *worse* response fails grading. The assertions are the defense; the transport is just cheap.
2. The nightly live sample.

And at scale the corpus needs its own health metric. Ten of ninety-eight scenarios are graded today; scaling that ratio to thousands scales the illusion, not the coverage. **Negative controls** are the cheap fix: for every graded scenario keep a hand-authored known-bad response and assert the grader rejects it. Zero LLM calls, and it is the only mechanism that proves a scenario is *capable* of failing. Track percent graded, percent with a passing negative control, percent stale — and treat that, not the fixture count, as the measure of the suite.

---

## Settled

**Do not adopt the Bedrock Mantle client.** It was considered for Phase 2 — the Anthropic Messages surface would make `system` + `cache_control` typed fields instead of hand-built JSON. Rejected: `llm-bedrock` is not Anthropic-only (`SUPPORTED_MODELS` carries `amazon.titan-text-express-v1`, the file is organised as per-family body builders, and `acceptsSamplingParams` already branches on family), so Mantle would either strand titan or force two clients inside one provider. It would also require re-validating `sendWithSignatureRecovery`, which exists for AWS SDK v3 poisoning `systemClockOffset` in warm Lambdas. The benefit is typing convenience; adding `cache_control` to `buildAnthropicBody` by hand is a one-field change.

**Cassette corpora are per-model.** Keys include `modelId`, so a corpus recorded against Bedrock-Claude does not serve a self-hosted Ollama run, and one corpus cannot cover every provider. Record against the SaaS default model only — Tier 1 tests the pipeline's handling of responses, not each vendor's behaviour. Provider coverage belongs in Tier 2.

---

## Still open

1. **Cassette storage location** — the fixtures repo next to `expect.json` (natural home, keeps this repo lean, but a prompt change here needs a fixtures-repo PR to re-record) or this repo next to the prompts that produce them (no cross-repo dance, larger repo).
2. **STALE threshold** — enforced per-PR, or only at release?
3. **The date line** — delete outright, or keep it at the tail and exclude it from cassette keys? It buys little against a model's knowledge cutoff. Leaning delete.
4. **Outcome-diff bot** — comments on the PR in this repo or in the fixtures repo? Couples to (1).
