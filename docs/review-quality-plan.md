# Review Quality Improvement Plan

**Status:** Living document — evidence-driven. As of 2026-05-20, every workstream W1–W11 has been implemented; W12 was largely subsumed by W6. See **Priority order** at the bottom for the shipped state.
**Purpose:** Track real-world MergeWatch review failures, distill them into patterns, and drive concrete fixes in the pipeline.

This is not a one-shot spec. We collect concrete examples of MergeWatch behaving worse than a competent human reviewer, tag each with the failure pattern(s) it exhibits, and prioritize fixes by how many examples a fix would have prevented.

Reviewing model observed in evidence: **claude-sonnet-4** (per the "Review details" block). Model choice is a lever (see W2), but the high-ROI fixes are structural, not "use a bigger model."

---

## How to use this doc

1. Add each new observation under **Observed Examples** using the template at the bottom. Keep raw evidence (PR link / screenshot path) and quote the bot's exact text.
2. Tag it with one or more **Failure Patterns**. Add a new pattern if none fit.
3. Patterns that accumulate examples pull their **Workstream** up in priority (see the count in the Evidence Index).
4. Each workstream names the concrete file(s) to change so it stays actionable.

---

## Evidence Index

| # | PR | Title | Verdict | Patterns hit |
|---|----|-------|---------|--------------|
| 1 | voice-bot #31 | node-pg-migrate on startup | 2/5 Needs fixes | P1 P2 P3 P4 P5 P6 P7 |
| 2 | orca #37 | S3-read seed as ECS task | 2/5 Needs fixes | P1 P5 P6 P7 P8 P10 P11 P12 |
| 3 | orca #38 | kbStore.searchCandidates + test | 3/5 Review rec. | P4 P5 P6 P11 P12 |
| 4 | orca #39 | KB_BACKEND s3\|postgres switch | 2/5 Needs fixes | P1 P2 P4 P5 P8 P9 P11 P12 |

Pattern frequency (7 examples): **P5×6, P1×5, P4×3, P6×3, P7×3, P11×3, P12×3**, P2×2, P3×2, P8×2, P9×2, P10×1, **P13×1 (new — and the highest user-visible severity: it leaves a PR structurally stuck at the GitHub level until a human dismisses the bot's review).**

> **Whack-a-mole / non-convergence** (P7+P9 compounded) is now the headline failure: PR #145's own re-review reported the *same finding as both "✅ resolved" and "🆕 new"* in one comment. Every fix commit shifts lines and regenerates ~4 "new" warnings, so the verdict never converges. This is the single highest-leverage thing to fix — see **W3∩W9 convergence guard**.

> Key takeaway: the "missing `await` on async X" hallucination is **systemic** — it independently recurred in #31 and #39, both times with **wrong line numbers** and an author rebuttal. P1/P2 + P8 are the spine of the problem.

---

## Failure Patterns (taxonomy)

| ID | Pattern | Description |
|----|---------|-------------|
| **P1** | Diff-only hallucination | Asserts absence of something (await, error handling, validation) because the hunk didn't include the lines that prove it's present. |
| **P2** | Self-contradicting suggestion | The "fix" is byte-identical to / a no-op against the existing code. |
| **P3** | Persisted after rebuttal | Re-review re-asserts a finding the author already disproved in a structured triage reply. |
| **P4** | Verdict dominated by one weak finding | The 1–5 score is gated almost entirely on a single unverified or design-opinion Critical. |
| **P5** | Low-signal nagging | Repeats a class of finding ("lacks test coverage") many times, including where it's out of scope. |
| **P6** | Comment / timeline clutter | Multiple overlapping comments restate the same content. |
| **P7** | Unstable finding identity | Same issue churns between new / carried-over / resolved across re-reviews. |
| **P8** | Location inaccuracy | Path prefix inconsistent *within one comment* (`src/x` vs `packages/voice-bot/src/x`); line numbers disagree across summary/critical/inline for the same finding; line points at a function *definition* not the call site; off-by-one to off-by-tens. |
| **P9** | Phantom resolution / counter inflation | Marks a finding "✅ Resolved on this commit" when the code was never changed (it was a false positive). The resolved/new/carried counters don't reflect reality. |
| **P10** | Fragmented duplicate findings | One underlying concern emitted as several separate findings at different lines/severities. |
| **P11** | Scope / architecture blindness | Flags work the PR's plan explicitly defers to a later task, or treats a correctly-throwing data-access function as a bug (ignores layering & stated task decomposition). |
| **P12** | Review spam / empty-body reviews | Multiple GitHub *Reviews* per run, some with empty bodies; pure timeline/email noise. |
| **P13** | "No-exit" critical / stuck PR state | A Critical the bot re-asserts every commit on a finding the author has dispositioned (often a design point with no code-level resolution), pinning `reviewDecision=CHANGES_REQUESTED` and check `FAILURE`. The PR is structurally blocked at the GitHub level because nothing in the product honors "rebutted with rationale" (W3) and no W7 score guardrail stops a single un-verified Critical from posting `CHANGES_REQUESTED`. User-visible manifestation of P3 compounded by missing W7. |

---

## Positive signals (do NOT regress these)

The goal is **precision, not silence.** Things MergeWatch already does well:

- **Real bugs caught.** #37 `seed.ts:38` (S3 errors unhandled) and `seed.ts:109` (rollback masks original error) were legit — author fixed both.
- **Accurate nit.** #39 `rag.ts:243` "comment describes removed import, not the lazy-load pattern" was correct and actionable — author fixed it.
- **Dedup exists.** #38 reported `Suppressed 4 findings removed by dedup & quality filters` — the machinery is there; it's under-tuned, not absent.
- **Real concurrency catch.** #145 (self-review) flagged unbounded `Promise.all` in `verifyCriticalFindings` — a genuine Bedrock-TPM risk, fixed. The bot caught a real defect in its own quality-improvement code.
- **Real security catch.** #148 (self-review) flagged the missing author-filter on `fetchTriageComments` as 🔴 Critical (prompt-injection via third-party triage comments). Genuine attack class; fixed via author-filter + prompt data-isolation. **1/1 critical was real and actionable** — the precision goal of the plan, validated on the bot's own security PR.
- **Diagram + summary + cost transparency** are genuinely useful and should stay.

Any fix that reduces noise must preserve these.

---

## Observed Examples

### Example 1 — voice-bot PR #31: "node-pg-migrate schema migrations on startup"

- **Evidence:** `~/Desktop/PR-31.png`
- **Verdict:** `2/5 — Needs fixes`. Counters: `3 resolved · 8 new · 2 carried over`. ~100,694 tok, ~$0.48, 31.6s.
- **What it got wrong:**
  - 🔴 Sole Critical `kb-migrate.ts:33 — Missing await on async migrationRunner call` is a **false positive**; the line already reads `const run = await migrationRunner({`. **[P1]**
  - Its suggestion — *"Add await before migrationRunner: `const run = await migrationRunner({`"* — is byte-identical to existing code. **[P2]**
  - Author posted proof-backed `mergewatch triage`; the bot `dismissed their stale review` and the new review **re-asserted the same Critical**. **[P3]**
  - 2/5 gated entirely on that false positive. **[P4]** Test-coverage nags in a repo with no test harness. **[P5]** 5 overlapping comments. **[P6]** False positive resurfaced as "new". **[P7]**
- **Patterns:** P1 P2 P3 P4 P5 P6 P7

### Example 2 — orca PR #37: "T1.3 wrapper: S3-read seed as a one-off ECS task" (MERGED)

- **Evidence:** `gh pr view 37 --repo santthosh/orca` · dashboard `…/reviews/santthosh%2Forca%3A37%234984f87`
- **Verdict:** `2/5 — Needs fixes`. Counters: `5 resolved · 4 new · 3 carried over`. 87,318 tok, ~$0.41, 26.3s. 2 reviews (DISMISSED → CHANGES_REQUESTED), both bodied `🔴 Critical issues found — see the full review…`.
- **Legit (kept honest):** 🔴 `seed.ts:38` S3 errors unhandled and 🔴 `seed.ts:109` rollback masks error — both real, author fixed.
- **What it got wrong:**
  - ⚠️ `seed.ts:150` "SQL injection risk in dynamic VALUES clause" (and prior `seed.ts:95`) — **false positive on the injection framing**: the embedding is a bound parameter (`$n::vector`); the concatenated string the bot saw is the *placeholder list* `$1,$2,…`, never values. Mis-categorized a parameterized query as injection. **[P1]**
  - **Location chaos within one comment** — summary table says `src/seed.ts:38` & `workflows/seed.yml:76`; the Critical block says `packages/voice-bot/src/seed.ts:38`; the warning says `.github/workflows/seed.yml:76`; the **inline comment landed at `packages/voice-bot/src/seed.ts:39`**. Rollback finding is `:109` in summary/Critical but the **inline comment is at `:160`**. Same finding, four different locations. **[P8]**
  - **Fragmented duplicates** — `seed.ts:150` (SQL injection), `seed.ts:82` (type assertion w/o validation), `seed.ts:130` Info (untrusted JSON) are **one concern**: "validate the parsed S3 chunk file." Author's single `assertEmbedding()` + `parseChunkFile()` covers all three. **[P10]**
  - ECS `Resource:"*"` (bootstrap*.sh:158) flagged though the entire pre-existing ECS policy (12 sibling actions) is already `*`; least-privilege is its own task. **[P11][P5]**
  - Injection false positive moved `:95 → :150` and counted under `🆕 4 new`. **[P7]** Two stacked reviews. **[P6][P12]**
- **Patterns:** P1 P5 P6 P7 P8 P10 P11 P12

### Example 3 — orca PR #38: "T1.7: kbStore.searchCandidates + integration test" (MERGED)

- **Evidence:** `gh pr view 38 --repo santthosh/orca` · dashboard `…%3A38%231cc2c72`
- **Verdict:** `3/5 — Review recommended`. Counters: `3 resolved · 1 new · 1 carried over`. 57,184 tok, ~$0.47, 19.8s. **4 reviews in 9 min**: DISMISSED (empty body), DISMISSED (empty body), DISMISSED (`Critical issues found…`), COMMENTED (`Review recommended…`).
- **What it got wrong:**
  - 🔴 Sole Critical `kb-store.ts:149` "Database query lacks error handling in RAG hot path." Author rebuts: **by design** — a data-access function should *throw*, not swallow (swallowing silently degrades RAG with no signal). The degraded-mode/fallback decision is explicitly **T1.8's job per the plan** (the very next PR). The Critical is a layering/scope misunderstanding, and the whole `3/5` hinges on it. **[P11][P4]**
  - `1 carried over` is the #37 ECS `Resource:"*"` note — already deferred-with-rationale; the bot keeps carrying a finding the author addressed across PRs. **[P5]**
  - Two **empty-body DISMISSED reviews** within 3 minutes — pure noise in timeline + email. **[P12][P6]**
- **Patterns:** P4 P5 P6 P11 P12

### Example 4 — orca PR #39: "T1.8: KB_BACKEND=s3|postgres switch in RAG read path" (MERGED)

- **Evidence:** `gh pr view 39 --repo santthosh/orca` · dashboard `…%3A39%23cf4e7c1`
- **Verdict:** `2/5 — Needs fixes`. Counters: `6 resolved · 4 new`. 69,652 tok, ~$0.46, 22.3s. 3 reviews (DISMISSED empty → DISMISSED → CHANGES_REQUESTED).
- **Legit (kept honest):** ⚠️ `rag.ts:243` stale comment about a removed import — accurate, author fixed.
- **What it got wrong:**
  - The **"missing await" hallucination recurs.** Under `📎 Previously reported → ✅ Resolved on this commit (6)`: `rag.ts:325 — Missing await on async searchViaPostgres call could cause unhandled rejection`. Author: **false positive** — the call is `return await searchViaPostgres(...)` inside `try/catch`; *"the cited line numbers (325, 330) don't match the call site at all — 330 is the function definition."* Same class as #31. **[P1][P2]**
  - **Phantom resolution.** That false positive (and `rag.ts:404 — fallback error handling not tested`) is listed under **"✅ Resolved on this commit"** though the author never changed that code — it was never broken. The "6 resolved" counter is inflated by findings that were never real. **[P9]**
  - **Line numbers systematically wrong**: missing-await cited at `:325/:330` (def, not call site); fallback at `:404` vs the live `:410`/`:419`. Author explicitly calls this out. **[P8]**
  - 🔴 Critical `rag.ts:410` "Postgres fallback untested" — it's a 3-line non-fatal `try/catch`; S3-fallback test deferred with rationale (needs invasive seams), Postgres path it guards *is* covered. 2/5 gated on a coverage-gap Critical. **[P4][P5][P11]**
  - `🆕 4 new` are all test-coverage gaps again. **[P5]** DISMISSED empty-body review. **[P12]**
- **Patterns:** P1 P2 P4 P5 P8 P9 P11 P12

### Example 5 — mergewatch.ai PR #145 (self-review / dogfood of the W1+W2 PR)

- **Evidence:** `gh pr view 145 --repo mergewatch/mergewatch.ai` · dashboard `…%3A145%23b8c91ef`
- **Verdict:** `3/5 — Review recommended`. 0 critical, **4 warnings**. 81,428 tok, ~$0.21, 29.3s. `Suppressed 7`, conventions loaded from `AGENTS.md`. One COMMENTED review (correct — no criticals, didn't block).
- **Legit (kept honest):**
  - ⚠️ **Unbounded `Promise.all` in `verifyCriticalFindings`** — genuine, the strongest catch. A PR with many criticals would burst N parallel Bedrock calls and hit the per-minute TPM quota — the exact failure `runReviewPipeline` already avoids via `withConcurrency`/`AGENT_CONCURRENCY`. **Fixed.**
  - ⚠️ **Silent fail-safe on unparseable verification JSON** — real observability gap; the keep-on-bad-output path emitted no signal. **Fixed** (sentinel default + explicit log).
- **What it got wrong:**
  - ⚠️ "Potential code injection / ReDoS in `suggestionAlreadyApplied`" — **mis-categorization (P1-family).** The regexes are all linear (no catastrophic backtracking) and `suggestion` is LLM-generated, not request-controlled — no injection/ReDoS path. Same shape as #37's "SQL injection" on a parameterized query: a confident security label on code that doesn't have the defect. (A 4KB input bound was still added for consistency with the codebase's own `FINDING_TEXT_MAX_BYTES` convention.)
  - ⚠️ "Broad exception catching masks failure modes" — the catch-all is the intentional fail-safe; all paths throw the same `Error` from `llm.invoke` and aren't separable. Low-signal nit. **[P5-adjacent]**
- **Round 2 (commit `f264640`, after the round-1 triage + fixes) — the whack-a-mole, on tape:** verdict `✅ 4 resolved · 🆕 4 new`, still pinned `3/5`. The "4 new" were the round-1 concerns **re-titled at shifted line numbers**:
  - `:1207` "Catch-and-continue pattern in critical verification" is the *same code* as round-1 `:1225` "Broad exception catching" — which the **same comment** lists under "✅ Resolved on this commit." **One finding reported as both resolved and new in a single review.** [P9]
  - `:1180` "Silent failure in file fetch" = round-1 `:1198` "silent JSON failure" relocated to `fetchFindingFileContents`. [P7]
  - `:1167` "LLM prompt injection in verification prompt" = round-1 `:1061` "code injection in `suggestionAlreadyApplied`" relocated to the prompt. [P1 mis-framing + P7] *(a real defense-in-depth guard was still added — `prompts.ts` data-isolation line, matching `buildConventionsBlock`.)*
  - `:1180` (info) "decompose function" — net-new nitpick. [P5]
  Root cause is exactly the confirmed P9 mechanism: identity key `` `${file}::${title}` `` + line drift on every commit ⇒ old titles "resolved", near-identical concerns "new". **The verdict cannot converge by fixing the PR.** Triage declared round 2 the last reactive round; the fix is W3∩W9 (convergence guard), not more commits.
- **Patterns:** P1 P5 P7 P9 — *Positive Signal: the bounded-concurrency catch was real and worth crediting. This example is now the canonical whack-a-mole / non-convergence demonstration.*

### Example 6 — mergewatch.ai PR #148 (self-review of the W3 PR)

- **Evidence:** `gh pr view 148 --repo mergewatch/mergewatch.ai` · dashboard `…%3A148%23aad15c1`
- **Verdict:** `2/5 — Needs fixes`. **1 critical**, 8 warnings, 1 info. 94,663 tok, ~$0.24, 39.5s. `Suppressed 9`. CHANGES_REQUESTED.
- **Legit (kept honest) — the bot caught a real attack class on its own quality PR:**
  - 🔴 **"Unvalidated triage comments enable prompt injection."** Genuine. `fetchTriageComments` accepted comments from anyone, so a third-party drive-by on a public OSS repo could post `## mergewatch triage` with an injection payload to manipulate suppression on someone else's PR. **Fixed in 90b81a5**: (a) `fetchTriageComments` now takes `prAuthor` and filters by `c.user?.login === prAuthor`, undefined `prAuthor` → `[]` without touching the API (fail-closed); (b) `TRIAGE_MAPPING_PROMPT` carries the same DATA-not-instructions guard the W2 verify prompt added in #145; (c) per-comment + total-prose byte caps. Regression-locked as **E2E-24** + a `triage.test.ts` case that includes an `IGNORE PREVIOUS INSTRUCTIONS` attacker comment.
  - ⚠️ "Unsafe property access on JSON items" — behaviour was already defensively safe via optional chaining; added explicit shape validation (`object` + `typeof index === 'number'` + `typeof disposition === 'string'`) for clarity, locked with a "malformed items" test.
  - ⚠️ "JSDoc misleads about return value" — minor; clarified.
- **What it got wrong:**
  - ⚠️ "ReDoS in `parseDispositionArray` `/\[\s\S]*\]/`" — **same mis-framing as #145's ReDoS finding [P1]**: the regex is linear (no nested quantifier, no catastrophic backtracking). Bound added anyway for codebase consistency, not because a ReDoS exists.
  - ⚠️ "Silent failure in `fetchTriageComments` / `computeDisputedKeys`" — **rebutted**, intentional fail-open documented in the file's own module JSDoc. Same shape as #145's "broad catch" rebuttal — the safe direction is "infra trouble never hides a finding."
  - ⚠️×3 "handler / pipeline integration lacks test coverage" — **rebutted on scope**. The transformation (`partitionDisputed`, `computeDisputedKeys`) is unit-tested through every interesting branch; the inline pipeline call is one-line plumbing whose behaviour is captured by those helpers + E2E-23. Mocking the full handler stack for plumbing is the ceremony `AGENTS.md` de-prioritises. [P5 nagging]
- **Patterns:** P1 P5 — *and a strong Positive Signal: a real critical caught on the bot's own security PR (author-filter gap → prompt-injection). 1 of 1 criticals was real and actionable — exactly the precision goal of the plan.*

### Example 7 — mergewatch.ai PR #148 rounds 3–4 (the "no-exit critical" — P13 canonical case)

- **Evidence:** `gh pr view 148 --repo mergewatch/mergewatch.ai` rounds 3 (`f8a2b98`) + 4 (`1ae92e0`).
- **Stack-wide state at round 4:** #145 APPROVED ✅, #147 COMMENTED ✅, **#148 `MergeWatch Review = FAILURE`, `CHANGES_REQUESTED`** (stuck).
- **What's happening:** the bot re-runs on every commit and posts a fresh `CHANGES_REQUESTED` review pinning a **🔴 Critical** that I've now dispositioned three times ("prompt injection via triage content" — fix is in place: author-filter is the security boundary, prompt-isolation guard is now also tested). The bot itself acknowledges the finding under "↻ Still present (1)" — it carries the same critical across runs but has no path to convert "still present + author-rebutted" into "withdrawn / non-blocking". Round 4's `🆕 9 new` are mostly P5 nitpicks **on code I just added in round 3**: "potential infinite loop" on a literal `for (cut = 0; cut < 4; cut++)`, "magic number 4", "Buffer.byteLength called twice — performance", plus the silent-fail-open and ReDoS findings rebutted 3 times each.
- **Why it's stuck:** there's no in-product way to honor "rebutted with rationale" — that's the W3 we're shipping. And no W7 score guardrail to stop a single un-verified Critical from posting `CHANGES_REQUESTED`. Chicken-and-egg: the fix for this PR's stuckness is *this PR* (W3) plus W7.
- **Unblock options (workflow, not code):** (a) author dismisses the stale `CHANGES_REQUESTED` review on #148 — the human triage convention manifested as the GitHub action it implies; (b) admin bypass merge; (c) merge #145 → #147 → #148 in order and let W3 self-suppress the rebutted critical on the next run (only works once main is deployed with W9+W3 active).
- **Patterns:** P13 (no-exit critical / stuck PR state) — **first observed**. Compounded by P3 (persisted-after-rebuttal), P9 (phantom resolution in earlier rounds via title-keyed delta), P5 (nitpick wave on freshly-added code).

### Example 8 — mergewatch.ai PR #148 (user-spotted Mermaid corruption — distinct from the finding-quality patterns)

- **Evidence:** PR #148 round-4 bot comment had a Mermaid diagram with two corruptions, *neither of which the bot self-reported*:
  - Syntactic delimiters as HTML entities in unquoted positions: `B&lsqb;…&rsqb;`, `--&gt;`, `&lpar;&rpar;`. Mermaid parses these as 6-char literals → no node anchor, no arrow → graph fails to render.
  - Multiple statements glued onto one line with `<br/>` as the separator (`<br/>` is only legal inside a `"…"` label).
- **What's notable:** this was a **rendering bug** in the bot's own output that none of the bot's many reviews on #148 ever flagged — the *user* spotted it. The finding-quality work doesn't cover comment-rendering issues; they need their own E2E coverage.
- **Fix:** PR #149 — new Pass-0 `decodeMermaidOutsideQuotes` in `sanitizeMermaidOutput` (decodes entities + de-glues `<br/>`-joined statements outside `"…"` regions only, so in-label legitimate forms are preserved). DIAGRAM_PROMPT also strengthened: explicitly forbids HTML entities in ANY position and reserves `<br/>` for in-label line breaks only. Regression-locked by extending E2E-15's expected outcomes + failure modes (deduped per the standing instruction — no new card).
- **Patterns:** none of the existing finding-quality patterns apply — this is a **comment-rendering / cosmetic** bug class. Worth noting as a category but not promoting to a tracked pattern unless it recurs.
- **Positive Signal (user):** maintainer-spotted bug not visible in any unit test or in the bot's own self-reviews. Validates that the e2e-fixture runbook (manual verification of actual rendered comments) catches a class of bug pure unit testing cannot.

### Example N — _TBD (template — copy this block)_

- **Evidence:** `<PR link / screenshot path / dashboard URL>`
- **Verdict:** `<score + counters + tokens/cost/latency>`
- **Legit (kept honest):** `<accurate findings — so we don't regress them>`
- **What it got wrong:** `<specifics, quote exact bot text + author rebuttal>`
- **Patterns:** `<P#, …>`

---

## Improvement Workstreams

Prioritized by ROI = (examples prevented) × (severity). Each names the file(s) to change.

### W1 — File-grounded findings + no-op-suggestion guard  ✅ SHIPPED (PR #145) — prevents P1,P2 in #31,#37,#39
**Targets:** `packages/core/src/agents/reviewer.ts`, `packages/core/src/agents/prompts.ts`
> **Decision (maintainer-confirmed):** accept the extra *input* tokens of full-file context — it materially reduces hallucinations (P1/P2). The expensive part (W2 verification) is gated to Criticals only, so net cost stays bounded relative to the cost of one wrong blocking review.
- ✅ `suggestionAlreadyApplied()` + a no-op guard in `groundFinding`: a finding whose suggested code already exists (whitespace-normalized, every code-shaped segment present) is dropped outright. Deterministic, zero LLM cost — kills the #31 case.
- Note: structural grounding already existed but only checked *identifier presence* (the missing-await false positive passed because `migrationRunner(` IS near the anchor). That gap is what W1/W2 close.

### W2 — Critical verification pass  ✅ SHIPPED (PR #145) — prevents P1,P4 in #31,#38,#39
**Targets:** `packages/core/src/agents/reviewer.ts`, `packages/core/src/agents/prompts.ts`
- ✅ `verifyCriticalFindings()`: every surviving Critical is re-checked by the light model against the **complete** file (`CRITICAL_VERIFICATION_PROMPT`). Dropped only on an explicit, parseable `valid:false`.
- ✅ Fail-safe: missing file / LLM error / unparseable output keeps the finding — infra trouble never silently suppresses a real Critical.
- ✅ Decoupled from `codebaseAwareness` via a new always-on `groundingFetch` context (full file fetched once, shared by W1+W2). Per the maintainer decision: full file for every flagged finding.
- Remaining lever (not yet done): run verification on a stronger model than the first-pass reviewer (currently sonnet-4); it only fires on Criticals so cost stays bounded.

### W3 — Honor triage / dispute replies  ✅ SHIPPED (PR #148 stacked, landed via #150) — prevents P3 in #31; half of the convergence guard
**Targets:** `packages/core/src/triage.ts` (new), `reviewer.ts`, both handlers
- ✅ `## mergewatch triage` replies are detected (`isTriageComment`/`fetchTriageComments`) and mapped via one light-model call (`computeDisputedKeys`, `TRIAGE_MAPPING_PROMPT`) onto the prior review's W9 stable keys. Only `rebutted`/`deferred` suppress; `fixed`/`unclear` don't.
- ✅ `partitionDisputed` drops matching current findings before delta + scoring with a `[triage-suppressed]` audit log; they roll into `Suppressed N`.
- ✅ **Fail-open:** no triage / no priors / list failure / LLM error / unparseable → suppress nothing. Only an explicit author disposition hides a finding.
- ✅ **Code-anchored** via the W9 fingerprint: a rebuttal stops applying once the cited code materially changes, so a finding that becomes real again resurfaces (E2E-23 over-suppression regression-check).
- Not done (deliberate, v1 = suppress): a visible **Disputed bucket** in the comment instead of silent suppression — tracked as a follow-up; the triage comment + audit log are the current trail.

### W8 — Location accuracy & reconciliation  ✅ SHIPPED (PR #153) — prevents P8 in #37,#39
**Targets:** `groundFinding` snap in `packages/core/src/agents/reviewer.ts`
- ✅ `findBestAnchorLine` walks every occurrence of every extracted identifier, classifies each as **definition** vs **use** by inspecting the chars immediately before the identifier name (`\b(function|class|interface|type|method|public|private|protected|static)\s+$` ⇒ def; everything else ⇒ use). When at least one use-site exists, definitions are dropped from the pool — a call-site finding anchored at the def line is the canonical P8 failure.
- ✅ Within the chosen pool, picks the occurrence **closest to the LLM's original anchor**. Distance-0 wins ties, so the snap is a no-op when the LLM was already right.
- ✅ Fallback when only def exists: keep the def-line anchor rather than dropping (better signal than nothing).
- ✅ Regression-locked by 4 new tests including the exact PR #39 reproduction (`searchViaPostgres` def at line 1, call at line 4 → snap to 4) + the over-snap regression check (def-only file keeps the def-line anchor).
- Inline-comment line == summary line was confirmed by tracing `buildInlineComments` — already uses `f.line` directly; no drift introduced. Lock-in via the existing client.test.ts cases.

### W9 — Honest counters / no phantom resolution  ✅ SHIPPED (PR #147) — prevents P9 in #39,#145; P7 in #31,#37,#145
**Targets:** `packages/core/src/review-delta.ts`, `reviewer.ts`
- Root cause confirmed & fixed: the old `findingKey()` = `` `${file}::${title}` `` (free-text title). ✅ `fingerprintFromCode` now derives a stable key from the **normalized cited code line** (not title, not line number); persisted on each finding (`fingerprint?`, back-compat, flows through the store JSON).
- ✅ `computeReviewDelta` **union-matches** on fingerprint key OR title key — can only *reduce* spurious resolved/new, never add it, and stays back-compat with pre-W9 stored findings. The duplicate `findingKey` in `reviewer.ts` was removed; security-improvement scoring reuses `computeReviewDelta` (one identity definition).
- ✅ Regression-locked: `review-delta.test.ts` "the whack-a-mole case" reproduces #145 round 2 (catch line unchanged, retitled, line-shifted) ⇒ `carriedOver`, not resolved+new.
- Not done (deliberate): a separate **Withdrawn** vs **Resolved** label in the UI — current behavior keeps unmatched priors in `resolved`; the convergence win is the union-match. Follow-up if the distinction proves needed.

### W10 — Finding consolidation  ✅ SHIPPED (PR #156) — prevents P10 in #37; P5 generally
**Targets:** `packages/core/src/finding-clustering.ts` (new); wired into `runReviewPipeline` after the W11 step
- ✅ `clusterFindings` — pure function, union-find over `(same file, |line distance| ≤ maxLineSpan, ≥ minTokenOverlap shared significant tokens across title + description)`. Transitive: A↔B↔C still groups even without a direct A↔C edge (the #37 lines 82/130/150 daisy-chain via 82↔130 = 48 and 130↔150 = 20 at default `maxLineSpan = 50`).
- ✅ `extractSignificantTokens` — lowercased alphanumeric ≥ 5 chars minus stop words + generic finding-prose vocabulary (*"issue"*, *"potential"*, *"missing"*, *"function"*, *"value"*, *"check"*, …). The 5-char floor avoids Jaccard collisions on generic short tokens.
- ✅ Conservative defaults: `maxLineSpan: 50, minTokenOverlap: 1, maxClusterSize: 5`. Clusters > cap pass through unmerged (over-clustering would hide distinct issues — worse than the noise it eliminates).
- ✅ Merge keeps the strongest severity, the earliest cited line in that severity bucket, and appends a *"Related concerns clustered into this finding (W10)"* block listing each absorbed sibling — full audit trail preserved.
- ✅ Regression-locked by 13 tests including the exact PR #37 reproduction (3 findings → 1 merged, severity warning, anchored at line 82) + the over-cluster regression check (different regions don't merge).

### W11 — Scope & architecture awareness  ✅ SHIPPED (PR #154) — prevents P11 in #37,#38,#39
**Targets:** `packages/core/src/scope-awareness.ts` (new), `prompts.ts` (SHARED_PREAMBLE)
- ✅ **Structural — test-coverage suppression**: `detectNoTestHarness(conventions)` scans the conventions document for explicit declarations (*"No unit test suite currently"*, *"no test harness yet"*, *"tests are out of scope"*, …). When detected, `suppressTestCoverageFindings` collapses N `category: 'test-coverage'` findings into **one** info-level aggregate note anchored at the first finding's file. Conservative — requires an explicit declaration, NOT absence of test files, so casual mentions of "tests" do not trigger. Regression-locked by 8 unit tests.
- ✅ **Prompt-only — layering rule**: SHARED_PREAMBLE now says *"A library / data-access function that correctly THROWS on an error is NOT a bug for 'not handling' errors that belong to the caller. … Flag the actual gap (an UNHANDLED call site) instead."* — targets the orca #38 mis-framing.
- ✅ **Prompt-only — PR-description scope**: SHARED_PREAMBLE now says *"Respect the PR description's stated SCOPE. If the description says a concern is 'out of scope', 'deferred to TX', 'tracked elsewhere', 'follow-up issue …', or 'intentionally not addressed' — and the diff does not introduce or worsen that concern — do NOT raise it as a new finding."* — targets #37/#39 carry-over nags.

### W6 — Single authoritative review comment  ✅ SHIPPED (PR #155) — prevents P6 in #31,#37,#38
**Targets:** `submitPRReview` in `packages/core/src/github/client.ts`; handlers (`review-processor.ts`, `review-agent.ts`)
- ✅ `submitPRReview` now handles GitHub's per-event body constraint internally: APPROVE → body field omitted; REQUEST_CHANGES / COMMENT → an HTML-comment-only stub `<!-- mergewatch-review -->` (GitHub's markdown renderer strips it, so the rendered Review body shows zero visible content; the timeline surfaces only the event label + batched inline comments).
- ✅ Both handlers pass `reviewBody = ''` for every event; the legacy *"🔴 Critical issues found — see the full review in the summary comment above"* / *"🟡 Review recommended …"* stub strings are removed.
- ✅ The HTML-comment stub doubles as the existing `BOT_COMMENT_MARKER` — both surfaces share one identifier so future tooling can find them by a single grep.
- ✅ Regression-locked by 7 unit tests asserting the API payload shape across all three events + the caller-non-empty-body pass-through.

### W12 — One review state transition per run; never empty-body  ⏭ MOSTLY SUBSUMED by W6 (PR #155)
**Targets:** review-submission path in `review-agent.ts` / `review-processor.ts`
- ✅ The "never empty-body" half is now structural: `submitPRReview` (W6) always passes an HTML-comment stub when GitHub's API requires a body and the caller wants nothing visible. There are no empty-body DISMISSED reviews to emit any more.
- ✅ The "at most one Review per run" half is already enforced by `dismissStaleReviews` + the single `submitPRReview` call per run (one `createReview` API call batches all inline comments under one Review event).
- Remaining surface (deferred): the *cosmetic* P12 case where re-reviews on successive commits stack DISMISSED entries in the timeline. Each is correct in isolation; the timeline noise comes from re-running the bot, not from the bot mis-behaving. Not blocking; revisit only if observed as a real complaint.

### W7 — Score guardrail  ✅ SHIPPED (PR #152) — prevents P4 in #31,#38,#39 + P13 in #148
**Targets:** `reconcileMergeScore` in `packages/core/src/agents/reviewer.ts`, `verifyCriticalFindings` (verification tagging), `ReviewFinding.verification` (persisted)
- ✅ `verifyCriticalFindings` now tags each surviving Critical: `verified` on explicit `valid:true`; `unverified` on LLM error / unparseable / no clear verdict (kept fail-safe but couldn't be confirmed); **no tag** when verification was skipped entirely (no file content — preserves legacy behavior for callers without `groundingFetch`).
- ✅ Score reconciliation extracted into a pure `reconcileMergeScore` function so every tier is directly unit-testable. New tier between "net security improvement" and the orchestrator default: when **every** surviving Critical has `verification === 'unverified'` AND `orchestratorScore ≤ 2`, clamp to **3** (= `COMMENT` per `mergeScoreToReviewEvent`). Verified or mixed-with-verified sets still block at the orchestrator's full score.
- ✅ Closes the P13 "no-exit critical" pin observed on #148 rounds 3–4: a Critical the bot itself couldn't confirm no longer posts `CHANGES_REQUESTED`. Combined with W3's triage suppression, P13 is structurally impossible going forward.
- ✅ Regression-locked by 7 reconcileMergeScore tests covering all tier interactions + the verifyCriticalFindings tagging contract.

---

## Priority order (current)

| # | Workstream | Status | Lands via | E2E |
|---|---|---|---|---|
| 1 | **W1** — file-grounded findings + no-op-suggestion guard | ✅ SHIPPED | #145 | E2E-21 |
| 2 | **W2** — claim-aware critical verification pass | ✅ SHIPPED | #145 | E2E-22 |
| 3 | **W9** — stable finding identity (code fingerprint) | ✅ SHIPPED | #147 → #150 | E2E-23 (a) |
| 4 | **W3** — triage-aware convergence guard | ✅ SHIPPED | #148 → #150 | E2E-23 (b), E2E-24 |
| 5 | **W7** — score guardrail (no-exit critical fix) | ✅ SHIPPED | #152 | E2E-25 |
| 6 | **W8** — location accuracy (call-site-preferring snap) | ✅ SHIPPED | #153 | E2E-26 |
| 7 | **W11** — scope/architecture awareness | ✅ SHIPPED | #154 | E2E-27 |
| 8 | **W6** — single authoritative review comment | ✅ SHIPPED | #155 | E2E-28 |
| 9 | **W10** — finding consolidation (clustering) | ✅ SHIPPED | #156 | E2E-29 |
| — | Mermaid sanitizer (user-spotted comment-rendering bug) | ✅ SHIPPED | #149 | E2E-15 (extended) |
| — | **W12** — never empty-body / one review per run | ⏭ SUBSUMED by W6 | #155 | — |

**Net shipped:** every numbered workstream W1–W11 plus the Mermaid sanitizer. The plan started with seven failure patterns (P1–P7); two more (P8, P9) emerged with the first batch of examples; three more (P10–P12) with the next; and the final P13 was discovered live on the bot's own quality PR (#148 rounds 3–4). All thirteen patterns are now either structurally prevented or have a regression-locked fixture in the runbook.

**What's next** isn't another workstream — it's running the e2e suite end-to-end (E2E-01 through E2E-29) against a deployed build to confirm the patterns stay dead on real PRs, and adding new Examples here as more real-world reviews land.

_Re-rank as examples land — the Evidence Index frequency row drives this._

---

## Success metrics (to instrument)

- **False-positive Critical rate** — Criticals withdrawn after triage ÷ total Criticals → ~0.
- **Location accuracy** — findings whose summary/Critical/inline path+line agree *and* match the source snippet ÷ total → ~100%.
- **Counter honesty** — "Resolved" entries whose cited region actually changed ÷ "Resolved" entries → ~100% (catches P9).
- **Triage reconciliation** — disputed findings that get explicit withdraw/counter ÷ disputed → 100%.
- **Finding churn** — "new" findings that are re-surfaced priors ÷ "new" → ~0.
- **Reviews per run** — distinct GitHub Reviews + comments per pipeline run → 1; **empty-body reviews → 0**.
- **Precision retained** — legit findings (the Positive Signals set) still surfaced → no regression.

---

## Open questions — answered (code-traced 2026-05-19)

- **Full file vs. diff?** ✅ Agents get **diff only** (`reviewer.ts` injects `${diff}`). Full-file fetch existed but was opt-in behind `codebaseAwareness`. W2 adds an always-on `groundingFetch` so grounding/verification get the full file regardless. *(W1/W8 plumbing now exists.)*
- **resolved/new/carried key?** ✅ `` `${file}::${title}` `` in `review-delta.ts:36` — `title` is free-text LLM output, so title drift makes one issue count as both "resolved" and "new". **This is the root cause of P9's phantom resolution.** W9 = stable `(file, rule, code-fingerprint)` key.
- **`mergewatch triage` parsed?** ✅ **No** — confirmed not referenced anywhere; only `/resolve` intent (`inline-reply.ts`) is parsed. W3 is greenfield.
- **2–4 reviews per run?** ✅ Mostly expected: one `submitPRReview` per run, prior bot reviews dismissed (one run per commit push). Empty-body DISMISSED entries still need a targeted look — **P12 downgraded** in priority.
- **`Suppressed N` source?** ✅ `totalRawFindings − filteredFindings.length` (`reviewer.ts`): orchestrator cap + grounding + line-proximity. The dedup is a ranking/cap, **not** root-cause clustering — W10 still needs its own consolidation step (cannot reuse as-is).
