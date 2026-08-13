# Backlog — Validation-Layer Pivot

> Flat, checkbox task list per phase, ready to become GitHub issues/PRs. Derived from [`project-plan.md`](./project-plan.md).
> **Date:** 2026-07-16. Tags: `[wedge] [moat] [product] [gtm] [thesis] [risk]` trace each task to a strategy outcome.
> **Convention:** each unchecked box ≈ one PR- or sprint-sized unit, consistent with how this repo ships (stacked PRs, RUNBOOK scenarios).

---

## Phase 0 — Validate the thesis  ⛔ gates Phase 1

- [ ] Build PR provenance classifier v0 (heuristic: commit trailers, `Co-Authored-By`, bot signatures, IDE metadata) in `packages/core` `[wedge]`
- [ ] Add unit tests + accuracy harness for the classifier against a labeled PR sample `[wedge][risk]`
- [ ] **Experiment 1:** retro provenance analysis — classify historical PRs on dogfood + design-partner repos, run existing pipeline, measure critical-finding rate by cohort `[thesis]`
- [ ] Write up Experiment 1 results; check the **≥1.5× critical-finding-rate** threshold `[thesis]`
- [ ] **Experiment 2:** build landing page ("validation gate for AI-generated code") + activation/CTA tracking `[gtm]`
- [ ] **Experiment 3:** fake-door 3-tier pricing page; run Van Westendorp with 30–50 ICP contacts `[gtm]`
- [ ] Recruit 3–5 design partners from beachhead ICP (30–150 eng, heavy agent adoption) `[gtm]`
- [ ] **Phase gate:** confirm Exp-1 ≥1.5×, classifier ≥80%, ≥3 partners committed — else STOP & revisit wedge `[risk]`

## Phase 1 — Beachhead wedge: provenance-aware blocking gate  ⛔ gates Phase 2

- [ ] Productize provenance detection as a first-class signal on every review (label + score input) `[wedge]`
- [ ] Extend `.mergewatch.yml` schema for validation policy-as-code (per-provenance, per-path rules) `[wedge][moat]`
- [ ] Wire differentiated policy into the blocking gate via `org-agents.ts` (stricter for agent PRs) `[wedge]`
- [ ] Make Check status + merge-readiness score the primary artifact; demote comment to secondary evidence `[product]`
- [ ] Ship override capture: instrument accept/dismiss/override as labeled signals + storage `[moat]`
- [ ] Refactor style/diagram agents into optional add-ons `[product]`
- [ ] Update docs/RUNBOOK with provenance-gate scenarios `[product]`
- [ ] Launch post publishing Experiment-1 provenance data ("validated N agent PRs, blocked X%") `[gtm]`
- [ ] Refresh GitHub Marketplace listing around the validation-gate positioning `[gtm]`
- [ ] **Phase gate:** ≥3 orgs run MergeWatch as a required check; blocking trusted (no false-block disables) `[risk]`

## Phase 2 — Expand the layer: policy graph + evidence  ⛔ gates Phase 3

- [ ] Dashboard: org-wide policy management (author rules across repos/paths/languages) `[moat]`
- [ ] Surface org-over-repo conflict resolution clearly in the dashboard `[moat]`
- [ ] Validation audit trail/dashboard: per-merge "validated / blocked / shipped anyway," exportable `[product][moat]`
- [ ] Build on reviews table (`prNumber#commitSha`) + time-to-merge (#194) for the evidence surface `[product]`
- [ ] Repo-by-repo rollout tooling (bulk-enable the gate across an org) `[gtm]`
- [ ] Implement hybrid seat + validation-usage metering (Team quota + overage) `[gtm]`
- [ ] Gate enterprise control plane (policy mgmt, audit, SSO) behind paid tier (open-core split) `[gtm][moat]`
- [ ] Stand up sales-assist motion for 50+ dev / self-hosted + audit buyer `[gtm]`
- [ ] **Phase gate:** ≥1 org running the gate across 10+ repos + first paid conversions `[risk]`

## Phase 3 — Category & moat: agent governance

- [ ] Agent-governance surface: per-agent policy + per-agent track record for Cursor/Claude Code/Devin/Copilot `[wedge][thesis]`
- [ ] Verification depth v1: "did this PR add tests for what it changed?" + diff-coverage checks `[product]`
- [ ] Compliance export as a named enterprise feature (SOC 2 / ISO / EU AI Act change-management) `[moat][thesis]`
- [ ] Broaden integration surface beyond GitHub (GitLab/Bitbucket, CI, agent frameworks, IDEs) `[moat]`
- [ ] Category narrative push: content/talks/ecosystem co-marketing around "the neutral, self-hostable validation gate" `[gtm]`
- [ ] Measure feedback-loop precision advantage from accumulated override data `[moat]`

---

### Notes
- **Do not start a phase until the prior phase's gate passes.** The Phase 0 gate is the highest-leverage checkpoint — it can kill the pivot cheaply.
- Price points, quotas, and classifier thresholds are estimates pending the Phase 0 experiments (see [`decision.md`](./decision.md)).
- Keep dogfooding: this repo's own `.mergewatch.yml` should adopt each new capability first.
