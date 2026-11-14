import * as PgClient from "@effect/sql-pg/PgClient";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core/query-effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect/db";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

interface ControlQueryEffect extends QueryEffectHKTBase {
  readonly error: EffectDrizzleQueryError;
  readonly context: never;
}

/**
 * The query builder both Drizzle drivers share: PostgreSQL in production and
 * PGlite in tests. Raw `execute` results differ between them, so services
 * stick to the query builder.
 */
export type ControlDatabase = PgEffectDatabase<ControlQueryEffect, PgQueryResultHKT>;

export class ControlDb extends Context.Service<ControlDb, ControlDatabase>()(
  "@codenine/control/db/ControlDb",
) {}

export const MIGRATIONS_TABLE = "control_migrations";

export const migrationsFolder = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../migrations/", import.meta.url));
});

export const layer = Layer.effect(
  ControlDb,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* migrate(db, {
      migrationsFolder: yield* migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return db;
  }),
).pipe(
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("CODENINE_CONTROL_DATABASE_URL") })),
);
