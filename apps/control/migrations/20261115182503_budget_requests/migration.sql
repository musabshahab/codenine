CREATE TABLE "control_budget_requests" (
	"id" varchar(64) PRIMARY KEY,
	"person_id" varchar(64) NOT NULL,
	"department_id" varchar(64),
	"level" varchar(32) NOT NULL,
	"period" varchar(16) NOT NULL,
	"amount_micros" bigint NOT NULL,
	"reason" varchar(500) NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"decided_by" varchar(512),
	"decided_at" varchar(64)
);
--> statement-breakpoint
CREATE INDEX "idx_control_budget_requests_status" ON "control_budget_requests" ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_control_budget_requests_period" ON "control_budget_requests" ("period","level");--> statement-breakpoint
ALTER TABLE "control_budget_requests" ADD CONSTRAINT "control_budget_requests_person_id_control_people_id_fkey" FOREIGN KEY ("person_id") REFERENCES "control_people"("id") ON DELETE CASCADE;