# Decision & Validating Experiments

> Companion to [`validation-layer-pivot.md`](./validation-layer-pivot.md). Go/no-go recommendation + the experiments that de-risk the pivot before heavy build.
> **Date:** 2026-07-16 · **Status:** For decision

---

## Recommendation: **GO — validate then build**

Pivot MergeWatch's narrative and product toward the **neutral, self-hostable, provenance-aware validation gate**, but do **not** open with heavy build. The thesis is well-supported and the wedge is defensible, yet the space is contested by better-funded incumbents (CodeRabbit $550M, Qodo $120M) and a platform threat (GitHub Copilot native review). The correct sequence is to run the cheapest disproving experiment first, then build only what the evidence justifies.

### Why GO
- **Thesis SUPPORTED (with a live threat):** AI writes ~40–50% of net-new code; review time up 91% on high-AI teams; 45% of AI code fails security tests; trust *falling* as usage rises; >$1.2B flowing to standalone verification. The pain is real, quantified, and concentrated at the merge chokepoint.
- **Defensible wedge exists:** neutrality + deployment flexibility + policy-gating + evidence is what a self-reviewing generator and a SaaS-only incumbent structurally *cannot* offer.
- **~70% already built:** the blocking org-custom-agent gate (#235), Check Runs, and the 1–5 merge-readiness score are shipped. This is a productization, not a rebuild.

### Why not "GO, full build"
- "Validation layer" as a phrase is the most contested narrative in dev tools right now; we win on substance, not by out-marketing $550M.
- The single biggest thesis risk — *do agent PRs actually fail validation more than human PRs?* — is cheaply testable and, if false, collapses the wedge. Test it before building it.

---

## The next 3 experiments (in priority order)

### Experiment 1 — Retro provenance analysis *(run this first — it's the cheapest and the thesis hinges on it)*
- **Hypothesis:** agent-authored PRs fail validation materially more than human-authored PRs.
- **Method:** classify historical PRs on our dogfood repo + 3–5 design-partner repos by authorship (commit trailers, `Co-Authored-By`, bot signatures), run the existing pipeline, measure block/critical-finding rate by cohort.
- **Success metric:** agent PRs show **≥1.5× higher critical-finding rate** than human PRs.
- **Effort:** ~1 week (scripting over existing agents + provenance heuristics).
- **Why first:** if agent PRs *don't* fail more, the entire wedge collapses — before any build. If they do, we get both proof *and* the killer marketing stat ("we validated N agent PRs and blocked X% for security flaws").
- **Kill signal:** critical-finding rates are statistically indistinguishable across cohorts.

### Experiment 2 — Provenance-value smoke test
- **Hypothesis:** teams will pay for a stricter gate specifically on agent-authored PRs.
- **Method:** landing page + demo positioning MergeWatch as "the validation gate for AI-generated code"; drive traffic from HN/GitHub Marketplace; measure install→activation and a "Book Enterprise" CTA.
- **Success metric:** **>8% of qualified visitors install or book** *(est.)*.
- **Effort:** ~1 week (copy + existing product, no new build).
- **Kill signal:** activation far below generic-review benchmarks — the provenance framing doesn't move buyers.

### Experiment 3 — Pricing willingness test
- **Hypothesis:** the hybrid seat + validation-usage model clears vs. flat-seat incumbents.
- **Method:** Van Westendorp / fake-door pricing page with the three tiers shown to 30–50 ICP contacts.
- **Success metric:** **>50% find the Team tier "acceptable value" and <30% flag usage-billing as a dealbreaker.**
- **Effort:** ~3–4 days.
- **Kill signal:** usage-on-top-of-seats triggers the same backlash Greptile's per-review pricing drew.

---

## Risks & kill-criteria

| # | Risk | Kill-criterion (stop signal) |
|---|---|---|
| 1 | **Coding agents absorb validation** (already partial — Copilot ships native review free) | In a customer sample, >40% say native agent self-review is "good enough" and drop/refuse independent validation within 2 quarters |
| 2 | **Market too crowded / commoditized** (race to the bottom on price) | CAC exceeds 12-month gross margin per customer for 2 consecutive quarters with no provenance-driven win-rate lift over generic reviewers |
| 3 | **Provenance signal weak / gameable** | Classifier accuracy <80% on real customer PR streams after reasonable effort |
| 4 | **Buyers won't pay usage on top of seats** | >30% of Team accounts hit their quota and churn/downgrade rather than expand |
| 5 | **Enterprise motion too heavy for a small team** | Enterprise sales cycle median >6 months with <20% close rate after 10 qualified opportunities |

---

## Decision gate

**Proceed to [Phase 0 of the project plan](./project-plan.md) immediately** (it *is* Experiment 1 plus provenance detection). Gate the Phase 1 build on Experiment 1 clearing its ≥1.5× threshold. If Experiment 1 fails, stop and revisit the wedge — do not spend build cycles on a differentiator the data doesn't support.
