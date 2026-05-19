# MergeWatch End-to-End Test Runbook

A curated set of fixture PRs that exercise every user-visible behavior MergeWatch ships. Run this after every production deploy to catch regressions before users see them.

> **Status**: manual checklist. A future iteration will script branch creation + assertions (see [Future Automation](#future-automation) at the end).

## Why this exists

Unit tests prove pieces work in isolation. They cannot prove:

- The Lambda actually fires webhooks against the deployed handler.
- The right comment body renders in the GitHub UI (HTML escaping, marker handling, Mermaid).
- Check runs land where they should and link to the right place.
- Reactions appear / don't appear.
- Edit-in-place actually edits rather than re-posts.
- Real Bedrock / Anthropic API calls succeed under prod IAM.

This runbook gives you ~30 minutes of structured manual testing that surfaces real-world breakage.

---

## Setup (one-time)

### 1. Create the fixtures repository

Create a public scratch repository — call it `mergewatch-fixtures` — under the same GitHub account that owns the MergeWatch App installation. Keep it separate from the main `mergewatch.ai` repo so test PR noise doesn't pollute production history.

```bash
gh repo create mergewatch-fixtures --public --description "E2E fixtures for MergeWatch"
git clone https://github.com/<owner>/mergewatch-fixtures.git
cd mergewatch-fixtures
```

Seed it with a minimal source tree so PRs have a place to land:

```bash
mkdir -p src docs
cat > src/app.ts <<'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF
cat > src/utils.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
EOF
# Seed co-located tests so the test-coverage agent sees existing coverage.
# Without this, ANY change to src/utils.ts trips "new public function lacks
# tests" even on JSDoc-only diffs — the agent can't tell pre-existing from new.
cat > src/utils.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { add, multiply } from './utils';

describe('add', () => {
  it('sums two positive numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
  it('handles negatives', () => {
    expect(add(-1, -2)).toBe(-3);
  });
  it('handles zero', () => {
    expect(add(0, 0)).toBe(0);
  });
});

describe('multiply', () => {
  it('multiplies two positive numbers', () => {
    expect(multiply(2, 3)).toBe(6);
  });
  it('handles zero', () => {
    expect(multiply(5, 0)).toBe(0);
  });
});
EOF
cat > README.md <<'EOF'
# mergewatch-fixtures

Scratch repo for MergeWatch E2E tests. See [e2e/RUNBOOK.md](https://github.com/<owner>/mergewatch.ai/blob/main/e2e/RUNBOOK.md).
EOF
git add . && git commit -m "Seed fixtures repo" && git push origin main
```

### 2. Install MergeWatch on the fixtures repo

- SaaS: visit the [MergeWatch GitHub App](https://github.com/apps/mergewatch) and install on `mergewatch-fixtures`.
- Self-hosted: configure your local instance's webhook to point at this repo, or install the dev App on it.

### 3. Verify install

Open any new PR (e.g., trivial commit + `gh pr create`). Within ~30s you should see the eyes 👀 reaction land. Close that PR — setup is done.

### 4. Tag commits (optional, recommended)

Add a `e2e-baseline` tag to the seed commit so every fixture can be re-created with `git reset --hard e2e-baseline`. This keeps the repo small and the fixture branches reproducible.

```bash
git tag e2e-baseline && git push --tags
```

---

## Test procedure (every fixture)

Each fixture follows this loop:

1. **Reset to baseline**: `git checkout main && git pull && git reset --hard e2e-baseline` (only if fixture state drifted).
2. **Create the fixture branch**: `git checkout -b fixture/<NN-name>`.
3. **Apply the setup** — copy the `.mergewatch.yml` snippet + create the source files listed in the fixture card.
4. **Push the branch**: `git push -u origin fixture/<NN-name>`.
5. **Open the PR**: `gh pr create --title "<fixture name>" --body "E2E fixture E2E-NN"`.
6. **Wait** for MergeWatch (~30–60s).
7. **Verify** against the fixture's "Expected outcomes" checklist below.
8. **Reset between runs**: close the PR, delete the remote branch (`git push origin :fixture/<NN-name>`), delete local branch.

For re-runs on the same fixture, you can amend + force-push (cheap) instead of creating a new PR.

---

## Full regression checklist

Run these in order — they cover all current behaviors. ~30 minutes end-to-end.

| ID | Behavior tested | Setup time | Wait | Verifies PR # |
|---|---|---|---|---|
| [E2E-01](#e2e-01-clean-pr--full-review) | Happy path: clean PR → 5/5 + APPROVE + empty review body | 1m | 60s | #132 |
| [E2E-02](#e2e-02-info-only-findings) | Info-only findings → 5/5, "All clear" + Info collapsible | 1m | 60s | #134 |
| [E2E-03](#e2e-03-critical-finding--inline-comment) | Critical finding → inline comment + REQUEST_CHANGES | 1m | 60s | core |
| [E2E-04](#e2e-04-autoreview-off--silent) | `autoReview: false` → zero PR trace | 1m | 30s | #136 |
| [E2E-05](#e2e-05-autoreview-off--mergewatch-override) | `autoReview: false` + `@mergewatch review` → review runs | 1m | 60s | #136 |
| [E2E-06](#e2e-06-smart-skip--docs-only) | Docs-only PR → visible "Review skipped" check run | 30s | 30s | core |
| [E2E-07](#e2e-07-smart-skip-bypass-via-includepatterns) | Docs-only + `includePatterns` → review runs | 1m | 60s | core |
| [E2E-08](#e2e-08-smart-skip-bypass-via-mention) | Docs-only + `@mergewatch review` → review runs | 1m | 60s | core |
| [E2E-09](#e2e-09-draft-pr-skip) | Draft PR → "Review skipped — Draft PR" | 30s | 30s | core |
| [E2E-10](#e2e-10-ignorelabels-skip) | `skip-review` label → "Review skipped — label" | 30s | 30s | core |
| [E2E-11](#e2e-11-re-review-on-synchronize) | Push new commit → old review dismissed + comment edited in place | 2m | 90s | core |
| [E2E-12](#e2e-12-re-run-check-via-github-ui) | Click "Re-run" on the check → new review fires | 30s | 60s | core |
| [E2E-13](#e2e-13-inline-reply-engages-on-mergewatch-thread) | Human replies in a MergeWatch inline thread → MergeWatch responds | 2m | 60s | #133 |
| [E2E-14](#e2e-14-inline-reply-skips-third-party-bot-thread) | Human replies in a non-MergeWatch inline thread → no engagement | 2m | 60s | #133 |
| [E2E-15](#e2e-15-mermaid-diagram-renders) | Complex diff produces a renderable Mermaid diagram | 2m | 60s | #128–#130 |
| [E2E-16](#e2e-16-agent-authored-pr-detection) | PR from `claude/*` branch → flagged as agent-authored | 1m | 60s | core |
| [E2E-17](#e2e-17-finding-grounding-drops-hallucinated-anchors) | Critical finding anchored at a comment line gets dropped or snapped | 2m | 60s | tier-1 |
| [E2E-18](#e2e-18-delta-aware-verdict-on-security-improvement) | PR that resolves prior criticals → green verdict (≥4/5), not orange | 3m | 90s | tier-1 |
| [E2E-19](#e2e-19-confidence-scores-hidden-by-default) | New install sees no `85%` etc. badges in finding rows | 30s | 60s | tier-1 |
| [E2E-20](#e2e-20-pr-description-vs-code-drift-catch) | Stale "we now use X" in PR body → reviewer flags the mismatch | 2m | 60s | feedback |
| [E2E-21](#e2e-21-no-op-suggestion-guard-w1) | Finding whose suggested fix already exists in the file → dropped | 1m | 60s | #145 |
| [E2E-22](#e2e-22-claim-aware-critical-verification-w2) | "Missing await" critical on code that already awaits (truncated-diff artifact) → dropped by full-file verification | 1m | 60s | #145 |
| [E2E-23](#e2e-23-re-review-convergence--no-whack-a-mole-w9w3) | Re-review never reports the same finding as both "✅ resolved" and "🆕 new" (W9); a triage-rebutted finding is not re-raised (W3) | 3m | 90s | W9 / W3 |

---

## Fixture cards

### E2E-01: Clean PR → full review

**Behavior**: a PR with no issues should produce 5/5 "Safe to merge", an APPROVE on the formal PR review (with empty body — verdict block removed in #132), and a summary comment with "All clear!".

**Setup**

Branch: `fixture/01-clean-pr`

`src/utils.ts` — change `add` to add a JSDoc comment (the function body stays
identical so the diff is comment-only):

```ts
/**
 * Add two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}
```

No `.mergewatch.yml` needed (default config). The seed commit already
includes `src/utils.test.ts` with coverage for `add`, so the test-coverage
agent has signal that `add` is pre-existing and covered.

**Expected outcomes**

- [ ] 👀 reaction lands within ~10s on the PR
- [ ] In-progress check run titled "Review in progress" appears
- [ ] Summary comment posted with:
  - [ ] MergeWatch wordmark image at top (~48px tall)
  - [ ] `🟢 5/5 — Safe to merge` verdict line
  - [ ] `🎉 All clear! No issues found` action-items section
  - [ ] No "Requires your attention" table (zero critical + zero warning)
- [ ] Formal PR review submitted with state = **Approved**
- [ ] **The Approved review has NO body text** (only the verdict state — #132 dropped the verdict body)
- [ ] Completed check run "MergeWatch Review" lands with conclusion = success
- [ ] +1 👍 reaction on the PR (success signal)
- [ ] 👀 reaction is **removed** once review completes — only 👍 remains

**Failure modes to watch for**
- ❌ PR review has a body that says "X/5 — verdict — view details" (regression of #132)
- ❌ Multiple summary comments instead of one edited-in-place
- ❌ 👀 reaction still present after review completes (regression of #138 eyes-cleanup)
- ❌ "Requires your attention" table with a "no test coverage" warning — that's the test-coverage agent firing on an unchanged public function (regression of the #138 prompt tightening)

---

### E2E-02: Info-only findings

**Behavior**: a PR that produces ONLY info-severity findings should reconcile to 5/5 (not the orchestrator's lower score) — fix from #134.

**Setup**

Branch: `fixture/02-info-only`

Edit `src/utils.ts` to use slightly verbose but functionally correct code that's likely to trip info-severity style observations:

```ts
export function add(a: number, b: number): number {
  // verify both inputs are valid numbers
  const valA = a;
  const valB = b;
  const result = valA + valB;
  return result;
}
```

No `.mergewatch.yml` needed.

**Expected outcomes**

- [ ] Summary comment with `🟢 5/5 — Safe to merge` (NOT 3/5 or 4/5)
- [ ] Verdict reason line says something like "No action items — only informational notes" (NOT "Multiple warnings")
- [ ] Action-items section reads `🎉 All clear! No issues found`
- [ ] An "Info (N)" collapsible section IS present below with at least 1 finding
- [ ] Formal PR review state = **Approved** (not Comment, not Request changes)

**Failure modes**
- ❌ Score shows 3/5 or 4/5 with "All clear!" — that's the bug #134 fixed reappearing
- ❌ "Requires your attention" table appears — only action items (critical/warning) should populate it

---

### E2E-03: Critical finding → inline comment

**Behavior**: a critical finding on a changed line should produce an inline review comment + REQUEST_CHANGES formal review.

**Setup**

Branch: `fixture/03-critical-finding`

`src/sql.ts` — new file:

```ts
import { Pool } from 'pg';
const pool = new Pool();

export async function findUser(userId: string) {
  // SQL injection — concatenating user input directly into the query string
  const result = await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
  return result.rows[0];
}
```

No `.mergewatch.yml` needed.

**Expected outcomes**

- [ ] Inline review comment lands on the `pool.query(...)` line
- [ ] Inline comment body starts with `**🔴 <title>**` and includes a Suggestion section
- [ ] Inline comment includes the hidden `<!-- mergewatch-inline -->` marker (verify via "View source" or curl `gh api .../pulls/N/comments` — needed for thread-root gating in E2E-13/14)
- [ ] Summary comment shows `🟠 2/5 — Needs fixes` or `🔴 1/5 — Do not merge`
- [ ] "Requires your attention" table lists the SQL Injection row with 🔴
- [ ] Formal PR review state = **Changes requested** (single review event — NOT multiple COMMENTED reviews)
- [ ] Review body is a single line that points at the summary comment (e.g. `🔴 Critical issues found — see the full review in the summary comment above.`)
- [ ] Check run conclusion = `failure` with a title like "N critical issues found"

**Failure modes to watch for**
- ❌ Formal review state is `COMMENTED` instead of `CHANGES_REQUESTED` (regression of #139 — was the bug observed in mergewatch-fixtures PR #3)
- ❌ Multiple COMMENTED reviews (one per inline comment) instead of one CHANGES_REQUESTED review with bundled inlines
- ❌ Review body is empty or matches the old multi-section verdict block — both are wrong; a one-line pointer is the target

---

### E2E-04: autoReview off → silent

**Behavior**: when `rules.autoReview: false`, MergeWatch leaves no trace on the PR (no reaction, no check run, no review, no comment). Ships in #136.

**Setup**

Branch: `fixture/04-auto-review-off`

`.mergewatch.yml`:

```yaml
rules:
  autoReview: false
```

`src/utils.ts` — any trivial change (e.g., rename a variable inside `add`).

**Expected outcomes**

- [ ] No 👀 reaction on the PR
- [ ] No "MergeWatch Review" check run on the PR (visible in the Checks tab)
- [ ] No summary comment
- [ ] No formal PR review
- [ ] No inline comments
- [ ] CloudWatch (SaaS) or stdout (self-hosted) shows a single log line: `autoReview off — silently skipping <owner>/<repo>#<N>`
- [ ] DynamoDB `mergewatch-reviews` table (or Postgres `reviews`) has NO row for this commit SHA

**Failure modes**
- ❌ "Auto-review is disabled for this repository" check run appears — that's the pre-#136 behavior the user explicitly asked to remove
- ❌ 👀 reaction lands then disappears — the reaction shouldn't have been added at all

---

### E2E-05: autoReview off + @mergewatch override

**Behavior**: even with `autoReview: false`, a `@mergewatch review` comment must force a full review. The silent gate must honor `mentionTriggered`.

**Setup**

Same branch as E2E-04 (`fixture/04-auto-review-off`) with the same `.mergewatch.yml`. Don't re-open a fresh PR — use the existing E2E-04 PR.

After confirming E2E-04 produced zero trace, post a comment on the PR:

```
@mergewatch review
```

**Expected outcomes**

- [ ] 👀 reaction lands within ~10s after the comment
- [ ] In-progress check run appears
- [ ] Summary comment is posted as normal
- [ ] Formal PR review submitted
- [ ] All the trace that was absent in E2E-04 is now present

**Failure modes**
- ❌ No reaction / no review — silent gate isn't honoring mentionTriggered (regression of skip-logic.ts)

---

### E2E-06: Smart skip — docs only

**Behavior**: a PR touching only docs/lock files should skip review and post a visible "Review skipped" check run.

**Setup**

Branch: `fixture/06-docs-only`

Edit `README.md` only (any change, e.g., add a paragraph).

No `.mergewatch.yml` needed.

**Expected outcomes**

- [ ] 👀 reaction lands briefly
- [ ] **Visible** check run titled "Review skipped" with summary like `Only docs changed`
- [ ] No summary comment
- [ ] No formal PR review
- [ ] (Auto-review IS on here — this is the smart-skip path, NOT the silent path)

---

### E2E-07: Smart skip bypass via includePatterns

**Behavior**: `includePatterns` lets a docs-only PR opt itself back into review.

**Setup**

Branch: `fixture/07-include-patterns`

`.mergewatch.yml`:

```yaml
includePatterns:
  - "docs/**"
```

Add `docs/architecture.md` with some content.

**Expected outcomes**

- [ ] Full review runs (👀 reaction → in-progress check run → summary comment → APPROVE)
- [ ] Summary comment treats the markdown file as a normal source file (no "skipped — only docs" message)

---

### E2E-08: Smart skip bypass via mention

**Behavior**: same as E2E-07 but proves `@mergewatch review` overrides smart-skip even without `includePatterns`.

**Setup**

Same as E2E-06 (docs-only PR, no override config). After the "Review skipped" check run appears, post:

```
@mergewatch review
```

**Expected outcomes**

- [ ] Review runs full pipeline despite docs-only content
- [ ] Summary comment posted
- [ ] (Check run from initial skip remains in history — that's fine)

---

### E2E-09: Draft PR skip

**Behavior**: draft PRs are skipped by default (`skipDrafts: true`) with a visible check run.

**Setup**

Branch: `fixture/09-draft-pr`. Make any non-trivial source change (e.g., `src/app.ts`).

Open the PR as a **draft**: `gh pr create --draft`.

**Expected outcomes**

- [ ] Visible "Review skipped" check run with summary mentioning "Draft PR"
- [ ] No summary comment
- [ ] No formal PR review

**Bonus**: convert to ready-for-review (`gh pr ready`). MergeWatch should now run a full review (synchronize-equivalent event).

---

### E2E-10: ignoreLabels skip

**Behavior**: a PR carrying a label in `rules.ignoreLabels` is skipped.

> **Important**: MergeWatch only re-evaluates skip rules on `pull_request` events with action `opened` / `synchronize` / `ready_for_review` / `reopened` (see `REVIEW_TRIGGERING_ACTIONS`). The `labeled` action is **not** in that list — adding a label to an already-reviewed PR will NOT cancel the in-flight review or supersede the existing verdict. To test this fixture correctly, add the label **before** the first commit lands, or follow the label add with a synchronize event (push any commit) so the rules-skip path actually runs.

**Setup**

Branch: `fixture/10-skip-review-label`. Make any non-trivial source change but **do not push yet**. Open the PR as draft → add the `skip-review` label → mark ready-for-review (which fires `ready_for_review` and re-evaluates the skip rules). Alternatively:

```bash
# Path A: label first, then push a commit (synchronize triggers re-evaluation)
gh pr create --title 'E2E-10' --body '...'
gh pr edit <N> --add-label skip-review
git commit --allow-empty -m 'trigger synchronize'
git push

# Path B: open as draft, label, then mark ready
gh pr create --draft --title 'E2E-10' --body '...'
gh pr edit <N> --add-label skip-review
gh pr ready <N>
```

**Expected outcomes**

- [ ] Visible "Review skipped" check run with summary like `PR has label "skip-review" which is in ignoreLabels`
- [ ] If a prior MergeWatch review was already submitted, it is **dismissed** by the new skip evaluation

**Known gap**
- ❌ Adding the `skip-review` label to a PR that's already mid-review (or already reviewed) does **not** cancel/supersede the existing review. The webhook only fires for the actions listed above. Tracked as a deliberate limitation — opening a code-side fix would require handling `labeled` / `unlabeled` actions specifically and is non-trivial.

---

### E2E-11: Re-review on synchronize

**Behavior**: pushing a new commit to an open PR should:
- Dismiss any prior formal PR reviews
- Edit the existing summary comment in place (not post a new one)
- Track the delta between commits (delta caption)

**Setup**

Use any active fixture PR (E2E-01 works). After the first review completes:

```bash
git checkout fixture/01-clean-pr
echo "// added in commit 2" >> src/utils.ts
git commit -am "Second commit"
git push
```

**Expected outcomes**

- [ ] Original formal PR review now shows as **Dismissed** (struck-through in the GitHub UI)
- [ ] Single summary comment (not two) — comment was edited in place via `BOT_COMMENT_MARKER` lookup
- [ ] Comment body's commit SHA reference at the bottom updates to the new SHA
- [ ] If findings changed, a delta caption appears ("Resolved X, introduced Y")
- [ ] Updated commit-hash link in the comment footer points at the new commit

---

### E2E-12: Re-run check via GitHub UI

**Behavior**: clicking the "Re-run" button on the MergeWatch check should trigger a fresh review on the same commit.

**Setup**

Open any completed fixture PR. In the Checks tab, click the ⋯ menu next to "MergeWatch Review" → "Re-run".

**Expected outcomes**

- [ ] Within ~30s a new "in progress" check run appears
- [ ] Summary comment is updated in place
- [ ] Behavior identical to a synchronize event

---

### E2E-13: Inline-reply engages on MergeWatch thread

**Behavior**: replying to a MergeWatch inline comment should trigger a focused conversational response.

**Setup**

Use the E2E-03 PR (which produced an inline comment from MergeWatch on the SQL injection finding). In the GitHub UI, reply to that inline comment with:

```
Can you elaborate on the parameterized query suggestion?
```

**Expected outcomes**

- [ ] 👀 reaction appears on YOUR reply within ~10s
- [ ] MergeWatch posts a follow-up reply in the same inline thread within ~30s
- [ ] 👀 reaction is removed once the reply lands
- [ ] Reply is reasonably on-topic about parameterized queries
- [ ] Reply does NOT contain the `<!-- mergewatch-inline -->` marker visibly (it's HTML-comment hidden)

**Verify the resolve fast-path**: post `/resolve` as a reply. MergeWatch should resolve the thread via GraphQL within ~10s without invoking the LLM.

---

### E2E-14: Inline-reply skips third-party bot thread

**Behavior**: MergeWatch must NOT engage when a human replies to a thread NOT rooted in a MergeWatch comment (e.g., CopilotAI's or a human's inline finding). Fix from #133.

**Setup**

You can't easily simulate CopilotAI from a fixtures repo. Two ways:

1. **Manual fake**: have a human (you) leave a top-level inline review comment on a PR file. Then have a different human (or the same one) reply in that thread.
2. **CopilotAI test**: install GitHub Copilot Code Review on `mergewatch-fixtures`, let it post an inline finding on a PR, then reply yourself.

For E2E-14a (manual fake — easiest):

Branch: `fixture/14-third-party-thread`. Make a non-trivial change so MergeWatch produces its own review. Once that completes, leave a NEW top-level inline comment on a different line of the diff (use the GitHub UI's "+ Add comment" gutter button on a line that MergeWatch DID NOT comment on). Then reply to that inline comment yourself with `@mergewatch what do you think?` or just `looks fine` — but on the human-rooted thread.

**Expected outcomes**

- [ ] MergeWatch does NOT post a reply in the human-rooted thread
- [ ] MergeWatch DOES still respond if you reply in its own thread on the same PR (sanity check)
- [ ] Logs show `thread root is not a MergeWatch comment` skip reason (CloudWatch / stdout)

**Failure modes**
- ❌ MergeWatch replies in a thread it didn't start — this is the interference the user explicitly called out

---

### E2E-15: Mermaid diagram renders

**Behavior**: complex PRs should produce a Mermaid `flowchart TD` diagram that renders correctly in the GitHub UI (no parse errors). Multiple sanitizer fixes shipped in #128–#130.

**Setup**

Branch: `fixture/15-mermaid-stress`. Add a multi-file change that touches at least 5 files with distinct names containing characters that historically broke Mermaid:

```
src/auth/oauth-callback.ts      (with a function named `[handle/callback]`)
src/utils/string-helpers.ts     (with content containing real newlines in identifiers)
src/db/migrations/0042-add.sql  (slashes + numbers)
src/api/v1/users.ts             (multi-segment path)
src/components/<Title>.tsx      (angle brackets in the path)
```

Use names with characters like `<`, `>`, `"`, `\t`, embedded newlines in JSDoc, etc.

**Expected outcomes**

- [ ] Diagram block in the summary comment renders inline in the GitHub PR view (no `mermaid parse error` shown)
- [ ] Diagram includes labeled boxes for each touched file
- [ ] No raw `&lt;` / `&gt;` HTML entities visible in the rendered diagram (they're decoded by Mermaid)
- [ ] No literal `<br/>` tags visible in node labels (they render as line breaks)
- [ ] Tabs / lone CR characters in upstream content don't break the diagram

**Failure modes**
- ❌ "Unable to render rich display" or red error block where the diagram should be
- ❌ Diagram truncates mid-node label
- ❌ Quoted labels show literal escape sequences

---

### E2E-16: Agent-authored PR detection

**Behavior**: a PR from a `claude/*`-prefixed branch should be classified as agent-authored and trigger agent-mode prompt suffixes / persist `source: 'agent', agentKind: 'claude'`.

**Setup**

`.mergewatch.yml`:

```yaml
agentReview:
  enabled: true
  detection:
    branchPrefixes: ["claude/", "cursor/", "codex/"]
```

Branch: `claude/fix-greet-bug`. Make a non-trivial change to `src/app.ts`.

**Expected outcomes**

- [ ] CloudWatch / stdout log: `Classified <owner>/<repo>#<N> as agent (claude) via branch`
- [ ] Summary comment renders normally (no visible difference yet — verification is internal)
- [ ] DynamoDB review record (or Postgres `reviews.source`) has `source: 'agent', agentKind: 'claude'`
- [ ] If `agentReview.strictChecks: true` (default), the prompt-mode suffix is applied → review tone may be terser on logic findings

To inspect the stored record (SaaS):

```bash
aws dynamodb get-item --table-name mergewatch-reviews \
  --key '{"repoFullName":{"S":"<owner>/mergewatch-fixtures"},"prNumberCommitSha":{"S":"<N>#<shortSha>"}}' \
  --profile mergewatch
```

---

### E2E-17: Finding grounding drops hallucinated anchors

**Behavior**: a finding whose cited anchor line doesn't actually contain the code it describes is dropped (critical) or downgraded (warning → info). The grounding step in `runReviewPipeline` re-fetches the file at the PR's headSha and verifies that an identifier from the finding's description appears within ±5 lines of the anchor; if not, it snaps to the first matching line in the file or drops the finding.

Verifies the regression flagged in user feedback: "the bot anchored a critical 'race condition' at lines 89–91 (which are comment lines), when the actual `await createChatSession()` was on line 92."

**Setup**

Branch: `fixture/17-grounding-hallucinated-anchor`. Add a file deliberately crafted so the LLM is likely to anchor a finding at a comment line:

`src/race-trap.ts`:

```ts
// This function persists chat state to two stores.
// IMPORTANT: the writes happen serially below — the comment block
// runs from line 1 to line 8 and contains words like "await",
// "race condition", and "fire-and-forget" so the reviewer might be
// tempted to anchor a finding inside this comment region.
//
// The actual code is below.

export async function persistChat(userId: string, msg: string): Promise<void> {
  const session = await createChatSession(userId);
  await addChatMessage(session.id, msg);
}

declare function createChatSession(userId: string): Promise<{ id: string }>;
declare function addChatMessage(id: string, msg: string): Promise<void>;
```

No `.mergewatch.yml` needed.

**Expected outcomes**

- [ ] If a critical finding is produced about race conditions or fire-and-forget writes, its `line` field points at line **10 or 11** (the `await createChatSession` / `await addChatMessage` lines) — NOT at lines 1–8
- [ ] If the orchestrator emitted such a finding anchored in the comment region (1–8), the grounding pass snapped the line to the actual code OR dropped the finding entirely
- [ ] No finding's anchor line is on a `//`-only line in the rendered "Requires your attention" table
- [ ] The dashboard review record (or DynamoDB `findings`) shows snapped line numbers, not the original orchestrator output

**Failure modes to watch for**
- ❌ Critical finding rendered at lines 1–8 (anchor still on a comment line)
- ❌ Critical finding describing functions that don't appear in `src/race-trap.ts` at all (full hallucination — the grounding pass should have dropped it)

**Note**: this fixture is stochastic — the LLM may not always anchor on a comment line on a small file. To force the failure mode pre-fix, you can manually inject `{ "file": "src/race-trap.ts", "line": 3, "severity": "critical", "title": "Race condition", "description": "createChatSession() and addChatMessage() are not awaited together." }` into the orchestrator response in a local self-hosted run.

---

### E2E-18: Delta-aware verdict on security improvement

**Behavior**: a PR that resolves critical findings from a prior review without introducing new criticals should produce a green verdict (≥4/5 "Generally safe" / "Safe to merge"), not the same orange "Needs fixes" face the original buggy commit got. Verifies the reconciliation rule added with the grounding fix.

User feedback motivating this: "PR #18 had real exploitable issues, PR #19 closed them — both landed at 2/5. When a PR is a security improvement, the verdict should reflect that."

**Setup**

Use a two-PR sequence on the fixtures repo.

**Step 1** — open a PR that produces critical findings:

Branch: `fixture/18a-introduce-criticals`. Add `src/admin-api.ts`:

```ts
import type { NextRequest } from 'next/server';

// No authentication — anyone can hit this admin endpoint.
export async function GET(_req: NextRequest) {
  const transcripts = await fetchAllTranscripts();
  return Response.json({ transcripts });
}

// User-controlled SQL.
export async function POST(req: NextRequest) {
  const { id } = await req.json();
  const result = await db.raw(`SELECT * FROM users WHERE id = '${id}'`);
  return Response.json(result);
}

declare const db: { raw(sql: string): Promise<unknown> };
declare function fetchAllTranscripts(): Promise<unknown[]>;
```

Open the PR, let MergeWatch review. Confirm it produces ≥1 critical findings and lands at 1/5 or 2/5 (orange/red). **Do not merge.**

**Step 2** — push a follow-up commit that fixes the criticals. The fix
deliberately wraps each handler with `try`/`catch` and explicit 401/500
responses so an LLM reviewer can't legitimately flag "no error handling
around the auth check" or "auth failures propagate as 500s" — both of
which would count as new criticals and break the security-improvement
verdict.

```ts
import type { NextRequest } from 'next/server';
import { requireAdmin, AdminAuthError } from '@/auth';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return new Response('Forbidden', { status: 403 });
    }
    return new Response('Server error', { status: 500 });
  }
  const transcripts = await fetchAllTranscripts();
  return Response.json({ transcripts });
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return new Response('Forbidden', { status: 403 });
    }
    return new Response('Server error', { status: 500 });
  }
  const { id } = await req.json();
  // Parameterized query — string concatenation is gone.
  const result = await db.prepare('SELECT * FROM users WHERE id = ?', [id]);
  return Response.json(result);
}

declare const db: { prepare(sql: string, params: unknown[]): Promise<unknown> };
declare function fetchAllTranscripts(): Promise<unknown[]>;
declare class AdminAuthError extends Error {}
declare function requireAdmin(req: NextRequest): Promise<void>;
```

Push to the same branch. MergeWatch will re-review with the fix-commit context.

**Expected outcomes (on the second review)**

- [ ] The "📎 Previously reported findings" section shows the ≥1 criticals from step 1 marked as **✅ Resolved**
- [ ] Verdict line shows `🟢 4/5 — Generally safe` or `🟢 5/5 — Safe to merge` — NOT red/orange
- [ ] If for some reason the LLM flags 1-2 new minor concerns on the fix, the verdict should land on **🟡 3/5** at worst (net-improvement tier — `resolvedCriticals > newCriticals` keeps it yellow, not red)
- [ ] Verdict reason mentions resolved criticals: `Resolved N critical issues from prior review, no new criticals introduced.` (pure) OR `Resolved N critical issues from prior review; introduced M new — net improvement, but review the new findings.` (net)
- [ ] Formal PR review state = **Approved** (empty body) on green; **Comment** on yellow
- [ ] Delta caption summarises the resolution: e.g., "Replaced unauthenticated admin endpoints with `requireAdmin` guards and parameterized the SQL query."

**Failure modes**
- ❌ Score red (1-2/5) despite resolved > new criticals (net-improvement tier regressed)
- ❌ Resolved criticals counted as still-open in the verdict reason
- ❌ LLM flags >3 new criticals on the fix code (likely false positives — the fix is now defensive enough that this would indicate a quality regression in the agent prompts; report it)

**Why the fix code looks verbose**: each try/catch + explicit error response defuses a specific LLM pattern-match ("no error handling", "auth errors leak as 500"). On a real PR, that ceremony might be middleware. For a regression fixture we want to leave nothing for the reviewer to pick at, so the verdict reflects only the criticals-resolved delta.

---

### E2E-19: Confidence scores hidden by default

**Behavior**: a fresh MergeWatch install should NOT render `XX%` confidence badges next to findings. The flag still exists (`InstallationSettings.summary.confidenceScore`) and users can opt back in via the dashboard, but the default is off because LLM-self-reported confidence has been observed to be miscalibrated against actual hit rate.

**Setup**

Branch: `fixture/19-confidence-default-off`. Make any change that's likely to produce a finding with non-empty confidence (e.g., add code with a clearly-named TODO that triggers the bug agent):

`src/cache.ts`:

```ts
export function getCached<T>(key: string): T | null {
  // TODO: this currently returns stale data after invalidation — fix me.
  return cache.get(key) ?? null;
}

declare const cache: Map<string, unknown>;
```

No `.mergewatch.yml`. Don't touch any dashboard settings.

**Expected outcomes**

- [ ] Summary comment includes a "Requires your attention" or "Info" section with at least one finding
- [ ] **No finding row contains a `XX%` badge** — neither in the action-items table nor in the collapsible Info section
- [ ] If you turn the setting back on (Settings → Summary → "Show confidence scores"), the next review's findings DO show the badge

**Failure modes**
- ❌ `85%`, `90%`, etc. badges appear in finding rows on a default install (regression of the default flip)
- ❌ The setting toggle in the dashboard doesn't have any effect

---

### E2E-20: PR description vs code drift catch

**Behavior**: when a PR's description claims behavior that the diff has since dropped or changed, the reviewer flags the discrepancy. This is a genuine catch the bot got right in user testing ("PR #18 description still said 'localStorage persistence' after I'd dropped it in commit c1e3a06").

This is more of a *spot-check* than a hard pass/fail — the LLM doesn't always catch description drift, but it should at least notice on obvious cases.

**Setup**

Branch: `fixture/20-description-drift`. Make TWO commits:

**Commit 1** — implement the behavior the description will describe:

`src/persistence.ts`:

```ts
export function savePref(key: string, value: string): void {
  localStorage.setItem(`pref:${key}`, value);
}
```

**Commit 2** — drop the localStorage usage in favor of an in-memory map:

```ts
const memCache = new Map<string, string>();
export function savePref(key: string, value: string): void {
  memCache.set(`pref:${key}`, value);
}
```

Open the PR with this body — **deliberately stale**:

```markdown
This PR adds preference persistence using `localStorage.setItem` so
user choices survive page reloads. The key format is `pref:<name>`.
```

**Expected outcomes** (spot-check, not strict pass/fail)

- [ ] At least one info or warning finding mentions that the PR description references `localStorage` but the diff has dropped it
- [ ] The mismatch surfaces in the summary text or the "Requires your attention" table
- [ ] Bonus: the reviewer's verdict reason or summary notes the description should be updated

**Note**: this is the only fixture where a miss isn't necessarily a bug. PR-description drift detection is best-effort. If MergeWatch never catches it, that's a quality-bar to raise; if it catches some but not all, log the misses for prompt tuning.

---

### E2E-21: No-op-suggestion guard (W1)

**Behavior**: a finding whose suggested fix is *already what the code does* is dropped outright (any severity). `groundFinding` runs `suggestionAlreadyApplied()`: it splits the suggestion into code-shaped segments and drops the finding when every such segment already appears (whitespace-normalized) in the file.

Distinct from E2E-17 (which is about an *anchor on a comment line* / identifier-absence). Here the identifier **is** present and on the right line — the tell is that the suggested replacement equals the existing code. This is the deterministic, zero-LLM guard; the canonical case is voice-bot #31 (suggestion `const run = await migrationRunner({` on a line that already reads exactly that).

**Setup**

Branch: `fixture/21-noop-suggestion`. Add `src/already-awaited.ts`:

```ts
export async function runMigrations(): Promise<string[]> {
  const run = await migrationRunner({ dir: 'migrations', direction: 'up' });
  return run.map((m) => m.name);
}

declare function migrationRunner(opts: { dir: string; direction: 'up' | 'down' }): Promise<{ name: string }[]>;
```

No `.mergewatch.yml` needed.

**Expected outcomes**

- [ ] No finding titled/described as "missing await on `migrationRunner`" (or similar) survives to the rendered comment
- [ ] If an agent emitted one, logs show it dropped by the no-op guard (suggestion already present), not merely line-snapped
- [ ] `Suppressed N` count reflects the drop

**Failure modes**
- ❌ A critical/warning "missing await" rendered with a suggestion that is byte-identical to the cited line (the #31 regression)

**Note**: stochastic on a real LLM. To force it in a self-hosted run, inject into the orchestrator response: `{ "file": "src/already-awaited.ts", "line": 2, "severity": "critical", "title": "Missing await on async migrationRunner call", "description": "migrationRunner result is not awaited.", "suggestion": "Add await before migrationRunner: const run = await migrationRunner({" }` — the guard must drop it.

---

### E2E-22: Claim-aware critical verification (W2)

**Behavior**: a CRITICAL derived from a truncated diff — where the cited identifier *is* present near the anchor (so structural grounding passes it) but the claim is false against the full file — is dropped by the LLM verification pass (`verifyCriticalFindings`, `CRITICAL_VERIFICATION_PROMPT`) using the **complete** file fetched via the always-on `groundingFetch` context. Fail-safe: missing file / LLM error / unparseable output keeps the finding.

This is the gap E2E-17 cannot close (identifier presence ≠ claim truth) and the systemic false positive in voice-bot #31 *and* #39 ("missing await on async X" with line numbers that pointed at the call site while the `await` was just outside the hunk).

**Setup**

Branch: `fixture/22-claim-aware-verify`. Add `src/kb.ts` so the awaited assignment sits on an unchanged context line and only the downstream use is in the hunk (mimics the real truncated-hunk failure):

```ts
export async function loadKb(): Promise<number> {
  const rows = await kbStore.searchCandidates(queryEmbedding, 8);
  const names = rows.map((r) => r.id);          // <-- diff-changed line
  return names.length;                          // <-- diff-changed line
}

declare const queryEmbedding: number[];
declare const kbStore: { searchCandidates(q: number[], k: number): Promise<{ id: string }[]> };
```

PR diff should only touch the `.map(...)` / `return` lines (so the `const rows = await …` line is unchanged context).

**Expected outcomes**

- [ ] No surviving CRITICAL claiming `searchCandidates` is unawaited / a missing-await race
- [ ] If an agent produced one, logs show `[critical-verify] dropped false-positive critical … ` with a reason citing the `await` on the assignment line
- [ ] A genuinely-unawaited variant (delete the `await`) is still reported (verification doesn't blanket-suppress)
- [ ] LLM/infra failure path keeps the finding (do not regress the fail-safe — exercise by pointing at an unreachable model in a self-hosted run)

**Failure modes**
- ❌ "Missing await" critical rendered despite `const rows = await kbStore.searchCandidates(...)` in the file (#31/#39 regression)
- ❌ Verification drops a *real* missing-await when the `await` is genuinely absent (over-suppression)

---

### E2E-23: Re-review convergence — no whack-a-mole (W9+W3)

**Behavior**: across commits, the same underlying concern keeps a stable identity and a rebutted finding is not regenerated. Specifically: (a) no finding appears as both **✅ Resolved** and **🆕 new** in the same review comment; (b) a finding the author rebutted in a `## mergewatch triage` reply on a prior commit is **not** re-raised under a drifted title/line on the next commit.

**Status:**
- **(a) — W9 SHIPPED** (PR #147): `computeReviewDelta` union-matches on a code fingerprint (`fingerprintFromCode`, normalized cited line) OR the title, so a line-shift + LLM reword no longer reads as resolved+new. Unit-locked in `review-delta.test.ts` ("the whack-a-mole case").
- **(b) — W3 SHIPPED**: a prior `## mergewatch triage` reply is mapped (one light-model call, `computeDisputedKeys`) onto the prior findings' stable keys; current findings whose key intersects the rebutted/deferred set are suppressed (`partitionDisputed`) before delta + scoring, with a `[triage-suppressed]` audit log. Fail-open (any error suppresses nothing). Unit-locked in `triage.test.ts`. Code-anchored: editing the cited code changes the fingerprint, so a rebuttal stops applying once the code materially changes.

Live evidence this card defends: **PR #145 round 2** reported `:1207 "Catch-and-continue pattern…"` as 🆕 new while the *same code* (`:1225 "Broad exception catching…"`) was listed ✅ Resolved in the same comment.

**Setup**

Two-commit sequence on branch `fixture/23-convergence`.

**Step 1** — open a PR with a function that reliably draws one stable warning (e.g. a broad `catch {}` that swallows an error). Let MergeWatch review; note the finding's title + line.

**Step 2** — post a PR comment starting `## mergewatch triage` that rebuts the finding *by design* (e.g. "the catch-all is the intentional fail-safe; logging added"), then push a small commit that adds the log line (shifts subsequent line numbers).

**Expected outcomes**

- [x] **(a) W9** The re-review's "📎 Previously reported" section does **not** list the same concern under both ✅ Resolved and 🆕 new (the catch line is unchanged → matched by fingerprint despite the reworded title and shifted line)
- [x] **(b) W3** The rebutted finding is **suppressed** — not re-raised as 🆕 new under a reworded title (check the agent log for a `[triage-suppressed]` line and that `Suppressed N` incremented)
- [x] **(a) W9** `🆕 new` counts only genuinely new concerns introduced by the step-2 diff (line drift alone produces zero "new")
- [x] **(b) W3** Verdict converges across commits once rebutted findings stop regenerating
- [ ] **Regression check** — push a *third* commit that materially rewrites the rebutted code; confirm the finding *does* resurface (rebuttal is code-anchored, not permanent)

**Failure modes**
- ✅ FIXED (W9) — Same finding simultaneously ✅ Resolved and 🆕 new (identity churned on title/line drift — P9). Regression-locked in `review-delta.test.ts`.
- ✅ FIXED (W3) — A `mergewatch triage`-rebutted finding reappears verbatim-in-substance at a new line (P3/P7). Regression-locked in `triage.test.ts`.
- ❌ WATCH — over-suppression: a rebutted finding that becomes real again after a code rewrite must resurface (the code-anchored fingerprint provides this; the regression-check step verifies it).

**Note**: both halves are now real regression guards (don't delete). The remaining manual step is the over-suppression regression check — automate it if it proves flaky.

---

## Quick smoke test (5 minutes)

When you just want to confirm the deploy didn't immediately break things:

1. Run **E2E-01** (clean PR → APPROVE).
2. Run **E2E-04** (autoReview off → silent).
3. Run **E2E-06** (docs-only → visible skip).

If all three pass, the deploy is at least minimally healthy. Full run gives much higher confidence.

---

## Troubleshooting

**MergeWatch didn't react at all within 60s**
- Check the App is installed on the fixtures repo (GitHub → Settings → Apps).
- Check webhook delivery: GitHub → fixtures repo → Settings → Webhooks → look for failed deliveries.
- SaaS: `pnpm run logs:webhook` (root) — search for the PR number.
- Self-hosted: `docker logs mergewatch-server`.

**Review took longer than 3 minutes**
- Bedrock TPM throttling — check CloudWatch metrics for `InvokeModelInvocationsThrottled`.
- Check `withConcurrency` is capped at 3 (in `packages/core/src/agents/reviewer.ts`).

**Summary comment appears but no formal PR review**
- Check `submitPRReview` IAM permissions (App needs `Pull requests: write`).
- Check the dismissStaleReviews call didn't throw — look for `dismissStaleReviews failed` in logs.

**Multiple summary comments instead of one edited**
- `findExistingBotComment` is failing — check `BOT_COMMENT_MARKER` matching logic.
- Could be a DynamoDB lookup issue if the cached comment ID is stale.

---

## Future automation

When this runbook stops feeling like fun, build the harness:

1. A `e2e/fixtures/` directory with one subdirectory per fixture (`01-clean-pr/`, etc.), each containing:
   - `mergewatch.yml` (the config)
   - `diff.patch` (the change to apply)
   - `expected.json` (asserted outcomes — check runs by name, comment body substrings, reactions, PR review state)
2. A `e2e/run.ts` script that:
   - Takes a fixture name
   - Resets the fixtures repo to `e2e-baseline`
   - Applies the patch, opens a PR via `gh pr create`
   - Polls for `n` seconds waiting for `expected.json` conditions
   - Reports pass/fail
3. A GitHub Action on the main repo that runs `e2e/run.ts` against every fixture nightly + after every deploy.

The main flakiness risk is webhook timing (asynchronous Lambda invokes can take 30-90s). Build in generous timeouts with retries.

---

## Update protocol

When you ship a new user-visible behavior:

1. Add a new fixture card to this file in the same PR.
2. Add the fixture to the regression checklist table.
3. Increment any related fixture's expected outcomes if the change affects them (e.g., a new comment section).
4. Note the PR number in the "Verifies PR #" column so future maintainers know why the fixture exists.

Keep the runbook as the source of truth for "what MergeWatch promises to do on a PR."
