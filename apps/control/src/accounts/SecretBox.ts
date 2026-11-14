import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Aead from "effect/crypto/Aead";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { Base64, Base64Url } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class SecretBoxError extends Schema.TaggedError<SecretBoxError>()("SecretBoxError", {
  cause: Schema.optional(Schema.Defect()),
}) {}

const encoder = new TextEncoder();

/**
 * Seals small secrets for the database with the server's secret key, which
 * lives in configuration, not the database. `context` binds a sealed value to
 * its row so values cannot be swapped between people.
 */
export class SecretBox extends Context.Service<
  SecretBox,
  {
    readonly seal: (plaintext: Uint8Array, context: string) => Effect.Effect<string>;
    readonly open: (sealed: string, context: string) => Effect.Effect<Uint8Array, SecretBoxError>;
  }
>()("@codenine/control/accounts/SecretBox") {
  static readonly make = Effect.fn("SecretBox.make")(function* (keyBytes: Uint8Array) {
    const aead = yield* Aead.Aead;
    const random = yield* SecureRandom.SecureRandom;
    const key = yield* Aead.key(Aead.aes256Gcm, keyBytes);
    return SecretBox.of({
      seal: Effect.fn("SecretBox.seal")(function* (plaintext: Uint8Array, context: string) {
        const nonce = yield* random.randomBytes(12);
        const sealed = yield* aead.encrypt(key, plaintext, { nonce, aad: encoder.encode(context) });
        return `v1.${Base64Url.encode(nonce)}.${Base64Url.encode(sealed)}`;
      }, Effect.orDie),
      open: Effect.fn("SecretBox.open")(function* (sealed: string, context: string) {
        const [version, nonceText, bodyText] = sealed.split(".");
        const decode = (text: string | undefined) =>
          text === undefined ? undefined : Result.getOrUndefined(Base64Url.decode(text));
        const nonce = decode(nonceText);
        const body = decode(bodyText);
        if (version !== "v1" || nonce === undefined || body === undefined) {
          return yield* new SecretBoxError({});
        }
        return yield* aead
          .decrypt(key, body, { nonce, aad: encoder.encode(context) })
          .pipe(Effect.mapError((cause) => new SecretBoxError({ cause })));
      }),
    });
  });

  /** Reads `CODENINE_CONTROL_SECRET_KEY`: 32 random bytes in base64, e.g. from `openssl rand -base64 32`. */
  static readonly layer = Layer.effect(
    SecretBox,
    Effect.gen(function* () {
      const encoded = Redacted.value(yield* Config.Redacted("CODENINE_CONTROL_SECRET_KEY")).trim();
      const bytes =
        Result.getOrUndefined(Base64.decode(encoded)) ??
        Result.getOrUndefined(Base64Url.decode(encoded));
      if (bytes === undefined || bytes.length !== 32) {
        return yield* Effect.die(
          "CODENINE_CONTROL_SECRET_KEY must be 32 random bytes in base64. Make one with `openssl rand -base64 32`.",
        );
      }
      return yield* SecretBox.make(bytes);
    }),
  );
}
