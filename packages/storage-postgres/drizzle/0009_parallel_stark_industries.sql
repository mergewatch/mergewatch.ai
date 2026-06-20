-- TTM (#194) — cycle-time block on the insight rollup. Nullable; pre-Stage-2
-- rows and rollups without a PR-lifecycle store leave it NULL (→ undefined).
ALTER TABLE "installation_fp_insights" ADD COLUMN IF NOT EXISTS "cycle_time" jsonb;