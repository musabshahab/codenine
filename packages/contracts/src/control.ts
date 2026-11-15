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
  "ai:manage",
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
    "ai:manage": "all",
  },
  admin: {
    "licence:read": "all",
    "people:manage": "all",
    "departments:manage": "all",
    "audit:read": "all",
    "ai:manage": "all",
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
  /** An owner who may sign in with a password while single sign-on is required. */
  emergency: Schema.Boolean,
  /** False until they set a password and an authenticator app, and again after a reset. */
  canSignIn: Schema.Boolean,
  /** Set after too many failed sign-ins; an admin can unlock sooner. */
  lockedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type ControlPerson = typeof ControlPerson.Type;

export const ControlTeam = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Each is also a member of the team's department. */
  members: Schema.Array(TrimmedNonEmptyString),
});
export type ControlTeam = typeof ControlTeam.Type;

/** A department and the people in it, by person ID. People can be in several. */
export const ControlDepartment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  members: Schema.Array(TrimmedNonEmptyString),
  teams: Schema.Array(ControlTeam),
});
export type ControlDepartment = typeof ControlDepartment.Type;

export class ControlDepartmentError extends Schema.TaggedError<ControlDepartmentError>()(
  "ControlDepartmentError",
  {
    reason: Schema.Literals([
      "invalid-name",
      "name-taken",
      "not-found",
      "not-empty",
      "not-in-department",
    ]),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-name":
        return "Give it a name of up to 128 characters.";
      case "name-taken":
        return "Another one already has that name.";
      case "not-found":
        return "That department or team does not exist.";
      case "not-empty":
        return "Move everyone out of the department before deleting it.";
      case "not-in-department":
        return "Add them to the department first.";
    }
  }
}

/** A host name, or with a leading dot, a domain and everything under it. */
export const ControlHost = Schema.String.check(Schema.isPattern(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/u));

/** Settings a layer can lock, so the layers below cannot change them. */
export const ControlProfileScalar = Schema.Literals([
  "image",
  "cpus",
  "memoryGb",
  "sleepMinutes",
  "claudeModels",
  "codexModels",
  "effort",
  "monthlyUsd",
  "dailyUsd",
]);
export type ControlProfileScalar = typeof ControlProfileScalar.Type;

/** An amount in US dollars, as the providers bill. */
export const ControlUsd = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000_000),
);

/** How hard a model may think, lowest first. Claude and OpenAI name their levels alike. */
export const ControlAiEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type ControlAiEffort = typeof ControlAiEffort.Type;

/** Why the AI gateway refused a call: a budget that was used up, or a rule. */
export const ControlAiRefusal = Schema.Literals([
  "person-month",
  "person-day",
  "department-month",
  "company-month",
  "model",
  "effort",
  "unpriced",
]);
export type ControlAiRefusal = typeof ControlAiRefusal.Type;

/** A model as the providers name it, such as `claude-opus-5-5` or `gpt-5.5`. */
export const ControlAiModel = Schema.String.check(Schema.isPattern(/^[a-z0-9][\w.:@/-]*$/u));

/**
 * One layer of a workspace profile: the company's, a department's, a team's or
 * one person's exception. What a layer leaves out comes from the layer above;
 * what a layer locks or blocks, no layer below can change.
 */
export const ControlProfileSettings = Schema.Struct({
  /** The workspace image; without one, the installation's. */
  image: Schema.optionalKey(TrimmedNonEmptyString),
  cpus: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(64)),
  ),
  memoryGb: Schema.optionalKey(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(512)),
  ),
  /** How long an idle workspace stays awake. */
  sleepMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(1440)),
  ),
  /** Whether members get a terminal. Owners and admins always do; restricted people never. */
  terminal: Schema.optionalKey(Schema.Literals(["allow", "block"])),
  /** Hosts workspaces may reach beyond the installation's list. */
  allowHosts: Schema.optionalKey(Schema.Array(ControlHost)),
  /** Hosts no layer below can allow, from the installation's list too. */
  blockHosts: Schema.optionalKey(Schema.Array(ControlHost)),
  /** The only models Claude may use. */
  claudeModels: Schema.optionalKey(Schema.Array(ControlAiModel).check(Schema.isMinLength(1))),
  /** The only models Codex may use. */
  codexModels: Schema.optionalKey(Schema.Array(ControlAiModel).check(Schema.isMinLength(1))),
  /** The highest effort a call may ask for. */
  effort: Schema.optionalKey(ControlAiEffort),
  /** What each person may spend on AI in a month. */
  monthlyUsd: Schema.optionalKey(ControlUsd),
  /** What each person may spend on AI in a day, to stop an agent stuck in a loop. */
  dailyUsd: Schema.optionalKey(ControlUsd),
  /** The company's profile only: what everyone may spend on AI in a month together. */
  companyMonthlyUsd: Schema.optionalKey(ControlUsd),
  /** The company's profile only: what each department's people may spend in a month together, by department id. */
  departmentMonthlyUsd: Schema.optionalKey(Schema.Record(Schema.String, ControlUsd)),
  /** Settings the layers below cannot change. */
  lock: Schema.optionalKey(Schema.Array(ControlProfileScalar)),
});
export type ControlProfileSettings = typeof ControlProfileSettings.Type;

/** What a person's workspace in one department is made from, all layers applied. */
export const ControlEffectiveProfile = Schema.Struct({
  /** Null for the installation's image. */
  image: Schema.NullOr(Schema.String),
  cpus: Schema.Number,
  memoryGb: Schema.Number,
  sleepMinutes: Schema.Number,
  terminal: Schema.Boolean,
  /** Beyond the installation's list. */
  allowHosts: Schema.Array(Schema.String),
  blockHosts: Schema.Array(Schema.String),
  /** Null where any model may be used. */
  claudeModels: Schema.NullOr(Schema.Array(Schema.String)),
  codexModels: Schema.NullOr(Schema.Array(Schema.String)),
  effort: Schema.NullOr(ControlAiEffort),
  /** Budgets in US dollars; null where there is no limit. */
  monthlyUsd: Schema.NullOr(Schema.Number),
  dailyUsd: Schema.NullOr(Schema.Number),
  /** What the person's department may spend in a month, together. */
  departmentMonthlyUsd: Schema.NullOr(Schema.Number),
  companyMonthlyUsd: Schema.NullOr(Schema.Number),
});
export type ControlEffectiveProfile = typeof ControlEffectiveProfile.Type;

/** The effective settings a preview lists changes to. */
export const ControlProfileSetting = Schema.Literals([
  "image",
  "cpus",
  "memoryGb",
  "sleepMinutes",
  "terminal",
  "allowHosts",
  "blockHosts",
  "claudeModels",
  "codexModels",
  "effort",
  "monthlyUsd",
  "dailyUsd",
  "departmentMonthlyUsd",
  "companyMonthlyUsd",
]);
export type ControlProfileSetting = typeof ControlProfileSetting.Type;

/** `company`, `department:<id>` or `team:<id>`. */
export const ControlProfileId = Schema.String.check(
  Schema.isPattern(/^(company|department:[\w-]+|team:[\w-]+)$/u),
);
export type ControlProfileId = typeof ControlProfileId.Type;

export const ControlProfileVersion = Schema.Struct({
  version: PositiveInt,
  settings: ControlProfileSettings,
  note: Schema.String,
  createdBy: Schema.String,
  createdAt: IsoDateTime,
});
export type ControlProfileVersion = typeof ControlProfileVersion.Type;

export const ControlProfile = Schema.Struct({
  id: ControlProfileId,
  /** What admins call it, such as `Company`, `Design` or `Design / Brand`. */
  name: Schema.String,
  /** The version everyone gets; null while it has none. */
  published: Schema.NullOr(PositiveInt),
  /** A newer version only some people get, until it is published or discarded. */
  test: Schema.NullOr(
    Schema.Struct({ version: PositiveInt, people: Schema.Array(TrimmedNonEmptyString) }),
  ),
  /** Newest first. */
  versions: Schema.Array(ControlProfileVersion),
});
export type ControlProfile = typeof ControlProfile.Type;

/** How a draft would change what people get, before it is saved. */
export const ControlProfilePreview = Schema.Struct({
  /** Everyone the profile applies to. */
  people: NonNegativeInt,
  /** Of them, those whose workspace or AI rules would change. */
  affected: NonNegativeInt,
  changes: Schema.Array(
    Schema.Struct({
      setting: ControlProfileSetting,
      people: NonNegativeInt,
      /** Values or hosts some people lose, and those they gain. */
      removed: Schema.Array(Schema.String),
      added: Schema.Array(Schema.String),
    }),
  ),
});
export type ControlProfilePreview = typeof ControlProfilePreview.Type;

/** A time-limited change for one person, applied after their teams. */
export const ControlProfileException = Schema.Struct({
  id: TrimmedNonEmptyString,
  personId: TrimmedNonEmptyString,
  /** Null for every department the person is in. */
  departmentId: Schema.NullOr(TrimmedNonEmptyString),
  settings: ControlProfileSettings,
  reason: Schema.String,
  endsAt: IsoDateTime,
  createdBy: Schema.String,
  createdAt: IsoDateTime,
});
export type ControlProfileException = typeof ControlProfileException.Type;

export class ControlProfileError extends Schema.TaggedError<ControlProfileError>()(
  "ControlProfileError",
  {
    reason: Schema.Literals([
      "not-found",
      "nothing-to-test",
      "nothing-to-roll-back",
      "outside-profile",
      "needs-reason",
      "invalid-end",
      "company-only",
    ]),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "That profile or exception does not exist.";
      case "nothing-to-test":
        return "No version is being tested.";
      case "nothing-to-roll-back":
        return "There is no earlier version to go back to.";
      case "outside-profile":
        return "Test a change only with people the profile applies to.";
      case "needs-reason":
        return "Say why the exception is needed.";
      case "invalid-end":
        return "An exception ends within 90 days.";
      case "company-only":
        return "The company's and departments' AI budgets are set on the company profile.";
    }
  }
}

export const ControlProfileTemplateName = Schema.Literals([
  "Coder",
  "Infrastructure",
  "Marketing",
  "HR",
  "Product",
]);
export type ControlProfileTemplateName = typeof ControlProfileTemplateName.Type;

/** Starting points for department profiles, copied and then adjusted. */
export const CONTROL_PROFILE_TEMPLATES: Record<
  ControlProfileTemplateName,
  { readonly description: string; readonly settings: ControlProfileSettings }
> = {
  Coder: {
    description: "Large workspaces with a terminal, GitHub and the package registries.",
    settings: { cpus: 4, memoryGb: 8, sleepMinutes: 60, terminal: "allow" },
  },
  Infrastructure: {
    description: "A terminal and the cloud providers' APIs, for read-only credentials.",
    settings: {
      cpus: 2,
      memoryGb: 4,
      sleepMinutes: 30,
      terminal: "allow",
      allowHosts: [".amazonaws.com", ".googleapis.com", "management.azure.com"],
    },
  },
  Marketing: {
    description: "No terminal; agents draft and edit.",
    settings: { cpus: 2, memoryGb: 4, sleepMinutes: 30, terminal: "block" },
  },
  HR: {
    description: "Small workspaces with no terminal, and no GitHub or package registries.",
    settings: {
      cpus: 1,
      memoryGb: 2,
      sleepMinutes: 15,
      terminal: "block",
      blockHosts: [
        ".github.com",
        ".githubusercontent.com",
        ".npmjs.org",
        ".yarnpkg.com",
        "pypi.org",
        "files.pythonhosted.org",
        ".crates.io",
        "proxy.golang.org",
        "sum.golang.org",
        "repo.maven.apache.org",
        "repo1.maven.org",
      ],
    },
  },
  Product: {
    description: "A terminal for prototypes, in medium workspaces.",
    settings: { cpus: 2, memoryGb: 4, sleepMinutes: 30, terminal: "allow" },
  },
};

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
      "single-sign-on",
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
      case "single-sign-on":
        return "Your company signs in with single sign-on. Choose it below.";
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

/** The departments someone works in, each with its own workspace. */
export const ControlMyDepartments = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  ),
  /** The one this browser works in; null when they are in none. */
  current: Schema.NullOr(TrimmedNonEmptyString),
  /** Someone else's workspace an owner opened in this browser, read-only, until it ends. */
  viewing: Schema.NullOr(
    Schema.Struct({
      personId: TrimmedNonEmptyString,
      displayName: Schema.String,
      departmentName: Schema.NullOr(Schema.String),
      until: IsoDateTime,
    }),
  ),
});
export type ControlMyDepartments = typeof ControlMyDepartments.Type;

/** An email domain such as `acme.com`. */
export const ControlEmailDomain = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u),
);

export const ControlSsoProtocol = Schema.Literals(["oidc", "saml"]);
export type ControlSsoProtocol = typeof ControlSsoProtocol.Type;

const SsoCommon = {
  /** Shown on the sign-in button, such as "Microsoft Entra ID". */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Only addresses in these domains are accepted from it. */
  domains: Schema.Array(ControlEmailDomain).check(Schema.isMinLength(1)),
  /** People in these domains sign in only through it, apart from emergency owners. */
  required: Schema.Boolean,
  /** Signs in people Codenine does not know yet, as members, when a seat is free. */
  createPeople: Schema.Boolean,
  /** The claim or attribute listing the person's groups; null leaves departments and roles alone. */
  groupsClaim: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  /** Groups that give a role, the first match winning; everyone else in it is a member. */
  roleGroups: Schema.Array(Schema.Struct({ group: TrimmedNonEmptyString, role: ControlRole })),
};

/** What an owner sets for one identity provider. Its client secret is write-only. */
export const ControlSsoSettings = Schema.Struct({
  ...SsoCommon,
  oidc: Schema.optionalKey(
    Schema.Struct({
      issuer: TrimmedNonEmptyString,
      clientId: TrimmedNonEmptyString,
      /** Left out to keep the one saved. */
      clientSecret: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  saml: Schema.optionalKey(
    Schema.Struct({
      /** Where people are sent to sign in. */
      entryPoint: TrimmedNonEmptyString,
      /** Its entity ID, which every response must name. */
      issuer: TrimmedNonEmptyString,
      /** Its signing certificate, in PEM or as base64. */
      certificate: TrimmedNonEmptyString,
    }),
  ),
});
export type ControlSsoSettings = typeof ControlSsoSettings.Type;

export const ControlSsoConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  protocol: ControlSsoProtocol,
  ...SsoCommon,
  oidc: Schema.NullOr(Schema.Struct({ issuer: Schema.String, clientId: Schema.String })),
  saml: Schema.NullOr(
    Schema.Struct({ entryPoint: Schema.String, issuer: Schema.String, certificate: Schema.String }),
  ),
  /** Where the identity provider sends people back, to register with it. */
  redirectUrl: Schema.String,
  /** For SAML: this service's entity ID and metadata. */
  serviceEntityId: Schema.NullOr(Schema.String),
  metadataUrl: Schema.NullOr(Schema.String),
});
export type ControlSsoConnection = typeof ControlSsoConnection.Type;

/**
 * Where the gateway sends calls: Anthropic's API or another gateway that
 * speaks it for Claude; OpenAI's, Azure OpenAI's, or another gateway that
 * speaks it for Codex.
 */
export const ControlAiAccountKind = Schema.Literals([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "azure-openai",
  "openai-compatible",
]);
export type ControlAiAccountKind = typeof ControlAiAccountKind.Type;

/** The agent an account's kind serves. */
export const aiAccountServes = (kind: ControlAiAccountKind): "claude" | "codex" =>
  kind === "anthropic" || kind === "anthropic-compatible" ? "claude" : "codex";

const AiAccountCommon = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  kind: ControlAiAccountKind,
  /** Null for the provider's own address; needed for Azure OpenAI and another gateway. */
  baseUrl: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** A percentage added to every price: -15 for a negotiated discount, 10 for a regional endpoint. */
  priceAdjustment: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(-100),
    Schema.isLessThanOrEqualTo(100),
  ),
  /** Whether workspaces use it for the agent it serves unless a rule picks another. */
  isDefault: Schema.Boolean,
};

/** What an admin sets for a company AI account. Its key is write-only. */
export const ControlAiAccountSettings = Schema.Struct({
  ...AiAccountCommon,
  /** Left out to keep the saved one; a new account needs it. */
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type ControlAiAccountSettings = typeof ControlAiAccountSettings.Type;

/** A company AI account the gateway calls the provider with. */
export const ControlAiAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  ...AiAccountCommon,
  /** The key's last four characters, to tell keys apart. */
  keyHint: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ControlAiAccount = typeof ControlAiAccount.Type;

export class ControlAiError extends Schema.TaggedError<ControlAiError>()(
  "ControlAiError",
  { reason: Schema.Literals(["not-found", "needs-key", "needs-address", "bad-address"]) },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "That AI account does not exist.";
      case "needs-key":
        return "Give the account's API key.";
      case "needs-address":
        return "Give the address, such as https://acme.openai.azure.com/openai or https://litellm.acme.internal.";
      case "bad-address":
        return "The address must start with http:// or https:// and have no query or password.";
    }
  }
}

/** An identity provider the sign-in page offers. */
export const ControlSsoChoice = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type ControlSsoChoice = typeof ControlSsoChoice.Type;

export class ControlWorkspaceAccessError extends Schema.TaggedError<ControlWorkspaceAccessError>()(
  "ControlWorkspaceAccessError",
  { reason: Schema.Literals(["needs-reason", "not-in-department"]) },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "needs-reason":
        return "Say why you need their workspace, in at least 10 characters.";
      case "not-in-department":
        return "Choose one of the departments they work in.";
    }
  }
}

export class ControlSsoError extends Schema.TaggedError<ControlSsoError>()(
  "ControlSsoError",
  {
    reason: Schema.Literals([
      "not-found",
      "protocol-settings",
      "domain-taken",
      "no-emergency-owner",
      "not-owner",
    ]),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "That single sign-on setup does not exist.";
      case "protocol-settings":
        return "Give the settings of its protocol, and a client secret for a new OIDC setup.";
      case "domain-taken":
        return "Another single sign-on setup already signs in one of those domains.";
      case "no-emergency-owner":
        return "Requiring it would leave no owner who can sign in without it. Mark an emergency owner first.";
      case "not-owner":
        return "Only owners can be emergency owners.";
    }
  }
}

/** How an identity provider reaches the control server to add, change and remove people. */
export const ControlProvisioning = Schema.Struct({
  /** The SCIM 2.0 address to give the identity provider. */
  url: Schema.String,
  /** The token it uses; only its use is shown, never the token. */
  token: Schema.NullOr(
    Schema.Struct({
      createdAt: IsoDateTime,
      createdBy: Schema.String,
      lastUsedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});
export type ControlProvisioning = typeof ControlProvisioning.Type;

/** A new provisioning token, shown this once. */
export const ControlProvisioningToken = Schema.Struct({
  token: Schema.String,
  provisioning: ControlProvisioning,
});
export type ControlProvisioningToken = typeof ControlProvisioningToken.Type;

/** A set-up link for an admin to pass on. It works once. */
export const ControlIssuedLink = Schema.Struct({
  person: ControlPerson,
  link: Schema.String,
  /** True when the link was also emailed to the person. */
  emailed: Schema.Boolean,
});
export type ControlIssuedLink = typeof ControlIssuedLink.Type;

/**
 * Who acted: a person, someone at the control server's command line, the
 * identity provider through provisioning, or Codenine itself.
 */
export const ControlAuditActorKind = Schema.Literals([
  "person",
  "operator",
  "provisioning",
  "system",
]);
export type ControlAuditActorKind = typeof ControlAuditActorKind.Type;

export const ControlAuditAction = Schema.Literals([
  "licence.install",
  "person.invite",
  "person.provision",
  "person.update",
  "person.role",
  "person.deactivate",
  "person.reactivate",
  "person.reset",
  "person.unlock",
  "person.sign-in",
  "person.files-deleted",
  "department.create",
  "department.rename",
  "department.delete",
  "department.add-member",
  "department.remove-member",
  "team.create",
  "team.rename",
  "team.delete",
  "team.add-member",
  "team.remove-member",
  "profile.publish",
  "profile.test",
  "profile.discard",
  "profile.rollback",
  "exception.create",
  "exception.end",
  "provisioning.token-create",
  "provisioning.token-revoke",
  "person.emergency",
  "person.sign-out",
  "person.workspace-open",
  "person.workspace-close",
  "sso.create",
  "sso.update",
  "sso.delete",
  "ai-account.create",
  "ai-account.update",
  "ai-account.delete",
]);
export type ControlAuditAction = typeof ControlAuditAction.Type;

export const ControlAuditTargetKind = Schema.Literals([
  "person",
  "licence",
  "department",
  "team",
  "profile",
  "provisioning",
  "sso",
  "ai-account",
]);
export type ControlAuditTargetKind = typeof ControlAuditTargetKind.Type;

/** What a change touched, before and after it. Secrets never appear here. */
export const ControlAuditValues = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
);
export type ControlAuditValues = typeof ControlAuditValues.Type;

/** One entry in the append-only audit log. Labels are kept as they were at the time. */
export const ControlAuditEntry = Schema.Struct({
  id: PositiveInt,
  at: IsoDateTime,
  actor: Schema.Struct({
    kind: ControlAuditActorKind,
    id: Schema.NullOr(Schema.String),
    label: Schema.String,
  }),
  action: ControlAuditAction,
  target: Schema.NullOr(
    Schema.Struct({ kind: ControlAuditTargetKind, id: Schema.String, label: Schema.String }),
  ),
  /** Where the request came from, when it came over the network. */
  source: Schema.Struct({
    address: Schema.NullOr(Schema.String),
    userAgent: Schema.NullOr(Schema.String),
  }),
  before: Schema.NullOr(ControlAuditValues),
  after: Schema.NullOr(ControlAuditValues),
});
export type ControlAuditEntry = typeof ControlAuditEntry.Type;

/** Newest first. */
export const ControlAuditPage = Schema.Struct({
  entries: Schema.Array(ControlAuditEntry),
  /** Pass as `before` for older entries; null when these are the oldest. */
  next: Schema.NullOr(PositiveInt),
});
export type ControlAuditPage = typeof ControlAuditPage.Type;

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
  {
    readonly sessionId: string;
    /** The department chosen in this session, which may no longer be the person's. */
    readonly departmentId: string | null;
    /** Someone else's workspace an owner opened in this session, until it ends. */
    readonly viewing: {
      readonly personId: string;
      readonly departmentId: string | null;
      readonly until: string;
    } | null;
    readonly person: ControlMe;
  }
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
  HttpApiEndpoint.get("ssoChoices", "/control/api/sign-in/sso", {
    success: Schema.Array(ControlSsoChoice),
  }).annotate(OpenApi.Summary, "The identity providers the sign-in page offers"),
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
    HttpApiEndpoint.get("departments", "/control/api/me/departments", {
      success: ControlMyDepartments,
    }),
    HttpApiEndpoint.put("chooseDepartment", "/control/api/me/department", {
      payload: Schema.Struct({ departmentId: TrimmedNonEmptyString }),
      success: ControlMyDepartments,
      error: ControlDepartmentError,
    }),
    HttpApiEndpoint.post("leaveWorkspace", "/control/api/me/leave-workspace", {
      success: ControlMyDepartments,
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
const DepartmentParams = Schema.Struct({ departmentId: TrimmedNonEmptyString });
const TeamParams = Schema.Struct({ teamId: TrimmedNonEmptyString });
const ProfileParams = Schema.Struct({ profileId: ControlProfileId });

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
        /** Department admins must name at least one of their own. */
        departments: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      }),
      success: ControlIssuedLink,
      error: [ControlForbiddenError, ControlAccountError, ControlDepartmentError],
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
    /** Opens their workspace, read-only, in this browser for an hour; they are told why. */
    HttpApiEndpoint.post("openWorkspace", "/control/api/admin/people/:personId/open-workspace", {
      params: PersonParams,
      payload: Schema.Struct({
        departmentId: Schema.NullOr(TrimmedNonEmptyString),
        reason: Schema.String,
      }),
      success: ControlMyDepartments,
      error: [ControlForbiddenError, ControlAccountError, ControlWorkspaceAccessError],
    }),
    HttpApiEndpoint.get("personSessions", "/control/api/admin/people/:personId/sessions", {
      params: PersonParams,
      success: Schema.Array(ControlSession),
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("signOutPerson", "/control/api/admin/people/:personId/sign-out", {
      params: PersonParams,
      success: ControlOk,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.post("unlock", "/control/api/admin/people/:personId/unlock", {
      params: PersonParams,
      success: ControlOk,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.get("departments", "/control/api/admin/departments", {
      success: Schema.Array(ControlDepartment),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("createDepartment", "/control/api/admin/departments", {
      payload: Schema.Struct({
        name: Schema.String,
        /** Its profile starts as a copy of this template. */
        template: Schema.optionalKey(ControlProfileTemplateName),
      }),
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.put("renameDepartment", "/control/api/admin/departments/:departmentId", {
      params: DepartmentParams,
      payload: Schema.Struct({ name: Schema.String }),
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.delete("deleteDepartment", "/control/api/admin/departments/:departmentId", {
      params: DepartmentParams,
      success: ControlOk,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.put(
      "addDepartmentMember",
      "/control/api/admin/departments/:departmentId/members/:personId",
      {
        params: Schema.Struct({ ...DepartmentParams.fields, ...PersonParams.fields }),
        success: ControlDepartment,
        error: [ControlForbiddenError, ControlDepartmentError, ControlAccountError],
      },
    ),
    HttpApiEndpoint.delete(
      "removeDepartmentMember",
      "/control/api/admin/departments/:departmentId/members/:personId",
      {
        params: Schema.Struct({ ...DepartmentParams.fields, ...PersonParams.fields }),
        success: ControlDepartment,
        error: [ControlForbiddenError, ControlDepartmentError, ControlAccountError],
      },
    ),
    HttpApiEndpoint.post("createTeam", "/control/api/admin/departments/:departmentId/teams", {
      params: DepartmentParams,
      payload: Schema.Struct({ name: Schema.String }),
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.put("renameTeam", "/control/api/admin/teams/:teamId", {
      params: TeamParams,
      payload: Schema.Struct({ name: Schema.String }),
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.delete("deleteTeam", "/control/api/admin/teams/:teamId", {
      params: TeamParams,
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError],
    }),
    HttpApiEndpoint.put("addTeamMember", "/control/api/admin/teams/:teamId/members/:personId", {
      params: Schema.Struct({ ...TeamParams.fields, ...PersonParams.fields }),
      success: ControlDepartment,
      error: [ControlForbiddenError, ControlDepartmentError, ControlAccountError],
    }),
    HttpApiEndpoint.delete(
      "removeTeamMember",
      "/control/api/admin/teams/:teamId/members/:personId",
      {
        params: Schema.Struct({ ...TeamParams.fields, ...PersonParams.fields }),
        success: ControlDepartment,
        error: [ControlForbiddenError, ControlDepartmentError, ControlAccountError],
      },
    ),
    HttpApiEndpoint.get("profiles", "/control/api/admin/profiles", {
      success: Schema.Array(ControlProfile),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("previewProfile", "/control/api/admin/profiles/:profileId/preview", {
      params: ProfileParams,
      payload: Schema.Struct({ settings: ControlProfileSettings }),
      success: ControlProfilePreview,
      error: [ControlForbiddenError, ControlProfileError],
    }),
    HttpApiEndpoint.post("saveProfile", "/control/api/admin/profiles/:profileId/versions", {
      params: ProfileParams,
      payload: Schema.Struct({
        settings: ControlProfileSettings,
        note: Schema.String,
        /** Give the new version only to these people first. */
        testWith: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      }),
      success: ControlProfile,
      error: [ControlForbiddenError, ControlProfileError],
    }),
    HttpApiEndpoint.post("publishTest", "/control/api/admin/profiles/:profileId/publish-test", {
      params: ProfileParams,
      success: ControlProfile,
      error: [ControlForbiddenError, ControlProfileError],
    }),
    HttpApiEndpoint.post("discardTest", "/control/api/admin/profiles/:profileId/discard-test", {
      params: ProfileParams,
      success: ControlProfile,
      error: [ControlForbiddenError, ControlProfileError],
    }),
    HttpApiEndpoint.post("rollBackProfile", "/control/api/admin/profiles/:profileId/roll-back", {
      params: ProfileParams,
      success: ControlProfile,
      error: [ControlForbiddenError, ControlProfileError],
    }),
    HttpApiEndpoint.get("personProfile", "/control/api/admin/people/:personId/profile", {
      params: PersonParams,
      query: Schema.Struct({ department: Schema.optionalKey(TrimmedNonEmptyString) }),
      success: ControlEffectiveProfile,
      error: [ControlForbiddenError, ControlAccountError],
    }),
    HttpApiEndpoint.get("exceptions", "/control/api/admin/exceptions", {
      success: Schema.Array(ControlProfileException),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("addException", "/control/api/admin/exceptions", {
      payload: Schema.Struct({
        personId: TrimmedNonEmptyString,
        departmentId: Schema.NullOr(TrimmedNonEmptyString),
        settings: ControlProfileSettings,
        reason: Schema.String,
        endsAt: IsoDateTime,
      }),
      success: ControlProfileException,
      error: [ControlForbiddenError, ControlProfileError, ControlAccountError],
    }),
    HttpApiEndpoint.post("endException", "/control/api/admin/exceptions/:exceptionId/end", {
      params: Schema.Struct({ exceptionId: TrimmedNonEmptyString }),
      success: ControlOk,
      error: [ControlForbiddenError, ControlProfileError, ControlAccountError],
    }),
    HttpApiEndpoint.get("ssoConnections", "/control/api/admin/sso", {
      success: Schema.Array(ControlSsoConnection),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("createSsoConnection", "/control/api/admin/sso", {
      payload: Schema.Struct({ protocol: ControlSsoProtocol, settings: ControlSsoSettings }),
      success: ControlSsoConnection,
      error: [ControlForbiddenError, ControlSsoError],
    }),
    HttpApiEndpoint.put("updateSsoConnection", "/control/api/admin/sso/:connectionId", {
      params: Schema.Struct({ connectionId: TrimmedNonEmptyString }),
      payload: ControlSsoSettings,
      success: ControlSsoConnection,
      error: [ControlForbiddenError, ControlSsoError],
    }),
    HttpApiEndpoint.delete("deleteSsoConnection", "/control/api/admin/sso/:connectionId", {
      params: Schema.Struct({ connectionId: TrimmedNonEmptyString }),
      success: ControlOk,
      error: [ControlForbiddenError, ControlSsoError],
    }),
    HttpApiEndpoint.get("aiAccounts", "/control/api/admin/ai/accounts", {
      success: Schema.Array(ControlAiAccount),
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.post("createAiAccount", "/control/api/admin/ai/accounts", {
      payload: ControlAiAccountSettings,
      success: ControlAiAccount,
      error: [ControlForbiddenError, ControlAiError],
    }),
    HttpApiEndpoint.put("updateAiAccount", "/control/api/admin/ai/accounts/:accountId", {
      params: Schema.Struct({ accountId: TrimmedNonEmptyString }),
      payload: ControlAiAccountSettings,
      success: ControlAiAccount,
      error: [ControlForbiddenError, ControlAiError],
    }),
    HttpApiEndpoint.delete("deleteAiAccount", "/control/api/admin/ai/accounts/:accountId", {
      params: Schema.Struct({ accountId: TrimmedNonEmptyString }),
      success: ControlOk,
      error: [ControlForbiddenError, ControlAiError],
    }),
    HttpApiEndpoint.put("setEmergency", "/control/api/admin/people/:personId/emergency", {
      params: PersonParams,
      payload: Schema.Struct({ emergency: Schema.Boolean }),
      success: ControlPerson,
      error: [ControlForbiddenError, ControlAccountError, ControlSsoError],
    }),
    HttpApiEndpoint.get("provisioning", "/control/api/admin/provisioning", {
      success: ControlProvisioning,
      error: ControlForbiddenError,
    }),
    /** Replaces any token there was, so the identity provider needs the new one. */
    HttpApiEndpoint.post("createProvisioningToken", "/control/api/admin/provisioning/token", {
      success: ControlProvisioningToken,
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.delete("revokeProvisioningToken", "/control/api/admin/provisioning/token", {
      success: ControlProvisioning,
      error: ControlForbiddenError,
    }),
    HttpApiEndpoint.get("audit", "/control/api/admin/audit", {
      query: Schema.Struct({
        before: Schema.optionalKey(
          Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
        ),
      }),
      success: ControlAuditPage,
      error: ControlForbiddenError,
    }),
  )
  .middleware(ControlSessionAuth);

export const ControlApi = HttpApi.make("ControlApi")
  .add(ControlHealthGroup, ControlAccountGroup, ControlMeGroup, ControlAdminGroup)
  .annotate(OpenApi.Title, "Codenine Control API");
export type ControlApi = typeof ControlApi;
