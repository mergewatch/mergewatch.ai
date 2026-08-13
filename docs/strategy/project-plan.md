# Project Plan — Pivot to the Validation Layer

> Companion to [`validation-layer-pivot.md`](./validation-layer-pivot.md). Phased roadmap → milestones → task items, each traced to a strategy outcome.
> **Date:** 2026-07-16 · **Flat checkbox version:** [`backlog.md`](./backlog.md)

## How to read this

Four phases, sequenced by **dependency** and by **fastest path to validating the pivot**. Each phase lists its **goal**, **task items**, **dependencies**, **success metric**, and **exit criteria**. Every phase traces back to a strategy outcome — no orphan work. Phases gate on each other: **do not start Phase 1 until Phase 0's experiment clears its threshold.**

Traceability tags: **[thesis]** = §1 market thesis · **[wedge]** = §3 wedge · **[moat]** = §3 moat · **[product]** = §4 build/keep/drop · **[gtm]** = §5 GTM · **[risk]** = §6 kill-criteria.

---

## Phase 0 — Validate the thesis (cheapest disproving experiments)

**Goal:** Prove or kill the core wedge — *do agent-authored PRs actually fail validation more than human PRs?* — before any heavy build. **[thesis][wedge][risk-3]**

**Task items:**
- Build a **PR provenance classifier (heuristic v0)**: detect human vs. agent authorship from commit trailers, `Co-Authored-By`, bot signatures, IDE metadata. Extends `packages/core/src/skip-logic.ts` patterns. **[wedge]**
- Run **retro provenance analysis** (Experiment 1) on the dogfood repo + 3–5 design-partner repos: classify historical PRs, run the existing pipeline, measure block/critical-finding rate by cohort. **[thesis]**
- Stand up the **provenance-value smoke test** (Experiment 2): landing page positioning "validation gate for AI-generated code" + activation/CTA tracking. **[gtm]**
- Run the **pricing willingness test** (Experiment 3): fake-door 3-tier pricing page to 30–50 ICP contacts. **[gtm]**
- Recruit **3–5 design partners** from the beachhead ICP (30–150 eng, heavy agent adoption). **[gtm]**

**Dependencies:** none — uses existing pipeline and repos.

**Success metric:** Experiment 1 shows agent PRs at **≥1.5× the critical-finding rate** of human PRs; classifier accuracy **≥80%**; smoke-test activation **>8%** of qualified visitors.

**Exit criteria:** Experiment 1 clears its threshold **and** ≥3 design partners committed. If Experiment 1 fails, **STOP** and revisit the wedge (see [`decision.md`](./decision.md) kill-criteria).

---

## Phase 1 — Beachhead wedge: the provenance-aware blocking gate

**Goal:** Ship the smallest thing that makes MergeWatch a *validation layer* not a *review bot* — a required, provenance-aware merge gate that applies differentiated policy to agent PRs. **[wedge][product]**

**Task items:**
- Productize **PR provenance detection** as a first-class signal surfaced on every review (label + score input). **[wedge]**
- Extend **`.mergewatch.yml` into validation policy-as-code**: declarative rules like "agent PRs touching `/payments` require passing security agent + human sign-off." Builds on `org-agents.ts` scope/target/blocking logic (#235). **[wedge][moat]**
- Make **check status + merge-readiness score the primary artifact** (comment demoted to secondary evidence). **[product]**
- Ship **override capture**: instrument accept/dismiss/override on every finding as a labeled signal — the feedback-loop moat starts compounding now. **[moat]**
- **Refactor:** demote style/diagram agents to optional add-ons to sharpen the validation narrative. **[product]**
- **GTM:** publish the Experiment-1 provenance data as a launch post ("we validated N agent PRs, blocked X%"); list/refresh on GitHub Marketplace. **[gtm]**

**Dependencies:** Phase 0 (classifier + validated thesis + design partners).

**Success metric:** ≥3 design partners make MergeWatch a **required status check** on ≥1 protected branch; provenance-differentiated policy blocks real unsafe agent PRs in production.

**Exit criteria:** the gate is load-bearing (required check) for ≥3 orgs and blocking is trusted (no design partner disables it over false-blocks).

---

## Phase 2 — Expand the layer: org rollout, policy graph, evidence

**Goal:** Turn the single-team wedge into an org-wide, defensible layer — the policy graph and the evidence trail that make it sticky. **[moat][product]**

**Task items:**
- **Org policy management** in the dashboard: central authoring of the merge policy across repos/paths/languages; org-over-repo conflict resolution surfaced clearly. **[moat]**
- **Validation audit trail / dashboard**: "what we validated, blocked, and shipped anyway," per merge, exportable. Builds on the reviews table (`prNumber#commitSha`) and time-to-merge work (#194). **[product][moat]**
- **Repo-by-repo rollout tooling**: make it trivial to spread the gate across an org's repos. **[gtm]**
- **Packaging & metering**: implement the hybrid seat + validation-usage model (Team quota + overage); gate the enterprise control plane (policy mgmt, audit, SSO) behind the paid tier. **[gtm]**
- **Sales-assist motion** for the 50+ dev / self-hosted + audit buyer. **[gtm]**

**Dependencies:** Phase 1 (a trusted, required gate to spread).

**Success metric:** first orgs running the gate across **10+ repos**; first **paid** conversions on the new packaging; audit export used by ≥1 buyer in a real compliance context.

**Exit criteria:** ≥1 org has adopted org-wide policy management and is paying; net-revenue retention signals expansion (gate spreads without churn).

---

## Phase 3 — Category & moat: agent governance and durable defensibility

**Goal:** Compound defensibility and establish the category — MergeWatch as the control plane for AI-generated code. **[moat][thesis]**

**Task items:**
- **Agent-governance surface**: treat autonomous coding agents (Cursor, Claude Code, Devin, Copilot) as first-class validated sources; per-agent policy and per-agent track record. **[wedge][thesis]**
- **Verification depth (v1)**: lightweight behavioral signals — "did this PR add tests for what it changed?", diff-coverage checks — moving beyond static critique toward "does the code actually work." (This is the true validation-layer whitespace; scope carefully.) **[product]**
- **Compliance/evidence productization**: SOC 2 / ISO / EU AI Act change-management export as a named enterprise feature. Times with EU AI Act enforcement (Aug 2, 2026). **[moat][thesis]**
- **Broaden the integration surface** beyond GitHub (GitLab/Bitbucket, CI systems, agent frameworks, IDEs) to deepen lock-in. **[moat]**
- **Category narrative push**: own "the neutral, self-hostable validation gate" in content, talks, and ecosystem co-marketing. **[gtm]**

**Dependencies:** Phase 2 (paying orgs, policy graph, evidence trail in place).

**Success metric:** MergeWatch cited/positioned as a distinct category ("validation gate") by customers and analysts; multi-product / multi-repo adoption is the norm among paying orgs; measurable feedback-loop precision advantage from accumulated override data.

**Exit criteria:** durable moats demonstrably compounding (policy graph depth, evidence usage, cross-agent coverage, override-driven precision) and a defensible position vs. the three ranked threats.

---

## Sequencing at a glance

```
Phase 0  ──(gate: Exp-1 ≥1.5×)──▶  Phase 1  ──(gate: required check @ ≥3 orgs)──▶  Phase 2  ──(gate: paying + org-wide)──▶  Phase 3
Validate                           Wedge                                           Expand                                    Category & moat
```

**Front-loaded principle:** Phase 0 is deliberately the fastest, cheapest phase and carries the highest kill-power. Everything expensive lives behind a passed experiment.
