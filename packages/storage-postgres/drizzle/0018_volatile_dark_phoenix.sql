-- #706 — approving is opt-in. Existing installations default to false: a 4-5
-- score submits COMMENT until an admin turns approve on.
ALTER TABLE "installation_settings" ADD COLUMN IF NOT EXISTS "approve" boolean DEFAULT false NOT NULL;