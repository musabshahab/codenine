CREATE TABLE "control_signing_keys" (
	"id" varchar(64) PRIMARY KEY,
	"private_key" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" varchar(64) NOT NULL
);
