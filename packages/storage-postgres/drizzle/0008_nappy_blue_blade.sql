CREATE TABLE IF NOT EXISTS "pr_lifecycle" (
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_created_at" text NOT NULL,
	"first_review_at" text,
	"merged_at" text,
	"closed_at" text,
	"state" text DEFAULT 'open' NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"total_pushes" integer DEFAULT 0 NOT NULL,
	"pushes_after_first_review" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "pr_lifecycle_installation_id_repo_full_name_pr_number_pk" PRIMARY KEY("installation_id","repo_full_name","pr_number")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_lifecycle_installation_idx" ON "pr_lifecycle" USING btree ("installation_id");
