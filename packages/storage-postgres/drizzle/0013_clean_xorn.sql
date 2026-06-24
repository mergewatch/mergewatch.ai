-- #193 — per-review cost denormalization (one row per completed review) so the
-- nightly rollup can aggregate spend per installation. IF NOT EXISTS so the
-- self-hosted startup migration is idempotent.
CREATE TABLE IF NOT EXISTS "review_costs" (
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"completed_at" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" text,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"model" text,
	CONSTRAINT "review_costs_installation_id_repo_full_name_pr_number_commit_sha_pk" PRIMARY KEY("installation_id","repo_full_name","pr_number","commit_sha")
);
--> statement-breakpoint
-- #193 — LLM-cost block on the insight rollup. Nullable; pre-cost rows and
-- rollups run without a cost store leave it NULL (→ undefined on the typed shape).
ALTER TABLE "installation_fp_insights" ADD COLUMN IF NOT EXISTS "cost" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_costs_installation_idx" ON "review_costs" USING btree ("installation_id");
