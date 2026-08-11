# MergeWatch documentation

The source for [docs.mergewatch.ai](https://docs.mergewatch.ai) — the user-facing documentation for MergeWatch, an open-source AI code review GitHub App.

Built with [Mintlify](https://mintlify.com). Pages are MDX files with YAML frontmatter; navigation and site config live in [`docs.json`](./docs.json).

## Directory layout

```
docs-site/
├── docs.json                 # Mintlify nav, theme, metadata
├── overview/                 # What MergeWatch is and how to get started
├── self-hosting/             # Docker Compose install + LLM providers + platform guides
├── configuration/            # .mergewatch.yml, skip rules, conventions, custom instructions
├── github-app/               # Permissions, webhook events, install flows
├── deployment/               # Architecture, deployment models, SAM template reference
├── dashboard/                # Dashboard pages (reviews, analytics, settings, etc.)
├── saas/                     # Managed SaaS — getting started, billing, data residency
├── reference/                # CLI/commands, env vars, changelog, FAQ, troubleshooting
├── comparisons/              # MergeWatch vs. other review tools
├── images/ logo/ favicon.svg # Assets
└── AGENTS.md                 # Style + terminology guide for contributors and AI tools
```

Not to be confused with [`docs/`](https://github.com/mergewatch/mergewatch.ai/tree/main/docs)
at the repo root, which holds internal engineering notes and plans and is **not** published.

## Local development

Install the Mintlify CLI:

```bash
npm i -g mint
```

From this directory (where `docs.json` lives):

```bash
cd docs-site
mint dev
```

This serves the site at [http://localhost:3000](http://localhost:3000) with live reload.

Check for broken internal links before opening a PR:

```bash
mint broken-links
```

## Contributing

1. Branch from `main` (e.g., `fix/env-vars-clarification`, `docs/new-platform-guide`).
2. Edit or add MDX files. When adding a new page, include it in the relevant group inside `docs.json` so it appears in the nav.
3. Follow the style rules in [`AGENTS.md`](./AGENTS.md) — active voice, sentence-case headings, bold for UI elements, code formatting for file names and commands.
4. Run `mint dev` to preview and `mint broken-links` to verify links.
5. Open a PR. Mintlify auto-deploys from `main` once merged.

Because the docs now live alongside the code, a change that alters documented
behavior should update the relevant page in the same PR. When fixing existing
drift, cite the source of truth in the PR description (e.g.
`packages/core/src/config/defaults.ts:120` or `infra/template.yaml:59`) so the
claim can be verified.

## Deployment

Pushes to `main` deploy automatically to [docs.mergewatch.ai](https://docs.mergewatch.ai) via the [Mintlify GitHub App](https://dashboard.mintlify.com/settings/organization/github-app), which is configured to build from the `docs-site` content directory. There is no separate build or publish step, and the docs site is not part of the pnpm workspace or the Turbo pipeline.

## AI-assisted writing

This directory includes an [`AGENTS.md`](./AGENTS.md) with style conventions, scoped to the docs tree. For Mintlify-specific component and configuration guidance, install the Mintlify skill into your AI tool:

```bash
npx skills add https://mintlify.com/docs
```

Works with Claude Code, Cursor, Windsurf, and other AI tools that support [skills](https://mintlify.com/docs/ai-tools).

## Getting help

- **MergeWatch product questions**: [open an issue](https://github.com/mergewatch/mergewatch.ai/issues)
- **Docs issues (typos, broken links, unclear pages)**: open an issue or PR against `docs-site/`
- **Mintlify platform questions**: [mintlify.com/docs](https://mintlify.com/docs)

## License

Documentation content in this directory is licensed under [MIT](./LICENSE). The MergeWatch product itself is licensed under [AGPL v3](https://github.com/mergewatch/mergewatch.ai/blob/main/LICENSE).
