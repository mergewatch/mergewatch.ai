# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MergeWatch is an open-source GitHub App that reviews pull requests using a multi-agent AI pipeline. It supports two deployment modes: **SaaS** (Lambda + DynamoDB + Bedrock) and **self-hosted** (Docker + Postgres + any LLM). It uses a pnpm monorepo with Turborepo for builds.

## Repository Structure (Monorepo)

```
packages/
  core/              — @mergewatch/core: Interfaces (ILLMProvider, IInstallationStore, IReviewStore,
                       IGitHubAuthProvider), review pipeline, agents, prompts, GitHub client, comment
                       formatter, skip logic, types, config. No AWS or Postgres deps.
  storage-dynamo/    — @mergewatch/storage-dynamo: DynamoDB implementations (SaaS path).
  storage-postgres/  — @mergewatch/storage-postgres: Postgres/Drizzle implementations (self-hosted).
  llm-bedrock/       — @mergewatch/llm-bedrock: Amazon Bedrock provider.
  llm-anthropic/     — @mergewatch/llm-anthropic: Anthropic direct API provider.
  llm-litellm/       — @mergewatch/llm-litellm: LiteLLM proxy (OpenAI-compatible, 100+ providers).
  llm-ollama/        — @mergewatch/llm-ollama: Ollama provider (local/air-gapped, experimental).
  lambda/            — @mergewatch/lambda: AWS Lambda handlers + SSM auth (SaaS path).
  server/            — @mergewatch/server: Express server + env auth (self-hosted path).
  dashboard/         — @mergewatch/dashboard: Next.js 15 dashboard (App Router, AWS Amplify).
infra/               — AWS SAM CloudFormation template
scripts/             — Deployment and SSM setup scripts
```

### Dependency Graph
```
core  ←  storage-dynamo   ←  lambda       (SaaS path)
core  ←  llm-bedrock      ←  lambda
core  ←  storage-postgres  ←  server      (self-hosted path)
core  ←  llm-anthropic     ←  server
core  ←  llm-litellm       ←  server
core  ←  llm-ollama        ←  server
core  ←  llm-bedrock       ←  server
core  ←  dashboard
```

## Common Commands

### Monorepo (from repo root)
```bash
pnpm install                   # Install all workspace dependencies
pnpm run build                 # Build all packages (Turborepo, respects dep order)
pnpm run typecheck             # TypeScript type checking across all packages
pnpm run deploy                # Deploy to AWS (prod)
pnpm run deploy:dev            # Deploy to dev stage
pnpm run logs:webhook          # Tail webhook Lambda logs
pnpm run logs:agent            # Tail review agent Lambda logs
```

### Self-hosted
```bash
docker-compose up -d           # Start server + Postgres
cp .env.example .env           # Configure (fill in GitHub App + LLM provider)
```

### Postgres Migrations (self-hosted)
The self-hosted server auto-runs Drizzle migrations on startup. When changing `packages/storage-postgres/src/schema.ts`:
```bash
cd packages/storage-postgres
pnpm run migrations:generate   # Generate migration SQL from schema diff
# IMPORTANT: Edit the generated SQL in drizzle/ to use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
pnpm run migrations:check      # Verify migrations match schema (CI runs this too)
```

### Dashboard (from packages/dashboard/)
```bash
cd packages/dashboard && pnpm run dev    # Local dev server (http://localhost:3000)
pnpm run build                           # Production build
pnpm run lint                            # Next.js linting
```

## Architecture

### Multi-Agent Pipeline
The review pipeline runs parallel specialized agents (security, bug, style, summary, diagram) via `Promise.all()`, then an orchestrator deduplicates findings and produces a merge readiness score (1-5). Key files:

- `packages/core/src/agents/reviewer.ts` — Pipeline orchestration via `runReviewPipeline(options, { llm })` with dependency-injected `ILLMProvider`
- `packages/core/src/agents/prompts.ts` — System prompts for each agent (JSON response format required)

### Interfaces (in @mergewatch/core)
- `ILLMProvider` — `invoke(modelId, prompt, maxTokens?)` — implemented by BedrockLLMProvider, AnthropicLLMProvider, LiteLLMProvider, OllamaLLMProvider
- `IInstallationStore` — `get()`, `getSettings()`, `upsert()` — implemented by DynamoInstallationStore, PostgresInstallationStore
- `IReviewStore` — `upsert()`, `updateStatus()`, `queryByPR()` — implemented by DynamoReviewStore, PostgresReviewStore
- `IGitHubAuthProvider` — `getInstallationOctokit()` — implemented by SSMGitHubAuthProvider (Lambda), EnvGitHubAuthProvider (server)

### SaaS Runtime (Lambda)
- `packages/lambda/src/handlers/webhook.ts` — Validates GitHub webhook signatures, parses events, invokes review agent Lambda
- `packages/lambda/src/handlers/review-agent.ts` — Main review logic: wires all providers, runs pipeline, posts comments
- `packages/lambda/src/github-auth-ssm.ts` — SSM-backed GitHub App auth + webhook secret

### Self-Hosted Runtime (Express)
- `packages/server/src/index.ts` — Express server entry point, wires Postgres + LLM factory
- `packages/server/src/webhook-handler.ts` — Webhook verification + event routing
- `packages/server/src/review-processor.ts` — Review pipeline processing (equivalent to Lambda review-agent)
- `packages/server/src/llm-factory.ts` — Creates LLM provider from `LLM_PROVIDER` env var
- `packages/server/src/github-auth-env.ts` — GitHub auth from env vars (no SSM)

### GitHub Integration
- `packages/core/src/github/client.ts` — Portable GitHub API ops: PR diffs, comments (upsert via `<!-- mergewatch-review -->` marker), Check Runs, reactions
- SaaS: credentials in AWS SSM Parameter Store
- Self-hosted: credentials in environment variables

### Data Layer
**SaaS (DynamoDB):** Two tables defined in `infra/template.yaml`:
- **mergewatch-installations** — PK: `installationId`, SK: `repoFullName` (or `#SETTINGS` for installation-level settings, `#AGENTS` for org custom agents)
- **mergewatch-reviews** — PK: `repoFullName`, SK: `prNumberCommitSha` (format: `42#abc123`). 90-day TTL.

**Self-hosted (Postgres):** Drizzle ORM schema in `packages/storage-postgres/src/schema.ts`:
- **installations** — composite PK (installation_id, repo_full_name)
- **installation_settings** — PK: installation_id
- **reviews** — composite PK (repo_full_name, pr_number_commit_sha)

Types in `packages/core/src/types/db.ts`, GitHub payload types in `packages/core/src/types/github.ts`.

### Web Dashboard
- **Auth**: NextAuth with GitHub OAuth provider (`packages/dashboard/lib/auth.ts`). Session exposes `accessToken` and `githubUserId`.
- **DynamoDB access**: Singleton client in `packages/dashboard/lib/dynamo.ts`, uses AWS credential chain (works locally with `aws configure`, on Amplify via IAM role).
- **GitHub API helpers**: `packages/dashboard/lib/github-repos.ts` — installation listing, repo fetching, admin checks.
- **Theming**: CSS custom properties in `packages/dashboard/app/globals.css` with semantic Tailwind tokens in `packages/dashboard/tailwind.config.ts`. Light/dark via `next-themes` with `class` strategy.
- **Amplify SSR caveat**: Server-side DynamoDB queries in page components can be unreliable. The dashboard uses client-side fetches to `/api/reviews` for review data. Env vars must be listed in `packages/dashboard/next.config.js` `env` block to be available at runtime.

### Key Patterns
- All server component pages use `export const dynamic = "force-dynamic"` to prevent caching
- Comment upsert: finds existing bot comment via HTML marker, DynamoDB lookup, or GitHub API scan
- Smart skip: `shouldSkipPR()` in `packages/core/src/skip-logic.ts` detects docs-only/lock-file PRs to avoid unnecessary LLM costs
- Installation settings stored as sentinel row with SK `#SETTINGS` in the installations table
- Org custom agents (#235): dashboard-defined, stored as the `#AGENTS` sentinel row (DynamoDB) / `installation_settings.custom_agents` jsonb (Postgres); selected by repo scope + path/language targeting, run in union with repo `.mergewatch.yml` `customAgents` (org wins), and a `blocking` agent's critical finding fails the check + requests changes. Logic in `packages/core/src/org-agents.ts`
- SaaS: Zero API keys — Lambda uses IAM instance profiles for Bedrock; GitHub credentials in SSM
- Self-hosted: LLM provider configurable via `LLM_PROVIDER` env var (anthropic, bedrock, litellm, ollama)

## Configuration

Per-repo config via `.mergewatch.yml` in repo root. See the self-referential `.mergewatch.yml` in this repo for the format. Settings can also be managed via the dashboard Settings page (stored in DynamoDB).

## Deployment

**SaaS:** Backend deploys via SAM (`scripts/deploy.sh`). Web dashboard deploys via AWS Amplify (connected to the `main` branch, app root set to `packages/dashboard`, auto-deploys on push).

**Self-hosted:** `docker-compose up -d` starts the Express server + Postgres. Configure via `.env` (copy from `.env.example`).
