CREATE TABLE "control_directory_groups" (
	"department_id" varchar(64) PRIMARY KEY,
	"external_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "control_directory_people" (
	"person_id" varchar(64) PRIMARY KEY,
	"user_name" varchar(320) NOT NULL,
	"external_id" varchar(255),
	"given_name" varchar(255),
	"family_name" varchar(255),
	"removed_at" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "control_provisioning_tokens" (
	"token_hash" varchar(128) PRIMARY KEY,
	"created_by" varchar(512) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"last_used_at" varchar(64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_control_directory_people_user_name" ON "control_directory_people" (lower("user_name"));--> statement-breakpoint
ALTER TABLE "control_directory_groups" ADD CONSTRAINT "control_directory_groups_04nycHJmiz2L_fkey" FOREIGN KEY ("department_id") REFERENCES "control_departments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_directory_people" ADD CONSTRAINT "control_directory_people_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;