import {
  PasskeyAssertion,
  type PasskeyCreationOptions,
  PasskeyRegistration,
  type PasskeyRequestOptions,
} from "@codenine/contracts/control";
import * as Schema from "effect/Schema";

import { controlErrorMessage } from "./control";

const decodeRegistration = Schema.decodeUnknownSync(PasskeyRegistration);
const decodeAssertion = Schema.decodeUnknownSync(PasskeyAssertion);

/** Whether this browser can create and use passkeys from the control server's options. */
export const passkeysAvailable = () =>
  typeof PublicKeyCredential !== "undefined" &&
  typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function" &&
  typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function";

const descriptors = (
  list: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly transports?: ReadonlyArray<string>;
  }>,
) =>
  list.map((descriptor) => ({
    id: descriptor.id,
    type: descriptor.type,
    ...(descriptor.transports === undefined ? {} : { transports: [...descriptor.transports] }),
  }));

/** Asks the browser for a new passkey. */
export async function createPasskey(options: PasskeyCreationOptions) {
  const { timeout, excludeCredentials, authenticatorSelection, attestation } = options;
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON({
    rp: { ...options.rp },
    user: { ...options.user },
    challenge: options.challenge,
    pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({ ...parameter })),
    ...(timeout === undefined ? {} : { timeout }),
    ...(excludeCredentials === undefined
      ? {}
      : { excludeCredentials: descriptors(excludeCredentials) }),
    ...(authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: { ...authenticatorSelection } }),
    ...(attestation === undefined ? {} : { attestation }),
  });
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("No passkey was created.");
  }
  return decodeRegistration(credential.toJSON());
}

/** Asks the browser to answer the control server's challenge with one of the person's passkeys. */
export async function signWithPasskey(options: PasskeyRequestOptions) {
  const { timeout, rpId, allowCredentials, userVerification } = options;
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON({
    challenge: options.challenge,
    ...(timeout === undefined ? {} : { timeout }),
    ...(rpId === undefined ? {} : { rpId }),
    ...(allowCredentials === undefined ? {} : { allowCredentials: descriptors(allowCredentials) }),
    ...(userVerification === undefined ? {} : { userVerification }),
  });
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("No passkey answered.");
  }
  return decodeAssertion(credential.toJSON());
}

export function passkeyErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "This device already holds a passkey for your account.";
  }
  if (error instanceof DOMException) {
    return "The passkey was not used. Try again, or choose another way.";
  }
  return controlErrorMessage(error);
}
