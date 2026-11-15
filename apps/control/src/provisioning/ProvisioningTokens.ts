import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import { controlProvisioningTokens } from "../persistence/schema.ts";

/** Easy for secret scanners to recognize. */
const TOKEN_PREFIX = "codenine_scim_";

export interface ProvisioningTokenUse {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly lastUsedAt: string | null;
}

/** The one token an identity provider provisions people with. */
export class ProvisioningTokens extends Context.Service<
  ProvisioningTokens,
  {
    readonly current: Effect.Effect<ProvisioningTokenUse | null>;
    /** A new token, replacing any there was. Only its digest is kept, so this is its one showing. */
    readonly issue: (by: string) => Effect.Effect<string>;
    /** True when there was one. */
    readonly revoke: Effect.Effect<boolean>;
    readonly authenticate: (token: string) => Effect.Effect<boolean>;
  }
>()("@codenine/control/provisioning/ProvisioningTokens") {}

const encoder = new TextEncoder();

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const hashToken = (token: string) => digest.digestHex(Digest.sha256, encoder.encode(token));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  return ProvisioningTokens.of({
    current: Effect.gen(function* () {
      const [row] = yield* db.select().from(controlProvisioningTokens).limit(1);
      return row === undefined
        ? null
        : { createdAt: row.createdAt, createdBy: row.createdBy, lastUsedAt: row.lastUsedAt };
    }).pipe(Effect.orDie, Effect.withSpan("ProvisioningTokens.current")),
    issue: Effect.fn("ProvisioningTokens.issue")(function* (by: string) {
      const token = `${TOKEN_PREFIX}${Base64Url.encode(yield* random.randomBytes(32))}`;
      const tokenHash = yield* hashToken(token);
      const createdAt = yield* nowIso;
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.delete(controlProvisioningTokens);
          yield* db
            .insert(controlProvisioningTokens)
            .values({ tokenHash, createdBy: by.slice(0, 512), createdAt });
        }),
      );
      return token;
    }, Effect.orDie),
    revoke: db
      .delete(controlProvisioningTokens)
      .returning()
      .pipe(
        Effect.map((removed) => removed.length > 0),
        Effect.orDie,
        Effect.withSpan("ProvisioningTokens.revoke"),
      ),
    authenticate: Effect.fn("ProvisioningTokens.authenticate")(function* (token: string) {
      if (!token.startsWith(TOKEN_PREFIX)) {
        return false;
      }
      const [used] = yield* db
        .update(controlProvisioningTokens)
        .set({ lastUsedAt: yield* nowIso })
        .where(eq(controlProvisioningTokens.tokenHash, yield* hashToken(token)))
        .returning({ tokenHash: controlProvisioningTokens.tokenHash });
      return used !== undefined;
    }, Effect.orDie),
  });
});

export const layer = Layer.effect(ProvisioningTokens, make);
