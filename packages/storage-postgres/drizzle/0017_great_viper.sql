CREATE TABLE IF NOT EXISTS "review_traces" (
	"repo_full_name" text NOT NULL,
	"pr_number_commit_sha" text NOT NULL,
	"outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"total_outcomes" integer,
	"created_at" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "review_traces_repo_full_name_pr_number_commit_sha_pk" PRIMARY KEY("repo_full_name","pr_number_commit_sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_traces_expires_idx" ON "review_traces" USING btree ("expires_at");
