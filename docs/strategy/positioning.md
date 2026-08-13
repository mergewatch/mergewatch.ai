# Positioning One-Pager

> Companion to [`validation-layer-pivot.md`](./validation-layer-pivot.md). Category narrative, wedge, moat, expansion path.
> **Date:** 2026-07-16

---

## The category statement

> **MergeWatch is the software validation layer for the AI build era — the neutral, self-hostable gate that decides what's safe to merge, for code written by humans or agents.**

Reinforced with the "merge gate of record" idea: MergeWatch doesn't just check a change — it **blocks** it, **records why**, and can **prove it later**.

## The 100-word positioning statement

> Software is now written as much by agents as by engineers, and merge volume is outpacing anyone's ability to review it by hand. MergeWatch is the **software validation layer for the AI build era** — the required gate that decides whether a change is safe to merge, regardless of whether a human or an AI agent wrote it. It enforces your organization's policy on every pull request, blocks what doesn't pass, and records a durable, auditable verdict for every change. Not a review bot that leaves comments — the system of record for *"is this safe to ship."* MergeWatch is where code earns the right to merge.

---

## Review vs. validation — the load-bearing distinction

**"AI PR review" is a feature. A "validation layer" is infrastructure the pipeline depends on.** The difference is authority, statefulness, and coverage — not comment quality. Five concrete properties turn MergeWatch from a bot into a layer:

1. **Gating authority (the merge gate).** A *required, blocking* status check on protected branches — a decision with teeth, not advice. (Seed: #235 blocking custom-agent gate.)
2. **System-of-record for merge-safety.** A durable verdict (score 1–5), the reason, the policies evaluated, and the evidence, keyed to `prNumber#commitSha`. Answerable months later: "why was commit abc123 allowed to merge, and what did we check?"
3. **Policy/compliance as code.** `.mergewatch.yml` + org custom agents = an **org policy graph**: which rules apply to which repos/paths/languages, which are blocking, who wins in a conflict (org over repo). The org's merge policy, codified and enforced uniformly.
4. **Evidence & audit trails.** Machine-readable validation records per merge, exportable for SOC 2 / ISO change-management controls — generated automatically instead of screenshotted quarterly.
5. **Uniform validation of human AND agent output.** MergeWatch validates the *artifact*, not the author. In an era of blurring provenance and exploding volume, a gate at the merge boundary that treats all sources uniformly (and agent PRs more strictly) is the only defensible checkpoint.

**One line:** *Review advises a human. Validation blocks a merge, records why, and proves it later — for code written by humans or agents.*

---

## The wedge

**The neutral, provenance-aware, blocking merge gate** — the required check that classifies each PR as human- or agent-authored, applies org policy (stricter for agent PRs), blocks what fails, and records the verdict.

Chosen because: it's ~70% built (#235 + Check Runs + 1–5 score), it creates day-one dependency (required checks get budget; advisory bots get muted), no competitor leads with provenance, and it's the credible on-ramp to the system-of-record.

**To a buyer:** *"You're about to let AI write a lot of your code. MergeWatch is the gate that decides what's allowed to merge — and proves it was checked."*

---

## The moat (honestly rated)

| Moat | Thickness |
|---|---|
| Neutrality / open-source trust ("we don't sell the AI that wrote your code") | **Durable & unique** |
| Deployment neutrality (self-host + any LLM, air-gapped) | **Thick** |
| Org policy graph (accumulated config) | **Thick** |
| Being the merge gate of record | **Thick but slow** |
| Proprietary feedback loop (override capture) | **Medium — only if instrumented now** |
| The LLM pipeline itself | **Thin — don't over-invest** |

**Invest in:** neutrality, deployment flexibility, the policy graph, the evidence trail. **Not:** raw review quality (commoditizing).

---

## Expansion path (land → expand)

- **Land — The Gate.** One required check on one team's protected branch. "Nothing bad merges." GitHub-native, self-hosted or SaaS.
- **Expand 1 — Org rollout & policy graph.** The gate spreads repo-by-repo; the org codifies its merge policy centrally. Value shifts from "catch bugs" to "enforce our standards everywhere."
- **Expand 2 — System of record & evidence.** The accumulating verdict/evidence trail becomes a product surface: change-management audit exports, "why did this merge" lookups, merge-safety dashboards, time-to-merge metrics (#194).
- **Expand 3 — Agent governance.** As orgs adopt autonomous coding agents, MergeWatch becomes the *control plane for AI-generated code*: the gate that validates agent output, the record of what agents shipped, the policy that constrains them. The "AI build era" payoff.
- **Full layer.** Every change — human or agent, in CI, IDE, or agent runtime — flows through MergeWatch for validation, verdict, and evidence. Other systems consume its output. It's infrastructure.

---

## Precedents to learn from

- **Vanta (compliance):** won by becoming the *continuous system of record* for compliance evidence — replacing a painful manual ritual (screenshotting controls at audit time) with automatic, audit-ready proof. **Lesson:** the moat is being the *record*, not the checker. MergeWatch's equivalent: replace manual change-management/review evidence with an automatic per-merge validation record.
- **Datadog (observability):** turned monitoring from a feature into a foundational layer by becoming the single pane every workload reports into, then expanding module-by-module (83% of customers use 2+ products). **Lesson:** land narrow (one required integration), expand relentlessly, let integration breadth become the lock-in.

**Common thread:** both became layers by owning a *continuous, authoritative record at a chokepoint*. MergeWatch's chokepoint is **merge-time** — the last moment before code enters production, and the one point where human and agent output converge.
