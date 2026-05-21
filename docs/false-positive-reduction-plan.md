# False-Positive Reduction Plan

**Status:** Forward-looking, structural-gap-driven. Companion to [`review-quality-plan.md`](./review-quality-plan.md).
**Purpose:** Track structural gaps in the review pipeline where false positives can still leak through, even after W1–W11 closed every observed failure pattern. Unlike the evidence-derived original plan (which addressed P1–P13 from real PRs), this doc is **gap-driven** — opportunities identified by reading the code, not by observing failures yet.

---

## How this differs from `review-quality-plan.md`

- The original plan started with seven failure patterns (P1–P7) seen on real PRs (voice-bot #31, orca #37/#38/#39) and grew to thirteen as more evidence arrived. Every pattern → an observation → a workstream → an E2E fixture.
- This doc starts from the **other direction**: walks the code looking for prompt-only rules that aren't enforced, single-event handlers that should be event-class handlers, and conservative checks that could be tightened. The motivating question is *"if we never saw another bad review, where could the bot still be wrong?"*
- Workstreams here are numbered **FP-A through FP-G** to avoid colliding with the W1–W12 namespace and to signal they're a distinct cohort.

---

## Evidence (or lack thereof)

No new failure patterns. Every concrete bad review we've seen is covered by W1–W11. The opportunities below are **prophylactic** — they close structural surfaces where the model's behaviour is currently the only thing between the user and a false positive. As real PRs roll through the post-W11 pipeline, add **Examples** here when they materialise and re-rank by frequency, same as the original plan does.

---

## Opportunities

Ranked by ROI: deterministic + low cost + high blast radius first.

### FP-A — Hard confidence-floor filter  ★★★

**Where the gap lives:** `packages/core/src/agents/prompts.ts:481` (rule #5 of `ORCHESTRATOR_PROMPT`):
> *"Drop any finding with confidence below 75."*

This is **prompt-only**. `grep -rn "confidence.*<" packages/core/src/agents | grep -v test | grep -v prompts.ts` returns zero hits — no code-level filter anywhere enforces it. Every agent prompt instructs the model to emit `confidence: 1-100`; the orchestrator's prompt asks it to drop low-confidence ones; nothing in code verifies either side.

**The fix:** ~5 lines after the orchestrator step in `runReviewPipeline`:

```ts
const CONFIDENCE_FLOOR = 75;
const lowConfidence = orchestratorResult.findings.filter(
  (f) => (f.confidence ?? 100) < CONFIDENCE_FLOOR,
);
if (lowConfidence.length > 0) {
  console.warn('[confidence-floor] dropped %d finding(s) with confidence < %d', lowConfidence.length, CONFIDENCE_FLOOR);
  orchestratorResult.findings = orchestratorResult.findings.filter(
    (f) => (f.confidence ?? 100) >= CONFIDENCE_FLOOR,
  );
}
```

**Why it's the highest-ROI single change:** catches the entire class of *"model didn't honor its own confidence rule"* false positives in one deterministic filter. Defaults missing/undefined to 100 so the filter is *only* a drop, never accidentally suppressive of legacy findings that lacked a confidence field.

**Code targets:** `packages/core/src/agents/reviewer.ts` (insert post-orchestrator).
**E2E target:** [E2E-30](./../e2e/RUNBOOK.md#e2e-30-fp-a--hard-confidence-floor-filter-target).

---

### FP-B — Pre-filter `previousFindings` by `disputedKeys`  ★★★

**Where the gap lives:** both handlers (`packages/server/src/review-processor.ts:425`, `packages/lambda/src/handlers/review-agent.ts:545`) pass `previousFindings: prevComplete?.findings` **raw** to `runReviewPipeline`. The orchestrator prompt then includes those prior findings via `buildPreviousFindingsBlock` (`reviewer.ts:798`) and explicitly tells the model to *"carry forward if still present."*

W3's `partitionDisputed` runs **after** the orchestrator. So the orchestrator has already been encouraged to re-emit findings the author dispositioned via `## mergewatch triage` — the clean output then has to be re-filtered. Wasted prompt tokens + the model occasionally re-emits in slightly-different framings that W3's stable-key match can miss.

**The fix:** in both handlers, compute `disputedKeys` *before* constructing the `runReviewPipeline` options, then filter `prevComplete.findings` to exclude entries whose `findingMatchKeys` intersect that set. ~5 lines per handler. Closes the W3 loop on the orchestrator's INPUT side.

**Code targets:** `packages/server/src/review-processor.ts`, `packages/lambda/src/handlers/review-agent.ts`. No core changes.
**E2E target:** [E2E-31](./../e2e/RUNBOOK.md#e2e-31-fp-b--pre-filter-previousfindings-by-disputedkeys-target).

---

### FP-C — Pre-orchestrator same-file-same-line dedup  ★★

**Where the gap lives:** the orchestrator is the ONLY cross-agent dedup point, and it's an LLM. Two agents flagging exactly `file:42` with overlapping titles relies on the model to merge them. W10's `clusterFindings` catches some post-hoc clustering on a wider region, but trivial same-file-same-line duplicates should be killed *before* the orchestrator sees them — saves prompt tokens AND eliminates a class of cross-agent doubles the model misses.

**The fix:** small pre-pass before `runOrchestratorAgent` over the per-agent `taggedFindings`. Group by `(file, line, normalized-rule)` where `normalized-rule` reuses W10's `extractSignificantTokens` over the title. Same-key duplicates from different agents merge (strongest severity wins; absorbed siblings recorded in the description).

**Code targets:** `packages/core/src/agents/reviewer.ts` (`runReviewPipeline` orchestrator setup) + reuse `packages/core/src/finding-clustering.ts`.
**E2E target:** [E2E-32](./../e2e/RUNBOOK.md#e2e-32-fp-c--pre-orchestrator-cross-agent-dedup-target).

---

### FP-D — Diagram path validation  ★★

**Where the gap lives:** `DIAGRAM_PROMPT` (`packages/core/src/agents/prompts.ts`) explicitly says *"Every node that references a file path MUST point to a file that actually appears in the diff."* Pure prompt — no enforcement. A diagram citing `src/utils/index.ts` when that file isn't in the diff renders confidently and misleads readers about what the PR touched.

**The fix:** post-process in `parseDiagramResponse` (`packages/core/src/agents/reviewer.ts`). After the existing `sanitizeMermaidOutput` step, scan the diagram for backticked + unquoted path-shaped tokens (`src/.../*.ts`, `packages/.../*.py`, etc.); intersect with `prContext.files`; if any cited path is NOT in the changed-files set, **drop the diagram** entirely (the existing empty-diagram fail path handles the comment-formatter side gracefully).

`prContext.files` is already available at `runDiagramAgent`'s caller (`runReviewPipeline`); pass it through to `parseDiagramResponse`.

**Code targets:** `packages/core/src/agents/reviewer.ts` (`parseDiagramResponse`, `runDiagramAgent`).
**E2E target:** [E2E-33](./../e2e/RUNBOOK.md#e2e-33-fp-d--diagram-path-validation-target).

---

### FP-E — Extend W2 verification to warnings  ★

**Where the gap lives:** `verifyCriticalFindings` (`packages/core/src/agents/reviewer.ts:1353`):
> `if (f.severity !== 'critical') return { keep: true };`

Currently the W2 claim-aware verification pass runs **only** on `critical` findings. Warnings can be false positives too — and there's a perverse incentive: an agent can downgrade a Critical to Warning to dodge today's verification. Closing that loophole reduces warning-level FPs and removes the severity-shopping incentive.

**The fix:** extend the loop to verify `warning` findings with the same prompt + same fail-open semantics + same `verification` tag persisted. The W7 score guardrail then naturally extends — an *all-unverified-warnings* set could clamp the score upward too (separate decision; not in this opportunity).

**Cost:** typical PR has 2–3 warnings, ~$0.01/each on light model → +$0.02–0.03 per review.

**Code targets:** `packages/core/src/agents/reviewer.ts` (`verifyCriticalFindings`; consider renaming to `verifyFindings`). Pure change to the severity-skip line + the verification scoring scope check.
**E2E target:** [E2E-34](./../e2e/RUNBOOK.md#e2e-34-fp-e--w2-verification-extended-to-warnings-target).

---

### FP-F — Inline-reply resolve memory → `disputedKeys`  ★

**Where the gap lives:** `packages/core/src/agents/inline-reply.ts:65` (`detectResolveIntent`) parses *"resolved"* / *"please resolve"* / *"mergewatch resolve"* from inline-thread replies and marks the GitHub thread resolved. But the finding's stable key (`findingMatchKeys`) is **not** added to any "don't re-raise" set — the next full review can re-emit that finding under a slightly different framing.

Same logical bug as the original W3 problem (model re-asserting rebutted findings), manifested on inline threads instead of top-level `## mergewatch triage` comments.

**The fix:** when `detectResolveIntent` fires in `handleInlineReply`, persist the resolved-finding's `findingMatchKeys` to a new per-PR "inline-disputed" set on the review record (alongside the existing `disputedFindingKeys` if added — otherwise as its own field). Union with the W3 disputedKeys when fetching them at the next review run.

**Code targets:** `packages/core/src/agents/inline-reply.ts`, `packages/core/src/triage.ts` (or a new `inline-resolutions.ts`), `packages/core/src/types/db.ts` (new optional field on `ReviewItem`).
**E2E target:** [E2E-35](./../e2e/RUNBOOK.md#e2e-35-fp-f--inline-reply-resolve-memory-target).

---

### FP-G — Linter-aware style agent  ★

**Where the gap lives:** `STYLE_REVIEWER_PROMPT` (`packages/core/src/agents/prompts.ts:138`) says *"Anything already enforced by a linter"* should not be reported — but the model has no way to know what linters the repo has configured. It conservatively reports things like *"missing semicolon"* / *"prefer const"* / *"unused import"* because it doesn't trust that a linter would catch them. False-positive surface = the gap between *"what the linter actually does"* and *"what the model assumes the linter does."*

**The fix:** lightweight detection at the conventions-load step (`fetchConventions` path). Look for marker files:

| Language | Marker |
|---|---|
| JS/TS | `.eslintrc*`, `eslint.config.{js,ts,mjs,cjs}`, `biome.json` |
| Python | `ruff.toml`, `pyproject.toml` (with `[tool.ruff]`), `.flake8` |
| Rust | `clippy.toml`, `.clippy.toml` |
| Go | `.golangci.yml`, `.golangci.yaml` |
| CSS | `.stylelintrc*` |

Pass the detected set into a new `LINTER_AWARE_DIRECTIVE` placeholder injected into `STYLE_REVIEWER_PROMPT` *only*: *"Repository has these linters configured: ${list}. Defer all formatting / lint-equivalent findings (semicolons, quotes, import order, unused imports, prefer-const, etc.) to them and do NOT emit those findings. Code-smell and architecture findings still in scope."*

**Code targets:** `packages/core/src/config/conventions.ts` (detection), `packages/core/src/agents/prompts.ts` (new placeholder), `packages/core/src/agents/reviewer.ts` (`buildPrompt` substitution path for style agent only).
**E2E target:** [E2E-36](./../e2e/RUNBOOK.md#e2e-36-fp-g--linter-aware-style-agent-target).

---

## Priority order

| ID | Opportunity | Cost | Code blast radius | ROI |
|---|---|---|---|---|
| **FP-A** | Hard confidence-floor filter | tiny | one filter call | ★★★ |
| **FP-B** | Pre-filter `previousFindings` by disputedKeys | tiny | two handlers, ~10 lines | ★★★ |
| **FP-C** | Pre-orchestrator same-file-same-line dedup | small | reuses W10's helper | ★★ |
| **FP-D** | Diagram path validation | small | `parseDiagramResponse` post-process | ★★ |
| **FP-E** | Extend W2 verification to warnings | LLM-cost +$0.02–0.03/review | one severity-skip line | ★ |
| **FP-F** | Inline-reply resolve memory → disputedKeys | medium | new storage field + handler wiring | ★ |
| **FP-G** | Linter-aware style agent | small | detection + prompt placeholder | ★ |

**Recommended sequencing:** **FP-A + FP-B + FP-C** as one PR — all three are tiny, deterministic, target the orchestrator boundary, and stack cleanly. Then FP-D as a separate Mermaid-focused PR. Then FP-E / FP-F / FP-G as individual polish PRs in any order.

---

## Cross-references

- [`docs/review-quality-plan.md`](./review-quality-plan.md) — the original evidence-derived plan (W1–W12). Patterns P1–P13.
- [`e2e/RUNBOOK.md`](./../e2e/RUNBOOK.md) — fixture cards. Each FP-X opportunity has a corresponding **TARGET** card (E2E-30..E2E-36) added before shipping, and inverted to a passing regression guard once the work lands.

---

## Update protocol

When a new structural gap is identified (without a real-PR observation yet):

1. Add it as **FP-H** (next letter) to the Opportunities section.
2. Add a matching **TARGET** card to `e2e/RUNBOOK.md` (next E2E-NN).
3. Re-rank Priority order.

When an opportunity is implemented:

1. Update the opportunity's heading to **✅ SHIPPED (PR #NN)**.
2. Flip the E2E card from TARGET to a passing fixture (or add the regression-check step).
3. If real evidence of a related false positive arrives later, log it as an Example in `review-quality-plan.md` and cross-reference back here.
