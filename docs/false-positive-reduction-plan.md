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

### FP-A — Hard confidence-floor filter  ✅ SHIPPED

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

### FP-B — Pre-filter `previousFindings` by `disputedKeys`  ✅ SHIPPED

**Where the gap lives:** both handlers (`packages/server/src/review-processor.ts:425`, `packages/lambda/src/handlers/review-agent.ts:545`) pass `previousFindings: prevComplete?.findings` **raw** to `runReviewPipeline`. The orchestrator prompt then includes those prior findings via `buildPreviousFindingsBlock` (`reviewer.ts:798`) and explicitly tells the model to *"carry forward if still present."*

W3's `partitionDisputed` runs **after** the orchestrator. So the orchestrator has already been encouraged to re-emit findings the author dispositioned via `## mergewatch triage` — the clean output then has to be re-filtered. Wasted prompt tokens + the model occasionally re-emits in slightly-different framings that W3's stable-key match can miss.

**The fix:** in both handlers, compute `disputedKeys` *before* constructing the `runReviewPipeline` options, then filter `prevComplete.findings` to exclude entries whose `findingMatchKeys` intersect that set. ~5 lines per handler. Closes the W3 loop on the orchestrator's INPUT side.

**Code targets:** `packages/server/src/review-processor.ts`, `packages/lambda/src/handlers/review-agent.ts`. No core changes.
**E2E target:** [E2E-31](./../e2e/RUNBOOK.md#e2e-31-fp-b--pre-filter-previousfindings-by-disputedkeys-target).

---

### FP-C — Pre-orchestrator same-file-same-line dedup  ✅ SHIPPED

**Where the gap lives:** the orchestrator is the ONLY cross-agent dedup point, and it's an LLM. Two agents flagging exactly `file:42` with overlapping titles relies on the model to merge them. W10's `clusterFindings` catches some post-hoc clustering on a wider region, but trivial same-file-same-line duplicates should be killed *before* the orchestrator sees them — saves prompt tokens AND eliminates a class of cross-agent doubles the model misses.

**The fix:** small pre-pass before `runOrchestratorAgent` over the per-agent `taggedFindings`. Group by `(file, line, normalized-rule)` where `normalized-rule` reuses W10's `extractSignificantTokens` over the title. Same-key duplicates from different agents merge (strongest severity wins; absorbed siblings recorded in the description).

**Code targets:** `packages/core/src/agents/reviewer.ts` (`runReviewPipeline` orchestrator setup) + reuse `packages/core/src/finding-clustering.ts`.
**E2E target:** [E2E-32](./../e2e/RUNBOOK.md#e2e-32-fp-c--pre-orchestrator-cross-agent-dedup-target).

---

### FP-D — Diagram path validation  ✅ SHIPPED

**Where the gap lived:** `DIAGRAM_PROMPT` (`packages/core/src/agents/prompts.ts`) explicitly says *"Every node that references a file path MUST point to a file that actually appears in the diff."* Pure prompt — no enforcement. A diagram citing `src/utils/index.ts` when that file isn't in the diff renders confidently and misleads readers about what the PR touched.

**The fix:** post-process inside `parseDiagramResponse` (`packages/core/src/agents/reviewer.ts`). After `sanitizeMermaidOutput` and `isValidMermaidDiagram`, run a new `validateDiagramPaths(diagram, changedFiles)` helper. It extracts every path-shaped token (`<seg>/<…>.ext`, 1–8-char extension, surrounding backticks stripped, URL captures detected via the immediately-preceding `://` and skipped). Each cited path is accepted if it (a) exactly matches a changed file, (b) is a trailing-segment suffix of a changed file (model emitted a shortened path), or (c) has a changed file as its own trailing suffix (model emitted an absolute-ish form). Any cited path that matches none → the **entire diagram** is dropped (`{ diagram: '', caption: '' }`) and the comment-formatter's existing empty-diagram path renders without a Mermaid block.

`runDiagramAgent` gained an optional `changedFiles?` arg. `runReviewPipeline` hoists `extractChangedLines(diff)` up front (cheap regex, no LLM call), derives `changedFiles = [...changedLines.keys()]`, and feeds both the diagram agent and the existing W2/line-proximity stages — no double-extraction, no API surface change for the handlers.

**Fail-open:** when `changedFiles` is undefined or empty, `validateDiagramPaths` returns `ok: true`. Older direct callers of `runDiagramAgent` (tests, external integrations) keep working unchanged.

**Code targets (final):** `packages/core/src/agents/reviewer.ts` (new exported `extractDiagramFilePaths`, `validateDiagramPaths`; wired into `parseDiagramResponse` + `runDiagramAgent` + `runReviewPipeline`), `packages/core/src/index.ts` (exports).
**E2E target:** [E2E-33](./../e2e/RUNBOOK.md#e2e-33-fp-d--diagram-path-validation).

---

### FP-E — Extend W2 verification to warnings  ✅ SHIPPED

**Where the gap lived:** `verifyCriticalFindings` (the old name) had a hard-coded `if (f.severity !== 'critical') return { keep: true };`. The W2 claim-aware verification pass ran **only** on `critical` findings. Warnings can be false positives too — and there was a perverse incentive: an agent could downgrade a Critical to Warning to dodge verification. Closing that loophole reduces warning-level FPs and removes the severity-shopping incentive.

**The fix:** the function was renamed to `verifyFindings` and the severity gate widened to `severity === 'critical' || severity === 'warning'`. Info-level findings continue to pass through untouched. The shared verifier prompt was renamed `CRITICAL_VERIFICATION_PROMPT` → `FINDING_VERIFICATION_PROMPT`, its title generalised ("a code-review finding" rather than "a CRITICAL code-review finding"), and a sentence added explaining that the same failure mode happens at both severities. The verifier input also now includes the finding's `severity` so the model can still consider it when judging. Log prefix changed from `[critical-verify]` to `[finding-verify]` (and includes the severity in every line).

The same fail-safe semantics apply at both severities: missing file content → no LLM call, no `verification` tag; LLM error / parse error / no verdict → keep + `unverified` tag; explicit `valid: false` → drop; explicit `valid: true` → keep + `verified` tag.

**W7 score-clamp scope (intentionally unchanged):** `reconcileMergeScore` still only inspects criticals for the W7 unverified-only clamp. Per the original opportunity, extending the clamp to warnings is a separate decision and explicitly out of scope here. The `verification` tag on warnings is informational + used by downstream delta/UX.

**Cost:** typical PR has 2–3 warnings, ~$0.01/each on light model → +$0.02–0.03 per review. Confirmed against current pricing.

**Code targets (final):** `packages/core/src/agents/reviewer.ts` (renamed `verifyFindings` + widened severity gate + updated docs + updated logging), `packages/core/src/agents/prompts.ts` (renamed `FINDING_VERIFICATION_PROMPT` + generalised prompt body).
**E2E target:** [E2E-34](./../e2e/RUNBOOK.md#e2e-34-fp-e--w2-verification-extended-to-warnings).

---

### FP-F — Inline-reply resolve memory → `disputedKeys`  ✅ SHIPPED

**Where the gap lived:** `detectResolveIntent` parses *"resolved"* / *"please resolve"* / *"mergewatch resolve"* / *"/resolve"* from inline-thread replies and marks the GitHub thread resolved. But the finding's stable key (`findingMatchKeys`) was **not** added to any "don't re-raise" set — the next full review could re-emit that finding under a slightly-different framing. Same logical bug as the original W3 problem, manifested on inline threads instead of top-level `## mergewatch triage` comments.

**The fix:**

- `ReviewThreadComment` (in `packages/core/src/github/client.ts`) gained an optional `path` field, populated from GitHub's review-comment `path` so the inline-resolve handler can recover the anchored file.
- `handleInlineReply` derives the resolved finding's `findingMatchKeys` from the thread root (`{ file: root.path, line: 0, title: extractInlineCommentTitle(root.body) }`) and surfaces them on `InlineReplyResult.resolvedFindingKeys`. Fail-safe: missing `path` or unparseable title returns `[]`; resolution itself still succeeds, just no key memory is surfaced.
- The handlers (`packages/server/src/review-processor.ts` and `packages/lambda/src/handlers/review-agent.ts`) append the keys onto the latest review record's new `inlineResolvedKeys` field (dedup + cap 500), persisted via the existing `updateStatus` extra-fields path. Log lines: `[fp-f] persisted N inline-resolved key(s) on …`.
- On the next full review (same handlers), `prevComplete.inlineResolvedKeys` is unioned with the live-computed W3 `disputedKeys` before being passed to `runReviewPipeline`. Log lines: `[fp-f] unioned N inline-resolved key(s) into disputedKeys (now N total)`. The downstream FP-B previousFindings pre-filter and W3 `partitionDisputed` already operate on the full union — no behaviour divergence vs the W3 path.

**Schema:**
- `ReviewItem.inlineResolvedKeys?: string[]` — added to `packages/core/src/types/db.ts`.
- Postgres `reviews.inline_resolved_keys` jsonb column + Drizzle migration `0002_bouncy_sally_floyd.sql` (using `ADD COLUMN IF NOT EXISTS` per CLAUDE.md guidance). DynamoDB is schemaless so no DDL change needed.
- `queryByPR` on the Postgres review-store maps the column back through to the typed `ReviewItem`.

**Code targets (final):** `packages/core/src/types/db.ts` (field), `packages/core/src/github/client.ts` (`ReviewThreadComment.path`), `packages/core/src/agents/inline-reply.ts` (`deriveResolvedFindingKeys` helper + result surface), `packages/server/src/review-processor.ts` + `packages/lambda/src/handlers/review-agent.ts` (persist on resolve + union on review), `packages/storage-postgres/src/schema.ts` + `drizzle/0002_*.sql` + `review-store.ts` output mapping.
**E2E target:** [E2E-35](./../e2e/RUNBOOK.md#e2e-35-fp-f--inline-reply-resolve-memory).

---

### FP-G — Linter-aware style agent  ✅ SHIPPED

**Where the gap lived:** `STYLE_REVIEWER_PROMPT` said *"Anything already enforced by a linter"* should not be reported — but the model had no way to know what linters the repo had configured. It conservatively reported things like *"missing semicolon"* / *"prefer const"* / *"unused import"* because it didn't trust that a linter would catch them. False-positive surface = the gap between *"what the linter actually does"* and *"what the model assumes the linter does."*

**The fix:**

- New `detectLinters(octokit, owner, repo, ref)` in `packages/core/src/config/conventions.ts`. Performs a single root-listing API call (`repos.getContent` with `path: ''`), matches entries against per-linter marker tables in `LINTER_MARKERS`:

  | Linter | Markers |
  |---|---|
  | eslint | `.eslintrc`, `.eslintrc.{js,cjs,mjs,json,yml,yaml}`, `eslint.config.{js,ts,mjs,cjs}` |
  | biome | `biome.json`, `biome.jsonc` |
  | ruff | `ruff.toml`, `.ruff.toml`, plus `pyproject.toml` when it contains `[tool.ruff…]` (one extra fetch + regex) |
  | flake8 | `.flake8` |
  | clippy | `clippy.toml`, `.clippy.toml` |
  | golangci | `.golangci.yml`, `.golangci.yaml`, `.golangci.toml` |
  | stylelint | `.stylelintrc`, `.stylelintrc.{json,js,cjs,yml,yaml}`, `stylelint.config.{js,cjs}` |

  Returns the detected set sorted lexicographically (deterministic for prompt caching). Best-effort: any API error returns `[]`.

- New `LINTER_AWARE_PLACEHOLDER` (`{{LINTERS_DETECTED}}`) in `STYLE_REVIEWER_PROMPT`. New `buildLinterAwareDirective(linters)` renders the directive when the set is non-empty; returns `''` (placeholder stripped) when empty — so back-compat with "no linters detected" is exact.

- `runStyleAgent` accepts a new optional `detectedLinters?: readonly string[]` and substitutes the placeholder. **Style-agent only** — the security, bug, error-handling, and test-coverage agents are unaffected.

- `ReviewPipelineOptions.detectedLinters` plumbs the set from the handlers (`server/review-processor.ts` + `lambda/review-agent.ts`). Both handlers call `detectLinters` in parallel with `fetchConventions` (`Promise.all`) so latency is unchanged from W4's conventions-load step.

- Telemetry: `[fp-g] detected linters: eslint, biome` log line when non-empty; silent when empty.

**Code targets (final):** `packages/core/src/config/conventions.ts` (`detectLinters` + `DetectedLinter` type + `LINTER_MARKERS`), `packages/core/src/agents/prompts.ts` (`LINTER_AWARE_PLACEHOLDER` + `buildLinterAwareDirective` + placeholder injection into `STYLE_REVIEWER_PROMPT`), `packages/core/src/agents/reviewer.ts` (`runStyleAgent` arg + `ReviewPipelineOptions.detectedLinters` + pipeline wiring), `packages/server/src/review-processor.ts` + `packages/lambda/src/handlers/review-agent.ts` (parallel detection + option passthrough), `packages/core/src/index.ts` (exports).
**E2E target:** [E2E-36](./../e2e/RUNBOOK.md#e2e-36-fp-g--linter-aware-style-agent).

---

## Priority order

| ID | Opportunity | Cost | Code blast radius | ROI |
|---|---|---|---|---|
| **FP-A** | Hard confidence-floor filter | tiny | one filter call | ✅ SHIPPED |
| **FP-B** | Pre-filter `previousFindings` by disputedKeys | tiny | two handlers, ~10 lines | ✅ SHIPPED |
| **FP-C** | Pre-orchestrator same-file-same-line dedup | small | reuses W10's helper | ✅ SHIPPED |
| **FP-D** | Diagram path validation | small | `parseDiagramResponse` post-process | ✅ SHIPPED |
| **FP-E** | Extend W2 verification to warnings | LLM-cost +$0.02–0.03/review | one severity-skip line | ✅ SHIPPED |
| **FP-F** | Inline-reply resolve memory → disputedKeys | medium | new storage field + handler wiring | ✅ SHIPPED |
| **FP-G** | Linter-aware style agent | small | detection + prompt placeholder | ✅ SHIPPED |

**Recommended sequencing:** **FP-A + FP-B + FP-C** as one PR (shipped — #159) — all three are tiny, deterministic, target the orchestrator boundary, and stack cleanly. Then FP-D as a separate Mermaid-focused PR (shipped — #160). Then FP-E / FP-F / FP-G as individual polish PRs (shipped — #161 / #162 / this one). **All seven items shipped.**

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
