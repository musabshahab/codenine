import {
  type PasskeyAssertion,
  PasskeyCreationOptions,
  type PasskeyRegistration,
  PasskeyRequestOptions,
} from "@codenine/contracts/control";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ControlPublicUrl } from "../config.ts";

export class PasskeyCheckError extends Schema.TaggedError<PasskeyCheckError>()(
  "PasskeyCheckError",
  { cause: Schema.Defect() },
) {}

/** A passkey as the checks need it. */
export interface StoredPasskey {
  readonly id: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly counter: number;
  readonly transports: ReadonlyArray<string>;
}

const attachment = (value: string | null | undefined) =>
  value === "platform" || value === "cross-platform" ? { authenticatorAttachment: value } : {};

// The library's option types are its own; decoding checks they match what browsers parse.
const toCreationOptions = Schema.decodeUnknownEffect(PasskeyCreationOptions);
const toRequestOptions = Schema.decodeUnknownEffect(PasskeyRequestOptions);

const descriptors = (passkeys: ReadonlyArray<StoredPasskey>) =>
  passkeys.map((passkey) => ({ id: passkey.id, transports: [...passkey.transports] }));

/**
 * Passkey ceremonies for this installation: the relying party is the public
 * address's host name, and every answer must come from its origin. A passkey
 * is a second factor after the password, so user verification is preferred,
 * not required.
 */
export class WebAuthn extends Context.Service<
  WebAuthn,
  {
    readonly creationOptions: (input: {
      readonly personId: string;
      readonly email: string;
      readonly displayName: string;
      readonly existing: ReadonlyArray<StoredPasskey>;
    }) => Effect.Effect<PasskeyCreationOptions>;
    readonly checkRegistration: (input: {
      readonly registration: PasskeyRegistration;
      readonly challenge: string;
    }) => Effect.Effect<StoredPasskey, PasskeyCheckError>;
    readonly requestOptions: (
      passkeys: ReadonlyArray<StoredPasskey>,
    ) => Effect.Effect<PasskeyRequestOptions>;
    /** Returns the passkey's new signature counter. */
    readonly checkAssertion: (input: {
      readonly assertion: PasskeyAssertion;
      readonly challenge: string;
      readonly passkey: StoredPasskey;
    }) => Effect.Effect<number, PasskeyCheckError>;
  }
>()("@codenine/control/accounts/WebAuthn") {
  static readonly layer = Layer.effect(
    WebAuthn,
    Effect.gen(function* () {
      const { origin } = yield* ControlPublicUrl;
      const rpID = new URL(origin).hostname;
      const encoder = new TextEncoder();

      return WebAuthn.of({
        creationOptions: Effect.fn("WebAuthn.creationOptions")(function* (input) {
          const options = yield* Effect.promise(() =>
            generateRegistrationOptions({
              rpName: "Codenine",
              rpID,
              userName: input.email,
              userDisplayName: input.displayName,
              userID: encoder.encode(input.personId),
              attestationType: "none",
              excludeCredentials: descriptors(input.existing),
              authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
            }),
          );
          return yield* toCreationOptions(options).pipe(Effect.orDie);
        }),
        checkRegistration: Effect.fn("WebAuthn.checkRegistration")(function* ({
          registration,
          challenge,
        }) {
          const { transports } = registration.response;
          const result = yield* Effect.tryPromise({
            try: () =>
              verifyRegistrationResponse({
                response: {
                  id: registration.id,
                  rawId: registration.rawId,
                  type: "public-key",
                  response: {
                    clientDataJSON: registration.response.clientDataJSON,
                    attestationObject: registration.response.attestationObject,
                    ...(transports === undefined ? {} : { transports: [...transports] }),
                  },
                  clientExtensionResults: {},
                  ...attachment(registration.authenticatorAttachment),
                },
                expectedChallenge: challenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
                requireUserVerification: false,
              }),
            catch: (cause) => new PasskeyCheckError({ cause }),
          });
          if (!result.verified) {
            return yield* new PasskeyCheckError({ cause: "The registration was not verified." });
          }
          const { credential } = result.registrationInfo;
          return {
            id: credential.id,
            publicKey: credential.publicKey,
            counter: credential.counter,
            transports: credential.transports ?? [],
          };
        }),
        requestOptions: Effect.fn("WebAuthn.requestOptions")(function* (passkeys) {
          const options = yield* Effect.promise(() =>
            generateAuthenticationOptions({
              rpID,
              allowCredentials: descriptors(passkeys),
              userVerification: "preferred",
            }),
          );
          return yield* toRequestOptions(options).pipe(Effect.orDie);
        }),
        checkAssertion: Effect.fn("WebAuthn.checkAssertion")(function* ({
          assertion,
          challenge,
          passkey,
        }) {
          const { userHandle } = assertion.response;
          const result = yield* Effect.tryPromise({
            try: () =>
              verifyAuthenticationResponse({
                response: {
                  id: assertion.id,
                  rawId: assertion.rawId,
                  type: "public-key",
                  response: {
                    clientDataJSON: assertion.response.clientDataJSON,
                    authenticatorData: assertion.response.authenticatorData,
                    signature: assertion.response.signature,
                    ...(userHandle == null ? {} : { userHandle }),
                  },
                  clientExtensionResults: {},
                  ...attachment(assertion.authenticatorAttachment),
                },
                expectedChallenge: challenge,
                expectedOrigin: origin,
                expectedRPID: rpID,
                credential: {
                  id: passkey.id,
                  publicKey: passkey.publicKey,
                  counter: passkey.counter,
                  transports: [...passkey.transports],
                },
                requireUserVerification: false,
              }),
            catch: (cause) => new PasskeyCheckError({ cause }),
          });
          if (!result.verified) {
            return yield* new PasskeyCheckError({ cause: "The assertion was not verified." });
          }
          return result.authenticationInfo.newCounter;
        }),
      });
    }),
  );
}
