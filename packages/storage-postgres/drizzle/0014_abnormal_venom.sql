-- #235 — org custom agents stored as a jsonb blob on the settings row.
-- IF NOT EXISTS so the self-hosted startup migration is idempotent.
ALTER TABLE "installation_settings" ADD COLUMN IF NOT EXISTS "custom_agents" jsonb DEFAULT '[]'::jsonb NOT NULL;