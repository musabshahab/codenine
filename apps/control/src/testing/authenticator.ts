import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { totpCode, totpStep } from "../accounts/totp.ts";

/** Reads an authenticator secret back from the base32 a person would type in. */
export const fromBase32 = (text: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: Array<number> = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
};

/** The code an authenticator app shows right now. */
export const codeNow = (secret: Uint8Array) =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((ms) => totpCode(secret, totpStep(ms))));
