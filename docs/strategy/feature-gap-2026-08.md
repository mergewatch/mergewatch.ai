# Feature Gap Refresh — August 2026

> Supersedes the competitor-facing portions of [`feature-gap.md`](./feature-gap.md) (2026-07-17). Adds **Greptile** and **Macroscope** as first-class comparators, updates CodeRabbit/Qodo/Copilot to their Aug-2026 state, and maps every gap to a scheduled weekly release. Tracking issue: [#304](https://github.com/mergewatch/mergewatch.ai/issues/304).
> **Date:** 2026-08-13 · **Sources:** vendor sites/docs/changelogs fetched 2026-08-13 (research briefs in the issue bodies); MergeWatch capabilities from this codebase.

---

## Executive read

The July conclusion still holds — **MergeWatch is behind on surface area, ahead on the wedge** — but the market moved in four ways that change the catch-up ordering:

1. **The review→fix closed loop became table stakes.** Greptile ("Fix with your Agent" → Claude Code/Cursor/Codex/Devin, auto-resolve), Qodo (fixer agent + agent-ready prompts per finding + `qodo-pr-resolver` skill), Macroscope (Fix It For Me: fix branch, CI retry, optional auto-merge), Copilot (dispatch coding agent), CodeRabbit (autofix, stacked fix PRs). A reviewer that only comments now reads as dated. *(→ R5, #282/#283)*
2. **Qodo went all-in on review.** Qodo 2.0 killed code generation, deprecated Qodo Gen's autocomplete, archived Qodo Cover, and demoted open-source PR-Agent to "community-maintained legacy." This validates the standalone review-platform market — and leaves **actively-maintained open source** as an open lane MergeWatch now occupies almost alone.
3. **Macroscope is a real fourth player, not an analytics tool.** AST + codebase-graph review for 10 languages, auto-approval of ~40% of AI-written PRs, user-authored *blocking* Check Run Agents with per-agent model/budget choice, ticket-aware review, and pure usage-based pricing. Its gaps are exactly our leads: GitHub-only, SaaS-only, no BYO-LLM, and culturally-risky productivity surveillance metrics.
4. **Provenance is no longer entirely unclaimed.** Greptile's *model inversion* (detect which coding agent authored the PR, review with a different model family) and CodeRabbit's *slop detection* are the first adjacent moves. MergeWatch still has the only provenance-*policy* surface (stricter gates for agent PRs), but the window to own the narrative is narrowing. *(→ R9, #289/#290)*

**Leads that still hold (defend while shipping):** blocking merge gate · open, unpaywalled self-host + BYO-model + air-gapped (CodeRabbit self-host: Enterprise/500-seat min; Greptile self-host: Enterprise annual contract; Qodo on-prem/BYOK: Enterprise; Macroscope: none) · provenance detection · FP discipline (W2/W9/FP passes) · analytics depth.

**Lead that is eroding:** the merge-readiness score is no longer unique — Greptile posts a 5/5 rating (optionally as a status check) and Macroscope has blocking-severity thresholds. The score must become the *evidence-backed* verdict (deterministic signals, R3–R4) to stay differentiated.

---

## Updated gap matrix (5 comparators)

Legend: ✅ has it · 🟡 partial · ❌ missing. MW column shows MergeWatch today.

| # | Capability | MW | CodeRabbit | Copilot | Qodo 2.x | Greptile v5 | Macroscope | Plan |
|---|---|---|---|---|---|---|---|---|
| 1 | Multi-category LLM review | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| 2 | Merge-readiness score | ✅ 1–5 | 🟡 | ❌ | 🟡 effort | ✅ 5/5 + check | 🟡 severity gate | defend via R3–R4 |
| 3 | Committable one-click fixes | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | **R1 #273** |
| 4 | Rich walkthrough / PR description | 🟡 prose | ✅ | ✅ | ✅ | ✅ | ✅ | **R1 #274** |
| 5 | Command set breadth | 🟡 3 cmds | ✅ | 🟡 | ✅ | 🟡 | 🟡 | **R1 #275** |
| 6 | Incremental review | ❌ | ✅ | ✅ | 🟡 | ✅ opt | ✅ | **R2 #276** |
| 7 | Review intensity profiles | 🟡 primitives | ✅ 3 profiles | ❌ | ✅ effort mode | ✅ strictness 1–3 | ✅ 2 modes | **R2 #277** |
| 8 | Bundled SAST | ❌ | ✅ 50+ tools | 🟡 CodeQL | 🟡 | ✅ Security Agent | 🟡 | **R3 #278** |
| 9 | Secret scanning | ❌ | ✅ | ✅ | 🟡 | ✅ | 🟡 | **R3 #279** |
| 10 | SCA / dependency scanning | ❌ | ✅ OSV/Trivy | ✅ Dependabot | 🟡 | ✅ | 🟡 | **R4 #280** |
| 11 | Agentic fix handoff | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | **R5 #282** |
| 12 | Auto-fix PRs | ❌ | ✅ | ✅ | ✅ fixer | 🟡 via agents | ✅ + CI retry | **R5 #283** |
| 13 | Feedback capture (👍/👎, addressed) | 🟡 dispositions | ✅ | ❌ | ✅ | ✅ | ✅ | **R6 #284** |
| 14 | Adaptive noise suppression | ❌ | 🟡 | ❌ | 🟡 judge | ✅ measured | ✅ auto-tune | **R6 #285** |
| 15 | Learnings / memory | ❌ conventions | ✅ full product | ❌ | ✅ Rule Miner | ✅ auto-rules | 🟡 | **R7 #286/#287** |
| 16 | Agent-rule-file ingestion (CLAUDE.md…) | 🟡 conventions | ✅ 10+ formats | ✅ | ✅ auto-import | ✅ auto-detect | 🟡 | **R7 #253** |
| 17 | Ticket compliance (Jira/Linear/…) | ❌ | ✅ | ❌ | ✅ 6 trackers | ✅ | ✅ | **R8 #288** |
| 18 | Auto-approve low-risk PRs | ❌ | ❌ | ❌ | 🟡 self-review | ✅ beta | ✅ ~40% of AI PRs | **R9 #289** |
| 19 | Provenance detection + policy | ✅ unique | 🟡 slop detect | ❌ | ❌ | 🟡 model inversion | ❌ | **R9 #290** deepen |
| 20 | Whole-repo context index | 🟡 on-demand | ✅ codegraph | ❌ | ✅ context engine | ✅ graph | ✅ AST+graph | **R10 #291** |
| 21 | Cross-repo impact | ❌ | 🟡 linked repos | ❌ | ✅ auto-discovery | ✅ clusters (7) | ❌ | **R10 #292** |
| 22 | SSO/SAML + RBAC | ❌ | ✅ Ent | ✅ | ✅ Ent | ✅ Ent | 🟡 | **R11 #293/#294** |
| 23 | Audit/evidence export | 🟡 records | 🟡 audit logs | ❌ | 🟡 | 🟡 | ❌ | **R11 #295** (own it) |
| 24 | CLI local review | ❌ | ✅ + agent mode | 🟡 | ✅ | ✅ | ✅ autoloop | **R12 #296** |
| 25 | Scheduled reports | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ digests | **R12 #297** |
| 26 | Slack surface | ❌ | ✅ agent | ❌ | ❌ | ❌ | ✅ agent | **R12 #298** |
| 27 | Sandboxed checks / test execution | ❌ | ✅ sandbox | ❌ | ❌ | ✅ TREX | ✅ check agents | backlog #299/#300 |
| 28 | SOC 2 | ❌ | ✅ II | ✅ | ✅ II | ✅ II | ✅ II | backlog #301 |
| 29 | IDE extension | ❌ MCP only | ✅ | ✅ | ✅ | 🟡 plugins | 🟡 CLI plugins | backlog #302 |
| 30 | Multi-platform (GitLab+) | ❌ | ✅ 7 | ❌ | ✅ 5+Gerrit | ✅ GitLab | ❌ | backlog #303 |
| 31 | Open-source, unpaywalled self-host + BYO-LLM | ✅ **unique** | ❌ | ❌ | 🟡 legacy OSS | ❌ | ❌ | defend |
| 32 | Blocking merge gate | ✅ | ✅ | ❌ | 🟡 | 🟡 check | ✅ | defend |

---

## Weekly release plan (one release per week)

Full issue specs live on each issue; master tracker is [#304](https://github.com/mergewatch/mergewatch.ai/issues/304).

| Release | Due | Theme | Issues |
|---|---|---|---|
| **R1** | Aug 22 | Table-stakes review UX | #273 · #274 · #275 |
| **R2** | Aug 29 | Incremental review + profiles | #276 · #277 |
| **R3** | Sep 5 | Deterministic signals I | #278 · #279 |
| **R4** | Sep 12 | Deterministic signals II | #280 · #281 |
| **R5** | Sep 19 | Fix loop | #282 · #283 |
| **R6** | Sep 26 | Feedback capture + noise learning | #284 · #285 |
| **R7** | Oct 3 | Learnings engine | #286 · #287 · #253 |
| **R8** | Oct 10 | Ticket compliance | #288 |
| **R9** | Oct 17 | Provenance moat | #289 (supersedes #272) · #290 |
| **R10** | Oct 24 | Context depth | #291 · #292 |
| **R11** | Oct 31 | Enterprise trust | #293 · #294 · #295 |
| **R12** | Nov 7 | Reach & reporting | #296 · #297 · #298 |
| Backlog | — | Deferred | #299 · #300 · #301 · #302 · #303 |

**Sequencing rationale** (unchanged from [`catch-up-plan.md`](./catch-up-plan.md), re-cut for weekly cadence): table-stakes credibility first, then the deterministic evidence that makes the gate defensible, then the fix loop the market now expects, then the feedback/learnings moat, compliance surfaces, provenance differentiation, context depth, and reach last. Big rocks (index, learnings, SSO) will span more than a week of build time — the milestone marks the release that *ships* them; start early.

---

## Competitor deltas since 2026-07-17 (summary)

- **CodeRabbit** ($143M raised; 17K customers claimed): Change Stack semantic diff navigation, PR Triage queue, post-merge actions, slop detection (early access), Slack/Discord agents, Security add-on ($40/user/mo), learnings dashboard + API, Agent Skills. Self-host still Enterprise-only, 500-seat minimum.
- **Qodo** (2.x): consolidated into a single review platform; cross-repo breaking-change detection with auto-discovered typed relationship graph; Rule Miner + rule health/decay analytics; fixer agent; spec-document and Figma design-drift review agents (previews); credit-based pricing (~$0.83–1.67/review). PR-Agent open source is stagnating.
- **Greptile** (v5, Aug 2026): parallel agent swarm (2:25 median review), TREX sandbox test execution (public beta), Security Agent on by default, auto-approve beta, model inversion (experimental), free single-dev tier, `.greptile/` cascading monorepo config, Claude Code plugin in the official marketplace.
- **Macroscope** (new comparator): see executive read; notable additionally — `.macroscope/check-run-agents/*.md` user-authored agentic checks with model/budget/`waitsFor` CI deps, Macros (scheduled/evented automations), BigQuery/Sentry/PostHog/LaunchDarkly context reach, $0.05/KB-diff pricing.
- **Field baseline** (Copilot, Bugbot, Graphite Agent, Ellipsis, Sourcery, Baz, Korbit): committable fixes, conversational follow-up, codebase-wide context, learning-from-feedback, and free-for-OSS are now the de facto 2026 baseline; usage-based pricing is displacing per-seat; review is merging into workflow platforms (Graphite) and agent ecosystems (everyone).

## What we are deliberately NOT chasing (unchanged)

- CodeRabbit's 50-linter breadth — only gate-worthy scanners (Semgrep, Gitleaks, OSV).
- A full test-generation product — behavior-coverage as a *signal* only (#300).
- IDE/multi-platform reach before the wedge is won (#302/#303 deferred).
- Engineering-productivity surveillance metrics (Macroscope's "Clickety Clack Score") — off-brand for a neutral validator; our analytics stay review/validation-scoped.
