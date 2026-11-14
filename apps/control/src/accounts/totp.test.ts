import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { base32, matchTotp, totpCode, totpStep } from "./totp.ts";

const rfcSecret = new TextEncoder().encode("12345678901234567890");

describe("totp", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as base32 %j (RFC 4648, unpadded)", (input, encoded) => {
    expect(base32(new TextEncoder().encode(input))).toBe(encoded);
  });

  it.effect.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ] as const)("matches the RFC 6238 SHA-1 code at %i seconds", ([seconds, code]) =>
    totpCode(rfcSecret, totpStep(seconds * 1_000)).pipe(
      Effect.map((actual) => expect(actual).toBe(code)),
      Effect.provide(NodeCrypto.layerMac),
    ),
  );

  it.effect("accepts one step of drift and never the same step twice", () =>
    Effect.gen(function* () {
      const nowMs = 1_111_111_111_000;
      const step = totpStep(nowMs);
      const stepOf = (offset: number, lastStep = 0) =>
        totpCode(rfcSecret, step + offset).pipe(
          Effect.flatMap((code) => matchTotp({ secret: rfcSecret, code, nowMs, lastStep })),
        );

      expect(yield* stepOf(-1)).toEqual(Option.some(step - 1));
      expect(yield* stepOf(0)).toEqual(Option.some(step));
      expect(yield* stepOf(1)).toEqual(Option.some(step + 1));
      expect(yield* stepOf(-2)).toEqual(Option.none());
      expect(yield* stepOf(2)).toEqual(Option.none());
      expect(yield* stepOf(0, step)).toEqual(Option.none());
      expect(yield* stepOf(1, step)).toEqual(Option.some(step + 1));
    }).pipe(Effect.provide(NodeCrypto.layerMac)),
  );
});
