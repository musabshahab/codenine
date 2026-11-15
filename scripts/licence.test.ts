import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { signLicence } from "@codenine/shared/licence";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";

import { buildLicenceClaims, readLicenceLedger } from "./licence.ts";

const base = {
  licenceId: "lic_test",
  customer: "Acme Ltd",
  seats: 25,
  editions: "coding, office",
  features: "single-sign-on,ai-gateway,single-sign-on",
  startsOn: "2026-12-01",
  endsOn: "2027-11-30",
  graceDays: 30,
  issuedAtMs: Date.parse("2026-11-14T10:00:00Z"),
};

describe("buildLicenceClaims", () => {
  it.effect("covers both dates in full and removes repeated items", () =>
    Effect.gen(function* () {
      const claims = yield* buildLicenceClaims(base);
      expect(claims.nbf).toBe(Date.parse("2026-12-01T00:00:00Z") / 1_000);
      expect(claims.exp).toBe(Date.parse("2027-12-01T00:00:00Z") / 1_000);
      expect(claims.editions).toEqual(["coding", "office"]);
      expect(claims.features).toEqual(["single-sign-on", "ai-gateway"]);
      expect(claims.iat).toBe(Date.parse("2026-11-14T10:00:00Z") / 1_000);
      expect("installationId" in claims).toBe(false);
    }),
  );

  it.effect.each([
    ["an end before the start", { endsOn: "2026-11-30" }, "--ends must not be before --starts."],
    ["a bad date", { startsOn: "1 December" }, "--starts must be a date like 2027-11-30."],
    ["an unknown edition", { editions: "coding,legal" }, "got legal"],
    ["no edition", { editions: " , " }, "Invalid licence details"],
    ["no seats", { seats: 0 }, "Invalid licence details"],
  ] as const)("refuses %s", ([, override, message]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(buildLicenceClaims({ ...base, ...override }));
      expect(error.message).toContain(message);
    }),
  );
});

describe("readLicenceLedger", () => {
  it.effect("lists each issued key and points at lines that are not keys", () =>
    Effect.gen(function* () {
      const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
      const privateKey = yield* Jwk.importPrivate(pair.privateKey, "EdDSA");
      const issue = (override: Partial<typeof base>) =>
        buildLicenceClaims({ ...base, ...override }).pipe(
          Effect.flatMap((claims) => signLicence({ privateKey, keyId: "2026-1", claims })),
        );
      const lapsed = yield* issue({
        licenceId: "lic_old",
        startsOn: "2025-01-01",
        endsOn: "2025-06-30",
      });
      const current = yield* issue({});

      const entries = yield* readLicenceLedger(
        `${lapsed}\n\nnot a key\n${current}\n`,
        Date.parse("2027-01-15T00:00:00Z"),
      );
      expect(entries).toEqual([
        {
          line: 1,
          licenceId: "lic_old",
          customer: "Acme Ltd",
          seats: 25,
          startsOn: "2025-01-01",
          endsOn: "2025-06-30",
          keyId: "2026-1",
          status: "expired",
        },
        { line: 3, problem: "not a licence key" },
        {
          line: 4,
          licenceId: "lic_test",
          customer: "Acme Ltd",
          seats: 25,
          startsOn: "2026-12-01",
          endsOn: "2027-11-30",
          keyId: "2026-1",
          status: "active",
        },
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
