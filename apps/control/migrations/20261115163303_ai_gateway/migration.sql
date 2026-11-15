CREATE TABLE "control_ai_accounts" (
	"id" varchar(64) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"base_url" varchar(2048),
	"price_adjustment" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"api_key" text NOT NULL,
	"key_hint" varchar(16) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_ai_usage" (
	"id" bigserial PRIMARY KEY,
	"at" varchar(64) NOT NULL,
	"person_id" varchar(64) NOT NULL,
	"department_id" varchar(64),
	"account_id" varchar(64),
	"provider" varchar(16) NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"web_searches" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"priced" boolean NOT NULL,
	"price_version" varchar(64) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"session_id" varchar(128),
	"request_id" varchar(128)
);
--> statement-breakpoint
CREATE INDEX "idx_control_ai_usage_at" ON "control_ai_usage" ("at");--> statement-breakpoint
CREATE INDEX "idx_control_ai_usage_person" ON "control_ai_usage" ("person_id","at");--> statement-breakpoint
CREATE INDEX "idx_control_ai_usage_department" ON "control_ai_usage" ("department_id","at");