# Site Repositioning Spec — Frontier Models · No Black Box · Pay-by-PR · OSS Program

**Created:** 2026-08-09
**Source of truth:** [`docs/repositioning.txt`](../repositioning.txt) (2026-08-04, Yasha + Santthosh)
**Scope:** All public-facing marketing surfaces in `packages/dashboard` (landing, pricing, about, sign-in, metadata/SEO, OG image, JSON-LD) + one new surface (MergeWatch for Open Source).
**Out of scope:** The authenticated dashboard app (`/dashboard/*`), billing internals, review pipeline behavior. This is a **messaging + one new page** change, not a product-logic change.

---

## 1. Why

The current site sells "AI reviews long diffs." The repositioning doc reframes MergeWatch around three claims that are already true, plus a community wedge:

1. **Frontier-model PR review without a closed black box** — use Claude / GPT via LiteLLM / Gemini / Bedrock / local Ollama; the pipeline is open and inspectable.
2. **Pay by reviewed PR, not by developer seat.**
3. **Self-hosting is 100% free, forever** (AGPL v3) — a philosophy, not a deployment footnote.
4. **MergeWatch for Open Source** — free hosted SaaS for qualifying OSS maintainers, framed as *ecosystem defense* against the coming wave of plausible-but-risky AI-generated PRs, in exchange for feedback + logo permission.

The raw materials are already on the site; the job is to make the wedge **louder and earlier**, fix cross-page inconsistencies, and add the OSS program as a real surface.

### Non-goals / guardrails (from the doc)
- Do **not** claim MergeWatch is always better than every closed competitor. The advantage is *control, transparency, model choice, auditability, pricing alignment*.
- Do **not** name competitors on the landing/pricing pages beyond the existing neutral "per-seat tools" framing. (The doc allows a single soft comparison sentence naming CodeRabbit/Greptile as category-provers; see §4.6 — flagged as an open decision.)
- OSS program copy must not imply maintainers are paid, and must not require endorsement before use.

---

## 2. Canonical decisions (resolve before editing copy)

These are the single sources of truth every surface must conform to. **Inconsistencies found in the audit are called out in §3.**

| # | Decision | Canonical value | Rationale |
|---|----------|-----------------|-----------|
| D1 | **Built-in agent count** | **5** (security, bug, style, summary, diagram) | Verified in `packages/core/src/agents/reviewer.ts:2102–2123` — exactly five `run*Agent` calls. Homepage already says "five" ✅. Pricing page says "6 agents" ❌ and self-hosting docs reportedly say "eight" ❌. The doc §"Site consistency cleanup" flags this explicitly. Standardize on **"five specialist agents (plus any custom agents you define)"**, or the softer **"multiple specialist agents"** where an exact count adds no value. |
| D2 | **Free-tier semantics** | ✅ **RESOLVED — 5 free reviews per month (resets monthly)** | Homepage FAQ (`page.tsx:51`) and pricing JSON-LD (`pricing/layout.tsx:53`) already say **"per month / every month"** ✅. The **pricing page body is now the outlier** (`pricing/page.tsx:213,322,328` say "one-time, lifetime, does not reset") — **flip it to monthly.** The calculator (`pricing/page.tsx:503`) takes a *monthly* PR count and subtracts `FREE_REVIEWS` once, which is already consistent with 5/month — no calculator change needed. ⚠️ **Backend verification item (out of scope for this spec):** confirm the billing enforcement in `packages/lambda` / `packages/server` actually resets the free allowance monthly; if it currently grants a one-time allowance, that's a follow-up backend ticket, not a site change. |
| D3 | **Positioning one-liner** | "Open-source AI PR review using the model stack you choose. Frontier-model review without a closed black-box workflow, priced by reviewed PR instead of developer seat, and free to self-host." | From the doc's "Positioning Statement → Short". Used in `<meta description>`, OG, and sign-in subhead. |
| D4 | **Terminology** | Approved: "frontier models", "closed black-box reviewer", "per-seat", "model choice", "self-host free". Avoid: "black box" as a slur on named vendors, "always more secure", competitor-bashing. | Doc "Competitive Framing". |
| D5 | **Provider phrasing** | "Claude (Anthropic), GPT-class models via LiteLLM, Gemini via LiteLLM, Amazon Bedrock, or local models via Ollama." Keep "four provider backends" as the technical count (Anthropic, Bedrock, LiteLLM, Ollama) but lead with *frontier model names* in marketing prose. | Doc Pillar 1. |
| D6 | **OSS program name + entry point** | ✅ **RESOLVED** — "**MergeWatch for Open Source**", new route `/open-source`, application via **a new Tally form** (matching the existing design-partner Tally pattern). ⚠️ **External artifact needed:** the Tally form URL must be created and supplied before PR 4/4 can link to it; until then use a placeholder constant `OSS_APPLY_URL`. |

---

## 3. Surface-by-surface change inventory

Each entry: **file → what changes → current → target**. Copy blocks are drafts derived from the doc; treat as starting points, not final wording.

### 3.1 Homepage — `app/page.tsx`

✅ **RESOLVED (Q1): replace the H1 with the wedge.** The current "The diff is too long. It always is." hook is retired from the H1. It may be repurposed lower on the page (e.g. as a section intro) if desired, but the top of the page now leads with the positioning.

| Location | Change |
|----------|--------|
| **Design-partner banner** (`:102–117`) | Keep, but add/rotate a second CTA path for OSS. Either widen this banner to two links or add a dedicated OSS entry in the nav (see nav row). Recommended: leave the design-partner banner as-is and add "For open source" to nav + a homepage OSS section (§3.1 new section). |
| **Nav** (`:120–154`) | Add a link: `For Open Source → /open-source`. Order: Docs · Pricing · **For Open Source** · GitHub · Get started. |
| **Hero eyebrow (new)** (above `:158`) | Optional small uppercase eyebrow above the H1, e.g. **"Open-source · Bring your own model"** in `text-primer-green`. (The "without the black box" line now lives in the H1 itself, so don't duplicate it here.) |
| **Hero H1** (`:158–162`) | ✅ **Replace** the three-color diff headline with: **"Frontier-model PR review, without the black box."** Keep the multi-color treatment (e.g. "Frontier-model PR review," in fg + "without the black box." in `text-primer-green`). Preserve `max-w-3xl` / responsive sizing. |
| **Hero subhead** (`:164–172`) | Rewrite to carry all three claims. Draft: *"MergeWatch reviews every pull request with the model stack you choose — Claude, GPT-class models via LiteLLM, Gemini, Bedrock, or local models via Ollama. The pipeline is open and inspectable, not a closed vendor box. Use the hosted SaaS and pay by PR, not by seat — or self-host the open-source version free and pay only your own model tokens. **Your reviewer makes the final call.**"* |
| **Trust strip** (`:193–200`, `:204–208`) | Replace the single "AGPL v3 — the whole codebase…" line + "Runs on AWS · GCP…" with the doc's 5-item trust strip: **AGPL v3 open source · Bring your own model · Pay by PR, not seat · Self-host free forever · Human reviewer makes the final call.** Keep the "Runs on AWS · GCP · Azure · Bare metal · Fly.io · Railway" line below it. |
| **"How it works" agent grid** (`:266–312`) | No structural change — already shows the correct **5** agents. Optionally add one line reinforcing "custom agents run in the same parallel pass." Ensure the count language stays "five specialists + your custom agents." |
| **New section — "Your model. Your infrastructure. Your review workflow."** (insert after the agent grid, ~`:313`) | New section per doc "Section headline/copy". Draft body: *"Closed PR review bots ask you to trust their pipeline. MergeWatch lets you inspect and control all of it — prompts, agents, provider routing, deployment, and data path. Bring Claude, GPT-class models via LiteLLM, Gemini, Bedrock, or run local models via Ollama for air-gapped environments."* Three sub-points: **Model choice**, **Inspectable pipeline (AGPL v3)**, **Your data path**. |
| **FAQ block** (`:42–63`) | (a) "How much does MergeWatch cost?" — already says "first five reviews free **every month**" ✅ under D2 (5/month); leave the monthly wording, just add "frontier" phrasing to the provider mention. (b) Add a new FAQ: **"Is MergeWatch a closed black box?"** answering with the transparency/AGPL/model-choice pillar (good for AI Overviews/JSON-LD). (c) Add **"Do you offer free access for open-source maintainers?"** pointing to `/open-source`. |
| **Three Pillars** (`:466–508`) | Already strong and on-message (per-PR pricing, AGPL auditability, self-host). Minor: retitle pillar 1 area to echo "Pay by PR, not by seat" verbatim, and add the word "frontier" to pillar 3's model list. |
| **New section — "Free frontier-model review for open-source maintainers"** (insert before Final CTA, ~`:574`) | New OSS teaser section per doc "Open-source section". Draft: *"Maintain a real open-source project? We'll give it free hosted MergeWatch access. AI-generated PRs are getting easier to produce and harder to inspect by hand — maintainers deserve frontier-model review on their side too. In exchange we ask for honest feedback and, if it helps, permission to list your project/logo as an early open-source user."* CTA: **Apply for free OSS access → /open-source**. |
| **Final CTA** (`:574–605`) | Keep the loss-aversion H2. Add a third CTA button row or subtext linking OSS: "Maintain open source? Apply for free access." |
| **Footer** (`:607–721`) | Add `/open-source` under **Product**. Add `/about` already present under Company ✅. |
| **FAQPage JSON-LD** (`:723–739`) | Regenerate from the updated `faqs[]` array (auto — it maps over `faqs`). Ensure new black-box + OSS FAQs are included. |
| **Freshness line** (`:198–200`) | "v1.0 · Updated April 2026 · Actively maintained" is stale (today is 2026-08-09). Bump to current or make it derive from a constant. Low priority but visible. |

### 3.2 Pricing — `app/pricing/page.tsx`

| Location | Change |
|----------|--------|
| **Nav** (`:24–61`) | Add "For Open Source → /open-source" (same as homepage). |
| **Hero** (`:65–78`) | Keep H1 "Pay for what you review. Not for who reviews it." ✅ on-message. Reword subhead to reinforce "not by seat" and align free-tier wording per **D2** ("your first 5 reviews each month are free, no credit card"). |
| **"6 agents per review (default pipeline)"** (`:304`) | ❌ **Bug — fix to 5.** Change to **"5 agents per review (default pipeline)"** (or "multiple specialist agents per review"). This is the doc-flagged inconsistency (D1). |
| **"Number of agents" cost factor** (`:184–187`) | Fine as-is ("multiple specialist agents"), but align example numbers if any reference a count. |
| **Free-tier card** (`:203–220`) | ⚠️ **Flip to monthly (D2).** Currently says "one-time evaluation period, not a monthly allowance" / "Free reviews don't reset each month." Rewrite to: "Your first **5 reviews each month** are free — no credit card. The free allowance resets monthly." This makes the pricing page consistent with the homepage FAQ, the JSON-LD, and the calculator. |
| **Competitor comparison** (`:259–281`) | ✅ **Stay neutral (Q3).** Keep the "per-seat tools" framing; **do not** name CodeRabbit/Greptile. No competitor-naming one-liner. |
| **FAQ "What happens when I hit my 5 free reviews?"** (`:322–329`) | ⚠️ **Flip to monthly (D2).** Currently says "one-time, lifetime evaluation — once used, they don't refresh." Rewrite so it states the 5 free reviews reset each month; keep the pause-and-add-credits behavior for overage within a month. |
| **FAQ "What LLM does the SaaS version use?"** (`:360–364`) | Reword to the frontier framing: "The hosted SaaS runs frontier Claude models via Amazon Bedrock with IAM auth — no API keys to manage. Self-hosted, you choose any provider." |
| **New FAQ** | Add "Do open-source maintainers pay?" → "No — qualifying OSS projects get free hosted access. See /open-source." |
| **Footer** (`:410–491`) | Add `/open-source` + `/about` (About is currently missing from the pricing footer's Company column — inconsistent with homepage footer; add it). |

### 3.3 Pricing metadata + JSON-LD — `app/pricing/layout.tsx`

| Location | Change |
|----------|--------|
| **`metadata.description`** (`:8–10`) | Keep "No per-seat fees. First 5 reviews free…". Under D2 (monthly), this is fine as-is; optionally clarify "first 5 reviews free each month." |
| **SoftwareApplication `unitText`** (`:53`) | ✅ "Free tier: first 5 reviews **per month**" already matches D2 (monthly). **No change needed** (keep the monthly wording). |
| **Offer description** (`:44–46`) | "First 5 pull request reviews free" ✅ — add "frontier-model review, priced by PR not by seat"; optionally "free each month." |

### 3.4 About — `app/about/page.tsx`

Already strongly on-message (open source, model choice, per-PR, self-host). Light touch:

| Location | Change |
|----------|--------|
| **Opening question** (`:16–20`) | Add the black-box frame: "…run on infrastructure you can't see, **sit inside a closed vendor box**, and lock you into a model you didn't choose?" |
| **"Two ways to run it"** (`:32–47`) | Add "frontier" to the provider list; keep both bullets. |
| **`metadata.description`** (`:6–7`) | Update to D3 positioning line. |
| **New short paragraph** | Add a 2–3 sentence "MergeWatch for Open Source" mention with a link to `/open-source`, framed as ecosystem defense (not charity). |
| **`lastUpdated`** (`:13`) | "April 13, 2026" is stale; bump. |

### 3.5 Sign-in — `app/signin/page.tsx`

| Location | Change |
|----------|--------|
| **Subhead** (`:34–36`) | "AI-powered PR reviews — your models, your cloud." → tighten to the wedge: **"Frontier-model PR review — your model, your workflow, priced by PR."** |

### 3.6 Global metadata — `app/layout.tsx`

| Location | Change |
|----------|--------|
| **`SITE_DESCRIPTION`** (`:8–9`) | Replace with D3 positioning line. Propagates to `<meta>`, OG, Twitter automatically. |
| **`title.default`** (`:14`) | ✅ **Keep "MergeWatch — AI-Powered PR Reviews" (Q2).** Do not change the `<title>` — preserve existing SERP ranking/CTR. The new positioning goes in the description + on-page copy only. |
| **OG/Twitter titles** (`:29,35`) | Keep aligned with the unchanged `title.default`. |
| **Organization JSON-LD** (`:59–67`) | Optionally add `description` = D3. |

### 3.7 OG image — `app/opengraph-image.tsx`

| Location | Change |
|----------|--------|
| **Headline** (`:44–46`) | "AI-Powered PR Reviews" → "Frontier-model PR review, without the black box." (verify it fits at `fontSize: 84`; may need 72). |
| **Subhead** (`:47–58`) | "Bring your own model. Run in your cloud…" → "Open source · Pay by PR, not seat · Self-host free · Your model." |
| **`alt`** (`:4`) | Match new headline. |

### 3.8 Sitemap + robots — `app/sitemap.ts`, `app/robots.ts`

| Location | Change |
|----------|--------|
| **`sitemap.ts`** (`:5–39`) | Add `/open-source` entry (priority ~0.8, changeFrequency monthly). |
| **`robots.ts`** | ✅ No change needed — `robots.ts` allows `/` with a fixed denylist (`/dashboard`, `/api/`, `/signin`, `/signout`, `/onboarding`); `/open-source` is crawlable by default, including by the allowed AI crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.). |

### 3.9 New surface — `/open-source` (MergeWatch for Open Source)

**New files:** `app/open-source/page.tsx` (+ `layout.tsx` if it needs the SaaS-mode redirect guard + its own metadata/JSON-LD, mirroring `pricing/layout.tsx`).

Page structure (per doc "Free frontier-model review" + program details):
1. **Hero** — "Free frontier-model review for open-source maintainers." Sub: ecosystem-defense framing.
2. **Why we're giving this away** — the security/trust position (not charity). Pull directly from doc lines 15–38.
3. **What you get** — free hosted SaaS for the project, install/config help, optional setup call, ability to shape review behavior via feedback.
4. **The ask** — use it on real PRs, give feedback, allow logo listing *if satisfied*, optional case study later with separate approval.
5. **Eligibility / guardrails** — public repos only, manual approval, fair-use limits, no SLA, maintainers can stop anytime.
6. **Apply** — CTA links to the **Tally form** (`OSS_APPLY_URL` constant; §5) capturing: project URL, maintainer GitHub, repo activity, contact, agreement to feedback.
7. **JSON-LD** — could add an `Offer` (price 0) or FAQ. Metadata description = OSS pitch.

Must reuse existing components: `Wordmark`, nav pattern, footer, `ArrowIcon`. Guard with the same `DEPLOYMENT_MODE !== "saas"` redirect used on `page.tsx`/`pricing/layout.tsx` (self-hosted builds shouldn't show a SaaS-giveaway page).

---

## 4. Cross-cutting consistency fixes (checklist)

- [ ] **Agent count = 5 everywhere** (D1): `pricing/page.tsx:304` (6→5). The `docs.mergewatch.ai` self-hosting docs (reportedly "eight agents") are **out of scope** — that source is not in this repo (no docs-site/mkdocs/docusaurus package here, and "eight agents" appears nowhere in-repo). Track separately.
- [ ] **Free tier semantics unified to MONTHLY** (D2): the pricing page body (`pricing/page.tsx:213,322,328`) is the only outlier — flip it to "5 free reviews per month." Homepage FAQ (`page.tsx:51`), pricing JSON-LD (`pricing/layout.tsx:53`), and the calculator already say/assume monthly ✅.
- [ ] **Positioning line (D3)** used verbatim in: `layout.tsx` SITE_DESCRIPTION, about metadata, OG subhead, sign-in subhead.
- [ ] **Provider phrasing (D5)** consistent: always list frontier model names, always mention Ollama = local/air-gapped/experimental.
- [ ] **Footers identical** across homepage + pricing (add `/open-source`, add `/about` to pricing footer).
- [ ] **Freshness stamps** (`page.tsx:199`, `about/page.tsx:13`, OG) bumped or derived from a shared constant.

---

## 5. OSS application form mechanism — RESOLVED

✅ **New Tally form** (matches the existing design-partner Tally pattern; zero backend). Implementation: reference the form via a single constant `OSS_APPLY_URL` in the `/open-source` page. **The Tally form itself must be created out-of-band and its URL supplied** before PR 4/4 merges; until then the constant holds a placeholder (`https://tally.so/r/PLACEHOLDER`) and the PR notes the blocker.

---

## 6. Resolved decisions (no remaining blockers)

All product decisions are locked — this spec can be implemented end-to-end without further input, except for the one external artifact noted below.

| # | Decision | Resolution |
|---|----------|------------|
| Q1 | **Hero treatment** | ✅ **Replace the H1** with "Frontier-model PR review, without the black box." (retire the diff hook from the H1). |
| Q2 | **SEO `<title>`** | ✅ **Keep** "MergeWatch — AI-Powered PR Reviews" (preserve SERP equity); new positioning lives in description + on-page copy. |
| Q3 | **Competitor naming** | ✅ **Stay neutral** — "per-seat tools" framing only; do not name CodeRabbit/Greptile anywhere. |
| Q4 | **Docs-site scope** | ✅ **Out of scope** — `docs.mergewatch.ai` source is not in this repo; the "eight agents" fix is tracked separately. |
| Q5 | **Free-tier semantics** | ✅ **5 free reviews per month** (resets monthly). Flip the pricing-page prose to match; everything else already says monthly. Backend monthly-reset enforcement is a separate verification/ticket. |
| Q6 | **OSS form** | ✅ **New Tally form** (§5). External artifact: Tally URL needed before PR 4/4. |

**Only external dependency:** the Tally form URL for `/open-source` (Q6). Everything else is self-contained.

---

## 7. Suggested phasing (stacked PRs, per `/ship-feature` convention)

Ordered so each PR is independently shippable and low-risk. Copy-only PRs first (reversible, no new routes), new surface last.

| PR | Title | Contents | Gates |
|----|-------|----------|-------|
| **1/4** | `chore(site): consistency fixes — agent count + free-tier semantics` | D1 (6→5 on `pricing/page.tsx:304`) + D2 (flip the pricing-page free-tier prose at `:213,322,328` to "5 free reviews per month" so it matches the already-monthly homepage FAQ, JSON-LD, and calculator). Pure copy/data, no logic. | build + typecheck + `pnpm --filter @mergewatch/dashboard test` |
| **2/4** | `feat(site): frontier-model / no-black-box messaging` | Homepage hero eyebrow + subhead + trust strip + new "Your model. Your infrastructure." section + new black-box FAQ; global metadata (D3); OG image; sign-in subhead; about tweaks. | build + typecheck + visual check via `/run` |
| **3/4** | `feat(site): pay-by-PR emphasis + pricing polish` | Pricing hero/subhead reword, frontier-framing on the LLM FAQ, footer parity (add `/about` + `/open-source`). Stays competitor-neutral (Q3). Free-tier flip already landed in PR 1/4. | build + typecheck |
| **4/4** | `feat(open-source): MergeWatch for Open Source page + program` | New `/open-source` route (+ layout guard, metadata, JSON-LD), homepage OSS teaser section + nav link + footer link, sitemap entry, application form (Q6). | build + typecheck + `/run` walk-through of the new route |

Each PR pairs with a `docs/pending/` feature note per the ship-feature workflow, graduating to `docs/` on ship. MergeWatch reviews its own PRs — address review findings inline.

---

## 8. Acceptance criteria

- [ ] Every public page leads with, or prominently carries, at least one of the three claims (frontier/no-black-box, pay-by-PR, self-host-free) above the fold.
- [ ] Zero remaining agent-count contradictions (grep: no "6 agents", no "eight … agents" in dashboard).
- [ ] Zero free-tier contradictions (grep: no "per month" free-review claims if D2 = one-time).
- [ ] `/open-source` renders in SaaS mode, redirects to `/signin` in self-hosted mode, is in the sitemap, and has a working application entry point.
- [ ] `pnpm run build` + `pnpm run typecheck` clean; dashboard vitest green.
- [ ] OG image + `<meta description>` reflect the new positioning (verify with a link-preview check).
