import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LicenceEdition, LicenceFeature, LicenceProblem, LicenceStatus } from "./licence.ts";

export const ControlLicenceSummary = Schema.TaggedUnion({
  missing: {},
  unusable: { licenceId: TrimmedNonEmptyString, problem: LicenceProblem },
  installed: {
    licenceId: TrimmedNonEmptyString,
    customer: TrimmedNonEmptyString,
    seats: PositiveInt,
    seatsUsed: NonNegativeInt,
    editions: Schema.NonEmptyArray(LicenceEdition),
    features: Schema.Array(LicenceFeature),
    status: LicenceStatus,
    startsAt: IsoDateTime,
    /** The licence covers time before this instant; grace follows it. */
    expiresAt: IsoDateTime,
    graceEndsAt: IsoDateTime,
    installedAt: IsoDateTime,
  },
});
export type ControlLicenceSummary = typeof ControlLicenceSummary.Type;

export const ControlLicenceOverview = Schema.Struct({
  /** Licence keys can be tied to this ID. */
  installationId: TrimmedNonEmptyString,
  licence: ControlLicenceSummary,
});
export type ControlLicenceOverview = typeof ControlLicenceOverview.Type;

export const ControlRole = Schema.Literals(["owner", "admin", "member"]);
export type ControlRole = typeof ControlRole.Type;

/** Invited and active people hold a seat; deactivated people do not. */
export const ControlPersonStatus = Schema.Literals(["invited", "active", "deactivated"]);
export type ControlPersonStatus = typeof ControlPersonStatus.Type;

export const ControlPerson = Schema.Struct({
  id: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  role: ControlRole,
  status: ControlPersonStatus,
  /** False until they set a password and an authenticator app, and again after a reset. */
  canSignIn: Schema.Boolean,
  /** Set after too many failed sign-ins; an admin can unlock sooner. */
  lockedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type ControlPerson = typeof ControlPerson.Type;

export const ControlSession = Schema.Struct({
  id: TrimmedNonEmptyString,
  userAgent: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ControlSession = typeof ControlSession.Type;

/** What an invitation or reset link shows before the person sets a password. */
export const ControlEnrolment = Schema.Struct({
  purpose: Schema.Literals(["invitation", "reset"]),
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  /** An `otpauth://` URI for a QR code; the secret is also shown for typing in. */
  authenticatorUri: Schema.String,
  authenticatorSecret: Schema.String,
});
export type ControlEnrolment = typeof ControlEnrolment.Type;

export class ControlAccountError extends Schema.TaggedError<ControlAccountError>()(
  "ControlAccountError",
  {
    reason: Schema.Literals([
      "invalid-email",
      "email-taken",
      "not-found",
      "owner-exists",
      "last-owner",
      "no-free-seat",
      "invalid-link",
      "weak-password",
      "wrong-code",
    ]),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-email":
        return "That is not an email address.";
      case "email-taken":
        return "Someone with that email address already has an account.";
      case "not-found":
        return "That person does not exist.";
      case "owner-exists":
        return "This installation already has an owner. Ask them to invite you.";
      case "last-owner":
        return "The last owner cannot be deactivated.";
      case "no-free-seat":
        return "Every seat on the licence is taken, or no working licence is installed.";
      case "invalid-link":
        return "This link has expired or has already been used. Ask an admin for a new one.";
      case "weak-password":
        return "Use a password of at least 12 characters.";
      case "wrong-code":
        return "That code is not right. Check the time on your device and try the newest code.";
    }
  }
}

export class ControlSignInError extends Schema.TaggedError<ControlSignInError>()(
  "ControlSignInError",
  {
    reason: Schema.Literals(["wrong-credentials", "locked", "invalid-ticket", "wrong-code"]),
    lockedUntil: Schema.optionalKey(IsoDateTime),
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    switch (this.reason) {
      case "wrong-credentials":
        return "The email address or password is wrong.";
      case "locked":
        return "Too many failed attempts. Try again later or ask an admin to unlock your account.";
      case "invalid-ticket":
        return "Sign-in took too long. Start again.";
      case "wrong-code":
        return "That code is not right.";
    }
  }
}

export class ControlUnavailableError extends Schema.TaggedError<ControlUnavailableError>()(
  "ControlUnavailableError",
  { reason: Schema.Literals(["database-unavailable"]) },
  { httpApiStatus: 503 },
) {}

export const ControlHealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("control"),
});
export type ControlHealthResponse = typeof ControlHealthResponse.Type;

/**
 * Everything the control server answers itself lives under `/control`, so
 * `/api` and `/ws` stay free to forward to a workspace server.
 */
const ControlHealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/control/health", {
    success: ControlHealthResponse,
    error: ControlUnavailableError,
  }).annotate(OpenApi.Summary, "Check the control server and its database"),
);

export const ControlApi = HttpApi.make("ControlApi")
  .add(ControlHealthGroup)
  .annotate(OpenApi.Title, "Codenine Control API");
export type ControlApi = typeof ControlApi;
