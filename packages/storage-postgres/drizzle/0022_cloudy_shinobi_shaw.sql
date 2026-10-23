-- #716 — reviewers' `@mergewatch safety <band>` votes on each review row,
-- append-only. Existing rows start with none.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "safety_feedback" jsonb DEFAULT '[]'::jsonb NOT NULL;
