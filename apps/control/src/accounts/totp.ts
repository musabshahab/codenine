import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// RFC 6238 with the defaults every authenticator app supports.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding, as authenticator apps expect. */
export const base32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? output + BASE32_ALPHABET[(value << (5 - bits)) & 31] : output;
};

export const authenticatorUri = (input: {
  readonly issuer: string;
  readonly account: string;
  readonly secret: Uint8Array;
}) => {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const issuer = encodeURIComponent(input.issuer);
  return `otpauth://totp/${label}?secret=${base32(input.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
};

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1_000 / STEP_SECONDS);

export const totpCode = Effect.fn("totp.code")(function* (secret: Uint8Array, step: number) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha1, secret);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const digest = yield* mac.sign(key, counter);
  const byte = (index: number) => digest[index] ?? 0;
  const offset = byte(digest.length - 1) & 0x0f;
  const binary =
    ((byte(offset) & 0x7f) << 24) |
    (byte(offset + 1) << 16) |
    (byte(offset + 2) << 8) |
    byte(offset + 3);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}, Effect.orDie);

/**
 * Finds the time step a code belongs to, allowing one step of clock drift
 * either way. Steps at or before `lastStep` are refused, so a code works once.
 */
export const matchTotp = Effect.fn("totp.match")(function* (input: {
  readonly secret: Uint8Array;
  readonly code: string;
  readonly nowMs: number;
  readonly lastStep: number;
}) {
  const current = totpStep(input.nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (step > input.lastStep && (yield* totpCode(input.secret, step)) === input.code) {
      return Option.some(step);
    }
  }
  return Option.none<number>();
});
