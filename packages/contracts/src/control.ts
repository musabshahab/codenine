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

/** Whether people can change anything in their workspace, and if not, why. */
export const ControlWorkspaceAccess = Schema.Struct({
  canWork: Schema.Boolean,
  reason: Schema.NullOr(
    Schema.Literals(["no-licence", "licence-unusable", "licence-not-started", "licence-ended"]),
  ),
});
export type ControlWorkspaceAccess = typeof ControlWorkspaceAccess.Type;

/** An asleep workspace starts on the person's next request, which takes a few seconds. */
export const ControlWorkspaceState = Schema.Struct({ asleep: Schema.Boolean });
export type ControlWorkspaceState = typeof ControlWorkspaceState.Type;

export const ControlRole = Schema.Literals([
  "owner",
  "admin",
  "department-admin",
  "member",
  "restricted",
  "auditor",
]);
export type ControlRole = typeof ControlRole.Type;

/** What a role may do on the control server. Workspace abilities are separate scopes. */
export const ControlPermission = Schema.Literals([
  "licence:manage",
  "licence:read",
  "security:manage",
  "people:manage",
  "departments:manage",
  "audit:read",
]);
export type ControlPermission = typeof ControlPermission.Type;

/** `own-department` reaches only the departments the person belongs to. */
export type ControlPermissionReach = "all" | "own-department";

const ROLE_PERMISSIONS: Record<
  ControlRole,
  Partial<Record<ControlPermission, ControlPermissionReach>>
> = {
  owner: {
    "licence:manage": "all",
    "licence:read": "all",
    "security:manage": "all",
    "people:manage": "all",
    "departments:manage": "all",
    "audit:read": "all",
  },
  admin: {
    "licence:read": "all",
    "security:manage": "all",
    "people:manage": "all",
    "departments:manage": "all",
    "audit:read": "all",
  },
  "department-admin": {
    "people:manage": "own-department",
    "departments:manage": "own-department",
    "audit:read": "own-department",
  },
  member: {},
  restricted: {},
  auditor: { "audit:read": "all" },
};

/** How far a role's permission reaches, or null when it has none. */
export const permissionReach = (role: ControlRole, permission: ControlPermission) =>
  ROLE_PERMISSIONS[role][permission] ?? null;

/** The roles a role may give: owners any, admins any but owner, department admins two. */
export const assignableRoles = (role: ControlRole): ReadonlyArray<ControlRole> => {
  switch (role) {
    case "owner":
      return ControlRole.literals;
    case "admin":
      return ControlRole.literals.filter((assignable) => assignable !== "owner");
    case "department-admin":
      return ["member", "restricted"];
    default:
      return [];
  }
};

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

// WebAuthn's JSON forms, which browsers parse and produce (`parseCreationOptionsFromJSON`,
// `PublicKeyCredential.toJSON`). Binary fields are base64url strings.
const PasskeyDescriptor = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("public-key"),
  transports: Schema.optionalKey(Schema.Array(Schema.String)),
});
const UserVerification = Schema.Literals(["discouraged", "preferred", "required"]);

/** Options for creating a passkey. */
export const PasskeyCreationOptions = Schema.Struct({
  rp: Schema.Struct({ id: Schema.optionalKey(Schema.String), name: Schema.String }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  challenge: Schema.String,
  pubKeyCredParams: Schema.Array(
    Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Number }),
  ),
  timeout: Schema.optionalKey(Schema.Number),
  excludeCredentials: Schema.optionalKey(Schema.Array(PasskeyDescriptor)),
  authenticatorSelection: Schema.optionalKey(
    Schema.Struct({
      authenticatorAttachment: Schema.optionalKey(Schema.Literals(["platform", "cross-platform"])),
      requireResidentKey: Schema.optionalKey(Schema.Boolean),
      residentKey: Schema.optionalKey(UserVerification),
      userVerification: Schema.optionalKey(UserVerification),
    }),
  ),
  attestation: Schema.optionalKey(Schema.Literals(["none", "indirect", "direct", "enterprise"])),
});
export type PasskeyCreationOptions = typeof PasskeyCreationOptions.Type;

/** Options for proving a passkey the person already has. */
export const PasskeyRequestOptions = Schema.Struct({
  challenge: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.Array(PasskeyDescriptor)),
  userVerification: Schema.optionalKey(UserVerification),
});
export type PasskeyRequestOptions = typeof PasskeyRequestOptions.Type;

/** A new passkey, as the browser returns it. */
export const PasskeyRegistration = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    attestationObject: Schema.String,
    transports: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  authenticatorAttachment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PasskeyRegistration = typeof PasskeyRegistration.Type;

/** A passkey's answer to a challenge, as the browser returns it. */
export const PasskeyAssertion = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.String,
    signature: Schema.String,
    userHandle: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  authenticatorAttachment: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PasskeyAssertion = typeof PasskeyAssertion.Type;

export const ControlPasskey = Schema.Struct({
  id: Schema.String,
  name: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type ControlPasskey = typeof ControlPasskey.Type;

/** How the signed-in person proves it is them after their password. */
export const ControlSignInMethods = Schema.Struct({
  authenticator: Schema.Boolean,
  passkeys: Schema.Array(ControlPasskey),
  recoveryCodesLeft: NonNegativeInt,
});
export type ControlSignInMethods = typeof ControlSignInMethods.Type;

/**
 * What a set-up link shows before the person sets a password. Invitations and
 * admin resets set up a new second factor, an authenticator app or a passkey;
 * a forgotten-password link asks for the current one.
 */
export const ControlEnrolment = Schema.Struct({
  purpose: Schema.Literals(["invitation", "reset", "password"]),
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  /** An `otpauth://` URI for a QR code, and its secret for typing in. */
  authenticator: Schema.optionalKey(Schema.Struct({ uri: Schema.String, secret: Schema.String })),
  /** For setting up a passkey instead of the authenticator app. */
  passkeySetup: Schema.optionalKey(PasskeyCreationOptions),
  /** For a forgotten password, when the person has passkeys. */
  passkeyCheck: Schema.optionalKey(PasskeyRequestOptions),
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
      "locked",
      "email-off",
      "passkey-failed",
      "last-second-factor",
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
        return "Codenine needs at least one owner. Make someone else an owner first.";
      case "no-free-seat":
        return "Every seat on the licence is taken, or no working licence is installed.";
      case "invalid-link":
        return "This link has expired or has already been used. Ask an admin for a new one.";
      case "weak-password":
        return "Use a password of at least 12 characters.";
      case "wrong-code":
        return "That code is not right. Check the time on your device and try the newest code.";
      case "locked":
        return "Too many failed attempts. Try again later or ask an admin to unlock your account.";
      case "email-off":
        return "This installation does not send email. Ask an admin to reset your sign-in.";
      case "passkey-failed":
        return "The passkey could not be checked. Try again.";
      case "last-second-factor":
        return "Keep at least one passkey or an authenticator app, so you can still sign in.";
    }
  }
}

export class ControlSignInError extends Schema.TaggedError<ControlSignInError>()(
  "ControlSignInError",
  {
    reason: Schema.Literals([
      "wrong-credentials",
      "locked",
      "invalid-ticket",
      "wrong-code",
      "passkey-failed",
      "desktop-code",
    ]),
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
      case "passkey-failed":
        return "That passkey did not work. Try again, or use a code.";
      case "desktop-code":
        return "That code is not right, or it has expired. Get a new one in your browser.";
    }
  }
}

/** A code a signed-in browser shows, to sign the desktop app in once. */
export const ControlDesktopCode = Schema.Struct({
  code: Schema.String,
  expiresAt: IsoDateTime,
});
export type ControlDesktopCode = typeof ControlDesktopCode.Type;

export class ControlUnavailableError extends Schema.TaggedError<ControlUnavailableError>()(
  "ControlUnavailableError",
  { reason: Schema.Literals(["database-unavailable", "workspace-unavailable"]) },
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
export const ControlIssuedLink = Schema.Struct({
  person: ControlPerson,
  link: Schema.String,
  /** True when the link was also emailed to the person. */
  emailed: Schema.Boolean,
});
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
    return "Your role does not allow this.";
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
    success: Schema.Struct({
      ticket: Schema.String,
      /** False when the person has only passkeys and recovery codes. */
      authenticator: Schema.Boolean,
      passkey: Schema.optionalKey(PasskeyRequestOptions),
    }),
    error: ControlSignInError,
  }).annotate(OpenApi.Summary, "Check a password; the ticket goes to the second step"),
  HttpApiEndpoint.post("completeSignIn", "/control/api/sign-in/code", {
    payload: Schema.Struct({
      ticket: Schema.String,
      code: Schema.optionalKey(Schema.String),
      passkey: Schema.optionalKey(PasskeyAssertion),
    }),
    success: ControlMe,
    error: ControlSignInError,
  }).annotate(OpenApi.Summary, "Check a code or passkey and start a session"),
  HttpApiEndpoint.post("desktopSignIn", "/control/api/desktop-sign-in", {
    payload: Schema.Struct({ code: Schema.String }),
    success: ControlMe,
    error: ControlSignInError,
  }).annotate(OpenApi.Summary, "Start a desktop app's session from a code a browser showed"),
  HttpApiEndpoint.post("requestPasswordReset", "/control/api/password-reset", {
    payload: Schema.Struct({ email: Schema.String }),
    success: ControlOk,
    error: ControlAccountError,
  }).annotate(
    OpenApi.Summary,
    "Email a link to choose a new password, if the address has an account",
  ),
  HttpApiEndpoint.post("startEnrolment", "/control/api/enrolment/start", {
    payload: Schema.Struct({ token: Schema.String }),
    success: ControlEnrolment,
    error: ControlAccountError,
  }).annotate(OpenApi.Summary, "Open an invitation, reset or new-password link"),
  HttpApiEndpoint.post("finishEnrolment", "/control/api/enrolment/finish", {
    payload: Schema.Struct({
      token: Schema.String,
      password: Schema.String,
      /** The authenticator code, or for a forgotten password a recovery code. */
      code: Schema.optionalKey(Schema.String),
      newPasskey: Schema.optionalKey(PasskeyRegistration),
      passkey: Schema.optionalKey(PasskeyAssertion),
    }),
    success: Schema.Struct({ me: ControlMe, recoveryCodes: Schema.Array(Schema.String) }),
    error: ControlAccountError,
  }).annotate(
    OpenApi.Summary,
    "Set a password, prove or set up the second factor, and start a session",
  ),
);

const ControlMeGroup = HttpApiGroup.make("me")
  .add(
    HttpApiEndpoint.get("me", "/control/api/me", { success: ControlMe }),
    HttpApiEndpoint.get("access", "/control/api/me/access", { success: ControlWorkspaceAccess }),
    HttpApiEndpoint.get("workspace", "/control/api/me/workspace", {
      success: ControlWorkspaceState,
      error: ControlUnavailableError,
    }),
    HttpApiEndpoint.post("wakeWorkspace", "/control/api/me/workspace/wake", {
      success: ControlOk,
      error: ControlUnavailableError,
    }),
    HttpApiEndpoint.post("createDesktopCode", "/control/api/me/desktop-code", {
      success: ControlDesktopCode,
    }),
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
    HttpApiEndpoint.get("signInMethods", "/control/api/me/sign-in-methods", {
      success: ControlSignInMethods,
    }),
    HttpApiEndpoint.post("startPasskey", "/control/api/me/passkeys/options", {
      success: Schema.Struct({ ticket: Schema.String, options: PasskeyCreationOptions }),
    }),
    HttpApiEndpoint.post("addPasskey", "/control/api/me/passkeys", {
      payload: Schema.Struct({
        ticket: Schema.String,
        name: Schema.String,
        passkey: PasskeyRegistration,
      }),
      success: ControlPasskey,
      error: ControlAccountError,
    }),
    HttpApiEndpoint.delete("removePasskey", "/control/api/me/passkeys/:passkeyId", {
      params: Schema.Struct({ passkeyId: TrimmedNonEmptyString }),
      success: ControlOk,
      error: ControlAccountError,
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
        role: ControlRole,
      }),
      success: ControlIssuedLink,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.put("setRole", "/control/api/admin/people/:personId/role", {
      params: PersonParams,
      payload: Schema.Struct({ role: ControlRole }),
      success: ControlPerson,
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
