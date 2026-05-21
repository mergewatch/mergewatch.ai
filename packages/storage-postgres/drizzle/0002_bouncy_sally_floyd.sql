CREATE TABLE IF NOT EXISTS "api_keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"label" text NOT NULL,
	"scope" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"first_billed_at" timestamp with time zone NOT NULL,
	"max_billed_cents" integer NOT NULL,
	"iteration" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "inline_resolved_keys" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_installation_idx" ON "api_keys" USING btree ("installation_id");
