import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildLicenceClaims } from "./licence.ts";

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
