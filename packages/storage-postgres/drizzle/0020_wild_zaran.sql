-- #713 — the advisory safety score and band (#712) on each review row. Null
-- when the feature is off or the safety agent did not answer usably.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "safety_score" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "safety_band" text;
