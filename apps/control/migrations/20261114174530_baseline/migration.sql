CREATE TABLE "control_installation" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"id" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "control_installation_singleton" CHECK ("singleton")
);
--> statement-breakpoint
CREATE TABLE "control_licences" (
	"id" varchar(255) PRIMARY KEY,
	"token" text NOT NULL,
	"installed_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_people" (
	"id" varchar(64) PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_control_licences_installed_at" ON "control_licences" ("installed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_control_people_email" ON "control_people" (lower("email"));