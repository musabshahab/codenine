import {
  LICENCE_TOKEN_TYPE,
  LicenceClaims,
  LicenceProblem,
  type LicenceStatus,
} from "@codenine/contracts/licence";
export {
  LICENCE_ISSUER,
  LicenceClaims,
  LicenceEdition,
  LicenceFeature,
} from "@codenine/contracts/licence";
import type * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Jwt from "effect/jose/Jwt";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class LicenceError extends Schema.TaggedError<LicenceError>()("LicenceError", {
  reason: LicenceProblem,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "malformed":
        return "This is not a Codenine licence key.";
      case "unknown-key":
        return "This licence key was signed with a key this build does not trust.";
      case "invalid-signature":
        return "This licence key has been altered or damaged.";
      case "wrong-type":
        return "This key is not a Codenine licence.";
      case "invalid-claims":
        return "This licence key is missing or has invalid details.";
      case "wrong-installation":
        return "This licence key belongs to a different installation.";
    }
  }
}

export class LicenceSigningError extends Schema.TaggedError<LicenceSigningError>()(
  "LicenceSigningError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The licence key could not be signed.";
  }
}

const DAY_MS = 86_400_000;
/** Admins are warned this long before a licence ends. */
const LICENCE_EXPIRY_WARNING_DAYS = 30;

const normalizePem = (value: string) => value.replace(/\\n/gu, "\n").trim();

const importLicencePrivateKey = (pem: string) =>
  Jwk.importPkcs8(Redacted.make(normalizePem(pem)), "EdDSA");

const importLicencePublicKey = (pem: string) => Jwk.importSpki(normalizePem(pem), "EdDSA");

const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(LicenceClaims));
const decodeClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(LicenceClaims));

export const signLicence = Effect.fn("licence.sign")(function* (input: {
  readonly privateKey: string | Jwk.PrivateKey;
  readonly keyId: string;
  readonly claims: LicenceClaims;
}): Effect.fn.Return<string, LicenceSigningError, Signature.Signature> {
  const key =
    typeof input.privateKey === "string"
      ? yield* importLicencePrivateKey(input.privateKey).pipe(
          Effect.mapError((cause) => new LicenceSigningError({ cause })),
        )
      : input.privateKey;
  if (key.algorithm !== "EdDSA") {
    return yield* new LicenceSigningError({});
  }
  const payload = yield* encodeClaims(input.claims).pipe(
    Effect.mapError((cause) => new LicenceSigningError({ cause })),
  );
  const token = yield* Jws.sign(new TextEncoder().encode(payload), key, {
    typ: LICENCE_TOKEN_TYPE,
    kid: input.keyId,
  }).pipe(Effect.mapError((cause) => new LicenceSigningError({ cause })));
  return Redacted.value(token);
});

/**
 * Checks a licence key's signature against the build's trusted public keys,
 * chosen by the key's `kid`. Dates are not judged here; see `licenceStanding`.
 */
export const verifyLicence = Effect.fn("licence.verify")(function* (input: {
  readonly token: string;
  readonly trustedKeys: ReadonlyMap<string, string | Jwk.PublicKey>;
  readonly installationId?: string | undefined;
}): Effect.fn.Return<LicenceClaims, LicenceError, Signature.Signature> {
  const token = input.token.trim();
  const unverified = yield* Jwt.decodeUnverified(token).pipe(
    Effect.mapError((cause) => new LicenceError({ reason: "malformed", cause })),
  );
  const keyId = unverified.protectedHeader.kid;
  const trusted = keyId === undefined ? undefined : input.trustedKeys.get(keyId);
  if (trusted === undefined) {
    return yield* new LicenceError({ reason: "unknown-key" });
  }
  const key =
    typeof trusted === "string"
      ? yield* importLicencePublicKey(trusted).pipe(
          Effect.mapError((cause) => new LicenceError({ reason: "unknown-key", cause })),
        )
      : trusted;
  const verified = yield* Jws.verify(token, key).pipe(
    Effect.mapError((cause) => new LicenceError({ reason: "invalid-signature", cause })),
  );
  if (
    verified.protectedHeader.typ !== LICENCE_TOKEN_TYPE ||
    verified.protectedHeader.kid !== keyId
  ) {
    return yield* new LicenceError({ reason: "wrong-type" });
  }
  const claims = yield* decodeClaims(new TextDecoder().decode(verified.payload)).pipe(
    Effect.mapError((cause) => new LicenceError({ reason: "invalid-claims", cause })),
  );
  if (claims.nbf >= claims.exp) {
    return yield* new LicenceError({ reason: "invalid-claims" });
  }
  if (
    claims.installationId !== undefined &&
    input.installationId !== undefined &&
    claims.installationId !== input.installationId
  ) {
    return yield* new LicenceError({ reason: "wrong-installation" });
  }
  return claims;
});

export interface LicenceStanding {
  readonly status: LicenceStatus;
  readonly expiresAtMs: number;
  readonly graceEndsAtMs: number;
}

/** Where a verified licence stands at `nowMs`. */
export function licenceStanding(claims: LicenceClaims, nowMs: number): LicenceStanding {
  const startsAtMs = claims.nbf * 1_000;
  const expiresAtMs = claims.exp * 1_000;
  const graceEndsAtMs = expiresAtMs + claims.graceDays * DAY_MS;
  const status: LicenceStatus =
    nowMs < startsAtMs
      ? "not-yet-valid"
      : nowMs < expiresAtMs - LICENCE_EXPIRY_WARNING_DAYS * DAY_MS
        ? "active"
        : nowMs < expiresAtMs
          ? "expiring"
          : nowMs < graceEndsAtMs
            ? "grace"
            : "expired";
  return { status, expiresAtMs, graceEndsAtMs };
}

/** Whether agents may start under this standing. Expired licences are read-only. */
export const licenceAllowsWork = (status: LicenceStatus) =>
  status === "active" || status === "expiring" || status === "grace";
