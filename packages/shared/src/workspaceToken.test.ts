import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { WorkspaceTokenClaims } from "@codenine/contracts/workspaceToken";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jws from "effect/jose/Jws";
import * as Redacted from "effect/Redacted";

import { signWorkspaceToken, verifyWorkspaceToken } from "./workspaceToken.ts";

const NOW = 1_800_000_000;

const claims: WorkspaceTokenClaims = {
  iss: "inst_control",
  aud: "wks_ada",
  sub: "per_ada",
  sid: "ses_ada",
  name: "Ada",
  scopes: ["orchestration:read", "orchestration:operate"],
  iat: NOW,
  exp: NOW + 120,
  jti: "tok_1",
};

const keyPair = Effect.gen(function* () {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "EdDSA" });
  return {
    privateKey: yield* Jwk.importPrivate(pair.privateKey, "EdDSA"),
    publicKey: yield* Jwk.importPublic(pair.publicKey, "EdDSA"),
  };
});

describe("workspace tokens", () => {
  it.effect("accepts a token for this workspace and refuses anything else", () =>
    Effect.gen(function* () {
      const ours = yield* keyPair;
      const theirs = yield* keyPair;
      const sign = (overrides: Partial<WorkspaceTokenClaims> = {}, privateKey = ours.privateKey) =>
        signWorkspaceToken({ privateKey, keyId: "wsk_1", claims: { ...claims, ...overrides } });
      const verify = (token: string, nowSeconds = NOW) =>
        verifyWorkspaceToken({
          token,
          publicKey: ours.publicKey,
          keyId: "wsk_1",
          issuer: "inst_control",
          audience: "wks_ada",
          nowSeconds,
        });
      const reasonFor = (token: string, nowSeconds = NOW) =>
        verify(token, nowSeconds).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

      expect(yield* verify(yield* sign())).toEqual(claims);
      expect(yield* verify(yield* sign(), NOW + 140)).toEqual(claims);

      const otherType = yield* Jws.sign(
        new TextEncoder().encode(JSON.stringify(claims)),
        ours.privateKey,
        {
          typ: "other+jwt",
          kid: "wsk_1",
        },
      ).pipe(Effect.map(Redacted.value));
      const otherKeyId = yield* signWorkspaceToken({
        privateKey: ours.privateKey,
        keyId: "wsk_2",
        claims,
      });
      const cases: ReadonlyArray<readonly [string, string, number?]> = [
        ["not a token", "malformed"],
        [otherKeyId, "unknown-key"],
        [yield* sign({}, theirs.privateKey), "invalid-signature"],
        [otherType, "wrong-type"],
        [yield* sign({ iss: "inst_elsewhere" }), "wrong-issuer"],
        [yield* sign({ aud: "wks_bea" }), "wrong-audience"],
        [yield* sign(), "expired", NOW + 150],
        [yield* sign({ iat: NOW + 60 }), "expired"],
      ];
      for (const [token, reason, nowSeconds] of cases) {
        expect(yield* reasonFor(token, nowSeconds)).toBe(reason);
      }
    }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );
});
