# docs/feat — feature plans

Phased implementation plans for **features / enhancements / new user-visible behavior**, authored by the [`/ship-feature`](../../.claude/skills/ship-feature.md) skill before any code is written.

**Naming:** `YYYYMMDD-NN-<kebab-name>.plan.md` — date the plan was created, a 2-digit per-day sequence, and the feature slug (e.g. `20260620-01-time-to-merge.plan.md`).

Each plan is approved up front, then drives a series of small **stacked PRs** (one per phase). The user-facing feature doc is built separately in [`docs/pending/`](../pending) and graduates to `docs/<feature>.md` when the feature ships. Chores/refactors/infra plans live in [`docs/chore/`](../chore) instead.
