# False-Positive Feedback Plan

**Status:** Forward-looking. Sister to [`false-positive-reduction-plan.md`](./false-positive-reduction-plan.md).
**Purpose:** Close the *feedback loop* on false positives. FP-A..FP-G reduced FPs structurally by closing gaps inside the pipeline — they were prophylactic, evidence-free. This plan does the opposite: capture explicit feedback from real reviewers, aggregate it per installation, surface recurring themes, and (optionally) feed the strongest signals back into the prompts.

---

## How this differs from `false-positive-reduction-plan.md`

- The FP plan was **inside-out**: walk the code, find prompt-only rules with no enforcement, close gaps prophylactically. Workstreams FP-A..FP-G all ship without ever observing a specific bad review — they harden the pipeline against classes of failure the code paths admit.
- This plan is **outside-in**: capture what real reviewers actually disagree with, persist the disagreement, surface it, and let the org act on it. Every workstream here begins as data collection; the prompt-level interventions (FB-L) are gated behind explicit configuration and remain advisory by default.
- Workstreams here are numbered **FB-A through FB-L** to avoid collision with the W1–W12 (review-quality) and FP-A..FP-G (false-positive-reduction) namespaces.

---

## What we already have but aren't fully using

Before adding new capture, take stock of the signal that's already in the system:

| Signal | Where it lives today | What we do with it |
|---|---|---|
| W3 triage prose (`## mergewatch triage`) | computed live → `disputedKeys` | drives suppression, not analytics |
| FP-F inline-resolve keys | persisted on `ReviewItem.inlineResolvedKeys` | drives suppression, not analytics |
| W2 verification verdicts | `verification: 'verified' \| 'unverified'` per finding | input to W7 score clamp; not aggregated |
| Top-comment reactions | `ReviewItem.reactions` | collected but largely unused — 👎 is FP-shaped |
| Dashboard thumbs | `ReviewItem.feedback` ('up' \| 'down') | review-level only, not finding-level |
| W9 fingerprints + match keys | `findingMatchKeys` (always emits a title key, plus a fingerprint key when available) | stable cross-PR identity for free |
| W10 cluster siblings | `clusterFindings` + `extractSignificantTokens` | already groups related concerns; same machinery clusters disputes |

**Take-away:** ~70% of the signal already exists. The gap is **persistence + aggregation + surface**.

---

## Direction (locked in)

Three architectural choices shape the rest of the plan:

1. **Capture is GitHub-native first.** Inline-comment reactions, `/mergewatch reject` slash command, W3 triage prose, FP-F inline-resolve. Dashboard thumbs are a bonus surface, not the primary signal source.
2. **Storage is a dedicated table**, not denormalized onto `ReviewItem`. `mergewatch-finding-dispositions` (PK: `installationId`, SK: `<repoFullName>#<findingMatchKey>`) keeps `ReviewItem` lean and makes org-wide queries feasible without scans.
3. **Active learning stays surface-only.** Charts, suggestions, opt-in prompt injection — no auto-suppression. Humans stay in the loop.

```
┌─────────────────────────────────────────────────────────────────┐
│ Capture (GitHub-native)                                         │
│  • Inline-comment 👎 / 🤔 reactions                              │
│  • /mergewatch reject "<reason>" slash command                  │
│  • W3 triage prose (already wired)                              │
│  • FP-F inline-resolve (already wired)                          │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Persist (new table)                                             │
│  mergewatch-finding-dispositions                                │
│  PK: installationId   SK: <repoFullName>#<findingMatchKey>      │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Aggregate (nightly rollup)                                      │
│  mergewatch-installation-fp-insights                            │
└──────────────────┬──────────────────────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Surface (dashboard only — no auto-action)                       │
│  • FP funnel chart                                              │
│  • Dispute-rate-by-agent chart                                  │
│  • Top recurring FP themes                                      │
│  • "Suggest .mergewatch.yml rule" CTA                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Storage shapes

### `mergewatch-finding-dispositions`

Per-finding-identity record. Created on first surfacing; updated on every subsequent surfacing, dispute, and verification.

```ts
interface FindingDispositionRecord {
  installationId: number;          // PK
  repoFullName: string;            // SK prefix
  findingMatchKey: string;         // SK suffix (file::T::title OR file::F::fingerprint)
  firstSeen: string;               // ISO; set once
  lastSeen: string;                // ISO; updated on each surfacing
  surfaceCount: number;            // # of distinct reviews this match key appeared in
  disputeCount: number;            // # of explicit disputes
  verifiedCount: number;           // # of times W2 said valid:true
  unverifiedCount: number;         // # of times W2 returned unverified
  silentDropCount: number;         // FB-B — # of times surfaced previously but dropped without code change
  agreementCount: number;          // 👍 / ❤️ / 🚀 reactions on the inline comment
  category?: 'security' | 'bug' | 'style' | 'errorHandling' | 'testCoverage' | 'commentAccuracy' | 'custom';
  topAgent?: string;
  sigTokens?: string[];            // reused W10 token bag — drives cluster rollup
  rejectReasons?: Array<{          // FB-D — categorical reasons from /mergewatch reject
    category: 'already-handled' | 'out-of-scope' | 'wrong-target' | 'style-disagreement' | 'other';
    text?: string;                 // optional free-text
    at: string;                    // ISO
  }>;
}
```

### `mergewatch-installation-fp-insights`

Periodic rollup; one row per installation per window (7d / 30d / 90d).

```ts
interface InstallationFPInsight {
  installationId: number;           // PK
  window: '7d' | '30d' | '90d';     // SK prefix
  windowStart: string; windowEnd: string;
  totalFindingsSurfaced: number;
  disputeRate: number;              // disputeCount / surfaceCount
  perCategory: Record<string, { surfaced: number; disputed: number; rate: number }>;
  topClusters: Array<{
    sigTokens: string[];
    representativeTitle: string;
    surfaceCount: number;
    disputeCount: number;
    rate: number;
  }>;
  perRepo: Record<string, { surfaced: number; disputed: number; rate: number }>;  // FB-J
}
```

DynamoDB for SaaS, Postgres `jsonb` columns for self-hosted — same shape, two backends, written behind the existing `IReviewStore`-style interface.

---

## Opportunities

Ranked by dependency order (foundation first → capture → aggregation → surface → active learning).

### FB-A — `FindingDispositionRecord` storage + writers  ✅ SHIPPED

**Where the gap lives:** W3 disputed keys are computed live every review; FP-F inline-resolve keys are persisted on `ReviewItem` but only as a flat string array — no surfaceCount, no rate, no per-agent attribution. We have *no* cross-review per-finding identity table today.

**The fix:**
- New `mergewatch-finding-dispositions` table (DynamoDB SaaS / Postgres self-hosted). Schema as above.
- New `IFindingDispositionStore` interface in `@mergewatch/core` with `upsert(rec)`, `incrementCounter(...)`, `getByInstallation(installationId, limit?)`.
- Wire writers into the existing W3 path (when `computeDisputedKeys` produces a key, increment `disputeCount`) and FP-F path (when inline-resolve persists, ditto). One write per signal — keep it cheap.
- Surfacing increment: when `runReviewPipeline` finalises a finding into the review, upsert the record's `surfaceCount`.

**Code targets:** `packages/core/src/storage/types.ts` (new interface), `packages/core/src/types/db.ts` (`FindingDispositionRecord` type), `packages/storage-dynamo/src/finding-disposition-store.ts` (new), `packages/storage-postgres/src/finding-disposition-store.ts` + Drizzle migration (new), `packages/server/src/review-processor.ts` + `packages/lambda/src/handlers/review-agent.ts` (wire writes).
**E2E target:** [E2E-37](./../e2e/RUNBOOK.md#e2e-37-fb-a--findingdispositionrecord-storage--writers-target).

---

### FB-B — Quiet-drop derived counter  ✅ SHIPPED

**Where the gap lives:** When a finding appeared in `previousFindings` AND the cited code's fingerprint didn't change AND it's NOT in the current review → the orchestrator silently dropped it. That's a *very strong* implicit FP signal we're throwing away today.

**The fix:** `computeReviewDelta` already produces the resolved-list. Cross-reference with the changedLines set + fingerprint stability check. For each "resolved without code change" finding, increment `silentDropCount` on its `FindingDispositionRecord`. No new agent, no new API call — pure derived signal.

**Code targets:** `packages/core/src/agents/reviewer.ts` (compute the quiet-drop set after the orchestrator), handlers (write through to the store).
**E2E target:** [E2E-38](./../e2e/RUNBOOK.md#e2e-38-fb-b--quiet-drop-derived-counter-target).

---

### FB-C — Inline-comment 👎 reactions → disputes  ✅ SHIPPED

**Where the gap lives:** Top-comment reactions are already collected via `ReviewItem.reactions`. Inline-comment reactions are not. Yet reactions on an inline finding are arguably *more* signal-dense than top-level reactions — they're per-finding, attributed to the reviewer, and require zero typing.

**The fix:** Two parts:
1. **Webhook**: subscribe to `pull_request_review_comment.created` reaction events (or add a periodic reaction-poll path for installations that don't enable the granular hook).
2. **Mapping**: 👎 / 🤔 increment `disputeCount`; 👍 / ❤️ / 🚀 increment `agreementCount`. Removing a reaction is a no-op (we don't decrement — partly to keep the signal monotonic, partly because we'd otherwise need an event-source-table to reconcile).

The bot's inline-comment ID is already linked to a finding via `ReviewItem.findings[].inlineCommentId` (or recoverable from the comment body's `**🔴 <title>**` + path, same as FP-F).

**Code targets:** `packages/lambda/src/handlers/webhook.ts` + `packages/server/src/webhook-handler.ts` (new event), `packages/core/src/github/client.ts` (reaction-mapping helper), handlers (write through).
**E2E target:** [E2E-39](./../e2e/RUNBOOK.md#e2e-39-fb-c--inline-comment--reactions--disputes-target).

---

### FB-D — `/mergewatch reject "<reason>"` slash command  ✅ SHIPPED

**Where the gap lives:** W3 triage prose is the cleanest signal we have — author writes a sentence explaining why a finding is wrong — but it requires the author to write prose and lives only on top-level comments. Inline threads have only `/resolve` (which is success-shaped, not FP-shaped). There's no quick "this finding is wrong" channel from an inline thread.

**The fix:** New intent parser alongside `detectResolveIntent`. Recognises:

```
/mergewatch reject already-handled
/mergewatch reject out-of-scope This is in the integration suite, not unit tests.
/mergewatch reject style-disagreement we use snake_case for python here
```

**Design decisions (locked):**

- **Prefix form:** exactly `/mergewatch reject <category> [text]`. Slash-prefixed for discoverability via autocomplete-aware GitHub clients; full `mergewatch` (not `/mw`) to avoid collisions with other CI bots that may install a `/mw` prefix.
- **Auto-resolve behaviour:** rejection does **NOT** auto-resolve the GitHub thread. Rejection is a *signal*; closure is a *human decision*. Reviewers can still type `/resolve` separately if they want both. Keeps `/resolve` and `/reject` as orthogonal verbs.
- **Categories:** closed set — `already-handled`, `out-of-scope`, `wrong-target`, `style-disagreement`, `other`. Free-text after the category is optional and persisted as `text`.
- **Unrecognised category fallback:** silently coerce to `other`, with the original token preserved as the leading word of `text`. Example: `/mergewatch reject typo-cat foo` persists as `{ category: 'other', text: 'typo-cat foo' }`. Preserves the signal even when the reviewer types something unexpected; the dashboard surfaces these as `other`-category rejections for triage.

The bot posts a confirming reply (`Got it — recording as <category>. This pattern won't be re-raised on similar code unless conditions change.`) and increments `disputeCount` + appends to `rejectReasons[]`.

**Code targets:** `packages/core/src/agents/inline-reply.ts` (new parser + handler branch), `packages/core/src/agents/prompts.ts` (confirmation reply template), `packages/server/src/review-processor.ts` + `packages/lambda/src/handlers/review-agent.ts` (write through).
**E2E target:** [E2E-40](./../e2e/RUNBOOK.md#e2e-40-fb-d--mergewatch-reject-slash-command-target).

---

### FB-E — Nightly `InstallationFPInsight` rollup  ✅ SHIPPED

**Where the gap lives:** Reading per-finding records on every dashboard pageload is O(N) on installation size. We want the dashboard to be O(1).

**The fix:** Scheduled task (EventBridge → Lambda for SaaS; node-cron job in the Express server for self-hosted) runs nightly per installation. Aggregates `FindingDispositionRecord` rows into `InstallationFPInsight` rows for the 7d / 30d / 90d windows. Cluster step reuses W10's `extractSignificantTokens` + a simple union-find on shared tokens; representative title = highest-surfaceCount member.

Compute cost is bounded by the largest installation's record count; rollups stay small (~tens of KB per installation per window).

**Code targets:** `packages/core/src/insights/rollup.ts` (new — algorithm), `packages/lambda/src/handlers/insights-rollup.ts` (new — scheduled handler), `packages/server/src/insights-cron.ts` (new — self-hosted), `infra/template.yaml` (EventBridge rule).
**E2E target:** [E2E-41](./../e2e/RUNBOOK.md#e2e-41-fb-e--nightly-installationfpinsight-rollup-target).

---

### FB-F — Dashboard FP funnel chart  ✅ SHIPPED

**Where the gap lives:** The dashboard surfaces individual reviews but nothing about FP *health* of the org.

**The fix:** Stacked bar (or Sankey) at the top of an org dashboard view: `surfaced → carried → resolved → disputed → silently-dropped`. Single chart that answers "is the review noise increasing or decreasing for us?" Reads exclusively from the FB-E rollup. Recharts component.

**Code targets:** `packages/dashboard/components/charts/FPFunnel.tsx` (new), `packages/dashboard/app/[installation]/insights/page.tsx` (new route), `packages/dashboard/app/api/insights/route.ts` (new API).
**E2E target:** [E2E-42](./../e2e/RUNBOOK.md#e2e-42-fb-f--dashboard-fp-funnel-chart-target).

---

### FB-G — Dispute-rate-by-agent line chart  ✅ SHIPPED (as bar chart in v1; line chart pending per-day rollup)

**Where the gap lives:** Per-agent FP rates differ wildly across orgs (a Python-heavy shop disputes most TS-style nits; a Rails shop disputes most type-assertion warnings). No way to see which agent is the noisiest for *this* org.

**The fix:** Time-series line chart, one line per agent category (`security`, `bug`, `style`, `errorHandling`, `testCoverage`, `commentAccuracy`, `custom`). X-axis: day buckets over 30/90 days. Y-axis: disputeRate. Reads from `InstallationFPInsight.perCategory`.

**Code targets:** `packages/dashboard/components/charts/DisputeByAgent.tsx` (new), same route as FB-F.
**E2E target:** [E2E-43](./../e2e/RUNBOOK.md#e2e-43-fb-g--dispute-rate-by-agent-line-chart-target).

---

### FB-H — Top recurring FP themes table

**Where the gap lives:** Aggregate metrics show *that* the org disputes findings; they don't show *what* the org disputes. Without that, no acting on the data.

**The fix:** Sortable table on the same dashboard route: rank `InstallationFPInsight.topClusters` by `disputeRate × surfaceCount`. Columns: representative title, sigTokens (as chips), surfaceCount, disputeCount, rate, last-seen, "View findings" drill-through. This is the actionable surface — every other chart contextualises this one.

**Code targets:** `packages/dashboard/components/charts/TopFPThemes.tsx` (new), drill-through to a filtered `/reviews?match-key=…` view.
**E2E target:** [E2E-44](./../e2e/RUNBOOK.md#e2e-44-fb-h--top-recurring-fp-themes-table-target).

---

### FB-I — Severity-shopping detector chart  ⏸ DEFERRED

**Why deferred**: `FindingDispositionRecord` only tracks `category` (the producing agent — security / bug / style / …), not `severity` (critical / warning / info). Building a severity-shopping detector requires extending the disposition schema with a `severity` field, migrating both Postgres + DynamoDB, updating the writer in `disposition-writer.ts` to set it from `finding.severity`, and adding a `perSeverity` bucket to `InstallationFPInsight`. That's a self-contained follow-up PR (~M effort, low risk) and out of scope for the FB-F + FB-G chart bundle.

**Trigger to revisit**: once FB-F + FB-G are in production and operators ask for severity-shopping visibility.

**Where the gap lives:** FP-E extended verification to warnings to close the severity-shopping loophole — the orchestrator might still downgrade Critical → Warning to dodge attention. We need a way to see whether warnings dispute-rate stays disproportionately high relative to criticals over time.

**The fix:** Overlay two lines (warnings dispute-rate vs criticals dispute-rate) on a single chart. Add an annotation when `warningsRate > criticalsRate * 1.5` over a ≥2-week window — surfaces a potential regression of the FP-E intent.

**Code targets:** `packages/dashboard/components/charts/SeverityShoppingDetector.tsx` (new).
**E2E target:** [E2E-45](./../e2e/RUNBOOK.md#e2e-45-fb-i--severity-shopping-detector-chart-target).

---

### FB-J — Per-repo FP heatmap (org-wide)

**Where the gap lives:** Organisations with dozens of repos need to know *which* repos are noisy. A single aggregate disputeRate hides this.

**The fix:** Grid heatmap, rows = repos, cols = day/week buckets, cell colour = disputeRate. Reads `InstallationFPInsight.perRepo`. Sorted by total disputes desc; collapsed beyond row 20 with a "show all" link.

**Code targets:** `packages/dashboard/components/charts/RepoFPHeatmap.tsx` (new).
**E2E target:** [E2E-46](./../e2e/RUNBOOK.md#e2e-46-fb-j--per-repo-fp-heatmap-target).

---

### FB-K — Suggest `.mergewatch.yml` rule CTA

**Where the gap lives:** Even with the themes table (FB-H), translating "we keep disputing X" into a working `.mergewatch.yml` rule still requires manual YAML drafting.

**The fix:** On any cluster row with `disputeRate > 80%` AND `surfaceCount ≥ 5`, show a "Suggest ignore rule" CTA. Pre-generates a YAML snippet using the cluster's sigTokens as title-pattern keywords + the per-finding categories. One-click copy. The user pastes into their `.mergewatch.yml`; no auto-write to the repo (preserves human control).

**Code targets:** `packages/dashboard/components/IgnoreRuleSuggestion.tsx` (new), `packages/core/src/insights/suggest-ignore.ts` (new — YAML synthesis helper, also exported for the MCP path).
**E2E target:** [E2E-47](./../e2e/RUNBOOK.md#e2e-47-fb-k--suggest-mergewatchyml-rule-cta-target).

---

### FB-L — `{{KNOWN_FP_PATTERNS}}` prompt injection (opt-in)

**Where the gap lives:** The strongest closed-loop signal — top disputed clusters — never makes it back into the review pipeline. Every review starts fresh.

**The fix:** New placeholder `{{KNOWN_FP_PATTERNS}}` on every finding-producing agent prompt. At review time, fetch the org's top-K (default 5) disputed clusters from the latest `InstallationFPInsight` rollup and render:

> *"In this organization the following finding patterns have been explicitly disputed by reviewers multiple times: [list with representative titles and sigTokens]. Report findings matching these patterns only if you have **strong** evidence — describe the evidence explicitly in the description."*

**Critical guardrails**:
- **Off by default.** Per-org config flag in `.mergewatch.yml`: `feedback: { learnFromDisputes: true }`. Opt-in.
- **Soft guidance, not suppression.** The model is asked for stronger evidence, not silenced. A real defect that matches the pattern should still surface (with explicit reasoning).
- **Rate-limited.** Only patterns with `surfaceCount ≥ 5` and `disputeRate ≥ 75%` qualify. Sub-threshold clusters don't leak into prompts.
- **Logged.** Every review using the directive logs `[fb-l] injected N known-FP patterns` so the effect is auditable.

**Code targets:** `packages/core/src/agents/prompts.ts` (new placeholder + `buildKnownFPPatternsDirective` builder), `packages/core/src/agents/reviewer.ts` (substitute on every finding agent), handlers (fetch + inject the latest insight), `packages/core/src/config/defaults.ts` (new feature flag).
**E2E target:** [E2E-48](./../e2e/RUNBOOK.md#e2e-48-fb-l--known_fp_patterns-prompt-injection-target).

---

## Priority order

| ID | Workstream | Bucket | Effort | Depends on | ROI |
|---|---|---|---|---|---|
| **FB-A** | FindingDispositionRecord storage + writers | Persist | S | — | ✅ SHIPPED |
| **FB-B** | Quiet-drop derived counter | Persist | S | FB-A | ✅ SHIPPED |
| **FB-C** | Inline-comment 👎 → disputes | Capture | M | FB-A | ✅ SHIPPED |
| **FB-D** | `/mergewatch reject` slash command | Capture | M | FB-A | ✅ SHIPPED |
| **FB-E** | Nightly InstallationFPInsight rollup | Aggregate | M | FB-A, FB-B | ✅ SHIPPED |
| **FB-F** | FP funnel chart | Surface | M | FB-E | ✅ SHIPPED |
| **FB-G** | Dispute-rate-by-agent chart | Surface | M | FB-E | ✅ SHIPPED (bar v1; line pending per-day) |
| **FB-H** | Top recurring themes table | Surface | M | FB-E | ★★★ |
| **FB-I** | Severity-shopping detector | Surface | S | FB-G | ⏸ DEFERRED (needs severity on dispositions) |
| **FB-J** | Per-repo FP heatmap | Surface | M | FB-E | ★★ |
| **FB-K** | Suggest `.mergewatch.yml` rule CTA | Surface | M | FB-H | ★★ |
| **FB-L** | `{{KNOWN_FP_PATTERNS}}` prompt injection | Learn | L | FB-E, FB-H | ★★★ (opt-in) |

**Recommended bundling:**

- **PR 1 — Foundation** — FB-A + FB-B. Tiny, deterministic, no UX surface yet. Same shape as the FP-A+B+C bundle.
- **PR 2 — Capture** — FB-C + FB-D. Both are webhook-driven and share parsing helpers.
- **PR 3 — Aggregation** — FB-E. Standalone scheduled job.
- **PR 4 — Charts** — FB-F + FB-G + FB-I (the three line/bar charts on the same dashboard route). Pull `recharts` as a dep.
- **PR 5 — Themes + heatmap** — FB-H + FB-J + FB-K (the actionable surface). All read the same rollup.
- **PR 6 — Active learning** — FB-L (opt-in prompt injection). Heaviest lift, biggest risk surface, last.

---

## Privacy & cost notes

- **Per-installation scoping is non-negotiable.** Disposition records carry `installationId` as the PK; no query path crosses installations.
- **Anonymized cross-org insights** (a hypothetical "across MergeWatch users, these are the most-disputed patterns globally") are deliberately **out of scope** here. They'd require opt-in + privacy review + a separate aggregation pipeline. Worth revisiting later if the per-org signal proves useful.
- **DynamoDB cost** is bounded: one record per distinct `findingMatchKey` per repo; even noisy installations land in the low-thousands range. TTL is **not** applied — recurring-FP signal is most valuable over long windows.
- **Postgres cost** equivalent: the same table with a `(installation_id, repo_full_name, finding_match_key)` composite PK.

---

## Cross-references

- [`docs/review-quality-plan.md`](./review-quality-plan.md) — original evidence-derived plan (W1–W12, P1–P13).
- [`docs/false-positive-reduction-plan.md`](./false-positive-reduction-plan.md) — gap-driven prophylactic plan (FP-A..FP-G). All shipped.
- [`e2e/RUNBOOK.md`](./../e2e/RUNBOOK.md) — fixture cards. Each FB-X opportunity has a corresponding **TARGET** card (E2E-37..E2E-48) added with this doc and inverted to a passing regression guard once the work lands.

---

## Update protocol

When a new feedback channel or surface is identified:

1. Add it as **FB-M** (next letter) to the Opportunities section.
2. Add a matching **TARGET** card to `e2e/RUNBOOK.md` (next E2E-NN).
3. Re-rank Priority order.

When an opportunity is implemented:

1. Update the opportunity's heading to **✅ SHIPPED (PR #NN)**.
2. Flip the E2E card from TARGET to a passing fixture (or add the regression-check step).
3. If the data the new surface exposes reveals a fresh structural FP class, log it as a new workstream in `false-positive-reduction-plan.md` and cross-reference back here.
