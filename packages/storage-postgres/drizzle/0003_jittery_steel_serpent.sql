CREATE TABLE IF NOT EXISTS "finding_dispositions" (
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"finding_match_key" text NOT NULL,
	"first_seen" text NOT NULL,
	"last_seen" text NOT NULL,
	"surface_count" integer DEFAULT 0 NOT NULL,
	"dispute_count" integer DEFAULT 0 NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	"unverified_count" integer DEFAULT 0 NOT NULL,
	"silent_drop_count" integer DEFAULT 0 NOT NULL,
	"agreement_count" integer DEFAULT 0 NOT NULL,
	"category" text,
	"top_agent" text,
	"sig_tokens" jsonb,
	"reject_reasons" jsonb,
	CONSTRAINT "finding_dispositions_installation_id_repo_full_name_finding_match_key_pk" PRIMARY KEY("installation_id","repo_full_name","finding_match_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finding_dispositions_installation_idx" ON "finding_dispositions" USING btree ("installation_id");
