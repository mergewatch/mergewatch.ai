---
description: Triage the latest MergeWatch review on a PR — verify each finding against the actual code, apply real fixes, reject false positives with evidence, post a structured reply on the PR
argument-hint: <PR-number> (defaults to the PR for the current branch)
allowed-tools: Bash, Read, Edit, Grep, Write
---

# /resolve-mergewatch

Walk a MergeWatch review on a PR, finding by finding, **verifying each claim against the actual code before applying or rejecting it**. Apply the real fixes, defend the design choices, post a single structured reply. Stay strictly within the PR's review surface — no cross-PR analysis, no follow-up-issue filing, no trend commentary.

## Inputs

- **PR number** — passed as `$1`. When omitted, resolve from the current branch via `gh pr view --json number`.

## Step-by-step

### 1. Fetch the latest review

```bash
# PR number from arg or current branch
PR=${1:-$(gh pr view --json number -q .number)}

# Review state (COMMENTED / CHANGES_REQUESTED / DISMISSED)
gh api repos/{owner}/{repo}/pulls/$PR/reviews \
  --jq '.[] | select(.user.login == "mergewatch[bot]") | {id, state, submitted_at, commit_id}'

# Latest top-level review body (the renderable markdown)
gh api repos/{owner}/{repo}/issues/$PR/comments \
  --jq '.[] | select(.user.login == "mergewatch[bot]") | {id, created_at}'
gh api repos/{owner}/{repo}/issues/comments/<id> --jq '.body'
```

If MW edited the comment after a fix commit (the "✅ N resolved · 🆕 M new" header form), read the **updated body** — that's the most recent state. There may also be line-anchored review comments via:

```bash
gh api repos/{owner}/{repo}/pulls/$PR/comments --jq '.[] | {id, line, path, body}'
```

(CodeQL / github-advanced-security findings live here.)

### 2. Enumerate findings

The MW comment is markdown. Parse out:

1. **"Requires your attention" table** — the user-visible warning rows (typically 2–4).
2. **🟡 Warnings collapsible** — same rows PLUS W10 cluster siblings ("and N related concerns" → list under "Related concerns clustered into this finding"). **Each cluster sibling is a distinct finding** even though it renders under one row.
3. **🔵 Info collapsible** — info-level findings. Some are W11-suppression notes (test coverage) which are *the system working as designed*, not findings to act on.
4. **🔴 Critical** (if present) — appears under a separate `### 🔴 Critical (N)` section.

For each, capture: **file path, line number, severity, title, suggestion text**.

### 3. Verify each finding against the code

**This is the most important step. Do not trust the finding's claim at face value.**

For each finding:

```bash
# Read the exact cited line + ±10 lines context
# Use the Read tool with `file_path`, `offset`, `limit`
```

Ask explicitly:

- **Does the code at the cited line actually exhibit the described defect?** Read the lines. Trace the data flow. Don't infer from the title.
- **For cluster siblings**: read each cited line independently. W10 clustering can put unrelated lines under one cluster head; verify the *anchor* on each.
- **Is the suggested fix already present in the code?** (FP-I's territory — but you still need to read the file to confirm.)
- **For "X injection" / security findings**: trace whether the data flows through an ORM (Drizzle `eq()`, Prisma `where`, etc.), an AWS SDK placeholder (`:foo`), `encodeURIComponent`, or other parameterising abstraction. If so, the threat is neutralised.

### 4. Classify each finding

| Tier | When |
|---|---|
| ✅ **VALID** | The cited code actually exhibits the defect AND the suggested fix is genuinely an improvement. **Apply.** |
| 🟡 **PARTIAL** | The reviewer surfaced a real concern but the fix overshoots, OR the concern is real but the right fix is structural (different from what they suggested), OR the issue is real but addressed by an adjacent design choice you can document. **Apply a smaller fix and/or strengthen the comment.** |
| 🟡 **DESIGN** | The code is intentional and the reviewer didn't see the design context. Examples: fail-open analytics writes, intentional re-throws on enumeration failure, defaults-on-flaky-GitHub. **Do not change code — defend with evidence in the reply.** |
| ❌ **FALSE** | The reviewer's claim doesn't hold on the actual code. Examples: ReDoS on `String#indexOf` (not a regex), SQL injection on Drizzle `eq()` (parameterised), URL injection on a server-trusted prop, math claim that's provably non-negative. **Reject with technical evidence.** |
| ℹ️ **WORKING AS DESIGNED** | W11 suppression notes, W3 carry-forward annotations, etc. — informational only, not actionable. **Mention but don't action.** |

### 5. Apply real fixes (VALID + PARTIAL)

Use Edit tool. Keep changes **surgical** — only the cited code, only the change the reviewer suggested (or the smaller version of it).

**Defensive fixes are OK even when math is provably correct.** Example: if the reviewer says "this subtraction could go negative" and your code chain is provably non-negative, you can still wrap each step in `Math.max(0, ...)` as belt-and-braces against future refactors that quietly break the invariant. State this in the commit message ("provably non-negative today, but the wrapper protects future refactors").

**Always add a code comment** when defending a design choice that MW will see on the next re-review — this prevents the same finding firing again. Example:

```ts
// We deliberately do NOT wrap this throw in try/catch — see PR #169 review
// thread for why. The throw bubbles to the Lambda runtime → invocation
// marked failed → CloudWatch alarm. Adding a catch would re-introduce the
// visibility gap the prior review asked us to fix.
```

### 6. Build + test before commit

```bash
pnpm run build 2>&1 | tail -3
pnpm run typecheck 2>&1 | tail -3
pnpm run test:coverage 2>&1 | tail -3
```

All three must be clean. If any task fails, fix it before committing — don't ship a "fix MW review" commit that breaks CI.

### 7. Commit with the canonical message structure

```
fix(scope): address MW review on PR #<N>

<one-line summary of net effect>

✅ APPLIED — <one-line title for each applied fix>
<paragraph: what changed and why. Reference the finding location.>

✅ APPLIED — <next applied fix title>
<paragraph>

🟡 DISAGREE — <finding title>
<paragraph: technical evidence for why the claim doesn't hold on the
actual code. Be specific: name the line, the function, the abstraction.>

🟡 DESIGN — <finding title>
<paragraph: explain the intentional choice + reference any prior PR
where the design was discussed.>

Local validation: <build / typecheck / coverage status>.

Co-Authored-By: <model> <noreply@anthropic.com>
```

Don't categorise findings as "info" or "warning" in the commit — group by **what you did** (APPLIED / DISAGREE / DESIGN). The reviewer can re-derive the original severity from the PR thread.

### 8. Push

```bash
git push
```

### 9. Post the reply on the PR

```bash
gh pr comment <PR> --body "$(cat <<'EOF'
Triaged in commit `<short-sha>`.

### Applied ✅

1. **<finding title or location>** — <one-line: what you changed and why it
   matched the reviewer's concern>.
2. **<next>** — <one-line>.

### Disagree 🟡

3. **<finding title or location>** — <one-line: technical evidence for
   why the claim doesn't hold on the actual code>.
4. **<finding title or location>** — <one-line: design choice + reference>.

Local validation: `pnpm run build` 12/12; `pnpm run test:coverage` 20/20.
EOF
)"
```

Format conventions:

- Use **bold** for the finding's location or short title (file:line or "doc accuracy on route comment").
- One sentence per finding. The full reasoning lives in the commit message; the PR comment is the summary.
- Number them across BOTH sections (1 → 2 → 3 → 4) so cross-references work.
- End with the local validation line — short, factual.

## Common false-positive shapes to watch for

When verifying findings, the following patterns recur. Be especially careful to read the actual code when you see them:

- **"ReDoS"** on a line that uses `String#indexOf` / `String#includes` / `String#lastIndexOf` — these are not regexes; they're O(n) linear searches with no backtracking. **False.**
- **"SQL injection"** on a line that uses an ORM query builder (`eq(col, val)` / `where: { x }` / `.where(col, val)`) — ORMs parameterise. **False unless raw string SQL is concatenated.**
- **"URL injection"** on a `fetch(...)` whose interpolated value is wrapped in `encodeURIComponent` — the encoding prevents injection. **False unless the value is concatenated raw.**
- **"Unhandled promise rejection"** on a Lambda handler that intentionally throws — see if there's a JSDoc explaining the throw is the fix. **Usually design when the function's role is "run-and-fail-to-CloudWatch".**
- **"Negative value" / "off-by-one"** on math you can prove correct by induction — read the prior lines, check the `Math.min` / `Math.max` clamps. **Often false; defensive wrapping is still OK to apply.**
- **Misanchored W10 cluster siblings** — the cluster head's complaint may be valid but the sibling lines (`:71`, `:82`, etc.) may point at unrelated code. **Verify each cited line independently.**
- **Wrong threat model** — env-var "injection" inside a Lambda where attackers with env control already have IAM creds; "container escape" on code that runs in a managed runtime; etc. **False — the prerequisite for the threat already implies compromise of a stronger boundary.**
- **Self-contradicting on re-reviews** — if the prior MW review said "do X" and the current one critiques the application of X (e.g. round-1: "re-throw on failure"; round-2: "this throw is unhandled"), the current finding is almost certainly wrong. **Defend with a doc comment in the source so the next re-review sees the intentional choice.**

## Scope discipline

Stay strictly within the PR's review surface. **Do not** in this skill:

- Open follow-up issues for newly-observed FP patterns.
- Cross-reference past PRs' hit rates.
- Speculate about systemic MW behaviour or propose new FP-* workstreams.
- Generate cross-PR trend tables.

If a pattern feels worth filing separately, surface it to the user in chat AFTER the triage is complete — do not bake it into the PR reply.

## Output

When the skill finishes, summarise to the user:

- The PR number triaged
- Count of findings: total / applied / disagreed
- Commit SHA + PR reply URL
- Local validation status

Keep it to ~6 lines.
