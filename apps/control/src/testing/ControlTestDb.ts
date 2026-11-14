import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate } from "drizzle-orm/effect-pglite/migrator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ControlDb, MIGRATIONS_TABLE, migrationsFolder } from "../db.ts";

/** A fresh in-memory PostgreSQL (PGlite) with every migration applied. */
export const layerControlTestDb = Layer.effect(
  ControlDb,
  Effect.gen(function* () {
    const db = yield* PgliteDrizzle.makeWithDefaults();
    yield* migrate(db, {
      migrationsFolder: yield* migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return db;
  }),
).pipe(Layer.provide(PgliteClient.layer()));
