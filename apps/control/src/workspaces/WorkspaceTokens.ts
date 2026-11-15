import type { AuthGrantScope } from "@codenine/contracts";
import { importWorkspacePublicKey, signWorkspaceToken } from "@codenine/shared/workspaceToken";
import { desc } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { SecretBox } from "../accounts/SecretBox.ts";
import { ControlDb } from "../db.ts";
import { Installation } from "../installation/Installation.ts";
import { controlSigningKeys } from "../persistence/schema.ts";
import type { WorkspaceKey } from "./WorkspaceManager.ts";

const TOKEN_SECONDS = 120;
/** Marks a workspace's AI token, so neither kind of token passes for the other. */
const GATEWAY_TOKEN_TYPE = "codenine-gateway+jws";
const GATEWAY_AUDIENCE = "codenine-gateway";

const GatewayClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Literal(GATEWAY_AUDIENCE),
  sub: Schema.String,
  dep: Schema.NullOr(Schema.String),
});
const encodeGatewayClaims = Schema.encodeEffect(Schema.fromJsonString(GatewayClaims));
const decodeGatewayClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayClaims));

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
    /**
     * The token a workspace calls the AI gateway with. It names the person and
     * department and nothing that changes, so a workspace keeps one token for
     * as long as it is made from the same settings; the gateway checks on every
     * call that the person may still work there.
     */
    readonly gatewayToken: (key: WorkspaceKey) => Effect.Effect<string>;
    /** Whose workspace a gateway token came from, if this server signed it. */
    readonly verifyGatewayToken: (token: string) => Effect.Effect<Option.Option<WorkspaceKey>>;
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
  const publicKey = yield* importWorkspacePublicKey(key.publicKey);

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

  const gatewayToken = Effect.fn("WorkspaceTokens.gatewayToken")(function* (
    workspace: WorkspaceKey,
  ) {
    const payload = yield* encodeGatewayClaims({
      iss: installation.id,
      aud: GATEWAY_AUDIENCE,
      sub: workspace.personId,
      dep: workspace.departmentId,
    });
    // Ed25519 signs the same input the same way, so the token stays the same.
    const token = yield* Jws.sign(encoder.encode(payload), privateKey, {
      typ: GATEWAY_TOKEN_TYPE,
      kid: key.id,
    }).pipe(Effect.provideService(Signature.Signature, signature));
    return Redacted.value(token);
  }, Effect.orDie);

  const verifyGatewayToken = Effect.fn("WorkspaceTokens.verifyGatewayToken")(function* (
    token: string,
  ) {
    const verified = yield* Jws.verify(token, publicKey).pipe(
      Effect.provideService(Signature.Signature, signature),
      Effect.option,
    );
    if (
      Option.isNone(verified) ||
      verified.value.protectedHeader.typ !== GATEWAY_TOKEN_TYPE ||
      verified.value.protectedHeader.kid !== key.id
    ) {
      return Option.none<WorkspaceKey>();
    }
    const claims = yield* decodeGatewayClaims(decoder.decode(verified.value.payload)).pipe(
      Effect.option,
    );
    if (Option.isNone(claims) || claims.value.iss !== installation.id) {
      return Option.none<WorkspaceKey>();
    }
    return Option.some<WorkspaceKey>({
      personId: claims.value.sub,
      departmentId: claims.value.dep,
    });
  });

  return WorkspaceTokens.of({
    verifier: { issuer: installation.id, keyId: key.id, publicKey: key.publicKey },
    mint,
    gatewayToken,
    verifyGatewayToken,
  });
}).pipe(Effect.orDie);

export const layer = Layer.effect(WorkspaceTokens, make);
