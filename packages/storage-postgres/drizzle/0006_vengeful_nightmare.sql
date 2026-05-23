-- FB-I — severity bucket on finding_dispositions powers the severity-shopping
-- detector rollup (warnings dispute-rate vs criticals dispute-rate). Nullable
-- so the column is safe to add on a running self-hosted server: existing rows
-- flow into the rollup's `uncategorized` bucket until they're written again.
ALTER TABLE "finding_dispositions" ADD COLUMN IF NOT EXISTS "severity" text;
