import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import { controlAiUsage } from "../persistence/schema.ts";

/** One call through the gateway, as the usage record keeps it. */
export type AiUsageRow = Omit<typeof controlAiUsage.$inferInsert, "id">;

/** The record of every AI call through the gateway: who, which model, tokens and cost. */
export class AiUsage extends Context.Service<
  AiUsage,
  { readonly record: (row: AiUsageRow) => Effect.Effect<void> }
>()("@codenine/control/gateway/AiUsage") {}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  return AiUsage.of({
    record: Effect.fn("AiUsage.record")(function* (row: AiUsageRow) {
      yield* db.insert(controlAiUsage).values(row);
    }, dieOnDatabaseError),
  });
});

export const layer = Layer.effect(AiUsage, make);
