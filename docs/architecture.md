# Architecture

MergeWatch is a multi-agent AI code review system with two deployment modes. This document covers the full architecture, data flow, and package design.

---

## Deployment Modes

| | SaaS | Self-Hosted |
|---|---|---|
| **Compute** | AWS Lambda | Any Docker host |
| **Storage** | DynamoDB | Postgres |
| **LLM** | Amazon Bedrock (IAM) | Anthropic, LiteLLM, Bedrock, Ollama |
| **Auth** | SSM Parameter Store | Environment variables |
| **Billing** | Stripe metered (planned) | Free forever |
| **Dashboard** | AWS Amplify | Separate container (planned) |

---

## Monorepo Package Map

```
packages/
  core/                 @mergewatch/core
  storage-dynamo/       @mergewatch/storage-dynamo
  storage-postgres/     @mergewatch/storage-postgres
  llm-bedrock/          @mergewatch/llm-bedrock
  llm-anthropic/        @mergewatch/llm-anthropic
  llm-litellm/          @mergewatch/llm-litellm
  llm-ollama/           @mergewatch/llm-ollama
  lambda/               @mergewatch/lambda
  server/               @mergewatch/server
  dashboard/            @mergewatch/dashboard
```

### Dependency Graph

```
                    ┌─── storage-dynamo ──┐
                    │                     ├─── lambda    (SaaS)
core ───────────────┼─── llm-bedrock ─────┘
                    │
                    │                     ┌─── server    (self-hosted)
                    ├─── storage-postgres ─┤
                    ├─── llm-anthropic ───┤
                    ├─── llm-litellm ─────┤
                    ├─── llm-ollama ──────┘
                    │
                    └─── dashboard
```

`core` has zero cloud dependencies. Everything in `core/` runs identically regardless of deployment mode.

---

## Core Interfaces

All agent logic depends only on these interfaces. No package in `core/` imports `@aws-sdk`, `pg`, or any provider SDK.

### ILLMProvider

```typescript
// packages/core/src/llm/types.ts
export interface ILLMProvider {
  invoke(modelId: string, prompt: string, maxTokens?: number): Promise<string>;
}
```

Implementations:

| Package | Class | Backend |
|---------|-------|---------|
| `llm-bedrock` | `BedrockLLMProvider` | AWS Bedrock SDK, detects model family (Anthropic vs Titan) |
| `llm-anthropic` | `AnthropicLLMProvider` | `@anthropic-ai/sdk` Messages API |
| `llm-litellm` | `LiteLLMProvider` | HTTP `fetch` to OpenAI-compatible `/chat/completions` |
| `llm-ollama` | `OllamaLLMProvider` | HTTP `fetch` to Ollama `/api/chat` |

### IInstallationStore

```typescript
// packages/core/src/storage/types.ts
export interface IInstallationStore {
  get(installationId: string, repoFullName: string): Promise<InstallationItem | null>;
  getSettings(installationId: string): Promise<InstallationSettings>;
  upsert(item: InstallationItem): Promise<void>;
}
```

Implementations:

| Package | Class | Backend |
|---------|-------|---------|
| `storage-dynamo` | `DynamoInstallationStore` | DynamoDB. Settings stored as sentinel row `SK=#SETTINGS`. |
| `storage-postgres` | `PostgresInstallationStore` | Postgres via Drizzle ORM. Separate `installation_settings` table. |

### IReviewStore

```typescript
export interface IReviewStore {
  upsert(review: ReviewItem): Promise<void>;
  updateStatus(repoFullName: string, key: string, status: ReviewStatus, extra?: Partial<ReviewItem>): Promise<void>;
  queryByPR(repoFullName: string, prPrefix: string, limit?: number): Promise<ReviewItem[]>;
}
```

Implementations:

| Package | Class | Backend |
|---------|-------|---------|
| `storage-dynamo` | `DynamoReviewStore` | DynamoDB. PK=`repoFullName`, SK=`prNumberCommitSha`. 90-day TTL. |
| `storage-postgres` | `PostgresReviewStore` | Postgres. Composite PK `(repo_full_name, pr_number_commit_sha)`. |

### IGitHubAuthProvider

```typescript
// packages/core/src/github/auth.ts
export interface IGitHubAuthProvider {
  getInstallationOctokit(installationId: number): Promise<Octokit>;
}
```

Implementations:

| Package | Class | Credential Source |
|---------|-------|-------------------|
| `lambda` | `SSMGitHubAuthProvider` | AWS SSM Parameter Store (cached in Lambda memory) |
| `server` | `EnvGitHubAuthProvider` | Constructor-injected App ID + private key |

---

## Multi-Agent Review Pipeline

The review pipeline is the core of MergeWatch. It runs entirely in `@mergewatch/core` with no cloud dependencies.

### Pipeline Flow

```
                          ┌── SecurityAgent ──┐
                          │                   │
diff + context ───────────┼── BugAgent ───────┼── Orchestrator ── ReviewResult
                          │                   │
                          ├── StyleAgent ──────┤
                          ├── SummaryAgent ────┤
                          └── DiagramAgent ────┘
```

All agents run in parallel via `Promise.all()`. The orchestrator deduplicates findings across agents, ranks by severity, applies confidence filtering, and assigns a merge readiness score (1-5).

### Entry Point

```typescript
// packages/core/src/agents/reviewer.ts
export async function runReviewPipeline(
  options: ReviewPipelineOptions,
  deps: { llm: ILLMProvider },
): Promise<ReviewPipelineResult>;
```

### Agent Responsibilities

| Agent | Model | Finds |
|-------|-------|-------|
| **Security** | Main (Sonnet) | Injection, auth flaws, secrets, crypto issues, SSRF, path traversal |
| **Bug** | Main (Sonnet) | Null deref, off-by-one, race conditions, resource leaks, missing awaits |
| **Style** | Main (Sonnet) | Code smells, duplication, naming, missing types, perf anti-patterns |
| **Summary** | Light (Haiku) | Human-readable PR summary (what changed, why, risks) |
| **Diagram** | Light (Haiku) | Mermaid diagram of architectural changes |

### Orchestrator Output

```typescript
export interface ReviewPipelineResult {
  summary: string;
  findings: OrchestratedFinding[];
  diagram: string;
  diagramCaption: string;
  mergeScore: number;        // 1-5
  mergeScoreReason: string;
}
```

Each finding includes:

```typescript
export interface OrchestratedFinding {
  file: string;
  line: number;
  severity: 'critical' | 'warning' | 'info';
  confidence: number;  // 1-100
  category: 'security' | 'bug' | 'style';
  title: string;
  description: string;
  suggestion: string;
}
```

### Merge Score

| Score | Meaning | Check Run |
|-------|---------|-----------|
| 5 | Safe to merge | `success` |
| 4 | Minor issues, safe to merge | `success` |
| 3 | Review recommended | `success` |
| 2 | Significant concerns | `failure` |
| 1 | Do not merge | `failure` |

### Smart Skip

Before running agents, `shouldSkipPR()` checks if the PR only touches files matching skip patterns (lock files, docs, config, dist). This avoids unnecessary LLM costs.

```typescript
// packages/core/src/skip-logic.ts
export function shouldSkipPR(files: string[]): string | null;
```

---

## SaaS Runtime (Lambda)

### Request Flow

```
GitHub Webhook POST
    │
    ▼
API Gateway (HTTP API)
    │
    ▼
WebhookHandler Lambda (256MB, 30s)
  ├─ Verify HMAC-SHA256 signature (SSM webhook secret)
  ├─ Parse X-GitHub-Event
  ├─ Route: pull_request / issue_comment / installation
  └─ Async invoke ReviewAgent Lambda (InvocationType=Event)
    │
    ▼
ReviewAgent Lambda (1024MB, 300s)
  ├─ SSMGitHubAuthProvider → Octokit
  ├─ getPRContext() + getPRDiff()
  ├─ shouldSkipPR()
  ├─ DynamoInstallationStore.get() + .getSettings()
  ├─ runReviewPipeline({ diff, context, ... }, { llm: BedrockLLMProvider })
  ├─ formatReviewComment()
  ├─ postReviewComment() or updateReviewComment()
  ├─ createCheckRun()
  └─ DynamoReviewStore.upsert() / .updateStatus()
```

### AWS Resources (SAM Template)

```
API Gateway (HTTP)      → WebhookHandler Lambda
                        → ReviewAgent Lambda (async invoke)

DynamoDB Tables:
  mergewatch-installations-{stage}   PK: installationId, SK: repoFullName
  mergewatch-reviews-{stage}         PK: repoFullName, SK: prNumberCommitSha (TTL: 90d)

SSM Parameters:
  /mergewatch/{stage}/github-app-id
  /mergewatch/{stage}/github-private-key
  /mergewatch/{stage}/github-webhook-secret

IAM Role:
  mergewatch-lambda-role-{stage}     Bedrock, DynamoDB, SSM, CloudWatch, Lambda:InvokeFunction
```

### Lambda Bundling

SAM uses esbuild to bundle each handler. `CodeUri: ../packages/lambda/src/` points at the Lambda source. esbuild follows pnpm workspace symlinks to resolve `@mergewatch/*` packages, producing a self-contained ~275KB bundle per handler.

---

## Self-Hosted Runtime (Express)

### Request Flow

```
GitHub Webhook POST
    │
    ▼
Express Server (:3000)
  ├─ POST /webhook
  │   ├─ Verify HMAC-SHA256 (env GITHUB_WEBHOOK_SECRET)
  │   ├─ Parse event type
  │   ├─ Return 200 immediately
  │   └─ Background: processReviewJob()
  │       ├─ EnvGitHubAuthProvider → Octokit
  │       ├─ getPRContext() + getPRDiff()
  │       ├─ shouldSkipPR()
  │       ├─ PostgresInstallationStore.get() + .getSettings()
  │       ├─ runReviewPipeline({ ... }, { llm: createLLMProvider() })
  │       ├─ formatReviewComment()
  │       ├─ postReviewComment() / updateReviewComment()
  │       ├─ createCheckRun()
  │       └─ PostgresReviewStore.upsert() / .updateStatus()
  │
  └─ GET /health → { status: "ok" }
```

### LLM Factory

```typescript
// packages/server/src/llm-factory.ts
export function createLLMProvider(): ILLMProvider {
  switch (process.env.LLM_PROVIDER) {
    case 'anthropic': return new AnthropicLLMProvider(process.env.ANTHROPIC_API_KEY!);
    case 'bedrock':   return new BedrockLLMProvider(process.env.AWS_REGION);
    case 'litellm':   return new LiteLLMProvider(process.env.LITELLM_BASE_URL!, process.env.LITELLM_API_KEY);
    case 'ollama':    return new OllamaLLMProvider(process.env.OLLAMA_BASE_URL);
  }
}
```

### Docker Deployment

```yaml
# docker-compose.yml
services:
  mergewatch:       # Express server
    build: .
    ports: ["3000:3000"]
    depends_on: [db]
  db:               # Postgres 16
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
```

Self-hosted onboarding:

```bash
cp .env.example .env    # Fill in GitHub App + LLM provider
docker-compose up -d    # Done
```

### LLM Provider Compatibility

| `LLM_PROVIDER` | Needs AWS? | Works everywhere? | Notes |
|-----------------|-----------|-------------------|-------|
| `anthropic` | No | Yes | Recommended default. Just an API key. |
| `litellm` | No | Yes | Run LiteLLM proxy — unlocks OpenAI, Azure, Gemini, Mistral, Cohere, 100+ more. |
| `ollama` | No | Yes | Local models. Air-gap capable. Experimental — review quality is lower. |
| `bedrock` | Yes | AWS only | IAM-native. Default for SaaS. |

---

## Data Model

### InstallationItem

Represents a GitHub App installation on a specific repository.

| Field | Type | Description |
|-------|------|-------------|
| `installationId` | string | GitHub App installation ID |
| `repoFullName` | string | `owner/repo` |
| `installedAt` | string (ISO 8601) | When the app was installed |
| `config` | RepoConfig | Per-repo settings from `.mergewatch.yml` |
| `modelId` | string? | Per-repo model override |

**DynamoDB key:** PK=`installationId`, SK=`repoFullName`
**Postgres:** Composite PK `(installation_id, repo_full_name)`

### InstallationSettings

Installation-wide settings (applies to all repos under this installation). Managed via the dashboard Settings page.

| Field | Type | Default |
|-------|------|---------|
| `severityThreshold` | `'Low' \| 'Med' \| 'High'` | `'Low'` |
| `commentTypes` | `{ syntax, logic, style: boolean }` | All `true` |
| `maxComments` | number | `25` |
| `summary` | `{ prSummary, confidenceScore, issuesTable, diagram: boolean }` | All `true` |
| `customInstructions` | string | `''` |
| `commentHeader` | string | `''` |

**DynamoDB:** Stored as sentinel row with SK=`#SETTINGS`
**Postgres:** Separate `installation_settings` table, PK=`installation_id`

### ReviewItem

A single review of a PR at a specific commit.

| Field | Type | Description |
|-------|------|-------------|
| `repoFullName` | string | `owner/repo` |
| `prNumberCommitSha` | string | `42#abc123` (PR number + short SHA) |
| `status` | enum | `pending`, `in_progress`, `complete`, `failed`, `skipped` |
| `createdAt` | string (ISO 8601) | |
| `completedAt` | string? | |
| `prTitle` | string? | |
| `prAuthor` | string? | |
| `commentId` | number? | GitHub comment ID (for upsert) |
| `model` | string? | Model used for this review |
| `durationMs` | number? | Wall-clock time |
| `findingCount` | number? | |
| `topSeverity` | enum? | Highest severity finding |
| `mergeScore` | number? | 1-5 |
| `findings` | ReviewFinding[]? | Full finding details |
| `feedback` | `'up' \| 'down'`? | User feedback from dashboard |

**DynamoDB key:** PK=`repoFullName`, SK=`prNumberCommitSha`. 90-day TTL.
**Postgres:** Composite PK `(repo_full_name, pr_number_commit_sha)`. Indexes on `installation_id` and `repo_full_name`.

---

## GitHub Integration

### Webhook Events

| Event | Action | Behavior |
|-------|--------|----------|
| `pull_request` | `opened` | Run full review |
| `pull_request` | `synchronize` | Run full review (new commits pushed) |
| `issue_comment` | `created` with `@mergewatch` | Run review / summary / respond based on command |
| `installation` | `created` | Store installation + repo records |

### Comment Management

Bot comments use a hidden HTML marker for upsert:

```html
<!-- mergewatch-review -->
```

On subsequent reviews of the same PR, MergeWatch finds and updates the existing comment rather than posting a new one. Lookup order:

1. `existingCommentId` from previous review record in DB
2. `findExistingBotComment()` — paginate PR comments looking for marker

### Check Runs

Each completed review creates a GitHub Check Run on the head commit:
- **Name:** `MergeWatch Review`
- **Conclusion:** `success` if no critical findings, `failure` if critical findings exist
- **Title:** `Score: {mergeScore}/5`
- **Summary:** Review summary text

---

## Configuration

### MergeWatchConfig

Runtime configuration merged from defaults + per-repo `.mergewatch.yml` + installation settings.

```typescript
export interface MergeWatchConfig {
  model: string;                    // Main model (Sonnet)
  lightModel: string;               // Cost-optimized model (Haiku)
  maxTokensPerAgent: number;         // Default: 4096
  agents: {
    security: boolean;
    bugs: boolean;
    style: boolean;
    summary: boolean;
  };
  customStyleRules: string[];
  excludePatterns: string[];
  minSeverity: 'info' | 'warning' | 'critical';
  maxFindings: number;               // Default: 25
  postSummaryOnClean: boolean;       // Post comment even if no findings
}
```

### Configuration Hierarchy

```
Code defaults (DEFAULT_CONFIG)
  └── Installation settings (DynamoDB / Postgres)
        └── Per-repo .mergewatch.yml (RepoConfig)
              └── LLM_MODEL env override (self-hosted only)
```

---

## Comment Formatting

`formatReviewComment()` produces a structured GitHub markdown comment:

```
<!-- mergewatch-review -->
[Logo]
[Merge Readiness Badge: 1-5 with color]

<details><summary>Summary</summary>
  PR summary text
</details>

<details><summary>Architecture Diagram</summary>
  Mermaid diagram
</details>

### Findings (N issues)
| Severity | File | Title | Confidence |
|----------|------|-------|------------|
| ...      | ...  | ...   | ...        |

[Finding details with descriptions and suggestions]

[Footer with dashboard link]
```

---

## Billing (Planned — Step 12)

Billing applies only to the SaaS deployment mode. Self-hosted installations are free forever by design.

### Design

- **Provider:** Stripe metered billing
- **Unit:** Per PR reviewed (not per agent invocation)
- **Gate:** `checkBilling()` runs before the review pipeline in SaaS mode
- **Recording:** `recordUsage()` creates a Stripe usage record after each review
- **Enforcement:** Reviews are blocked (not queued) when billing is in a `block` state

### Planned Data Model Extensions

The `InstallationItem` would gain billing fields for SaaS:

```typescript
// SaaS-only fields (not present in self-hosted Postgres schema)
stripeCustomerId?: string;
stripeSubscriptionId?: string;
billingStatus?: 'active' | 'trial' | 'past_due' | 'canceled';
reviewCount?: number;           // Current billing period
reviewLimit?: number;           // Plan limit (null = unlimited)
```

### Planned Resources

| Resource | Purpose |
|----------|---------|
| `BillingHandler Lambda` | Stripe webhook handler (subscription events) |
| DynamoDB GSI: `stripe-customer-index` | Look up installation by Stripe customer ID |
| SSM: `/mergewatch/{stage}/stripe-secret-key` | Stripe API key |
| SSM: `/mergewatch/{stage}/stripe-webhook-secret` | Stripe webhook signing secret |

### Planned Pipeline Integration

```typescript
// In core/pipeline.ts (SaaS path only)
export async function runReviewPipeline(params, deps) {
  const billingStatus = await checkBilling(params.installationId, deps.installations);
  if (billingStatus === 'block') return { blocked: true };

  // ... run agents ...

  await recordUsage(params.installationId, deps.installations);
  return result;
}
```

### Pricing Model (Planned)

Graduated metered pricing via Stripe:

| Tier | Price per PR |
|------|-------------|
| First 100 PRs/month | Free |
| 101-500 | $0.50 |
| 501+ | $0.25 |

Self-hosted users never hit this code path. The billing module is structurally absent from the self-hosted runtime — it's not just disabled, it's not imported.

---

## Cloud Compatibility (Self-Hosted)

Self-hosted MergeWatch runs on any platform that can run a Docker container.

| Platform | How |
|----------|-----|
| **Google Cloud Run** | `gcloud run deploy --image ghcr.io/mergewatch/mergewatch` (scales to zero) |
| **GCP GKE / Compute Engine** | Docker or Kubernetes |
| **Azure Container Apps / AKS** | Managed containers or Kubernetes |
| **AWS ECS / Fargate / EC2** | Docker on AWS |
| **Fly.io** | `fly launch` |
| **Railway / Render** | Connect repo, auto-deploys |
| **DigitalOcean App Platform** | Point at container image |
| **Bare metal / VPS** | `docker-compose up` |
| **Air-gapped on-prem** | Docker + Postgres + Ollama (zero external dependencies) |

---

## Build System

### Turborepo

```json
// turbo.json
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      { "dependsOn": ["^build"] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

`turbo run build` only rebuilds packages whose source (or dependencies) changed. With 10 packages, this prevents unnecessary CI rebuilds.

### pnpm Workspaces

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
```

Inter-package dependencies use `workspace:*` protocol. `.npmrc` includes `node-linker=hoisted` for Amplify compatibility.

### SAM + esbuild

Lambda handlers are bundled by SAM's built-in esbuild support. esbuild resolves pnpm workspace symlinks, producing self-contained bundles (~275KB each) that include all `@mergewatch/*` dependencies.

### CI/CD

- **GitHub Actions:** Build, typecheck, SAM build, then deploy to dev (and optionally prod with approval)
- **Amplify:** Auto-deploys dashboard on push to `main`. Build spec in `amplify.yml` uses `pnpm -w run build` to build all packages before Next.js build.
