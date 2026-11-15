CREATE TABLE "control_passkeys" (
	"id" text PRIMARY KEY,
	"person_id" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text,
	"created_at" varchar(64) NOT NULL,
	"last_used_at" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "control_tickets" ADD COLUMN "pending_challenge" text;--> statement-breakpoint
ALTER TABLE "control_credentials" ALTER COLUMN "totp_secret" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_control_passkeys_person" ON "control_passkeys" ("person_id");--> statement-breakpoint
ALTER TABLE "control_passkeys" ADD CONSTRAINT "control_passkeys_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;