import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// Times are ISO-8601 UTC strings, as in the relay, so they sort as text and
// read back the same from PostgreSQL and from PGlite in tests.

export const controlInstallation = pgTable(
  "control_installation",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: varchar("id", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [check("control_installation_singleton", sql`${table.singleton}`)],
);

/** Every licence key ever installed; the most recently installed one applies. */
export const controlLicences = pgTable(
  "control_licences",
  {
    id: varchar("id", { length: 255 }).primaryKey(),
    token: text("token").notNull(),
    installedAt: varchar("installed_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_control_licences_installed_at").on(table.installedAt)],
);

export const controlPeople = pgTable(
  "control_people",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    role: varchar("role", { length: 16 }).notNull().$type<"owner" | "admin" | "member">(),
    /** Invited and active people hold a seat; deactivated people do not. */
    status: varchar("status", { length: 16 })
      .notNull()
      .$type<"invited" | "active" | "deactivated">(),
    /** Their workspace files are kept for a while after this, then deleted. */
    deactivatedAt: varchar("deactivated_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [uniqueIndex("idx_control_people_email").on(sql`lower(${table.email})`)],
);

const personId = () =>
  varchar("person_id", { length: 64 })
    .notNull()
    .references(() => controlPeople.id, { onDelete: "cascade" });

/**
 * A person can sign in once they have a password and a second factor: an
 * authenticator app, passkeys (`control_passkeys`), or both.
 */
export const controlCredentials = pgTable("control_credentials", {
  personId: personId().primaryKey(),
  /** PHC string: `$argon2id$v=19$m=...,t=...,p=...$salt$hash`. */
  passwordHash: text("password_hash").notNull(),
  /** The authenticator secret, sealed with the server's secret key; null with passkeys only. */
  totpSecret: text("totp_secret"),
  /** The last authenticator time step accepted, so each code works once. */
  totpLastStep: integer("totp_last_step").notNull().default(0),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: varchar("locked_until", { length: 64 }),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const controlRecoveryCodes = pgTable(
  "control_recovery_codes",
  {
    personId: personId(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: varchar("used_at", { length: 64 }),
  },
  (table) => [primaryKey({ columns: [table.personId, table.codeHash] })],
);

/**
 * Single-use tokens, stored as SHA-256 hashes: invitation, reset and
 * new-password links, and the ticket between the two steps of sign-in.
 */
export const controlTickets = pgTable(
  "control_tickets",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    purpose: varchar("purpose", { length: 16 })
      .notNull()
      .$type<"invitation" | "reset" | "password" | "sign-in" | "passkey" | "desktop">(),
    personId: personId(),
    /** The sealed authenticator secret offered during set-up, until it is confirmed. */
    pendingTotpSecret: text("pending_totp_secret"),
    /** The WebAuthn challenge sent with this ticket, until a passkey answers it. */
    pendingChallenge: text("pending_challenge"),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    usedAt: varchar("used_at", { length: 64 }),
  },
  (table) => [index("idx_control_tickets_person").on(table.personId)],
);

/** Passkeys a person signs in with after their password. */
export const controlPasskeys = pgTable(
  "control_passkeys",
  {
    /** The credential ID, base64url. */
    id: text("id").primaryKey(),
    personId: personId(),
    name: varchar("name", { length: 128 }).notNull(),
    /** The COSE public key, base64url. */
    publicKey: text("public_key").notNull(),
    /** The authenticator's signature counter, which only grows unless it stays at zero. */
    counter: integer("counter").notNull().default(0),
    /** JSON array of transport hints such as "internal" or "usb". */
    transports: text("transports"),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    lastUsedAt: varchar("last_used_at", { length: 64 }),
  },
  (table) => [index("idx_control_passkeys_person").on(table.personId)],
);

export const controlSessions = pgTable(
  "control_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    personId: personId(),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    lastSeenAt: varchar("last_seen_at", { length: 64 }).notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
  },
  (table) => [
    uniqueIndex("idx_control_sessions_token_hash").on(table.tokenHash),
    index("idx_control_sessions_person").on(table.personId),
  ],
);

/**
 * Keys the control server signs workspace tokens with. The private key is
 * sealed with the server's secret key; workspaces are configured with the
 * public key.
 */
export const controlSigningKeys = pgTable("control_signing_keys", {
  id: varchar("id", { length: 64 }).primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
});
