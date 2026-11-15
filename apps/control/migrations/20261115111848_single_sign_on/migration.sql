CREATE TABLE "control_sso_connections" (
	"id" varchar(64) PRIMARY KEY,
	"protocol" varchar(8) NOT NULL,
	"name" varchar(64) NOT NULL,
	"domains" jsonb NOT NULL,
	"required" boolean NOT NULL,
	"create_people" boolean NOT NULL,
	"groups_claim" varchar(255),
	"role_groups" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"sealed_secret" text,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_sso_identities" (
	"connection_id" varchar(64),
	"subject" varchar(512),
	"person_id" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"last_used_at" varchar(64) NOT NULL,
	CONSTRAINT "control_sso_identities_pkey" PRIMARY KEY("connection_id","subject")
);
--> statement-breakpoint
CREATE TABLE "control_sso_requests" (
	"id" varchar(64) PRIMARY KEY,
	"connection_id" varchar(64) NOT NULL,
	"binding_hash" varchar(128) NOT NULL,
	"code_verifier" varchar(128),
	"nonce" varchar(128),
	"next" varchar(512) NOT NULL,
	"person_id" varchar(64),
	"expires_at" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_people" ADD COLUMN "emergency" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "control_sso_identities" ADD CONSTRAINT "control_sso_identities_Aupsha1Tncpf_fkey" FOREIGN KEY ("connection_id") REFERENCES "control_sso_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_sso_identities" ADD CONSTRAINT "control_sso_identities_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_sso_requests" ADD CONSTRAINT "control_sso_requests_YzzD1dIzbV4f_fkey" FOREIGN KEY ("connection_id") REFERENCES "control_sso_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_sso_requests" ADD CONSTRAINT "control_sso_requests_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;