import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { LicenceClaims } from "@codenine/contracts/licence";
import { signLicence } from "@codenine/shared/licence";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Redacted from "effect/Redacted";

export const TEST_KEY_ID = "test-1";

const DAY = 86_400;
export const DEC_1_2026 = Date.parse("2026-12-01T00:00:00Z") / 1_000;

export const testClaims = (overrides: Partial<LicenceClaims> = {}): LicenceClaims => ({
  iss: "codenine",
  sub: "lic_first",
  customer: "Acme Ltd",
  seats: 3,
  editions: ["coding"],
  features: [],
  iat: DEC_1_2026,
  nbf: DEC_1_2026,
  exp: DEC_1_2026 + 365 * DAY,
  graceDays: 30,
  ...overrides,
});

export const testKeyPair = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
  );
  const publicKey = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
  );
  return { privateKey: Redacted.value(privateKey), publicKey };
});

export const signTestLicence = (claims: LicenceClaims, privateKey: string) =>
  signLicence({ privateKey, keyId: TEST_KEY_ID, claims }).pipe(
    Effect.provide(NodeCrypto.layerSignature),
  );
