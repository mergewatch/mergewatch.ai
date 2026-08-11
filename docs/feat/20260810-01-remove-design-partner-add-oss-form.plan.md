# Spec — Remove Design-Partner References & Wire the OSS Free SaaS Access Application

**Created:** 2026-08-10
**Depends on:** the site repositioning (PRs #243–#246, merged) — specifically the `/open-source` page and its `OSS_APPLY_URL` / `APPLICATIONS_OPEN` graceful-degradation guard.
**Scope:** Two coupled changes on the marketing surfaces: (1) remove the design-partner promotional references, and (2) replace the placeholder OSS apply URL with the live **MergeWatch OSS Free SaaS Access Application** Google Form.
**Out of scope:** The authenticated dashboard, billing, review pipeline. Internal strategy docs (see §2.3).

---

## 1. Why

- The **design-partner** promotion ("We're onboarding our first design partners — free through GA, direct line to the founder") was a pre-repositioning GTM banner pointing at a Tally form (`tally.so/r/GxolrQ`). It no longer fits the repositioned messaging (frontier-model / no-black-box / OSS program) and should be removed everywhere it appears publicly.
- The `/open-source` program page currently ships with a **placeholder** apply URL (`https://tally.so/r/PLACEHOLDER`), so its CTAs render as a disabled "Applications opening soon" button. The real intake now exists as a **Google Form**, so we can make the OSS application live.

**Google Form (the real intake):**
`https://docs.google.com/forms/d/e/1FAIpQLSfiIx-0o5GJ8dwbhj_Fs1FfoCmvWpVS8ImlUR4L9gWQfh_msA/viewform`

---

## 2. Scope decisions

### 2.1 What counts as a "design-partner reference" to remove
Public/promotional surfaces only:
- The homepage top banner (`packages/dashboard/app/page.tsx`).
- The README banner (`README.md`).
- A stale code comment in `packages/dashboard/app/open-source/page.tsx` that mentions the "design-partner banner pattern".

### 2.2 The Tally form (`tally.so/r/GxolrQ`)
Every remaining public reference to this Tally URL is part of the design-partner banner, so removing the banners removes it. After this change, **no `tally.so` reference should remain** in `packages/dashboard` or `README.md`. (The OSS apply URL is switching to the Google Form, so the Tally placeholder goes too.)

### 2.3 ⚠️ Internal strategy docs — OUT of scope (needs confirmation)
`docs/strategy/*.md` (backlog, project-plan, decision, validation-layer-pivot, catch-up-plan) use **"design partners"** in a *different, legitimate* sense: early-adopter customers and design-partner repos for the validation-layer pivot and its experiments (e.g. "recruit 3–5 design partners", "retro provenance analysis on design-partner repos"). These are not the promotional banner and are load-bearing GTM strategy.

**Recommendation:** leave the strategy docs untouched. "Remove all design-partner references" is read as *the public/promotional banner*, not the strategy concept.
**Decision needed (Q1):** confirm strategy docs stay, or list which (if any) should also change.

The repositioning plan doc (`docs/feat/20260809-01-repositioning-site.plan.md`) also mentions design-partner/Tally as historical context describing the *old* banner — harmless to leave; optionally add a one-line note that both were removed by this spec.

---

## 3. Surface-by-surface changes

### 3.1 Homepage banner — `packages/dashboard/app/page.tsx:111–127`

Current: a full-width green top banner linking to the Tally design-partner form:
```
{/* ─── 0. Design-partner banner ─── */}
<a href="https://tally.so/r/GxolrQ" ...>
  … We're onboarding our first design partners — free through GA, direct line to the founder. Join → …
</a>
```

**Decision needed (Q2) — remove vs. repurpose:**

- **Option A — Replace with an OSS banner (recommended).** Keep a prominent top-of-page CTA, but repoint it at the OSS program. Preserves the visual slot and directly serves "add the OSS application."
  ```
  {/* ─── 0. Open-source program banner ─── */}
  <Link href="/open-source" className="group block w-full bg-primer-green text-black transition hover:brightness-110">
    <div className="mx-auto flex max-w-5xl ... ">
      <span>Maintain an open-source project? Get free frontier-model PR review.</span>
      <span className="… group-hover:underline">Apply → </span>
    </div>
  </Link>
  ```
  - Link target: prefer **`/open-source`** (the program page) over linking the Google Form directly, so visitors get context + the graceful-degradation guard still governs the actual apply action. (Internal `Link`, not an external `<a>`.)
  - Note: `ArrowIcon` is already defined in this file; reuse it.

- **Option B — Remove the banner entirely.** Homepage has no top banner; OSS is still promoted via the nav link, the dedicated OSS section, the OSS FAQ, and the footer link (all already present from the repositioning). Simpler, less prominent.

Recommendation: **Option A.**

### 3.2 README banner — `README.md:19–21`

Current:
```html
<p align="center">
  <strong>We&rsquo;re onboarding our first design partners</strong> &mdash; free through GA, direct line to the founder. <a href="https://tally.so/r/GxolrQ"><strong>Join &rarr;</strong></a>
</p>
```

**Target:** replace with an OSS-program banner (parallel to the homepage decision), or remove. Recommended (matches Option A):
```html
<p align="center">
  <strong>Maintain an open-source project?</strong> &mdash; get free frontier-model PR review. <a href="https://docs.google.com/forms/d/e/1FAIpQLSfiIx-0o5GJ8dwbhj_Fs1FfoCmvWpVS8ImlUR4L9gWQfh_msA/viewform"><strong>Apply &rarr;</strong></a>
</p>
```
- README is read on GitHub (no Next.js routing / no `DEPLOYMENT_MODE` guard), so linking the **Google Form directly** is correct here (there's no `/open-source` page to route to from GitHub).
- If Q2 = Option B (remove), delete the `<p>` block entirely.

### 3.3 OSS apply URL — `packages/dashboard/app/open-source/page.tsx:24`

Current:
```ts
const OSS_APPLY_URL = "https://tally.so/r/PLACEHOLDER";
```
**Target:**
```ts
const OSS_APPLY_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfiIx-0o5GJ8dwbhj_Fs1FfoCmvWpVS8ImlUR4L9gWQfh_msA/viewform";
```

Effect: `APPLICATIONS_OPEN = !OSS_APPLY_URL.includes("PLACEHOLDER")` (line 31) flips to **true**, so both CTAs (`ApplyButton` in the hero row and the closing CTA) automatically become live links to the form — **"Apply for free OSS access"** — instead of the disabled "Applications opening soon" state. No JSX changes needed; the guard already handles the switch.

### 3.4 Comment cleanup — `packages/dashboard/app/open-source/page.tsx`

- **Lines 15–23** (the `OSS_APPLY_URL` doc comment): rewrite to drop the `TODO`, the "Tally", and the "design-partner banner pattern" references. New comment states it's the live Google Form for the MergeWatch OSS Free SaaS Access Application, and that `APPLICATIONS_OPEN` (below) still degrades the CTAs if the URL is ever reset to a placeholder.
- **Lines 26–30** (the `APPLICATIONS_OPEN` comment): change "real Tally form URL" → "real application form URL".
- **~Line 292** (the `ApplyButton` doc comment): "Renders a live link to the Tally form" → "Renders a live link to the application form (Google Form)".

### 3.5 Grep gate (acceptance)
After the change, these must all be empty in `packages/dashboard` + `README.md` (excluding `node_modules`/`.next`):
- `design.?partner`
- `tally`
- `PLACEHOLDER` (within `open-source/page.tsx`)

And present:
- The Google Form URL in `open-source/page.tsx` (and README if Option A).

---

## 4. Verification

- **Static:** `tsc --noEmit` (dashboard) pass; `vitest run` 19/19.
- **Grep:** §3.5 gate clean.
- **Live render** (`DEPLOYMENT_MODE=saas`, dev server):
  - `/` → 200; no design-partner banner text; if Option A, the OSS banner is present and links to `/open-source`.
  - `/open-source` → 200; CTAs now read **"Apply for free OSS access"** (not "Applications opening soon"); the anchor `href` is the Google Form URL; opens in a new tab (`target="_blank" rel="noopener noreferrer"` — already on `ApplyButton`).
- **Manual:** click-through the form URL resolves to the live Google Form (200, not 404/permission-walled). ⚠️ Confirm the form is set to **accept responses** and is **not restricted to a Google Workspace org** (public "anyone with the link"), or external maintainers can't submit.

---

## 5. Open decisions

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Do the internal `docs/strategy/*.md` "design partner" references stay? (They're GTM strategy, not the banner.) | **Leave them** — out of scope. |
| Q2 | Homepage + README banner: **replace with an OSS banner** (Option A) or **remove entirely** (Option B)? | **Option A** (replace) — keeps a prominent OSS CTA. |
| Q3 | Homepage banner link target: `/open-source` (context page) or the Google Form directly? | **`/open-source`** for the site banner; **direct form** for the README (no routing on GitHub). |

---

## 6. Phasing

Single PR — small, copy/config only, no logic beyond the constant swap:

**`chore(site): remove design-partner banners; wire live OSS application form`**
- Homepage banner (Q2), README banner, `OSS_APPLY_URL` → Google Form, comment cleanup.
- Gate: build + typecheck + vitest + `/run` render check + §3.5 grep.
- MergeWatch will re-review; expect green (the placeholder finding it flagged before is resolved by this change).

---

## 7. Acceptance criteria

- [ ] No `design.?partner` or `tally` reference remains in `packages/dashboard` or `README.md`.
- [ ] `OSS_APPLY_URL` is the Google Form; `APPLICATIONS_OPEN` is `true`; both OSS CTAs are live links to the form and open in a new tab.
- [ ] Homepage renders per the Q2 decision (OSS banner present, or no banner).
- [ ] `tsc --noEmit` + vitest green; MergeWatch review green.
- [ ] The Google Form is publicly submittable (manually confirmed).
