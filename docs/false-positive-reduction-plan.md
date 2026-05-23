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

### FP-H — Anti-anchoring on prior findings  ✅ SHIPPED

**Where the gap lived:** observed live across PRs #163 / #166 / #169 — when MergeWatch re-reviews after a fix commit, it carries the previous bot review in conversation history (via `buildPreviousFindingsBlock`). The model was treating the previous-findings block as **stylistic guidance** — "look for findings shaped like these" — even after the cited instances were gone. The frame outlived the referent, producing round-2 false positives whose hit-rate dropped to 0/3 on the most extreme case (#166 round-2). Filed as [#167](https://github.com/santthosh/mergewatch.ai/issues/167).

**The fix (Layer 1 + Layer 2):**

- **Layer 1** — explicit counter-instruction in `buildPreviousFindingsBlock`. A new "CRITICAL (FP-H)" paragraph tells the orchestrator that the previous-findings list is **for stable-identity matching only**, NOT a stylistic template. Pattern-matching against a prior finding is named as a known failure mode and explicitly forbidden.
- **Layer 2** — `verifyFindings` accepts an optional `previousFindings` arg and constructs a per-batch prior-context block via `buildVerifierPriorContext(...)`. The verifier prompt gains an additional INVALID condition: *"the current finding's title overlaps heavily with a prior finding's significant tokens AND the cited line does not contain the construct the finding describes"*. The verifier sees prior titles + per-prior sigToken bags (computed via the same W10 helper FB-A uses).

Both layers compose: Layer 1 reduces the rate at which orchestrator-emitted findings are pattern-matched in the first place; Layer 2 catches the residual that still gets through.

**Code targets (final):** `packages/core/src/agents/reviewer.ts` (`buildPreviousFindingsBlock` counter-instruction + `verifyFindings` priorFindings arg + caller threading), `packages/core/src/agents/prompts.ts` (`PRIOR_CONTEXT_PLACEHOLDER` + `buildVerifierPriorContext` + verifier-prompt extension), `packages/core/src/index.ts` (exports).
**E2E target:** [E2E-49](./../e2e/RUNBOOK.md#e2e-49-fp-h--anti-anchoring-on-prior-findings).

---

### FP-I — Verify "suggestion already implemented"  ✅ SHIPPED

**Where the gap lived:** `FINDING_VERIFICATION_PROMPT` (FP-E) checks defect existence but not whether the *suggested fix is already the existing code*. On PR #169 round-2 (commit `69573aa`), MW produced a finding whose suggestion was byte-identical to the existing `console.warn(...)` call on the cited line. The verifier let it through because the prompt asks *"does the defect exist?"* — not *"is the fix already implemented?"*. Filed as [#168](https://github.com/santthosh/mergewatch.ai/issues/168).

**The fix (Layer 1 + Layer 2):**

- **Layer 1** — extended `FINDING_VERIFICATION_PROMPT` with an additional INVALID condition: *"the Suggestion field proposes code that is ALREADY implemented in the cited region of the file"*. Zero additional LLM cost — same verifier call, longer prompt. Asks the model to inspect the suggestion's code-shaped content (backticks / fences) against the cited ±5-line region.
- **Layer 2** — new exported `suggestionMatchesExistingCode(suggestion, fileContent, line)` helper. Extracts code chunks from the suggestion (fenced blocks first, then inline backticks), normalises whitespace, requires ≥10 chars to avoid generic-punctuation false positives, and checks for substring overlap against the cited ±5-line window. When `true`, `verifyFindings` drops the finding **before** the LLM call — deterministic structural backstop that catches the unambiguous cases cheaply (`[finding-verify] dropped … — FP-I L2: suggestion already implemented`).

**Code targets (final):** `packages/core/src/agents/reviewer.ts` (`suggestionMatchesExistingCode` helper + verifyFindings pre-LLM short-circuit), `packages/core/src/agents/prompts.ts` (FINDING_VERIFICATION_PROMPT INVALID condition extension).
**E2E target:** [E2E-50](./../e2e/RUNBOOK.md#e2e-50-fp-i--verify-suggestion-already-implemented).

---

### FP-J — Verifier honours prior recommendations  ✅ SHIPPED

**Where the gap lived (Layer 2):** on PR #169 round-2, MW directly contradicted its own round-1 advice. Round-1 said *"re-throw on `listInstallationIds` failure so CloudWatch alarms"*. I made that change. Round-2 then flagged the very same throw as a 🔴 Critical *"unhandled promise rejection"*. The verifier had no notion of prior recommendations being binding constraints on subsequent reviews. Filed as [#170](https://github.com/santthosh/mergewatch.ai/issues/170).

**Where the gap lived (Layer 1 + 3):** the verdict tier (`COMMENTED` vs `CHANGES_REQUESTED`) was dominated by the *presence* of any non-info finding, not by the *fraction* of findings that were historically accurate. A PR with 1 valid warning + 2 false ones flipped to `CHANGES_REQUESTED` even though the average finding accuracy was 33%. The fix was deferred until FB-A/FB-E accumulated production data — once the FP-feedback plan shipped (FB-A → FB-L), the counters were available to drive the verdict softener.

**The fix (three layers — all shipped):**

- **Layer 2** — the same prior-context block from FP-H L2 also lists prior **recommendations** (suggestions) from `previousFindings[].suggestion`. The verifier prompt gains an additional INVALID condition: *"the current finding contradicts a prior recommendation — if the prior review suggested X and X is now present, a current finding that critiques X MUST be dropped"*. The prior advice is binding for the duration of the PR. Same single prompt-extension surface as FP-H L2 — one verifier call, three new INVALID conditions, three failure modes collapsed into one mechanism.
- **Layer 1** — `reconcileMergeScore` gains an optional `categoryDisputeRates: Record<string, number>` input projected from `InstallationFPInsight.perCategory` over the 30d window. When the orchestrator wants to BLOCK (score ≤ 2) AND more than half the action findings come from chronically-disputed categories (rate ≥ 0.75 AND surfacings ≥ 5), the verdict is softened to 3 (Review recommended / advisory). Same shape as the W7 unverified-criticals clamp, but driven by FB-A dispute counters rather than W2 verification verdicts. Pure deterministic scoring — no LLM calls, no prompt changes. `loadCategoryDisputeRates(insightStore, installationId)` is the read helper; both handlers (server + lambda) wire it into the existing parallel-fetches block alongside `fetchConventions` and `detectLinters`.
- **Layer 3** — a transparent disclosure footer (`📊 N of M action findings are from a category disputed ≥ 75% of the time in this org's recent reviews…`) renders as a quiet `<sub>` line beneath the merge-score badge whenever at least one action finding's category qualifies — even when the tier didn't change. Gives reviewers context about *why* the verdict looks the way it does without auto-suppressing the findings themselves.

Back-compat is total at every layer: absent `categoryDisputeRates` (fresh installation, no rollup yet, upstream-degraded read) → identical to pre-FP-J behaviour. The loader's `{}` default behaves as "no down-weighting" in the reconcile path, and the formatter's empty `disputeDisclosure` simply omits the footer.

**Code targets (final):**
- Layer 2: `packages/core/src/agents/prompts.ts` (FINDING_VERIFICATION_PROMPT — new INVALID condition; `buildVerifierPriorContext` lists prior suggestions), `packages/core/src/agents/reviewer.ts` (PreviousFinding widened with optional `suggestion`).
- Layer 1: `packages/core/src/agents/reviewer.ts` (`reconcileMergeScore` extended with `categoryDisputeRates` input + dispute-aware softener tier; `ReviewPipelineOptions.categoryDisputeRates?` + `ReviewPipelineResult.disputeDisclosure?`), `packages/core/src/insights/dispute-rates.ts` (new — `loadCategoryDisputeRates` helper with `MIN_SURFACED = 5` filter), handler wiring in `packages/server/src/review-processor.ts` + `packages/lambda/src/handlers/review-agent.ts` (parallel-fetch alongside conventions + linters).
- Layer 3: `packages/core/src/comment-formatter.ts` (FormatOptions gains `disputeDisclosure?` rendered as `<sub>` beneath the score line).

**E2E targets:** [E2E-51](./../e2e/RUNBOOK.md#e2e-51-fp-j--verifier-honours-prior-recommendations) (Layer 2), [E2E-53](./../e2e/RUNBOOK.md#e2e-53-fp-j-l1l3--dispute-aware-verdict-softening--disclosure) (Layer 1 + 3).

### FP-L — Propagate W2 verification to rendering surfaces  ✅ SHIPPED

**Where the gap lived:** on PR #172 round-2, W2 tagged a critical as `verification: 'unverified'` and W7 correctly clamped the merge score to 3 (advisory) — but **three other rendering surfaces still shouted "🔴 CRITICAL"**: the inline review comment at the cited line, the "Requires your attention" action-items table at the top of the review comment, and the "🔴 Critical (N)" detailed section in the middle. The reviewer experience was schizophrenic: the formal verdict said *"Downgraded to advisory — the PR is not blocked on unverified concerns"* while three of the five visual surfaces (and the most-disruptive one — the inline comment that fires a GitHub notification) looked blocking.

Root cause: W7's score-clamp checks `verification: 'unverified'` and adjusts the merge score. But `buildInlineComments` filtered on `severity === 'critical'` only, `formatReviewComment`'s `actionFindings` filtered on `severity === 'critical' || severity === 'warning'` only, and the Critical section dumped everything from `grouped.get('critical')`. When W2 added the verification tag, the rendering layer was never wired to the same signal. Filed as [#175](https://github.com/santthosh/mergewatch.ai/issues/175).

**The fix (three layers, all pure-rendering):**

- **Layer 1** — `buildInlineComments` filter rejects findings with `verification === 'unverified'`. The finding still appears in the top-level review body (under Layer 3's new sub-section) — it just doesn't get the most-disruptive surface (inline 🔴 + GitHub notification + red diff marker).
- **Layer 2** — `formatReviewComment`'s `actionFindings` filter excludes unverified criticals from the "Requires your attention" table. The table now matches the W7-clamped score (an advisory PR doesn't claim to require attention on the formal blocking surface).
- **Layer 3** — the `### 🔴 Critical (N)` header is split. Verified criticals keep the existing header; unverified criticals get a separate `### ⚠️ Unverified concerns (M)` sub-section with the advisory subtitle *"The verifier couldn't confirm these against the source. Review carefully; the PR is not blocked on them."* The sub-section is omitted entirely when there are no unverified criticals — no empty headers on the clean path.

Back-compat: a finding with `verification` absent is treated as a pre-W2 record and renders normally in all three surfaces (no behaviour change for callers that don't run W2).

**Code targets (final):** `packages/core/src/github/client.ts` (`InlineCommentCandidate.verification?` + filter), `packages/core/src/comment-formatter.ts` (`Finding.verification?` + action-table filter + split Critical section).
**E2E target:** [E2E-52](./../e2e/RUNBOOK.md#e2e-52-fp-l--propagate-w2-verification-to-rendering-surfaces).

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
| **FP-H** | Anti-anchoring on prior findings (L1 + L2) | small | prompt extension + verifier ctx | ✅ SHIPPED |
| **FP-I** | Verify suggestion-already-implemented (L1 + L2) | small | verifier prompt + structural helper | ✅ SHIPPED |
| **FP-J** | Verifier honours prior recommendations + dispute-aware reconcile + disclosure | small (L2) + medium (L1 + L3) | verifier prompt + reconcile + formatter | ✅ SHIPPED (all 3 layers) |
| **FP-L** | Propagate W2 verification tag to rendering surfaces | small | inline filter + comment-formatter split | ✅ SHIPPED |

**Recommended sequencing:** **FP-A + FP-B + FP-C** as one PR (shipped — #159) — all three are tiny, deterministic, target the orchestrator boundary, and stack cleanly. Then FP-D as a separate Mermaid-focused PR (shipped — #160). Then FP-E / FP-F / FP-G as individual polish PRs (shipped — #161 / #162 / #163). **FP-H + FP-I + FP-J Layer 2** as a single follow-up bundle (#171). **FP-L** as a standalone PR (this PR) — pure rendering change, no prompt churn, isolated blast radius; tying it in with FP-K (verifier-extension) would have mixed prompt-and-render concerns in one diff.

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
