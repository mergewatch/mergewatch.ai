-- #718 — org safety areas (dashboard-defined), unioned with each repo's areas
-- at review time. Existing installations start with none.
ALTER TABLE "installation_settings" ADD COLUMN IF NOT EXISTS "safety_areas" jsonb DEFAULT '[]'::jsonb NOT NULL;
