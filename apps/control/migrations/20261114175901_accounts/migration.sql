CREATE TABLE "control_credentials" (
	"person_id" varchar(64) PRIMARY KEY,
	"password_hash" text NOT NULL,
	"totp_secret" text NOT NULL,
	"totp_last_step" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" varchar(64),
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_recovery_codes" (
	"person_id" varchar(64),
	"code_hash" varchar(64),
	"used_at" varchar(64),
	CONSTRAINT "control_recovery_codes_pkey" PRIMARY KEY("person_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "control_sessions" (
	"id" varchar(64) PRIMARY KEY,
	"token_hash" varchar(64) NOT NULL,
	"person_id" varchar(64) NOT NULL,
	"user_agent" varchar(512),
	"created_at" varchar(64) NOT NULL,
	"last_seen_at" varchar(64) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"revoked_at" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "control_tickets" (
	"token_hash" varchar(64) PRIMARY KEY,
	"purpose" varchar(16) NOT NULL,
	"person_id" varchar(64) NOT NULL,
	"pending_totp_secret" text,
	"created_at" varchar(64) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"used_at" varchar(64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_control_sessions_token_hash" ON "control_sessions" ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_control_sessions_person" ON "control_sessions" ("person_id");--> statement-breakpoint
CREATE INDEX "idx_control_tickets_person" ON "control_tickets" ("person_id");--> statement-breakpoint
ALTER TABLE "control_credentials" ADD CONSTRAINT "control_credentials_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_recovery_codes" ADD CONSTRAINT "control_recovery_codes_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_sessions" ADD CONSTRAINT "control_sessions_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_tickets" ADD CONSTRAINT "control_tickets_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;