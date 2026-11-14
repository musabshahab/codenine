import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
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

export const ControlOk = Schema.Struct({ ok: Schema.Literal(true) });

/** The signed-in person. */
export const ControlMe = Schema.Struct({
  id: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  role: ControlRole,
});
export type ControlMe = typeof ControlMe.Type;

export const ControlSessionEntry = Schema.Struct({
  ...ControlSession.fields,
  /** The session making this request. */
  current: Schema.Boolean,
});
export type ControlSessionEntry = typeof ControlSessionEntry.Type;

/** A set-up link for an admin to pass on. It works once. */
export const ControlIssuedLink = Schema.Struct({ person: ControlPerson, link: Schema.String });
export type ControlIssuedLink = typeof ControlIssuedLink.Type;

export class ControlSignedOutError extends Schema.TaggedError<ControlSignedOutError>()(
  "ControlSignedOutError",
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Sign in to continue.";
  }
}

export class ControlForbiddenError extends Schema.TaggedError<ControlForbiddenError>()(
  "ControlForbiddenError",
  {},
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Only owners and admins can do this.";
  }
}

export class ControlLicenceInstallError extends Schema.TaggedError<ControlLicenceInstallError>()(
  "ControlLicenceInstallError",
  { problem: LicenceProblem },
  { httpApiStatus: 400 },
) {}

export class ControlPrincipal extends Context.Service<
  ControlPrincipal,
  { readonly sessionId: string; readonly person: ControlMe }
>()("@codenine/contracts/control/ControlPrincipal") {}

/** Reads the session cookie. */
export class ControlSessionAuth extends HttpApiMiddleware.Service<
  ControlSessionAuth,
  { provides: ControlPrincipal }
>()("ControlSessionAuth", { error: ControlSignedOutError }) {}

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

const ControlAccountGroup = HttpApiGroup.make("account").add(
  HttpApiEndpoint.post("signIn", "/control/api/sign-in", {
    payload: Schema.Struct({ email: Schema.String, password: Schema.String }),
    success: Schema.Struct({ ticket: Schema.String }),
    error: ControlSignInError,
  }).annotate(OpenApi.Summary, "Check a password; the ticket goes to the code step"),
  HttpApiEndpoint.post("completeSignIn", "/control/api/sign-in/code", {
    payload: Schema.Struct({ ticket: Schema.String, code: Schema.String }),
    success: ControlMe,
    error: ControlSignInError,
  }).annotate(OpenApi.Summary, "Check an authenticator or recovery code and start a session"),
  HttpApiEndpoint.post("startEnrolment", "/control/api/enrolment/start", {
    payload: Schema.Struct({ token: Schema.String }),
    success: ControlEnrolment,
    error: ControlAccountError,
  }).annotate(OpenApi.Summary, "Open an invitation or reset link"),
  HttpApiEndpoint.post("finishEnrolment", "/control/api/enrolment/finish", {
    payload: Schema.Struct({ token: Schema.String, password: Schema.String, code: Schema.String }),
    success: Schema.Struct({ me: ControlMe, recoveryCodes: Schema.Array(Schema.String) }),
    error: ControlAccountError,
  }).annotate(OpenApi.Summary, "Set a password and authenticator and start a session"),
);

const ControlMeGroup = HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("me", "/control/api/me", { success: ControlMe }),
    HttpApiEndpoint.post("signOut", "/control/api/sign-out", { success: ControlOk }),
    HttpApiEndpoint.get("sessions", "/control/api/me/sessions", {
      success: Schema.Array(ControlSessionEntry),
    }),
    HttpApiEndpoint.delete("revokeSession", "/control/api/me/sessions/:sessionId", {
      params: Schema.Struct({ sessionId: TrimmedNonEmptyString }),
      success: ControlOk,
    }),
    HttpApiEndpoint.post("signOutEverywhere", "/control/api/me/sign-out-everywhere", {
      success: ControlOk,
    }),
  )
  .middleware(ControlSessionAuth);

const PersonParams = Schema.Struct({ personId: TrimmedNonEmptyString });

const ControlAdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("licence", "/control/api/admin/licence", {
      success: ControlLicenceOverview,
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.put("installLicence", "/control/api/admin/licence", {
      payload: Schema.Struct({ token: Schema.String }),
      success: ControlLicenceOverview,
      error: [ControlForbiddenError, ControlLicenceInstallError],
    }),
    HttpApiEndpoint.get("people", "/control/api/admin/people", {
      success: Schema.Array(ControlPerson),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("invite", "/control/api/admin/people", {
      payload: Schema.Struct({
        email: Schema.String,
        displayName: Schema.String,
        role: Schema.Literals(["admin", "member"]),
      }),
      success: ControlIssuedLink,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("deactivate", "/control/api/admin/people/:personId/deactivate", {
      params: PersonParams,
      success: ControlOk,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("reactivate", "/control/api/admin/people/:personId/reactivate", {
      params: PersonParams,
      success: ControlPerson,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("reset", "/control/api/admin/people/:personId/reset", {
      params: PersonParams,
      success: ControlIssuedLink,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("unlock", "/control/api/admin/people/:personId/unlock", {
      params: PersonParams,
      success: ControlOk,
      error: [ControlForbiddenError, ControlAccountError],
    }),
  )
  .middleware(ControlSessionAuth);

export const ControlApi = HttpApi.make("ControlApi")
  .add(ControlHealthGroup, ControlAccountGroup, ControlMeGroup, ControlAdminGroup)
  .annotate(OpenApi.Title, "Codenine Control API");
export type ControlApi = typeof ControlApi;
