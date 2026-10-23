-- #711 — the dashboard's safety-score switch. Existing installations default
-- to off; a default-branch .mergewatch.yml can still turn it on.
ALTER TABLE "installation_settings" ADD COLUMN IF NOT EXISTS "safety_score_config" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL;
