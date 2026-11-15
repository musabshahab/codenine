import type {
  ControlAuditAction,
  ControlAuditActorKind,
  ControlAuditTargetKind,
  ControlAuditValues,
  ControlProfileSettings,
  ControlRole,
} from "@codenine/contracts/control";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
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
    role: varchar("role", { length: 16 }).notNull().$type<ControlRole>(),
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
    /** The department this browser works in, while the person is still in it. */
    departmentId: varchar("department_id", { length: 64 }),
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

/** People can belong to several departments, and get a workspace in each. */
export const controlDepartments = pgTable(
  "control_departments",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [uniqueIndex("idx_control_departments_name").on(sql`lower(${table.name})`)],
);

const departmentId = () =>
  varchar("department_id", { length: 64 })
    .notNull()
    .references(() => controlDepartments.id, { onDelete: "cascade" });

export const controlDepartmentMembers = pgTable(
  "control_department_members",
  {
    departmentId: departmentId(),
    personId: personId(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.departmentId, table.personId] }),
    index("idx_control_department_members_person").on(table.personId),
  ],
);

/** A group within a department, with its own adjustments to the department's profile. */
export const controlTeams = pgTable(
  "control_teams",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    departmentId: departmentId(),
    name: varchar("name", { length: 128 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_control_teams_name").on(table.departmentId, sql`lower(${table.name})`),
  ],
);

/** Team members are members of the team's department too. */
export const controlTeamMembers = pgTable(
  "control_team_members",
  {
    teamId: varchar("team_id", { length: 64 })
      .notNull()
      .references(() => controlTeams.id, { onDelete: "cascade" }),
    personId: personId(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.personId] })],
);

/**
 * The token an identity provider provisions people with. Only its digest is
 * kept, and a new token replaces the old one.
 */
export const controlProvisioningTokens = pgTable("control_provisioning_tokens", {
  tokenHash: varchar("token_hash", { length: 128 }).primaryKey(),
  createdBy: varchar("created_by", { length: 512 }).notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  lastUsedAt: varchar("last_used_at", { length: 64 }),
});

/**
 * How the identity provider knows a person: its user name, which can differ
 * from their email, its own ID and their names. A person it removed stays
 * deactivated here but is no longer one of its users.
 */
export const controlDirectoryPeople = pgTable(
  "control_directory_people",
  {
    personId: personId().primaryKey(),
    userName: varchar("user_name", { length: 320 }).notNull(),
    externalId: varchar("external_id", { length: 255 }),
    givenName: varchar("given_name", { length: 255 }),
    familyName: varchar("family_name", { length: 255 }),
    removedAt: varchar("removed_at", { length: 64 }),
  },
  (table) => [
    uniqueIndex("idx_control_directory_people_user_name").on(sql`lower(${table.userName})`),
  ],
);

/** The identity provider's own ID for a department it pushed as a group. */
export const controlDirectoryGroups = pgTable("control_directory_groups", {
  departmentId: departmentId().primaryKey(),
  externalId: varchar("external_id", { length: 255 }),
});

/**
 * A workspace profile layer: `company`, `department:<id>` or `team:<id>`. Its
 * versions are kept; one is what everyone gets, and a newer one can go to a
 * few people first.
 */
export const controlProfiles = pgTable("control_profiles", {
  id: varchar("id", { length: 80 }).primaryKey(),
  published: integer("published"),
  testVersion: integer("test_version"),
  testPeople: jsonb("test_people").$type<ReadonlyArray<string>>(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const controlProfileVersions = pgTable(
  "control_profile_versions",
  {
    profileId: varchar("profile_id", { length: 80 })
      .notNull()
      .references(() => controlProfiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    settings: jsonb("settings").notNull().$type<ControlProfileSettings>(),
    note: varchar("note", { length: 500 }).notNull(),
    createdBy: varchar("created_by", { length: 512 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    /** When it last became what everyone gets, so a rollback knows what came before. */
    publishedAt: varchar("published_at", { length: 64 }),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.version] })],
);

/** A time-limited change for one person, in one department or all of theirs. */
export const controlProfileExceptions = pgTable(
  "control_profile_exceptions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    personId: personId(),
    departmentId: varchar("department_id", { length: 64 }).references(() => controlDepartments.id, {
      onDelete: "cascade",
    }),
    settings: jsonb("settings").notNull().$type<ControlProfileSettings>(),
    reason: varchar("reason", { length: 500 }).notNull(),
    endsAt: varchar("ends_at", { length: 64 }).notNull(),
    endedAt: varchar("ended_at", { length: 64 }),
    createdBy: varchar("created_by", { length: 512 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_control_profile_exceptions_person").on(table.personId)],
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

/**
 * Who did what, to what, from where and when. Rows are only ever added; the
 * retention sweep removes old ones. Labels are copied in, so entries read the
 * same after people change.
 */
export const controlAuditEvents = pgTable(
  "control_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: varchar("at", { length: 64 }).notNull(),
    actorKind: varchar("actor_kind", { length: 16 }).notNull().$type<ControlAuditActorKind>(),
    actorId: varchar("actor_id", { length: 64 }),
    actorLabel: varchar("actor_label", { length: 512 }).notNull(),
    action: varchar("action", { length: 64 }).notNull().$type<ControlAuditAction>(),
    targetKind: varchar("target_kind", { length: 16 }).$type<ControlAuditTargetKind>(),
    targetId: varchar("target_id", { length: 128 }),
    targetLabel: varchar("target_label", { length: 512 }),
    address: varchar("address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    before: jsonb("before").$type<ControlAuditValues>(),
    after: jsonb("after").$type<ControlAuditValues>(),
  },
  (table) => [index("idx_control_audit_events_at").on(table.at)],
);

/**
 * How far each export has sent the audit log. Entries past retention are
 * removed only once every configured export has them.
 */
export const controlAuditExports = pgTable("control_audit_exports", {
  sink: varchar("sink", { length: 16 }).primaryKey().$type<"syslog" | "otlp">(),
  lastId: bigint("last_id", { mode: "number" }).notNull(),
});
