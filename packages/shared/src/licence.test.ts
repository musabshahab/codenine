import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { LicenceClaims, LicenceStatus } from "@codenine/contracts/licence";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Redacted from "effect/Redacted";

import { licenceAllowsWork, licenceStanding, signLicence, verifyLicence } from "./licence.ts";

const DAY = 86_400;
const NOW = 1_800_000_000;

const claims: LicenceClaims = {
  iss: "codenine",
  sub: "lic_test",
  customer: "Acme Ltd",
  seats: 25,
  editions: ["coding", "office"],
  features: ["single-sign-on", "ai-gateway"],
  iat: NOW,
  nbf: NOW,
  exp: NOW + 365 * DAY,
  graceDays: 30,
};

const keyPair = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportPkcs8(key, { format: "pem" })),
  );
  const publicKey = yield* Jwk.importPublic(pair.publicKey, "EdDSA").pipe(
    Effect.flatMap((key) => Jwk.exportSpki(key, { format: "pem" })),
  );
  return { privateKey: Redacted.value(privateKey), publicKey };
});

describe("licence keys", () => {
  it.effect("verifies a signed key and refuses altered or untrusted ones", () =>
    Effect.gen(function* () {
      const ours = yield* keyPair;
      const theirs = yield* keyPair;
      const trustedKeys = new Map([["2026-1", ours.publicKey]]);
      const token = yield* signLicence({ privateKey: ours.privateKey, keyId: "2026-1", claims });

      expect(yield* verifyLicence({ token, trustedKeys })).toEqual(claims);

      const reasonFor = (input: Parameters<typeof verifyLicence>[0]) =>
        verifyLicence(input).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      const [header, , signature] = token.split(".");
      const raisedSeats = Buffer.from(JSON.stringify({ ...claims, seats: 5_000 })).toString(
        "base64url",
      );
      expect(
        yield* reasonFor({ token: `${header}.${raisedSeats}.${signature}`, trustedKeys }),
      ).toBe("invalid-signature");

      const signedElsewhere = yield* signLicence({
        privateKey: theirs.privateKey,
        keyId: "2026-1",
        claims,
      });
      expect(yield* reasonFor({ token: signedElsewhere, trustedKeys })).toBe("invalid-signature");

      const unknownKeyId = yield* signLicence({
        privateKey: ours.privateKey,
        keyId: "2099-9",
        claims,
      });
      expect(yield* reasonFor({ token: unknownKeyId, trustedKeys })).toBe("unknown-key");

      expect(yield* reasonFor({ token: "not a licence", trustedKeys })).toBe("malformed");

      const ourKey = yield* Jwk.importPkcs8(Redacted.make(ours.privateKey), "EdDSA");
      const signRaw = (payload: unknown, typ: string) =>
        Jws.sign(new TextEncoder().encode(JSON.stringify(payload)), ourKey, {
          typ,
          kid: "2026-1",
        }).pipe(Effect.map(Redacted.value));
      expect(yield* reasonFor({ token: yield* signRaw(claims, "other+jwt"), trustedKeys })).toBe(
        "wrong-type",
      );
      expect(
        yield* reasonFor({
          token: yield* signRaw({ ...claims, seats: 0 }, "codenine-licence+jwt"),
          trustedKeys,
        }),
      ).toBe("invalid-claims");
      expect(
        yield* reasonFor({
          token: yield* signRaw({ ...claims, nbf: claims.exp }, "codenine-licence+jwt"),
          trustedKeys,
        }),
      ).toBe("invalid-claims");

      const pinned = yield* signLicence({
        privateKey: ours.privateKey,
        keyId: "2026-1",
        claims: { ...claims, installationId: "inst_a" },
      });
      expect(
        yield* verifyLicence({ token: pinned, trustedKeys, installationId: "inst_a" }),
      ).toEqual({ ...claims, installationId: "inst_a" });
      expect(yield* reasonFor({ token: pinned, trustedKeys, installationId: "inst_b" })).toBe(
        "wrong-installation",
      );
    }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );

  it.each<[string, number, LicenceStatus, boolean]>([
    ["before it starts", NOW - 1, "not-yet-valid", false],
    ["on its first day", NOW, "active", true],
    ["31 days before the end", NOW + 334 * DAY, "active", true],
    ["29 days before the end", NOW + 336 * DAY, "expiring", true],
    ["on the day it ends", NOW + 365 * DAY, "grace", true],
    ["late in the grace period", NOW + 394 * DAY, "grace", true],
    ["after the grace period", NOW + 395 * DAY, "expired", false],
  ])("stands %s", (_label, nowSeconds, status, allowsWork) => {
    const standing = licenceStanding(claims, nowSeconds * 1_000);
    expect(standing.status).toBe(status);
    expect(licenceAllowsWork(standing.status)).toBe(allowsWork);
  });
});
