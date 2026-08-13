# Catch-Up Plan — Closing the Gap vs. the Top 3

> Companion to [`feature-gap.md`](./feature-gap.md). A detailed, phased task list to close the gaps vs. CodeRabbit, GitHub Copilot code review, and Qodo — sequenced by **wedge-alignment**, not blind parity.
> **Date:** 2026-07-17 · **Strategy anchor:** [`validation-layer-pivot.md`](./validation-layer-pivot.md)

## Guiding principle

**Don't chase feature parity — close the gaps that convert "AI reviewer" into "validation gate of record," and defend the leads that make us defensible.** Every phase below is ordered so that wedge-reinforcing gaps (deterministic validation, enterprise trust, the feedback-loop moat) come before reach-expanding gaps (IDE, CLI, multi-platform).

**Leads to protect throughout** (never regress these): blocking merge gate · open/unpaywalled self-host + BYO-model + air-gapped · agent-provenance detection · FP discipline · analytics depth.

**Phase mapping to the strategy roadmap** ([`project-plan.md`](./project-plan.md)): Phase C1 ≈ Phase 1 (beachhead wedge), C2 ≈ Phase 2 (expand the layer), C3–C4 ≈ Phase 3 (category & moat). Gate each catch-up phase behind the strategy phase's exit criteria.

Each task is tagged with the gap it closes (`#N` from [`feature-gap.md`](./feature-gap.md)) and sized ≈ one PR/sprint unit. Effort: **S** (≤1 wk) · **M** (1–3 wk) · **L** (3–6 wk) · **XL** (quarter).

---

## Phase C1 — Table-stakes credibility + first deterministic signal
**Goal:** Stop reading as "less finished," and land the first deterministic validation signal that differentiates the gate. **Gate behind strategy Phase 1.**

- [ ] **Committable one-click suggested fixes** `#7` — convert the prose `suggestion` field into GitHub committable `suggestion` blocks on inline comments; only for verified (W2) findings. **M** 🔴
- [ ] **Incremental review** `#14` — review only the new-commit delta on re-review instead of re-running all agents on the full diff; reuse existing delta-tracking (`review-delta.ts`) to scope agent input. Cuts cost/latency at agent-PR volume. **L** 🟠
- [ ] **Bundle Semgrep as a deterministic validation signal** `#15` — run Semgrep on changed files, normalize findings into the finding schema, feed into the merge score + blocking gate. First proof of "LLM + deterministic evidence." **L** 🔴
- [ ] **Bundle secret scanning (Gitleaks/TruffleHog)** `#16` — scan the diff for secrets; a hit is a blocking-by-default validation failure. **M** 🔴
- [ ] **PR walkthrough table** `#4` — upgrade the prose summary to a file-by-file changes table (parity with CodeRabbit/Qodo `/describe`). **S** 🟠
- [ ] **Expand the command set** `#9` — add `@mergewatch describe`, `@mergewatch improve` (surface fixes), align naming with user expectations from CodeRabbit/Qodo. **S** 🟠

**Exit criteria:** committable fixes shipped; Semgrep + secret findings flow into the gate and block on critical; incremental review live and measurably cheaper. **Success metric:** review cost/PR down ≥30% on re-reviews; ≥1 real secret/SAST finding blocked in a design-partner repo.

---

## Phase C2 — Enterprise trust + deterministic depth (unlock the ICP)
**Goal:** Make MergeWatch procurable by the regulated mid-market beachhead and complete the deterministic-validation story. **Gate behind strategy Phase 2.**

- [ ] **SOC 2 Type II** `#29` — begin the audit (Vanta/Drata-style continuous evidence); the single biggest procurement unlock for the ICP. **XL** (external, start early) 🔴
- [ ] **SSO / SAML** `#29` — enterprise auth for the dashboard. **L** 🔴
- [ ] **RBAC** `#29` — roles for org policy admin vs. viewer vs. member. **M** 🔴
- [ ] **SCA / dependency scanning (OSV-Scanner/Trivy)** `#17` — flag vulnerable/hallucinated dependencies ("slopsquatting" defense) as a validation signal. **M** 🟠
- [ ] **Sandboxed custom pre-merge checks** `#19` — extend blocking custom agents to run sandboxed shell commands / project tests (not just LLM prompts); matches CodeRabbit's agentic checks. **XL** 🟠
- [ ] **Ticket/requirement compliance** `#21` — validate a PR against its linked Jira/Linear/GitHub issue; surface non-compliance as a gate signal. **L** 🟠
- [ ] **Compliance/audit evidence export** `#22` — export the per-merge validation record (what was checked, verdict, policies, evidence) for SOC 2/ISO/EU AI Act change-management. Builds on the reviews table + TTM (#194). **L** 🟠

**Exit criteria:** SOC 2 audit in progress + SSO/RBAC shipped; SCA live; at least one enterprise-grade validation evidence export usable in a real compliance context. **Success metric:** first regulated-mid-market design partner passes procurement; audit export used by ≥1 buyer.

---

## Phase C3 — The feedback-loop moat + context depth
**Goal:** Build the compounding differentiators — learning from feedback and deeper repo understanding. **Gate behind strategy Phase 3.**

- [ ] **Override/feedback capture (moat foundation)** `#10` — instrument every accept/dismiss/`/resolve`/override as a labeled signal (partly present via `finding_dispositions`; make it a first-class mechanic). Prereq for learnings. **M** 🔴
- [ ] **Learnings / memory engine** `#10` — aggregate accepted/dismissed patterns per org/repo and feed them back into agent prompts (MergeWatch's answer to CodeRabbit "learnings" / Qodo "auto best-practices"). Reinforces the feedback-loop moat from the strategy. **XL** 🔴
- [ ] **Whole-repo context / lightweight index** `#13` — persistent per-repo index for cross-file reasoning, beyond on-demand file fetch; improves correctness on large PRs. **XL** 🟠
- [ ] **Test-generation / behavior-coverage signal (v1)** `#12` — "did this PR add tests for what it changed?" → optionally generate a candidate test and verify it runs/increases coverage (Qodo Cover's differentiator; scope tightly as a validation signal, not a full test-gen product). **XL** 🟠
- [ ] **Agentic fix handoff** `#11` — hand a finding to a coding agent (Claude Code/Cursor/Copilot) to auto-open a fix PR; ride the agent ecosystem. **L** 🟠

**Exit criteria:** override data driving measurable review precision improvement; learnings applied in production; a behavior-coverage signal feeding the gate. **Success metric:** demonstrable FP-rate reduction from learnings; feedback-loop precision advantage visible in analytics.

---

## Phase C4 — Reach (defer until wedge is won)
**Goal:** Expand surface area and TAM *after* the validation-gate position is established. Explicitly deferred — off the core wedge.

- [ ] **IDE extension (VS Code / Cursor)** `#23` — local pre-PR validation; MCP server partially covers this today, so lower urgency. **XL** 🔴 (deferred)
- [ ] **CLI local review** `#24` — terminal/agent-mode self-review, JSON output for agent loops. **L** (deferred)
- [ ] **GitLab support** `#25` — first non-GitHub platform; abstract the GitHub client behind the existing provider interfaces. **XL** (deferred)
- [ ] **Bitbucket / Azure DevOps** `#25` — follow GitLab. **XL** (deferred)

**Exit criteria:** none gating — pursue opportunistically once C1–C3 land and the ICP is proven. Note: Copilot is also GitHub-only, so multi-platform is not urgent against the platform threat.

---

## What we deliberately are NOT doing (and why)

- **Not chasing CodeRabbit's ~50 bundled linters wholesale.** Bundle the few that produce *gate-worthy* signals (Semgrep, Gitleaks/TruffleHog, OSV-Scanner/Trivy). Breadth-for-breadth is off-wedge.
- **Not positioning on "multi-agent pipeline."** Qodo 2.0 has the same architecture. Position on the gate + provenance + open neutrality instead.
- **Not building a full test-generation product.** Take only the behavior-coverage *validation signal*, not a Qodo-Cover competitor.
- **Not prioritizing IDE/CLI/multi-platform early.** They power CodeRabbit's PLG but don't advance "the merge gate of record."

---

## Sequencing at a glance

```
C1 Table-stakes + first deterministic signal   →  C2 Enterprise trust + deterministic depth  →  C3 Feedback-loop moat + context  →  C4 Reach (deferred)
   committable fixes, Semgrep, secrets,            SOC2/SSO/RBAC, SCA, sandboxed checks,          learnings, index, coverage,          IDE, CLI, GitLab,
   incremental, walkthrough                        ticket compliance, audit export                agentic handoff                      Bitbucket/Azure
   (≈ strategy Phase 1)                            (≈ strategy Phase 2)                           (≈ strategy Phase 3)                 (post-wedge)
```

**Bottom line:** MergeWatch's core review quality is already competitive and its wedge features (blocking gate, open neutrality, provenance detection) are *ahead*. The catch-up work is real but bounded — close the deterministic-validation, enterprise-trust, and feedback-loop gaps first; defer the reach/ecosystem gaps that don't serve the validation-layer wedge.
