ALTER TABLE "control_people" ADD COLUMN "deactivated_at" varchar(64);--> statement-breakpoint
UPDATE "control_people" SET "deactivated_at" = "updated_at" WHERE "status" = 'deactivated';
