# docs/pending — in-flight feature docs

User-facing feature documentation that is **still being built**. The [`/ship-feature`](../../.claude/skills/ship-feature.md) skill writes `docs/pending/<feature>.md` and fills it in phase by phase as the stacked PRs land (architecture, storage shapes, edge cases, config, cross-references).

When the final phase merges, the doc **graduates**: `git mv docs/pending/<feature>.md docs/<feature>.md`, its status flips to `✅ Shipped`, and the matching `e2e/RUNBOOK.md` scenarios flip to `✅ SHIPPED`.

A doc sitting here means the feature isn't fully shipped yet — see the corresponding plan in [`docs/feat/`](../feat) for status.
