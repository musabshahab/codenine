// @effect-diagnostics nodeBuiltinImport:off - A software authenticator signs with a P-256 key and SHA-256, which Effect's crypto modules do not expose raw.
import * as NodeCrypto from "node:crypto";

import type {
  PasskeyAssertion,
  PasskeyCreationOptions,
  PasskeyRegistration,
  PasskeyRequestOptions,
} from "@codenine/contracts/control";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) =>
  new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest());
const counterBytes = (counter: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
};

/** User present and user verified, as a platform authenticator reports them. */
const PRESENT_AND_VERIFIED = 0x05;
const ATTESTED_CREDENTIAL = 0x40;

/**
 * A passkey held in memory, answering the way a browser and platform
 * authenticator do, with "none" attestation. `origin` defaults to the one the
 * passkey was made for, so tests can answer from a different site.
 */
export const makeSoftwarePasskey = (input: { readonly origin: string }) => {
  const rpId = new URL(input.origin).hostname;
  const credentialId = NodeCrypto.randomBytes(16);
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  );
  let counter = 0;
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(
      `{"type":"${type}","challenge":"${challenge}","origin":"${origin}","crossOrigin":false}`,
    );

  return {
    id: base64url(credentialId),
    register: (options: PasskeyCreationOptions, origin = input.origin): PasskeyRegistration => {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([PRESENT_AND_VERIFIED | ATTESTED_CREDENTIAL]),
        counterBytes(counter),
        Buffer.alloc(16),
        idLength,
        credentialId,
        coseKey,
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ["fmt", "none"],
          ["attStmt", new Map<string, string>()],
          ["authData", authData],
        ]),
      );
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: base64url(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: base64url(attestationObject),
          transports: ["internal"],
        },
        authenticatorAttachment: "platform",
      };
    },
    answer: (options: PasskeyRequestOptions, origin = input.origin): PasskeyAssertion => {
      counter += 1;
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([PRESENT_AND_VERIFIED]),
        counterBytes(counter),
      ]);
      const clientDataJSON = clientData("webauthn.get", options.challenge, origin);
      const signature = NodeCrypto.sign(
        "sha256",
        Buffer.concat([authData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: base64url(credentialId),
        rawId: base64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: base64url(clientDataJSON),
          authenticatorData: base64url(authData),
          signature: base64url(signature),
        },
        authenticatorAttachment: "platform",
      };
    },
  };
};
