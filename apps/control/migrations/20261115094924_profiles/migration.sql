CREATE TABLE "control_profile_exceptions" (
	"id" varchar(64) PRIMARY KEY,
	"person_id" varchar(64) NOT NULL,
	"department_id" varchar(64),
	"settings" jsonb NOT NULL,
	"reason" varchar(500) NOT NULL,
	"ends_at" varchar(64) NOT NULL,
	"ended_at" varchar(64),
	"created_by" varchar(512) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_profile_versions" (
	"profile_id" varchar(80),
	"version" integer,
	"settings" jsonb NOT NULL,
	"note" varchar(500) NOT NULL,
	"created_by" varchar(512) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"published_at" varchar(64),
	CONSTRAINT "control_profile_versions_pkey" PRIMARY KEY("profile_id","version")
);
--> statement-breakpoint
CREATE TABLE "control_profiles" (
	"id" varchar(80) PRIMARY KEY,
	"published" integer,
	"test_version" integer,
	"test_people" jsonb,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_control_profile_exceptions_person" ON "control_profile_exceptions" ("person_id");--> statement-breakpoint
ALTER TABLE "control_profile_exceptions" ADD CONSTRAINT "control_profile_exceptions_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_profile_exceptions" ADD CONSTRAINT "control_profile_exceptions_paO3lk2WUdv3_fkey" FOREIGN KEY ("department_id") REFERENCES "control_departments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_profile_versions" ADD CONSTRAINT "control_profile_versions_profile_id_control_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "control_profiles"("id") ON DELETE CASCADE;