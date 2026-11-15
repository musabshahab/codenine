import * as Context from "effect/Context";
import * as Kdf from "effect/crypto/Kdf";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

interface Argon2Cost {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

// RFC 9106's second recommended setting, for memory-constrained hosts.
const PARAMETERS: Argon2Cost = { memory: 65_536, passes: 3, parallelism: 4 };

/** The cost of new hashes. Tests lower it; a check always uses the cost stored in the hash. */
export const PasswordHashCost = Context.Reference<Argon2Cost>(
  "@codenine/control/accounts/passwords/PasswordHashCost",
  { defaultValue: () => PARAMETERS },
);
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

const encoder = new TextEncoder();
const unpadded = (bytes: Uint8Array) => Base64.encode(bytes).replace(/=+$/u, "");
const padded = (text: string) => text.padEnd(text.length + ((4 - (text.length % 4)) % 4), "=");

/** Stands in for a real hash when the email is unknown, so timing does not reveal it. */
export const UNKNOWN_PERSON_HASH = `$argon2id$v=19$m=${PARAMETERS.memory},t=${PARAMETERS.passes},p=${PARAMETERS.parallelism}$${"A".repeat(22)}$${"A".repeat(43)}`;

const derive = (password: string, salt: Uint8Array, parameters: Argon2Cost, length: number) =>
  Kdf.Kdf.pipe(
    Effect.flatMap((kdf) =>
      kdf.derive(Kdf.argon2id(parameters), encoder.encode(password), { salt, length }),
    ),
    Effect.orDie,
  );

export const hashPassword = Effect.fn("passwords.hash")(function* (password: string) {
  const cost = yield* PasswordHashCost;
  const salt = yield* (yield* SecureRandom.SecureRandom).randomBytes(16);
  const hash = yield* derive(password, salt, cost, 32);
  return `$argon2id$v=19$m=${cost.memory},t=${cost.passes},p=${cost.parallelism}$${unpadded(salt)}$${unpadded(hash)}`;
});

export const verifyPassword = Effect.fn("passwords.verify")(function* (
  password: string,
  phc: string,
) {
  const match = PHC.exec(phc);
  const salt =
    match?.[4] === undefined ? undefined : Result.getOrUndefined(Base64.decode(padded(match[4])));
  const expected =
    match?.[5] === undefined ? undefined : Result.getOrUndefined(Base64.decode(padded(match[5])));
  if (match === null || salt === undefined || expected === undefined) {
    return false;
  }
  const actual = yield* derive(
    password,
    salt,
    { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) },
    expected.length,
  );
  return Mac.timingSafeEqual(actual, expected);
});
