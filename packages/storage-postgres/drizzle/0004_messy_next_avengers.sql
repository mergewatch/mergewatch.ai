ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "inline_reactions_snapshot" jsonb DEFAULT '{}'::jsonb;
