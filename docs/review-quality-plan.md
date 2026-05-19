# Review Quality Improvement Plan

**Status:** Living document — evidence-driven.
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

Pattern frequency (4 examples): **P1×3, P4×3, P5×4, P6×3, P11×3, P12×3**, P2×2, P7×2, P8×2, P3×1, P9×1, P10×1.

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

---

## Positive signals (do NOT regress these)

The goal is **precision, not silence.** Things MergeWatch already does well:

- **Real bugs caught.** #37 `seed.ts:38` (S3 errors unhandled) and `seed.ts:109` (rollback masks original error) were legit — author fixed both.
- **Accurate nit.** #39 `rag.ts:243` "comment describes removed import, not the lazy-load pattern" was correct and actionable — author fixed it.
- **Dedup exists.** #38 reported `Suppressed 4 findings removed by dedup & quality filters` — the machinery is there; it's under-tuned, not absent.
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

### W3 — Honor triage / dispute replies  ★★ (prevents P3 in #31; P9 root cause)
**Targets:** `packages/lambda/src/handlers/review-agent.ts`, `packages/server/src/review-processor.ts`, `reviewer.ts`
- Parse the `## mergewatch triage` reply convention (the author already uses it consistently). Feed rebuttal + disputed finding + file slice into a re-eval before the next review.
- Outcome must be explicit: **withdraw** (not "resolve" — see W9) or post a specific counter-argument. Never silently re-assert.

### W8 — Location accuracy & reconciliation  ★★★ (prevents P8 in #37,#39)
**Targets:** finding→location mapping in `packages/core/src/agents/` + `packages/core/src/github/client.ts`
- Single canonical path per finding (always repo-root-relative, e.g. `packages/voice-bot/src/seed.ts`). Summary table, Critical block, and inline comment must use the **same** path+line for the same finding.
- Resolve the LLM's line guess to a real anchor by matching the quoted code snippet against file contents; if it can't be matched, the finding is low-confidence (downgrade or drop).
- Never cite a function *definition* line for a call-site finding.

### W9 — Honest counters / no phantom resolution  ★★★ (prevents P9 in #39; P7 in #31,#37)
**Targets:** the resolved/new/carried-over diffing logic (locate via `Explore`; agents + review-store comparison)
- A finding may be marked **Resolved** only if the cited code region actually changed *and* it re-evaluates clean. A prior finding that was a false positive becomes **Withdrawn**, not Resolved.
- Stable identity key: `(canonical_path, normalized_rule, code_fingerprint)` — not line number — so a finding doesn't churn new↔carried as lines shift.
- Disputed findings get a **Disputed** bucket, not back to "new."

### W10 — Finding consolidation  ★★ (prevents P10 in #37; P5 generally)
**Targets:** orchestrator dedup in `reviewer.ts` + the `Suppressed … by dedup & quality filters` path (already exists — extend it)
- Cluster findings by (root cause, file region); emit one finding with the strongest severity instead of N fragments (#37's injection/type-assertion/untrusted-JSON were one issue).

### W11 — Scope & architecture awareness  ★★ (prevents P11 in #37,#38,#39)
**Targets:** `packages/core/src/agents/prompts.ts`, `packages/core/src/skip-logic.ts`
- Feed the PR description / linked task plan into the orchestrator. Respect explicit "deferred to T1.8" / "out of scope" statements; downgrade matching findings to non-blocking "tracked."
- Layering rule in prompts: a data-access/library function that *correctly throws* is not a bug for "not handling" errors that belong to the caller. Don't emit design-opinion Criticals.
- Context-aware test-coverage suppression: if the repo has no test harness (deps/script/CLAUDE.md), collapse N "lacks coverage" warnings into one non-blocking note.

### W6 — Single authoritative review comment  ★★ (prevents P6 in #31,#37,#38)
**Targets:** comment formatter + `packages/core/src/github/client.ts` (`<!-- mergewatch-review -->` upsert)
- One upserted summary comment; fold verdict/status into it. Stop posting separate "Critical issues found" stub comments.

### W12 — One review state transition per run; never empty-body  ★★ (prevents P12 in #37,#38,#39)
**Targets:** review-submission path in `review-agent.ts` / `review-processor.ts`
- At most one GitHub *Review* per run. Never submit a review with an empty body (#38 emitted two empty DISMISSED reviews in 3 min). Reuse/transition the existing review instead of stacking.

### W7 — Score guardrail  ★ (prevents P4 in #31,#38,#39)
**Targets:** scoring logic in `reviewer.ts`
- Score may not drop to ≤2/5 on a single Critical that hasn't passed W2 verification or that W11 classifies as design-opinion/deferred.

---

## Priority order (current)

0. ✅ **W1, W2** — SHIPPED in PR #145 (claim-aware grounding + no-op guard; the systemic missing-await false positive from #31/#39).
1. **W8** — location accuracy (P8: same finding cited at 4 places; line points at the function definition).
2. **W9** — stop lying in the counters (phantom "resolved", churn).
3. **W3** — close the loop on author rebuttals (feeds W9).
4. **W11, W7** — scope awareness + score sanity (stops the design-opinion 2/5s).
5. **W6, W10, W12** — noise/clutter polish (preserve the Positive Signals while doing this).

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
