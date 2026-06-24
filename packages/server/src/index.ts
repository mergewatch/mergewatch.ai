import { readFileSync } from 'fs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  PostgresInstallationStore,
  PostgresReviewStore,
  PostgresFindingDispositionStore,
  PostgresFPInsightStore,
  PostgresPRLifecycleStore,
  PostgresSatisfactionStore,
  runMigrations,
} from '@mergewatch/storage-postgres';
import { EnvGitHubAuthProvider } from './github-auth-env.js';
import { createLLMProvider } from './llm-factory.js';
import { createWebhookHandler } from './webhook-handler.js';
import { startInsightsCron } from './insights-cron.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Resolve the GitHub App private key from either:
 *   - GITHUB_PRIVATE_KEY (inline PEM, newlines escaped as \n)
 *   - GITHUB_PRIVATE_KEY_FILE (path to .pem file)
 */
function resolvePrivateKey(): string {
  const inline = process.env.GITHUB_PRIVATE_KEY;
  const filePath = process.env.GITHUB_PRIVATE_KEY_FILE;

  if (inline) {
    return inline.replace(/\\n/g, '\n');
  }
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch (err: any) {
      throw new Error(`Failed to read GITHUB_PRIVATE_KEY_FILE at "${filePath}": ${err.message}`);
    }
  }
  throw new Error('Either GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_FILE must be set');
}

async function main() {
  // Required env vars
  const databaseUrl = requireEnv('DATABASE_URL');
  const githubAppId = requireEnv('GITHUB_APP_ID');
  const githubPrivateKey = resolvePrivateKey();
  const webhookSecret = requireEnv('GITHUB_WEBHOOK_SECRET');
  const port = parseInt(process.env.PORT || '3000', 10);
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL || '';

  // Initialize database
  const sql = postgres(databaseUrl);
  const db = drizzle(sql);

  // Auto-migrate: creates tables if missing, adds new columns on upgrade
  console.log('Running database migrations...');
  await runMigrations(db);
  console.log('Database migrations complete.');

  // Initialize providers
  const installationStore = new PostgresInstallationStore(db);
  const reviewStore = new PostgresReviewStore(db);
  const dispositionStore = new PostgresFindingDispositionStore(db);
  const fpInsightStore = new PostgresFPInsightStore(db);
  const prLifecycleStore = new PostgresPRLifecycleStore(db);
  const satisfactionStore = new PostgresSatisfactionStore(db);
  const authProvider = new EnvGitHubAuthProvider(githubAppId, githubPrivateKey);
  const llm = createLLMProvider();

  // FB-E — start the nightly insights rollup scheduler. Runs at startup
  // (60s after init to let migrations complete) and every 24h after.
  // Errors are caught + logged inside; the cron handle is kept for
  // future graceful-shutdown support.
  startInsightsCron({ installationStore, dispositionStore, fpInsightStore, prLifecycleStore, satisfactionStore });

  // Express app
  const app = express();

  // Parse JSON but keep raw body for signature verification
  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  }));

  // Health check with DB connectivity
  app.get('/health', async (_req, res) => {
    let dbStatus = 'disconnected';
    try {
      await db.execute(drizzleSql`SELECT 1`);
      dbStatus = 'connected';
    } catch {
      // DB unreachable
    }

    const status = dbStatus === 'connected' ? 'ok' : 'degraded';
    const statusCode = dbStatus === 'connected' ? 200 : 503;

    res.status(statusCode).json({
      status,
      version: '0.1.0',
      db: dbStatus,
      llmProvider: process.env.LLM_PROVIDER || 'anthropic',
    });
  });

  // Rate limit webhook endpoint to mitigate abuse
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,            // 120 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Webhook endpoint
  app.post('/webhook', webhookLimiter, createWebhookHandler({
    webhookSecret,
    installationStore,
    reviewStore,
    dispositionStore,
    fpInsightStore,
    prLifecycleStore,
    satisfactionStore,
    authProvider,
    llm,
    dashboardBaseUrl,
  }));

  app.listen(port, () => {
    console.log(`MergeWatch server listening on port ${port}`);
    console.log(`LLM provider: ${process.env.LLM_PROVIDER || 'anthropic'}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
