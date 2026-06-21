-- #195 — developer-engagement block on the insight rollup (acceptance /
-- command-usage / re-review KPIs). Nullable; pre-engagement rows and rollups
-- run before this stage leave it NULL (→ undefined on the typed shape).
ALTER TABLE "installation_fp_insights" ADD COLUMN IF NOT EXISTS "engagement" jsonb;