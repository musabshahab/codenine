CREATE TABLE "control_audit_events" (
	"id" bigserial PRIMARY KEY,
	"at" varchar(64) NOT NULL,
	"actor_kind" varchar(16) NOT NULL,
	"actor_id" varchar(64),
	"actor_label" varchar(512) NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_kind" varchar(16),
	"target_id" varchar(128),
	"target_label" varchar(512),
	"address" varchar(64),
	"user_agent" varchar(512),
	"before" jsonb,
	"after" jsonb
);
--> statement-breakpoint
CREATE INDEX "idx_control_audit_events_at" ON "control_audit_events" ("at");