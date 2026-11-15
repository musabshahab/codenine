import type { AuthGrantScope } from "@codenine/contracts";
import { signWorkspaceToken } from "@codenine/shared/workspaceToken";
import { desc } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Jwk from "effect/jose/Jwk";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { SecretBox } from "../accounts/SecretBox.ts";
import { ControlDb } from "../db.ts";
import { Installation } from "../installation/Installation.ts";
import { controlSigningKeys } from "../persistence/schema.ts";

const TOKEN_SECONDS = 120;

export class WorkspaceTokens extends Context.Service<
  WorkspaceTokens,
  {
    /** What a workspace needs to check tokens: this server's ID and public key. */
    readonly verifier: {
      readonly issuer: string;
      readonly keyId: string;
      readonly publicKey: string;
    };
    readonly mint: (input: {
      readonly personId: string;
      readonly sessionId: string;
      readonly name: string;
      readonly workspaceId: string;
      readonly scopes: ReadonlyArray<AuthGrantScope>;
    }) => Effect.Effect<string>;
  }
>()("@codenine/control/workspaces/WorkspaceTokens") {}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const sealContext = (keyId: string) => `signing-key:${keyId}`;

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const box = yield* SecretBox;
  const installation = yield* Installation;
  const random = yield* SecureRandom.SecureRandom;
  const signature = yield* Signature.Signature;

  const newest = db
    .select()
    .from(controlSigningKeys)
    .orderBy(desc(controlSigningKeys.createdAt), desc(controlSigningKeys.id))
    .limit(1);
  if ((yield* newest).length === 0) {
    const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
    const privatePem = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
      Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
    );
    const publicPem = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
      Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
    );
    const id = `wsk_${Hex.encode(yield* random.randomBytes(8))}`;
    yield* db.insert(controlSigningKeys).values({
      id,
      privateKey: yield* box.seal(encoder.encode(Redacted.value(privatePem)), sealContext(id)),
      publicKey: publicPem,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  }
  // Read back the newest key, so two servers starting together agree on one.
  const [key] = yield* newest;
  if (key === undefined) {
    return yield* Effect.die("The workspace signing key is missing after it was written.");
  }
  const privatePem = decoder.decode(yield* box.open(key.privateKey, sealContext(key.id)));
  const privateKey = yield* Jwk.importPkcs8(Redacted.make(privatePem), "EdDSA");

  const mint = Effect.fn("WorkspaceTokens.mint")(function* (input: {
    readonly personId: string;
    readonly sessionId: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly scopes: ReadonlyArray<AuthGrantScope>;
  }) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    return yield* signWorkspaceToken({
      privateKey,
      keyId: key.id,
      claims: {
        iss: installation.id,
        aud: input.workspaceId,
        sub: input.personId,
        sid: input.sessionId,
        name: input.name,
        scopes: input.scopes,
        iat: now,
        exp: now + TOKEN_SECONDS,
        jti: `tok_${Hex.encode(yield* random.randomBytes(8))}`,
      },
    }).pipe(Effect.provideService(Signature.Signature, signature));
  });

  return WorkspaceTokens.of({
    verifier: { issuer: installation.id, keyId: key.id, publicKey: key.publicKey },
    mint,
  });
}).pipe(Effect.orDie);

export const layer = Layer.effect(WorkspaceTokens, make);
