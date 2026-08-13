# Goal: Position MergeWatch as the Software Validation Layer for the AI Build Era

> **Status:** Brief / kickoff goal for market research + competitive analysis + strategy + execution planning.
> **Owner:** Santthosh
> **Use:** Hand this document to research/strategy agents as the top-level goal. Every agent should trace its output back to a workstream and deliverable defined here.

---

## North Star

AI is now writing the majority of net-new code. The bottleneck has moved from **writing** software to **trusting** it. MergeWatch's ambition is to own that trust gap — to become the **validation layer** that sits between AI-generated code and production, verifying that what agents ship is correct, safe, and mergeable at machine speed.

We are not "a better PR review bot." We are the **quality gate for autonomous and AI-assisted software development** — the system of record for whether a change is safe to merge, regardless of whether a human or an agent wrote it.

## Strategic Question to Answer

> As code generation becomes cheap and abundant, validation becomes the scarce, high-value layer. **Can MergeWatch credibly own that layer, and what is the sharpest wedge to get there?**

Produce a market research + competitive analysis + strategy document that lets us make a confident go/no-go and sequencing decision on this pivot — and a concrete execution plan to run it.

---

## Research & Planning Workstreams

Workstreams 1–4 run in **parallel**. Workstream 5 runs **after** them and consumes their outcomes.

### 1. Market & Thesis Validation
- Size and characterize the shift: how much code is now AI-generated, growth trajectory, where the trust/validation pain concentrates (velocity, hallucinated code, security regressions, review fatigue).
- Who feels this pain most acutely today, and who will in 12–24 months? Identify the beachhead segment.
- Validate or falsify the core thesis: is "validation" actually becoming the scarce layer, or does it get absorbed by the coding agents themselves (Cursor, Claude Code, Devin, Copilot)?

### 2. Competitive Landscape
- Map the field across adjacent categories: AI code review (CodeRabbit, Greptile, Graphite, Qodo, Bito/Diamond), traditional SAST/quality (Snyk, SonarQube, Semgrep), CI/testing/verification, and agent-native QA/eval tools.
- For each: positioning, wedge, pricing, ICP, funding/momentum, and — critically — **whether they could extend into "validation layer" and how defensible we'd be against that.**
- Identify white space: what does no one credibly own yet?

### 3. Positioning & Differentiation
- Define what "validation layer" means concretely and defensibly (vs. "AI PR review"). What capabilities, integrations, and trust guarantees make it a *layer* rather than a *feature*?
- Articulate the wedge, the moat, and the expansion path (land → expand).
- Draft the one-line category-defining narrative.

### 4. Strategy & GTM Recommendation
- Recommend the sharpest entry wedge and target ICP.
- Sequencing: what to build/keep/drop from today's PR-review product to get to the validation-layer vision.
- Pricing and packaging hypothesis for the new positioning.
- Risks, kill-criteria, and the 2–3 experiments that would most quickly validate or invalidate the pivot.

### 5. Execution Plan (derived from Workstreams 1–4)
- Translate the recommended wedge, ICP, and sequencing into a concrete, phased project plan.
- Every phase must trace back to a strategy outcome — no orphan work.
- Break each phase into task items sized to be actionable (roughly PR- or sprint-sized), each with an owner-type, a definition of done, and a success metric.
- Sequence by dependency and by "fastest path to validating the pivot" — front-load the experiments from Workstream 4.
- Anchor against MergeWatch's real codebase today: what to build, keep, refactor, or retire from the current PR-review product.

---

## Tangible Artifacts (deliverables)

| Artifact | Path | Purpose |
|---|---|---|
| **Strategy doc** | `docs/strategy/validation-layer-pivot.md` | Thesis + evidence, positioning, recommended wedge + GTM, risks, decision |
| **Competitive matrix** | `docs/strategy/competitive-matrix.md` | Sourced comparison across categories + white-space analysis |
| **Positioning one-pager** | `docs/strategy/positioning.md` | Category narrative, wedge, moat, expansion path |
| **Project plan** | `docs/strategy/project-plan.md` | Phased roadmap → milestones → task items, each traced to a strategy outcome |
| **Phase/task backlog** | `docs/strategy/backlog.md` | Flat, checkbox task list (per phase) ready to become GitHub issues/PRs |
| **Decision & experiments** | `docs/strategy/decision.md` | Go/no-go recommendation + next 3 validating experiments with kill-criteria |

---

## Project Plan Shape (what `project-plan.md` should contain)

- **Phase 0 — Validate the thesis:** the cheapest experiments that prove/disprove the pivot before heavy build. (Front-loaded from Workstream 4.)
- **Phase 1 — Beachhead wedge:** the single sharpest capability for the beachhead ICP; the smallest thing that makes MergeWatch a *validation layer* not a *review bot*.
- **Phase 2 — Expand the layer:** capabilities/integrations that turn the wedge into a defensible layer (land → expand).
- **Phase 3 — Category & moat:** what compounds defensibility (data, integrations, trust guarantees) and establishes the category narrative.

Each phase must specify: **goal · task items (checkboxed) · dependencies · success metric · exit criteria.**

---

## Constraints & Guardrails

- Ground claims in real, cited sources — no hand-waving on market size or competitor facts.
- Stay honest about disconfirming evidence (especially the "coding agents eat validation" risk).
- Anchor to MergeWatch's actual assets today — multi-agent review pipeline, GitHub-native, self-host + SaaS, org custom agents (`packages/core/src/agents`, `packages/core/src/org-agents.ts`). The strategy and plan must be **reachable from where we are.**
- Prefer **stacked, PR-sized tasks** consistent with how this repo already ships features.
- Keep phases honest about kill-criteria — the plan should be as ready to *stop* the pivot as to pursue it.
- Every artifact ends with a clear **recommendation and next steps.**

---

## Suggested Execution (how to run the agents)

1. Fan out **Workstreams 1–4 in parallel** (market, competitive, positioning, GTM).
2. Gate on a **synthesis** step that reconciles their findings into the wedge + ICP + sequencing decision.
3. Run **Workstream 5 (execution plan) sequentially** so it consumes the real outcomes.
4. Write all six artifacts to `docs/strategy/`.
5. Adversarially verify the riskiest market claims and the core thesis before finalizing the decision.
