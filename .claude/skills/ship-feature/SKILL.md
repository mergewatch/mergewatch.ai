---
description: Drive a feature or non-trivial change from request to shipped — write a phased plan doc in docs/feat or docs/chore, get it approved, then implement in stacked PRs with e2e/RUNBOOK.md scenarios and a docs/pending feature doc, gating each stage on build+typecheck+test and auto-addressing MergeWatch review concerns. Use whenever the user asks for a new feature, enhancement, refactor, or other multi-step change request.
argument-hint: <feature or change description>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, Task, TaskCreate, TaskUpdate, TaskGet, TaskList, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill
---

# /ship-feature

Take a feature or change request from idea to merged, the MergeWatch way: **plan first, get approval, then ship in small stacked PRs** — each with tests, an `e2e/RUNBOOK.md` scenario, a `docs/pending/` feature doc, and MergeWatch's own review concerns triaged before you move on.

Dogfood the product. Never commit to `main`. Match the surrounding code's idioms.

---

## Phase 0 — Plan (no code until approved)

### 0.1 Classify + scope

- **Feature / enhancement / new user-visible behavior** → plan lives in `docs/feat/`.
- **Chore / refactor / dep-bump / infra / maintenance** → plan lives in `docs/chore/`.

Read the request, then **ground the plan in the actual code** before writing it. For anything touching more than one file, fan out `Explore` agents (one per subsystem — e.g. storage, webhook, rollup, dashboard) and wait for their findings. Quote real file paths, types, and function signatures in the plan; don't plan against assumptions.

### 0.2 Surface the real decisions

If the request has genuine architecture forks (storage shape, single vs staged PRs, scope boundaries, backend coverage), ask the user with `AskUserQuestion` — give a recommendation as the first option. Don't ask about things with an obvious default; pick those and note them in the plan.

### 0.3 Write the phased plan doc

Compute the filename:

```bash
DATE=$(date +%Y%m%d)
# next 2-digit sequence for today across BOTH plan dirs
N=$(printf '%02d' $(( $(ls docs/feat docs/chore 2>/dev/null | grep -oE "^${DATE}-[0-9]{2}" | sort -u | tail -1 | grep -oE '[0-9]{2}$' | sed 's/^0*//' || echo 0) + 1 )))
echo "docs/feat/${DATE}-${N}-<kebab-feature-name>.plan.md"
```

So the path is `docs/<feat|chore>/YYYYMMDD-NN-<kebab-name>.plan.md` (e.g. `docs/feat/20260620-01-time-to-merge.plan.md`).

The plan doc must contain:

- **Title + status line** (`Status: Proposed` → flips to `In progress` / `Shipped` as work lands).
- **Summary** + **Why** (link the tracking issue if one exists).
- **Decisions** — the forks you settled with the user, each with the chosen option and one-line rationale.
- **Architecture** — how it plugs into the existing pipeline, with real file paths.
- **Phased breakdown** — **each phase is one PR**. Per phase: goal, files touched, the RUNBOOK scenario(s) it adds, the test strategy, and a checkbox. Order phases by strict dependency so they stack cleanly.
- **Out of scope / deferred** — what you're explicitly not doing (file follow-up tickets later if asked).

Keep phases small and independently reviewable — mirror how MCP (#112) and time-to-merge (#194) shipped: 3-ish PRs, strict dep order, capstone PR carries the docs.

### 0.4 Get approval

Present the plan via `ExitPlanMode` (or, if not in plan mode, summarize it and ask for a go/no-go). **Do not write implementation code until the user approves.** Once approved, set the plan doc status to `In progress` and create a `TaskCreate` task per phase to track progress.

---

## Phase 1..N — Implement, one stacked PR per phase

For each phase in the approved plan:

### 1. Branch

- Phase 1: branch off `main` — `feat/<short>-stage1-<desc>` (or `chore/...`).
- Later phases that depend on an unmerged earlier phase: **stack** — branch off the previous phase's branch, and note the dependency in the PR body. If the previous phase has already merged, branch off fresh `main` instead (`git checkout main && git pull --ff-only`).

### 2. Implement

- Match the surrounding code's comment density, naming, and idiom.
- Storage changes touch **both** backends (DynamoDB + Postgres) — keep them at parity. New Postgres columns/tables need a generated Drizzle migration; **hand-edit the SQL to use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`** (CI runs `migrations:check`).
- New cross-cutting types go in `@mergewatch/core` and are re-exported from its `index.ts`.

### 3. Add the E2E runbook scenario(s)

Every user-visible behavior gets a card in `e2e/RUNBOOK.md`, matching the existing `E2E-NN` format:

- Find the last `E2E-NN`, increment.
- Card = **Status** (`✅ SHIPPED (#PR)` once open) · **Behavior** · **Setup** (`fixture/NN-<name>` branch) · **Expected outcomes** (checkboxes) · **Failure modes**. Reference the `docs/pending/` doc.
- Add a matching row to the **Full regression checklist** table with the PR number in the `Verifies PR #` column.

### 4. Add / update the pending feature doc

`docs/pending/<feature>.md` — the user-facing feature documentation, built up phase by phase (architecture, storage shapes, edge cases, config, cross-refs). It **graduates** to `docs/<feature>.md` when the final phase ships (see Completion).

### 5. Gate — all must be clean before commit

```bash
pnpm run build 2>&1 | tail -3
pnpm run typecheck 2>&1 | tail -3
pnpm run test 2>&1 | tail -3
```

If anything fails, fix it before committing. Never push a phase that breaks build/CI.

### 6. Commit + push + PR

- Stage **only** the feature files. Leave build artifacts out (`*.tsbuildinfo`, `.DS_Store`, `.claude/worktrees/`).
- Commit message: `feat(scope): <summary> (#issue, stage N)` with a body explaining the phase and what's deferred. End with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Push the branch, then `gh pr create` with a body that states: which stage this is, what it does, the edge cases handled, the verification status, and what's deferred to later stages. For stacked PRs, name the base PR it stacks on.

### 7. Address MergeWatch's review automatically

MergeWatch reviews its own PRs — triage that review before moving to the next phase:

```bash
# Wait for the MergeWatch Review check to finish (it auto-runs on open; if it
# doesn't appear within ~60s, nudge it with: gh pr comment <PR> --body "@mergewatch review")
until [ "$(gh pr view <PR> --repo <owner/repo> --json statusCheckRollup \
  --jq '[.statusCheckRollup[]? | select(.name=="MergeWatch Review") | .status] | first')" != "IN_PROGRESS" ]; do sleep 10; done
```

Then invoke the existing triage skill to verify each finding against the code, apply real fixes, reject false positives with evidence, and post a structured reply:

```
Skill: resolve-mergewatch  (args: <PR-number>)
```

Re-run the build/test gate after any fix it applies. **Don't reflexively accept findings** — `resolve-mergewatch` already encodes the verify-before-applying discipline and the common false-positive shapes; trust it, and only escalate to the user if a finding implies a real design change.

### 8. Update tracking

Tick the phase's checkbox in the plan doc, mark its `TaskUpdate` complete, and tell the user the PR is up (with the MergeWatch verdict). Then continue to the next phase — or pause for the user to merge if phases must merge in order.

---

## Completion (final phase ships)

When the last phase is merged:

1. **Graduate the doc** — `git mv docs/pending/<feature>.md docs/<feature>.md`, flip its status to `✅ Shipped`, and fix any cross-references.
2. **Flip RUNBOOK statuses** to `✅ SHIPPED (#PR)`.
3. **Close out the plan** — set the plan doc status to `Shipped`, all phase checkboxes ticked.
4. If the merge of a capstone PR dropped the docs commit (it happens — a squash can leave a late commit behind), check `main` and re-apply the docs as a tiny follow-up PR.
5. Offer to file follow-up tickets for anything deferred — don't bake it into the shipped PR.

---

## Conventions (this repo)

- **pnpm monorepo + Turborepo.** `pnpm install`, `pnpm run build` (respects dep order). Tests via `pnpm run test`; coverage via `pnpm run test:coverage`.
- **Two deploy paths** — SaaS (Lambda + DynamoDB + Bedrock) and self-hosted (Express + Postgres + any LLM). A change to one usually needs the mirror in the other (webhook handler, store, rollup wiring).
- **AWS CLI** — always `--profile mergewatch`.
- **Postgres migrations** — `cd packages/storage-postgres && pnpm run migrations:generate`, then edit the SQL for idempotency, then `pnpm run migrations:check`.
- **Memory** — record the staging plan + read-shapes for multi-PR work (like `project_ttm_staging.md`) so a later session can resume.

## Output

When a phase's PR is up, summarize in ~5 lines: stage N of M, PR URL, what it ships, verification status (build/typecheck/test counts), and the MergeWatch verdict (score + how many findings applied/disagreed). When the whole feature is done, give the full PR table and note anything deferred.
