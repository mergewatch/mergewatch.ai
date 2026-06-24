-- #195 Phase 4 — helpful 👍/👎 votes on the summary-comment prompt (one row
-- per PR). IF NOT EXISTS so the self-hosted startup migration is idempotent.
CREATE TABLE IF NOT EXISTS "helpful_votes" (
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"up" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL,
	"last_vote_at" text NOT NULL,
	CONSTRAINT "helpful_votes_installation_id_repo_full_name_pr_number_pk" PRIMARY KEY("installation_id","repo_full_name","pr_number")
);
--> statement-breakpoint
-- #195 Phase 5 — dashboard NPS survey responses (one row per admin).
CREATE TABLE IF NOT EXISTS "nps_responses" (
	"installation_id" text NOT NULL,
	"github_user_id" text NOT NULL,
	"score" integer NOT NULL,
	"responded_at" text NOT NULL,
	CONSTRAINT "nps_responses_installation_id_github_user_id_pk" PRIMARY KEY("installation_id","github_user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "helpful_votes_installation_idx" ON "helpful_votes" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nps_responses_installation_idx" ON "nps_responses" USING btree ("installation_id");
