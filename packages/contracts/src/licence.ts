import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LICENCE_TOKEN_TYPE = "codenine-licence+jwt";
export const LICENCE_ISSUER = "codenine";

export const LicenceEdition = Schema.Literals(["coding", "creative", "office"]);
export type LicenceEdition = typeof LicenceEdition.Type;

export const LicenceFeature = Schema.Literals([
  "single-sign-on",
  "saml",
  "provisioning",
  "audit-export",
  "ai-gateway",
  "offline-install",
  "custom-roles",
]);
export type LicenceFeature = typeof LicenceFeature.Type;

/** Claims of a signed business licence. Times are Unix seconds. */
export const LicenceClaims = Schema.Struct({
  iss: Schema.Literal(LICENCE_ISSUER),
  sub: TrimmedNonEmptyString,
  customer: TrimmedNonEmptyString,
  seats: PositiveInt,
  editions: Schema.NonEmptyArray(LicenceEdition),
  features: Schema.Array(LicenceFeature),
  iat: NonNegativeInt,
  nbf: NonNegativeInt,
  exp: NonNegativeInt,
  graceDays: NonNegativeInt,
  installationId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LicenceClaims = typeof LicenceClaims.Type;

/** `grace` keeps everything working after expiry; `expired` means read-only. */
export const LicenceStatus = Schema.Literals([
  "not-yet-valid",
  "active",
  "expiring",
  "grace",
  "expired",
]);
export type LicenceStatus = typeof LicenceStatus.Type;
