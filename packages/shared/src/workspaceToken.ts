import {
  WORKSPACE_TOKEN_TYPE,
  WorkspaceTokenClaims,
  WorkspaceTokenProblem,
} from "@codenine/contracts/workspaceToken";
import type * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Jwt from "effect/jose/Jwt";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class WorkspaceTokenError extends Schema.TaggedError<WorkspaceTokenError>()(
  "WorkspaceTokenError",
  { reason: WorkspaceTokenProblem, cause: Schema.optional(Schema.Defect()) },
) {}

/** Clock difference tolerated between a control server and its workspaces. */
const LEEWAY_SECONDS = 30;

const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(WorkspaceTokenClaims));
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceTokenClaims));

export const signWorkspaceToken = Effect.fn("workspaceToken.sign")(function* (input: {
  readonly privateKey: Jwk.PrivateKey;
  readonly keyId: string;
  readonly claims: WorkspaceTokenClaims;
}) {
  const payload = yield* encodeClaims(input.claims);
  const token = yield* Jws.sign(new TextEncoder().encode(payload), input.privateKey, {
    typ: WORKSPACE_TOKEN_TYPE,
    kid: input.keyId,
  });
  return Redacted.value(token);
}, Effect.orDie);

export const importWorkspacePublicKey = (pem: string) =>
  Jwk.importSpki(pem.replace(/\\n/gu, "\n").trim(), "EdDSA");

/**
 * Checks a token from the control server: its signature with the configured
 * key, and that it names this control server and this workspace and has not
 * expired.
 */
export const verifyWorkspaceToken = Effect.fn("workspaceToken.verify")(function* (input: {
  readonly token: string;
  readonly publicKey: Jwk.PublicKey;
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds: number;
}): Effect.fn.Return<WorkspaceTokenClaims, WorkspaceTokenError, Signature.Signature> {
  const fail = (reason: WorkspaceTokenProblem) => new WorkspaceTokenError({ reason });
  const unverified = yield* Jwt.decodeUnverified(input.token).pipe(
    Effect.mapError((cause) => new WorkspaceTokenError({ reason: "malformed", cause })),
  );
  if (unverified.protectedHeader.kid !== input.keyId) {
    return yield* fail("unknown-key");
  }
  const verified = yield* Jws.verify(input.token, input.publicKey).pipe(
    Effect.mapError((cause) => new WorkspaceTokenError({ reason: "invalid-signature", cause })),
  );
  if (verified.protectedHeader.typ !== WORKSPACE_TOKEN_TYPE) {
    return yield* fail("wrong-type");
  }
  const claims = yield* decodeClaims(new TextDecoder().decode(verified.payload)).pipe(
    Effect.mapError((cause) => new WorkspaceTokenError({ reason: "invalid-claims", cause })),
  );
  if (claims.iss !== input.issuer) {
    return yield* fail("wrong-issuer");
  }
  if (claims.aud !== input.audience) {
    return yield* fail("wrong-audience");
  }
  if (
    claims.exp + LEEWAY_SECONDS <= input.nowSeconds ||
    claims.iat - LEEWAY_SECONDS > input.nowSeconds
  ) {
    return yield* fail("expired");
  }
  return claims;
});
