import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";

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
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [uniqueIndex("idx_control_people_email").on(sql`lower(${table.email})`)],
);
