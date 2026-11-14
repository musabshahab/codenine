import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import { controlInstallation } from "../persistence/schema.ts";

/** This installation's ID, made on first start. Licence keys can be tied to it. */
export class Installation extends Context.Service<Installation, { readonly id: string }>()(
  "@codenine/control/installation/Installation",
) {
  static readonly layer = Layer.effect(
    Installation,
    Effect.gen(function* () {
      const db = yield* ControlDb;
      const random = yield* SecureRandom.SecureRandom;
      yield* db
        .insert(controlInstallation)
        .values({
          id: `inst_${Hex.encode(yield* random.randomBytes(8))}`,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .onConflictDoNothing();
      const [row] = yield* db.select({ id: controlInstallation.id }).from(controlInstallation);
      if (row === undefined) {
        return yield* Effect.die("The installation row is missing after it was written.");
      }
      return { id: row.id };
    }),
  );
}
