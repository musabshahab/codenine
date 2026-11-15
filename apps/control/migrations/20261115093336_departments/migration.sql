CREATE TABLE "control_department_members" (
	"department_id" varchar(64),
	"person_id" varchar(64),
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "control_department_members_pkey" PRIMARY KEY("department_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "control_departments" (
	"id" varchar(64) PRIMARY KEY,
	"name" varchar(128) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_team_members" (
	"team_id" varchar(64),
	"person_id" varchar(64),
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "control_team_members_pkey" PRIMARY KEY("team_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "control_teams" (
	"id" varchar(64) PRIMARY KEY,
	"department_id" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_control_department_members_person" ON "control_department_members" ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_control_departments_name" ON "control_departments" (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_control_teams_name" ON "control_teams" ("department_id",lower("name"));--> statement-breakpoint
ALTER TABLE "control_department_members" ADD CONSTRAINT "control_department_members_mhI2JCLQYaeZ_fkey" FOREIGN KEY ("department_id") REFERENCES "control_departments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_department_members" ADD CONSTRAINT "control_department_members_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_team_members" ADD CONSTRAINT "control_team_members_team_id_control_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "control_teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_team_members" ADD CONSTRAINT "control_team_members_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "control_teams" ADD CONSTRAINT "control_teams_department_id_control_departments_id_fkey" FOREIGN KEY ("department_id") REFERENCES "control_departments"("id") ON DELETE CASCADE;