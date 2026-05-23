-- FB-I — perSeverity bucket on installation_fp_insights. Populated by the
-- nightly rollup once finding_dispositions rows carry severity (added in
-- 0006). Default `{}` so pre-FB-I rollups remain valid; existing rows
-- backfill on the next nightly run.
ALTER TABLE "installation_fp_insights" ADD COLUMN IF NOT EXISTS "per_severity" jsonb DEFAULT '{}'::jsonb NOT NULL;
