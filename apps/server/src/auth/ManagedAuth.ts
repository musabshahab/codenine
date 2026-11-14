import { AuthSessionId } from "@codenine/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { importWorkspacePublicKey, verifyWorkspaceToken } from "@codenine/shared/workspaceToken";
import * as Clock from "effect/Clock";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ManagedControlConfig } from "../config.ts";

/** Subjects of control-server people; the prefix keeps them apart from built-in subjects. */
const MANAGED_SUBJECT_PREFIX = "managed:";

/**
 * Checks tokens from this workspace's control server. Each forwarded request
 * carries a fresh one; the session it describes is the control server's, so
 * nothing is stored here and the control server ends sockets on sign-out.
 */
export const makeManagedTokenVerifier = Effect.fn("ManagedAuth.makeVerifier")(function* (
  control: ManagedControlConfig,
) {
  const publicKey = yield* importWorkspacePublicKey(control.publicKey).pipe(
    Effect.catch(() =>
      Effect.die("CODENINE_MANAGED_PUBLIC_KEY is not an Ed25519 public key in PEM form."),
    ),
  );
  const signature = yield* Signature.Signature.pipe(Effect.provide(NodeCrypto.layerSignature));
  return Effect.fn("ManagedAuth.verify")(function* (token: string) {
    const claims = yield* verifyWorkspaceToken({
      token,
      publicKey,
      keyId: control.keyId,
      issuer: control.issuer,
      audience: control.workspaceId,
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
    }).pipe(Effect.provideService(Signature.Signature, signature));
    return {
      sessionId: AuthSessionId.make(`${MANAGED_SUBJECT_PREFIX}${claims.sid}`),
      subject: `${MANAGED_SUBJECT_PREFIX}${claims.sub}`,
      method: "bearer-access-token" as const,
      scopes: claims.scopes,
      expiresAt: DateTime.makeUnsafe(claims.exp * 1_000),
    };
  });
});
