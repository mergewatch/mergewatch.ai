CREATE TABLE IF NOT EXISTS "installation_fp_insights" (
	"installation_id" text NOT NULL,
	"window" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"generated_at" text NOT NULL,
	"total_findings_surfaced" integer DEFAULT 0 NOT NULL,
	"total_disputes" integer DEFAULT 0 NOT NULL,
	"dispute_rate" text DEFAULT '0' NOT NULL,
	"total_silent_drops" integer DEFAULT 0 NOT NULL,
	"total_agreements" integer DEFAULT 0 NOT NULL,
	"per_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"per_repo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_clusters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "installation_fp_insights_installation_id_window_pk" PRIMARY KEY("installation_id","window")
);
