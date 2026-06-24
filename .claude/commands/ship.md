---
description: Drive an issue or feature to a production-quality, fully unit-tested, review-clean PR with a live task list mirrored onto the issue
argument-hint: <issue URL | #number | one-line scope of work>
---

# Ship: $ARGUMENTS

Deliver the work described above as a **production-quality, fully unit-tested pull request** (or a stack of them).
Treat this as a hard goal: **do not consider the task complete until every Definition-of-Done item below holds and is verified.** Maintain a detailed task list, mirror it onto the issue, and check items off as you progress.

If `$ARGUMENTS` is empty, ask what to ship and stop.

> ## ▶ For unattended / persist-until-done runs, launch with `/goal`
> ```
> /goal ship $ARGUMENTS
> ```
> `/ship` on its own is the **playbook** — instructions I follow within a turn, with no enforcement. `/goal ship <target>` adds the session **Stop-hook**, which blocks the session from stopping until the Definition of Done actually verifies (it auto-clears when met). Use the `/goal` form whenever you want this to keep driving across blockers/stop points without you re-prompting — especially for multi-PR stacks. Plain `/ship` is fine for an attended, single pass you're watching.

## Definition of done (every item must hold)

- [ ] **Accomplishes the ask completely** — re-read the issue/scope and satisfy each acceptance criterion (don't partially implement and call it done).
- [ ] A **detailed task list exists** (via the Task tools) and is **mirrored onto the issue** as a living checklist, kept in sync as work progresses (boxes ticked, PRs linked).
- [ ] `pnpm run build` and `pnpm run typecheck` pass across the workspace.
- [ ] `pnpm run test` passes, and the new/changed behavior has **solid unit tests** covering the happy path **and** edge cases (null/empty, error paths, back-compat), mirroring the existing test style in neighboring files.
- [ ] If the DB schema changed: an **idempotent** Drizzle migration is generated and `migrations:check` passes.
- [ ] Changes **match existing conventions** and stay **scoped** — no unrelated refactors, renames, reformatting, or drive-by edits.
- [ ] Docs/RUNBOOK updated where the repo expects (e.g. `e2e/RUNBOOK.md` scenarios, `docs/`, a `docs/pending/*` feature note when one fits the pattern).
- [ ] A **PR is opened** for every unit of work (never commit to `main`; branch first and dogfood the product).
- [ ] **Every MergeWatch automated-review concern is addressed** — fix and push until the review returns clean (5/5) or each finding is explicitly resolved/justified.
- [ ] CI checks (**Build & Test**, **MergeWatch Review**) are green on each PR.
- [ ] When all work is merged, the issue's tracking checklist is fully ticked and the issue is closed (or `Closes #N` lands it).

## Workflow

1. **Understand.** If the target is a GitHub issue (URL or `#number`), read it with `gh issue view <n> --repo <owner/repo>` and extract the acceptance criteria; restate the scope in one line. Resolve genuinely blocking ambiguity before coding; otherwise pick sensible defaults and proceed. Study how similar features are already wired in this repo before designing.

2. **Plan + publish the task list.** This is mandatory, not optional:
   - **Build a detailed local task list** with the Task tools (`TaskCreate`) — decompose the work into concrete, verifiable steps. Set dependencies where they matter.
   - **Decide the PR shape.** If the change is large or has natural dependency boundaries, plan a **stack of PRs** in strict dependency order (e.g. types/store → core logic → runtime wiring → dashboard → docs). Each PR is a phase. Keep each PR independently buildable, testable, and reviewable.
   - **Mirror the plan onto the issue** as a single **tracking comment** (one comment you keep editing — never spam new ones). Organize it by phase/PR with GitHub checkboxes. Capture the comment id from the create output (`...#issuecomment-<id>`) so you can edit it later. See *Issue checklist mechanics* below.

3. **Implement, phase by phase.** For each task/phase:
   - Mark the local task `in_progress` (`TaskUpdate`) when you start it, `completed` when it's truly done (tests pass — not before).
   - Make focused, convention-matching changes. Read surrounding code first; reuse existing patterns/helpers; match comment density, naming, and idioms.

4. **Test.** Add unit tests alongside the code, using the same framework/structure as neighboring tests. Cover edge cases and back-compat. Update any existing tests your change affects (don't silently weaken assertions).

5. **Gate.** Run `pnpm run build`, `pnpm run typecheck`, and `pnpm run test` (plus `migrations:check` if the schema changed). **Everything must pass before opening the PR.**

6. **PR.** Branch off `main`, commit with a clear message (end with the repo's `Co-Authored-By` trailer), push to the configured `origin`, and open the PR with a description that ties back to the issue (link it / `Closes #N` on the final PR of a stack). **Then update the tracking comment:** tick the boxes this PR completes and add the PR link next to its phase.

7. **Address review.** Wait for the **MergeWatch Review** check to complete, read its findings, and resolve each — fix + push, or justify why it's a non-issue. Re-poll until the review is clean and CI is green. Make a fair call on each finding; don't blindly apply low-value suggestions, but don't ignore real ones.

8. **Advance the stack.** When a PR is open/merged, update both the local task list and the issue tracking comment, then start the next phase. Repeat 3–7 until the stack is complete.

9. **Report.** Finish with every PR link and final check status, and confirm the issue tracking checklist is fully ticked. Flag anything intentionally deferred or left as a follow-up, with a one-line reason.

## Issue checklist mechanics (keep ONE living tracking comment)

**Create it once** (after planning), then **edit the same comment** as you progress — do not post a new comment per update.

Create and capture the id:
```bash
URL=$(gh issue comment <n> --repo <owner/repo> --body "$(cat <<'EOF'
## 🚚 Ship tracker (auto-maintained)

**Scope:** <one-line restatement>
**Plan:** <N> stacked PR(s) in dependency order.

### Phase 1 — <title>  ·  _PR: pending_
- [ ] <task>
- [ ] <task>

### Phase 2 — <title>  ·  _PR: pending_
- [ ] <task>

_Last updated as work progresses._
EOF
)")
ID="${URL##*-}"   # numeric comment id from ...#issuecomment-<id>
```
Update it later (tick boxes, fill in PR links, flip status) by PATCHing the same comment:
```bash
gh api --method PATCH "/repos/<owner>/<repo>/issues/comments/$ID" -F body=@updated.md
# (or, simplest if it's still your most recent comment: `gh issue comment <n> --repo R --edit-last --body ...`)
```
Conventions:
- One checkbox per concrete task; group by phase/PR.
- When a phase's PR opens, replace `_PR: pending_` with the PR link; when it merges, mark the phase header ✅.
- Keep the local Task-tool list and the issue checklist in lock-step — every `TaskUpdate` to `completed` ticks the matching box.

## Stacked PRs

When you choose a stack:
- Plan the whole stack up front and record it in the tracking comment (Phase 1..N, dependency order).
- Open PRs **in order**; each must build/typecheck/test green and pass MergeWatch review before the next starts (later phases depend on earlier ones merging or being branched from them).
- Only the **final** PR carries `Closes #N`; earlier PRs reference the issue (`Part of #N`).
- After each merge: sync `main`, tick that phase ✅ in the tracking comment, and proceed.

## Quality bar

- Prefer the **smallest change that fully solves the ask** — no speculative abstractions, no handling for cases that can't occur.
- **Faithfully report outcomes.** If a test fails or a step was skipped, say so with the evidence; only state "done and verified" when you've actually verified it.
- Keep each diff reviewable: feature-only staging (don't sweep in `.DS_Store`, build artifacts, or unrelated files).
- This command already produces a phased task list + stacked PRs for non-trivial work. Reach for the **`ship-feature`** skill only when you also want a checked-in `docs/feat/*` plan doc and a heavier graduation workflow.
