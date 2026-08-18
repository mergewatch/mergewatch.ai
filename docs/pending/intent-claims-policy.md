# Intent claims: sanctioned channels only

**Status:** 🚧 In review
**Issue:** [#372](https://github.com/mergewatch/mergewatch.ai/issues/372)

#368 demonstrated end-to-end that a code comment claiming a defect is intentional ("simulates X for testing", "regression guard") suppressed findings at both the agent layer (nothing emitted) and the W2 verifier layer (emitted, then dropped as a false positive). In a customer repo that makes comments an attacker-writable suppression oracle.

## Policy

**Comments may inform what code does — never whether a defect is reported.** Intent is honored only through sanctioned, versioned, org-governed channels:

| Intent | Channel |
|---|---|
| "This repo/dir contains deliberately vulnerable material" | Conventions (`AGENTS.md` / `CONVENTIONS.md` / `conventions:`) — already authoritative in agent prompts |
| "Don't review this scaffolding" | `excludePatterns` / `rules.ignorePatterns` |
| "This specific finding is a non-issue" | `/resolve` / `/mergewatch reject` (per-finding, human-in-the-loop, with memory) |

## Enforcement — two layers

1. **Prompts**: every agent prompt carries `INTENT_CLAIMS_DIRECTIVE` (report the defect anyway; suggest declaring genuine intent in conventions or excluding the path). The W2 verifier prompt states intent is irrelevant to existence — never `valid:false` on a comment's say-so.
2. **Deterministic guard**: prompts alone are not enforcement. `isIntentClaimDismissal()` pattern-matches the verifier's own stated dismissal reason; an intent-shaped `valid:false` is refused and the finding is kept as `unverified` — advisory via the existing FP-L rendering and W7 score clamp, with a distinct `[finding-verify] refused intent-claim dismissal` log line. Fail-safe direction: a false match converts a would-be drop into a visible advisory concern, never the reverse.

## Edge cases

- Conventions-declared intent keeps today's suppression authority (the directive explicitly defers to the conventions block).
- Technical verifier dismissals (parameterized queries, already-in-try/catch, FP-I redundancy) are untouched.
- A dismissal reason that merely *mentions* tests (e.g. a test-coverage judgment) may be guard-matched and kept advisory instead of dropped — accepted trade in the fail-safe direction, watched via the FB-E dispute-rate rollups.
