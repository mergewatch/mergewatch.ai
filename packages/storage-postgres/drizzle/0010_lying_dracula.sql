-- #195 — /resolve command counter on the per-finding disposition record. An
-- explicit engagement signal (distinct from a 👎 dispute). Default 0 so rows
-- written before this counter existed need no backfill.
ALTER TABLE "finding_dispositions" ADD COLUMN IF NOT EXISTS "resolve_count" integer DEFAULT 0 NOT NULL;
