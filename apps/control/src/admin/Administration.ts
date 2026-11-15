import {
  type ControlAiAccount,
  type ControlAiAccountSettings,
  type ControlAiError,
  ControlBudgetError,
  type ControlBudgetRequest,
  type ControlBudgetRequestLevel,
  assignableRoles,
  type ControlAccountError,
  type ControlAuditAction,
  type ControlAuditPage,
  type ControlAuditValues,
  type ControlDepartment,
  type ControlDepartmentError,
  type ControlEffectiveProfile,
  ControlForbiddenError,
  ControlLicenceInstallError,
  type ControlLicenceOverview,
  type ControlMe,
  type ControlPermission,
  type ControlPerson,
  type ControlProfile,
  ControlProfileError,
  type ControlProfileException,
  type ControlProfileId,
  type ControlProfilePreview,
  type ControlProfileSettings,
  type ControlProfileTemplateName,
  type ControlProvisioning,
  type ControlProvisioningToken,
  type ControlRole,
  type ControlSession,
  ControlSsoError,
  type ControlSsoConnection,
  type ControlSsoProtocol,
  type ControlSsoSettings,
  ControlWorkspaceAccessError,
  CONTROL_PROFILE_TEMPLATES,
  permissionReach,
} from "@codenine/contracts/control";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";

import { Accounts, type IssuedLink } from "../accounts/Accounts.ts";
import { Sessions, type Viewing } from "../accounts/Sessions.ts";
import {
  type AuditActor,
  AuditLog,
  type AuditRecord,
  ON_THE_SERVER,
  type RequestSource,
} from "../audit/AuditLog.ts";
import { ControlPublicUrl } from "../config.ts";
import { Departments } from "../departments/Departments.ts";
import { AiAccounts } from "../gateway/AiAccounts.ts";
import { BudgetRequests } from "../gateway/BudgetRequests.ts";
import { type LicenceInstallResult, LicenceService } from "../licence/LicenceService.ts";
import { Mailer } from "../mail/Mailer.ts";
import { workspaceOpenedMail } from "../mail/messages.ts";
import { describeLayerChange, sameSharedBudgets } from "../profiles/layering.ts";
import {
  type ProfileGuard,
  type ProfileStep,
  Profiles,
  type WorkspaceChange,
} from "../profiles/Profiles.ts";
import { ProvisioningTokens } from "../provisioning/ProvisioningTokens.ts";
import { SsoConnections } from "../sso/SsoConnections.ts";
import { WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import { WorkspaceRetention } from "../workspaces/WorkspaceRetention.ts";

/** Who asks for an admin action: their role decides what they may do, and the audit log names them. */
export interface AdminActor {
  readonly role: ControlRole;
  readonly who: AuditActor;
  readonly source: RequestSource;
}

export const personActor = (person: ControlMe, source: RequestSource): AdminActor => ({
  role: person.role,
  who: { kind: "person", id: person.id, label: person.email },
  source,
});

/** Someone at the control server's command line, who can already reach its database. */
export const operatorActor = (label: string): AdminActor => ({
  role: "owner",
  who: { kind: "operator", id: null, label },
  source: ON_THE_SERVER,
});

/**
 * The identity provider, through the provisioning token only owners create.
 * It acts as an owner so that removing anyone, owners too, ends their access;
 * it never gives roles, and the last owner stays.
 */
export const provisioningActor = (source: RequestSource): AdminActor => ({
  role: "owner",
  who: { kind: "provisioning", id: null, label: "Provisioning" },
  source,
});

/** Where identity providers reach SCIM provisioning on the control server. */
export const SCIM_PATH = "/control/scim/v2";

const PROVISIONING_TARGET = {
  kind: "provisioning",
  id: "scim",
  label: "SCIM provisioning",
} as const;

type PersonError = ControlForbiddenError | ControlAccountError;
type DepartmentError = ControlForbiddenError | ControlDepartmentError;
type MembershipError = DepartmentError | ControlAccountError;
type ProfileError = ControlForbiddenError | ControlProfileError;

/**
 * Licence, people and department changes, checked against the asker's role and
 * written to the audit log once made. Someone manages a person only if they
 * could give that person's role, so an admin cannot reset an owner's sign-in and
 * take over their account. Department admins reach only their own departments.
 */
export class Administration extends Context.Service<
  Administration,
  {
    readonly licence: (
      actor: AdminActor,
    ) => Effect.Effect<ControlLicenceOverview, ControlForbiddenError>;
    readonly installLicence: (
      actor: AdminActor,
      token: string,
    ) => Effect.Effect<LicenceInstallResult, ControlForbiddenError | ControlLicenceInstallError>;
    /** Everyone within the actor's reach, including people they cannot change. */
    readonly people: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlPerson>, ControlForbiddenError>;
    readonly invite: (
      actor: AdminActor,
      input: {
        readonly email: string;
        readonly displayName: string;
        readonly role: ControlRole;
        readonly departments?: ReadonlyArray<string> | undefined;
      },
    ) => Effect.Effect<IssuedLink, PersonError | ControlDepartmentError>;
    /** An owner looks at someone's workspace in this session, read-only, for an hour. */
    readonly openWorkspace: (
      actor: AdminActor,
      input: {
        readonly sessionId: string;
        readonly personId: string;
        readonly departmentId: string | null;
        readonly reason: string;
      },
    ) => Effect.Effect<Viewing, PersonError | ControlWorkspaceAccessError>;
    /** Back to their own workspace. */
    readonly closeWorkspace: (actor: AdminActor, sessionId: string) => Effect.Effect<void>;
    readonly personSessions: (
      actor: AdminActor,
      personId: string,
    ) => Effect.Effect<ReadonlyArray<ControlSession>, PersonError>;
    /** Ends every session of theirs, and with it their open windows. */
    readonly signOutPerson: (
      actor: AdminActor,
      personId: string,
    ) => Effect.Effect<void, PersonError>;
    /** Someone the identity provider manages, who signs in through it: a member with no link. */
    readonly provisionPerson: (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string },
    ) => Effect.Effect<ControlPerson, PersonError>;
    readonly updatePerson: (
      actor: AdminActor,
      input: {
        readonly personId: string;
        readonly email?: string;
        readonly displayName?: string;
      },
    ) => Effect.Effect<ControlPerson, PersonError>;
    /** The first owner, before anyone can sign in to invite them. */
    readonly inviteOwner: (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string },
    ) => Effect.Effect<IssuedLink, PersonError>;
    readonly setRole: (
      actor: AdminActor,
      input: { readonly personId: string; readonly role: ControlRole },
    ) => Effect.Effect<ControlPerson, PersonError>;
    readonly deactivate: (actor: AdminActor, personId: string) => Effect.Effect<void, PersonError>;
    readonly reactivate: (
      actor: AdminActor,
      personId: string,
    ) => Effect.Effect<ControlPerson, PersonError>;
    readonly issueReset: (
      actor: AdminActor,
      personId: string,
    ) => Effect.Effect<IssuedLink, PersonError>;
    readonly unlock: (actor: AdminActor, personId: string) => Effect.Effect<void, PersonError>;
    /** The departments within the actor's reach. */
    readonly departments: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlDepartment>, ControlForbiddenError>;
    /** With a template, the department's profile starts as a copy of it. */
    readonly createDepartment: (
      actor: AdminActor,
      name: string,
      template?: ControlProfileTemplateName,
    ) => Effect.Effect<ControlDepartment, DepartmentError>;
    readonly renameDepartment: (
      actor: AdminActor,
      departmentId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, DepartmentError>;
    readonly deleteDepartment: (
      actor: AdminActor,
      departmentId: string,
    ) => Effect.Effect<void, DepartmentError>;
    readonly addDepartmentMember: (
      actor: AdminActor,
      departmentId: string,
      personId: string,
    ) => Effect.Effect<ControlDepartment, MembershipError>;
    readonly removeDepartmentMember: (
      actor: AdminActor,
      departmentId: string,
      personId: string,
    ) => Effect.Effect<ControlDepartment, MembershipError>;
    readonly createTeam: (
      actor: AdminActor,
      departmentId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, DepartmentError>;
    readonly renameTeam: (
      actor: AdminActor,
      teamId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, DepartmentError>;
    readonly deleteTeam: (
      actor: AdminActor,
      teamId: string,
    ) => Effect.Effect<ControlDepartment, DepartmentError>;
    readonly addTeamMember: (
      actor: AdminActor,
      teamId: string,
      personId: string,
    ) => Effect.Effect<ControlDepartment, MembershipError>;
    readonly removeTeamMember: (
      actor: AdminActor,
      teamId: string,
      personId: string,
    ) => Effect.Effect<ControlDepartment, MembershipError>;
    /** The profiles the actor may change: the company's, and their departments' and teams'. */
    readonly profiles: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlProfile>, ControlForbiddenError>;
    readonly previewProfile: (
      actor: AdminActor,
      profileId: ControlProfileId,
      settings: ControlProfileSettings,
    ) => Effect.Effect<ControlProfilePreview, ProfileError>;
    readonly saveProfile: (
      actor: AdminActor,
      input: {
        readonly profileId: ControlProfileId;
        readonly settings: ControlProfileSettings;
        readonly note: string;
        readonly testWith: ReadonlyArray<string> | null;
      },
    ) => Effect.Effect<ControlProfile, ProfileError>;
    readonly publishTest: (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) => Effect.Effect<ControlProfile, ProfileError>;
    readonly discardTest: (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) => Effect.Effect<ControlProfile, ProfileError>;
    readonly rollBackProfile: (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) => Effect.Effect<ControlProfile, ProfileError>;
    /** What a person's workspace in a department, or outside any, is made from. */
    readonly personProfile: (
      actor: AdminActor,
      personId: string,
      departmentId: string | null,
    ) => Effect.Effect<ControlEffectiveProfile, PersonError>;
    readonly exceptions: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlProfileException>, ControlForbiddenError>;
    readonly addException: (
      actor: AdminActor,
      input: {
        readonly personId: string;
        readonly departmentId: string | null;
        readonly settings: ControlProfileSettings;
        readonly reason: string;
        readonly endsAt: string;
      },
    ) => Effect.Effect<ControlProfileException, ProfileError | ControlAccountError>;
    readonly endException: (
      actor: AdminActor,
      exceptionId: string,
    ) => Effect.Effect<void, ProfileError | ControlAccountError>;
    readonly ssoConnections: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlSsoConnection>, ControlForbiddenError>;
    readonly createSsoConnection: (
      actor: AdminActor,
      protocol: ControlSsoProtocol,
      settings: ControlSsoSettings,
    ) => Effect.Effect<ControlSsoConnection, ControlForbiddenError | ControlSsoError>;
    readonly updateSsoConnection: (
      actor: AdminActor,
      connectionId: string,
      settings: ControlSsoSettings,
    ) => Effect.Effect<ControlSsoConnection, ControlForbiddenError | ControlSsoError>;
    readonly deleteSsoConnection: (
      actor: AdminActor,
      connectionId: string,
    ) => Effect.Effect<void, ControlForbiddenError | ControlSsoError>;
    readonly aiAccounts: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlAiAccount>, ControlForbiddenError>;
    readonly createAiAccount: (
      actor: AdminActor,
      settings: ControlAiAccountSettings,
    ) => Effect.Effect<ControlAiAccount, ControlForbiddenError | ControlAiError>;
    readonly updateAiAccount: (
      actor: AdminActor,
      accountId: string,
      settings: ControlAiAccountSettings,
    ) => Effect.Effect<ControlAiAccount, ControlForbiddenError | ControlAiError>;
    readonly deleteAiAccount: (
      actor: AdminActor,
      accountId: string,
    ) => Effect.Effect<void, ControlForbiddenError | ControlAiError>;
    /** Requests for more budget the actor may decide: pending, and decided lately. */
    readonly budgetRequests: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlBudgetRequest>, ControlForbiddenError>;
    readonly decideBudgetRequest: (
      actor: AdminActor,
      requestId: string,
      approve: boolean,
    ) => Effect.Effect<ControlBudgetRequest, ControlForbiddenError | ControlBudgetError>;
    /** Owners only; it lets them sign in with a password while single sign-on is required. */
    readonly setEmergency: (
      actor: AdminActor,
      input: { readonly personId: string; readonly emergency: boolean },
    ) => Effect.Effect<ControlPerson, PersonError | ControlSsoError>;
    readonly provisioning: (
      actor: AdminActor,
    ) => Effect.Effect<ControlProvisioning, ControlForbiddenError>;
    /** Replaces any token there was. */
    readonly createProvisioningToken: (
      actor: AdminActor,
    ) => Effect.Effect<ControlProvisioningToken, ControlForbiddenError>;
    readonly revokeProvisioningToken: (
      actor: AdminActor,
    ) => Effect.Effect<ControlProvisioning, ControlForbiddenError>;
    readonly audit: (
      actor: AdminActor,
      before: number | null,
    ) => Effect.Effect<ControlAuditPage, ControlForbiddenError>;
  }
>()("@codenine/control/admin/Administration") {}

export const make = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const licence = yield* LicenceService;
  const retention = yield* WorkspaceRetention;
  const auditLog = yield* AuditLog;
  const departments = yield* Departments;
  const profiles = yield* Profiles;
  const sessions = yield* Sessions;
  const workspaces = yield* WorkspaceManager;
  const provisioningTokens = yield* ProvisioningTokens;
  const ssoConnections = yield* SsoConnections;
  const aiAccounts = yield* AiAccounts;
  const budgetRequests = yield* BudgetRequests;
  const mailer = yield* Mailer;
  const { origin } = yield* ControlPublicUrl;

  const record = (
    actor: AdminActor,
    action: ControlAuditAction,
    target: AuditRecord["target"],
    before: ControlAuditValues | null,
    after: ControlAuditValues | null,
  ) => auditLog.record({ actor: actor.who, source: actor.source, action, target, before, after });
  const personTarget = (person: ControlPerson) =>
    ({ kind: "person", id: person.id, label: person.email }) as const;
  const departmentTarget = (department: ControlDepartment) =>
    ({ kind: "department", id: department.id, label: department.name }) as const;
  const teamOf = (department: ControlDepartment, teamId: string) =>
    department.teams.find((team) => team.id === teamId);
  const teamTarget = (department: ControlDepartment, teamId: string) =>
    ({
      kind: "team",
      id: teamId,
      label: `${department.name} / ${teamOf(department, teamId)?.name ?? teamId}`,
    }) as const;
  const appliedLicence = Effect.map(licence.overview, ({ licence: applied }) =>
    applied._tag === "missing" ? null : applied.licenceId,
  );

  const reachOf = (actor: AdminActor, permission: ControlPermission) => {
    const reach = permissionReach(actor.role, permission);
    return reach === null ? Effect.fail(new ControlForbiddenError({})) : Effect.succeed(reach);
  };

  const canGive = (actor: AdminActor, role: ControlRole) =>
    assignableRoles(actor.role).includes(role);

  /** The departments an own-department reach covers: the actor's own. */
  const ownDepartments = (actor: AdminActor) =>
    actor.who.kind === "person" && actor.who.id !== null
      ? departments.ofPerson(actor.who.id)
      : Effect.succeed<ReadonlyArray<string>>([]);

  const requireDepartment = Effect.fn("Administration.requireDepartment")(function* (
    actor: AdminActor,
    departmentId: string,
  ) {
    const reach = yield* reachOf(actor, "departments:manage");
    if (reach !== "all" && !(yield* ownDepartments(actor)).includes(departmentId)) {
      return yield* new ControlForbiddenError({});
    }
  });

  const requireManaged = Effect.fn("Administration.requireManaged")(function* (
    actor: AdminActor,
    personId: string,
  ) {
    const reach = yield* reachOf(actor, "people:manage");
    const person = yield* accounts.findPerson(personId);
    if (!canGive(actor, person.role)) {
      return yield* new ControlForbiddenError({});
    }
    if (reach === "own-department") {
      const mine = yield* ownDepartments(actor);
      const theirs = yield* departments.ofPerson(personId);
      if (!theirs.some((departmentId) => mine.includes(departmentId))) {
        return yield* new ControlForbiddenError({});
      }
    }
    return person;
  });

  /** The company's profile is for owners and admins; a department's or team's, for its admins too. */
  const requireProfile = Effect.fn("Administration.requireProfile")(function* (
    actor: AdminActor,
    profileId: ControlProfileId,
  ) {
    const reach = yield* reachOf(actor, "departments:manage");
    const departmentId = yield* profiles.departmentOf(profileId);
    if (departmentId === null ? reach !== "all" : false) {
      return yield* new ControlForbiddenError({});
    }
    if (departmentId !== null) {
      yield* requireDepartment(actor, departmentId);
    }
  });

  /**
   * Where a company lets only owners decide what departments may spend, a
   * change by anyone else to the company's profile must leave the shared
   * budgets, and that choice, as they were.
   */
  const sharedBudgetsGuard = (
    actor: AdminActor,
    profileId: ControlProfileId,
  ): ProfileGuard | undefined =>
    profileId !== "company" || actor.role === "owner"
      ? undefined
      : (before, after) =>
          (before.published?.budgetApprovers ?? "owners-and-admins") === "owners" &&
          (!sameSharedBudgets(before.published, after.published) ||
            !sameSharedBudgets(before.test, after.test))
            ? Effect.fail(new ControlProfileError({ reason: "owners-only" }))
            : Effect.void;

  const decidesForDepartments = (actor: AdminActor, approvers: "owners" | "owners-and-admins") =>
    actor.role === "owner" || (actor.role === "admin" && approvers === "owners-and-admins");

  /** Whether owners alone, or admins too, decide what departments may spend. */
  const budgetApprovers = profiles.list(["company"]).pipe(
    Effect.map(([company]) => {
      const published = company?.versions.find(({ version }) => version === company.published);
      return published?.settings.budgetApprovers ?? "owners-and-admins";
    }),
    // The company's profile always exists to be read.
    Effect.orDie,
  );

  /**
   * Puts into effect at once what can change while a workspace runs: whether its
   * person may use the terminal, which their connections pick up as they
   * reconnect, and the hosts it reaches. The rest waits for its next start.
   */
  const takeEffect = Effect.fn("Administration.takeEffect")(function* (
    changed: ReadonlyArray<WorkspaceChange>,
  ) {
    const reconnecting = new Set(
      changed
        .filter(({ before, after }) => before.terminal !== after.terminal)
        .map(({ key }) => key.personId),
    );
    for (const personId of reconnecting) {
      yield* sessions.reconnect(personId);
    }
    const rerouted = changed.filter(
      ({ before, after }) =>
        !Equal.equals(before.allowHosts, after.allowHosts) ||
        !Equal.equals(before.blockHosts, after.blockHosts),
    );
    if (rerouted.length > 0) {
      yield* workspaces.applyNetwork(rerouted.map(({ key }) => key)).pipe(
        // The change stands: each workspace gets its hosts when it next starts.
        Effect.catchTags({
          WorkspaceUnavailableError: (error) =>
            Effect.logWarning("Running workspaces could not get their new hosts.", error),
        }),
      );
    }
  });

  /** Records a profile step and puts what it changed into effect. */
  const finishStep = Effect.fn("Administration.finishStep")(function* (
    actor: AdminActor,
    action: ControlAuditAction,
    step: ProfileStep,
    extra: ControlAuditValues = {},
  ) {
    const names = new Map(
      (step.to?.settings.departmentMonthlyUsd ?? step.from?.settings.departmentMonthlyUsd) ===
        undefined
        ? []
        : (yield* departments.list).map((department) => [department.id, department.name]),
    );
    yield* record(
      actor,
      action,
      { kind: "profile", id: step.profile.id, label: step.profile.name },
      step.from === null ? null : { version: step.from.version },
      step.to === null
        ? null
        : {
            version: step.to.version,
            changes:
              describeLayerChange(
                step.from?.settings ?? null,
                step.to.settings,
                (id) => names.get(id) ?? id,
              ) || null,
            ...extra,
          },
    );
    yield* takeEffect(step.changed);
    return step.profile;
  });

  /** Where an exception applies, for the audit log. */
  const exceptionPlace = (departmentId: string | null) =>
    departmentId === null
      ? Effect.succeed("every department")
      : departments.find(departmentId).pipe(
          Effect.map((department) => department.name),
          Effect.orElseSucceed(() => departmentId),
        );

  /** Exceptions for all of someone's departments are for owners and admins. */
  const requireExceptionPlace = Effect.fn("Administration.requireExceptionPlace")(function* (
    actor: AdminActor,
    departmentId: string | null,
  ) {
    if (departmentId === null) {
      if ((yield* reachOf(actor, "people:manage")) !== "all") {
        return yield* new ControlForbiddenError({});
      }
      return;
    }
    yield* requireDepartment(actor, departmentId);
  });

  /** The departments a permission reaches for the actor. */
  const reachedDepartments = Effect.fn("Administration.reachedDepartments")(function* (
    actor: AdminActor,
    permission: ControlPermission,
  ) {
    const reach = yield* reachOf(actor, permission);
    const all = yield* departments.list;
    if (reach === "all") return { all: true, departments: all };
    const mine = yield* ownDepartments(actor);
    return { all: false, departments: all.filter((department) => mine.includes(department.id)) };
  });

  /** Sign-in and provisioning settings can take over or remove anyone, so they are owners' alone. */
  const requireSecurity = Effect.fn("Administration.requireSecurity")(function* (
    actor: AdminActor,
  ) {
    if ((yield* reachOf(actor, "security:manage")) !== "all") {
      return yield* new ControlForbiddenError({});
    }
  });

  /** Company AI keys spend the company's money, so only owners and admins hold them. */
  const requireAi = Effect.fn("Administration.requireAi")(function* (actor: AdminActor) {
    if ((yield* reachOf(actor, "ai:manage")) !== "all") {
      return yield* new ControlForbiddenError({});
    }
  });
  const aiAccountTarget = (account: ControlAiAccount) =>
    ({ kind: "ai-account", id: account.id, label: account.name }) as const;
  // The key's last characters show that it changed, never the key.
  const aiAccountValues = (account: ControlAiAccount): ControlAuditValues => ({
    name: account.name,
    kind: account.kind,
    baseUrl: account.baseUrl,
    priceAdjustment: account.priceAdjustment,
    isDefault: account.isDefault,
    key: `…${account.keyHint}`,
  });

  const ssoTarget = (connection: ControlSsoConnection) =>
    ({ kind: "sso", id: connection.id, label: connection.name }) as const;
  const ssoValues = (connection: ControlSsoConnection): ControlAuditValues => ({
    name: connection.name,
    protocol: connection.protocol,
    domains: connection.domains.join(" "),
    required: connection.required,
    createPeople: connection.createPeople,
    groupsClaim: connection.groupsClaim,
    roleGroups:
      connection.roleGroups.map(({ group, role }) => `${group}=${role}`).join(" ") || null,
  });

  const provisioningOverview = Effect.map(
    provisioningTokens.current,
    (token): ControlProvisioning => ({ url: `${origin}${SCIM_PATH}`, token }),
  );

  return Administration.of({
    licence: Effect.fn("Administration.licence")(function* (actor: AdminActor) {
      yield* reachOf(actor, "licence:read");
      return yield* licence.overview;
    }),
    installLicence: Effect.fn("Administration.installLicence")(function* (
      actor: AdminActor,
      token: string,
    ) {
      yield* reachOf(actor, "licence:manage");
      const before = yield* appliedLicence;
      const installed = yield* licence
        .install(token)
        .pipe(
          Effect.mapError((error) => new ControlLicenceInstallError({ problem: error.reason })),
        );
      const { licence: applied } = installed.overview;
      yield* record(
        actor,
        "licence.install",
        { kind: "licence", id: installed.licenceId, label: installed.licenceId },
        { applied: before },
        { applied: applied._tag === "missing" ? null : applied.licenceId },
      );
      return installed;
    }),
    people: Effect.fn("Administration.people")(function* (actor: AdminActor) {
      const reached = yield* reachedDepartments(actor, "people:manage");
      const everyone = yield* accounts.listPeople;
      if (reached.all) return everyone;
      const visible = new Set(reached.departments.flatMap((department) => department.members));
      return everyone.filter((person) => visible.has(person.id));
    }),
    invite: Effect.fn("Administration.invite")(function* (
      actor: AdminActor,
      input: {
        readonly email: string;
        readonly displayName: string;
        readonly role: ControlRole;
        readonly departments?: ReadonlyArray<string> | undefined;
      },
    ) {
      const reach = yield* reachOf(actor, "people:manage");
      const departmentIds = [...new Set(input.departments ?? [])];
      if (!canGive(actor, input.role)) {
        return yield* new ControlForbiddenError({});
      }
      if (reach === "own-department") {
        const mine = yield* ownDepartments(actor);
        if (departmentIds.length === 0 || departmentIds.some((id) => !mine.includes(id))) {
          return yield* new ControlForbiddenError({});
        }
      }
      const joining = yield* Effect.forEach(departmentIds, departments.find);
      const issued = yield* accounts.invite(input);
      for (const department of joining) {
        yield* departments.addMember(department.id, issued.person.id);
      }
      const { email, displayName, role } = issued.person;
      yield* record(actor, "person.invite", personTarget(issued.person), null, {
        email,
        displayName,
        role,
        departments: joining.map((department) => department.name).join(", ") || null,
      });
      return issued;
    }),
    openWorkspace: Effect.fn("Administration.openWorkspace")(function* (
      actor: AdminActor,
      input: {
        readonly sessionId: string;
        readonly personId: string;
        readonly departmentId: string | null;
        readonly reason: string;
      },
    ) {
      yield* requireSecurity(actor);
      const opener = actor.who.kind === "person" ? actor.who.id : null;
      if (opener === null) {
        return yield* new ControlForbiddenError({});
      }
      const person = yield* requireManaged(actor, input.personId);
      const reason = input.reason.trim().slice(0, 500);
      if (reason.length < 10) {
        return yield* new ControlWorkspaceAccessError({ reason: "needs-reason" });
      }
      const theirs = yield* departments.ofPerson(person.id);
      if (input.departmentId === null ? theirs.length > 0 : !theirs.includes(input.departmentId)) {
        return yield* new ControlWorkspaceAccessError({ reason: "not-in-department" });
      }
      const until = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
      const viewing = { personId: person.id, departmentId: input.departmentId, until };
      yield* sessions.view({ personId: opener, sessionId: input.sessionId, viewing });
      // They are told who looked and why, as well as the audit log.
      const noticeEmailed = mailer.enabled
        ? yield* mailer
            .send(
              workspaceOpenedMail({
                to: person.email,
                displayName: person.displayName,
                origin,
                by: actor.who.label,
                reason,
                until,
              }),
            )
            .pipe(
              Effect.as(true),
              Effect.catchTags({
                MailDeliveryError: (error) =>
                  Effect.logWarning(
                    "Could not tell someone their workspace was opened.",
                    error,
                  ).pipe(Effect.as(false)),
              }),
            )
        : false;
      yield* record(actor, "person.workspace-open", personTarget(person), null, {
        reason,
        department:
          input.departmentId === null
            ? null
            : (yield* departments.find(input.departmentId).pipe(Effect.orDie)).name,
        until,
        noticeEmailed,
      });
      return viewing;
    }),
    closeWorkspace: Effect.fn("Administration.closeWorkspace")(function* (
      actor: AdminActor,
      sessionId: string,
    ) {
      const opener = actor.who.kind === "person" ? actor.who.id : null;
      if (opener === null) return;
      const viewed = yield* sessions.stopViewing({ personId: opener, sessionId });
      if (viewed === null) return;
      const person = yield* accounts.findPerson(viewed.personId).pipe(Effect.option);
      yield* record(
        actor,
        "person.workspace-close",
        person._tag === "Some"
          ? personTarget(person.value)
          : { kind: "person", id: viewed.personId, label: viewed.personId },
        null,
        null,
      );
    }),
    personSessions: Effect.fn("Administration.personSessions")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      yield* requireManaged(actor, personId);
      return yield* sessions.list(personId);
    }),
    signOutPerson: Effect.fn("Administration.signOutPerson")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      const person = yield* requireManaged(actor, personId);
      const signedIn = (yield* sessions.list(personId)).length;
      yield* sessions.revokeAll(personId);
      yield* record(actor, "person.sign-out", personTarget(person), { sessions: signedIn }, null);
    }),
    provisionPerson: Effect.fn("Administration.provisionPerson")(function* (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string },
    ) {
      if ((yield* reachOf(actor, "people:manage")) !== "all" || !canGive(actor, "member")) {
        return yield* new ControlForbiddenError({});
      }
      const person = yield* accounts.addPerson(input);
      const { email, displayName, role } = person;
      yield* record(actor, "person.provision", personTarget(person), null, {
        email,
        displayName,
        role,
      });
      return person;
    }),
    updatePerson: Effect.fn("Administration.updatePerson")(function* (
      actor: AdminActor,
      input: {
        readonly personId: string;
        readonly email?: string;
        readonly displayName?: string;
      },
    ) {
      const before = yield* requireManaged(actor, input.personId);
      const after = yield* accounts.updatePerson(input);
      const changed = (["email", "displayName"] as const).filter(
        (key) => before[key] !== after[key],
      );
      if (changed.length > 0) {
        yield* record(
          actor,
          "person.update",
          personTarget(after),
          Object.fromEntries(changed.map((key) => [key, before[key]])),
          Object.fromEntries(changed.map((key) => [key, after[key]])),
        );
      }
      return after;
    }),
    inviteOwner: Effect.fn("Administration.inviteOwner")(function* (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string },
    ) {
      if (!canGive(actor, "owner")) {
        return yield* new ControlForbiddenError({});
      }
      const issued = yield* accounts.inviteOwner(input);
      const { email, displayName, role } = issued.person;
      yield* record(actor, "person.invite", personTarget(issued.person), null, {
        email,
        displayName,
        role,
      });
      return issued;
    }),
    setRole: Effect.fn("Administration.setRole")(function* (
      actor: AdminActor,
      input: { readonly personId: string; readonly role: ControlRole },
    ) {
      const person = yield* requireManaged(actor, input.personId);
      if (!canGive(actor, input.role)) {
        return yield* new ControlForbiddenError({});
      }
      const changed = yield* accounts.setRole(input);
      if (changed.role !== person.role) {
        yield* record(
          actor,
          "person.role",
          personTarget(person),
          { role: person.role },
          { role: changed.role },
        );
      }
      return changed;
    }),
    deactivate: Effect.fn("Administration.deactivate")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      const person = yield* requireManaged(actor, personId);
      yield* retention.deactivate(personId);
      if (person.status !== "deactivated") {
        yield* record(
          actor,
          "person.deactivate",
          personTarget(person),
          { status: person.status },
          { status: "deactivated" },
        );
      }
    }),
    reactivate: Effect.fn("Administration.reactivate")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      const person = yield* requireManaged(actor, personId);
      const reactivated = yield* accounts.reactivate(personId);
      if (person.status === "deactivated") {
        yield* record(
          actor,
          "person.reactivate",
          personTarget(person),
          { status: person.status },
          { status: reactivated.status },
        );
      }
      return reactivated;
    }),
    issueReset: Effect.fn("Administration.issueReset")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      const person = yield* requireManaged(actor, personId);
      const issued = yield* accounts.issueReset(personId);
      yield* record(
        actor,
        "person.reset",
        personTarget(person),
        { canSignIn: person.canSignIn },
        { canSignIn: false },
      );
      return issued;
    }),
    unlock: Effect.fn("Administration.unlock")(function* (actor: AdminActor, personId: string) {
      const person = yield* requireManaged(actor, personId);
      yield* accounts.unlock(personId);
      yield* record(
        actor,
        "person.unlock",
        personTarget(person),
        { lockedUntil: person.lockedUntil },
        { lockedUntil: null },
      );
    }),
    departments: Effect.fn("Administration.departments")(function* (actor: AdminActor) {
      return (yield* reachedDepartments(actor, "departments:manage")).departments;
    }),
    createDepartment: Effect.fn("Administration.createDepartment")(function* (
      actor: AdminActor,
      name: string,
      template?: ControlProfileTemplateName,
    ) {
      if ((yield* reachOf(actor, "departments:manage")) !== "all") {
        return yield* new ControlForbiddenError({});
      }
      const department = yield* departments.create(name);
      if (template !== undefined) {
        yield* profiles
          .save({
            id: `department:${department.id}`,
            settings: CONTROL_PROFILE_TEMPLATES[template].settings,
            note: `From the ${template} template`,
            testWith: null,
            by: actor.who.label,
          })
          .pipe(Effect.catchTags({ ControlProfileError: Effect.die }));
      }
      yield* record(actor, "department.create", departmentTarget(department), null, {
        name: department.name,
        template: template ?? null,
      });
      return department;
    }),
    renameDepartment: Effect.fn("Administration.renameDepartment")(function* (
      actor: AdminActor,
      departmentId: string,
      name: string,
    ) {
      if ((yield* reachOf(actor, "departments:manage")) !== "all") {
        return yield* new ControlForbiddenError({});
      }
      const before = yield* departments.find(departmentId);
      const renamed = yield* departments.rename(departmentId, name);
      if (renamed.name !== before.name) {
        yield* record(
          actor,
          "department.rename",
          departmentTarget(renamed),
          { name: before.name },
          { name: renamed.name },
        );
      }
      return renamed;
    }),
    deleteDepartment: Effect.fn("Administration.deleteDepartment")(function* (
      actor: AdminActor,
      departmentId: string,
    ) {
      if ((yield* reachOf(actor, "departments:manage")) !== "all") {
        return yield* new ControlForbiddenError({});
      }
      const department = yield* departments.find(departmentId);
      yield* departments.remove(departmentId);
      yield* record(
        actor,
        "department.delete",
        departmentTarget(department),
        { name: department.name },
        null,
      );
    }),
    addDepartmentMember: Effect.fn("Administration.addDepartmentMember")(function* (
      actor: AdminActor,
      departmentId: string,
      personId: string,
    ) {
      yield* requireDepartment(actor, departmentId);
      const person = yield* requireManaged(actor, personId);
      const department = yield* departments.find(departmentId);
      const hadDepartment = (yield* departments.ofPerson(personId)).length > 0;
      if (yield* departments.addMember(departmentId, personId)) {
        // Someone who worked outside departments moves into this one's workspace.
        if (!hadDepartment) {
          yield* sessions.reconnect(personId);
        }
        yield* record(actor, "department.add-member", personTarget(person), null, {
          department: department.name,
        });
      }
      return yield* departments.find(departmentId);
    }),
    removeDepartmentMember: Effect.fn("Administration.removeDepartmentMember")(function* (
      actor: AdminActor,
      departmentId: string,
      personId: string,
    ) {
      yield* requireDepartment(actor, departmentId);
      const person = yield* requireManaged(actor, personId);
      const department = yield* departments.find(departmentId);
      if (yield* departments.removeMember(departmentId, personId)) {
        // Their open windows move to another department, and that workspace stops.
        yield* sessions.reconnect(personId);
        yield* retention.leaveDepartment(personId, departmentId);
        yield* record(
          actor,
          "department.remove-member",
          personTarget(person),
          { department: department.name },
          null,
        );
      }
      return yield* departments.find(departmentId);
    }),
    createTeam: Effect.fn("Administration.createTeam")(function* (
      actor: AdminActor,
      departmentId: string,
      name: string,
    ) {
      yield* requireDepartment(actor, departmentId);
      const before = yield* departments.find(departmentId);
      const after = yield* departments.createTeam(departmentId, name);
      const created = after.teams.find((team) => !before.teams.some(({ id }) => id === team.id));
      if (created !== undefined) {
        yield* record(actor, "team.create", teamTarget(after, created.id), null, {
          name: created.name,
          department: after.name,
        });
      }
      return after;
    }),
    renameTeam: Effect.fn("Administration.renameTeam")(function* (
      actor: AdminActor,
      teamId: string,
      name: string,
    ) {
      const department = yield* departments.ofTeam(teamId);
      yield* requireDepartment(actor, department.id);
      const after = yield* departments.renameTeam(teamId, name);
      const before = teamOf(department, teamId)?.name ?? null;
      const renamed = teamOf(after, teamId)?.name ?? null;
      if (before !== renamed) {
        yield* record(
          actor,
          "team.rename",
          teamTarget(after, teamId),
          { name: before },
          { name: renamed },
        );
      }
      return after;
    }),
    deleteTeam: Effect.fn("Administration.deleteTeam")(function* (
      actor: AdminActor,
      teamId: string,
    ) {
      const department = yield* departments.ofTeam(teamId);
      yield* requireDepartment(actor, department.id);
      const members = teamOf(department, teamId)?.members ?? [];
      const { result: after, changed } = yield* profiles.measure(
        members.map((personId) => ({ personId, departmentId: department.id })),
        departments.removeTeam(teamId),
      );
      yield* record(
        actor,
        "team.delete",
        teamTarget(department, teamId),
        { name: teamOf(department, teamId)?.name ?? null },
        null,
      );
      yield* takeEffect(changed);
      return after;
    }),
    addTeamMember: Effect.fn("Administration.addTeamMember")(function* (
      actor: AdminActor,
      teamId: string,
      personId: string,
    ) {
      const department = yield* departments.ofTeam(teamId);
      yield* requireDepartment(actor, department.id);
      const person = yield* requireManaged(actor, personId);
      const { result: added, changed } = yield* profiles.measure(
        [{ personId, departmentId: department.id }],
        departments.addTeamMember(teamId, personId),
      );
      if (added) {
        yield* record(actor, "team.add-member", personTarget(person), null, {
          team: teamTarget(department, teamId).label,
        });
      }
      yield* takeEffect(changed);
      return yield* departments.find(department.id);
    }),
    removeTeamMember: Effect.fn("Administration.removeTeamMember")(function* (
      actor: AdminActor,
      teamId: string,
      personId: string,
    ) {
      const department = yield* departments.ofTeam(teamId);
      yield* requireDepartment(actor, department.id);
      const person = yield* requireManaged(actor, personId);
      const { result: removed, changed } = yield* profiles.measure(
        [{ personId, departmentId: department.id }],
        departments.removeTeamMember(teamId, personId),
      );
      if (removed) {
        yield* record(
          actor,
          "team.remove-member",
          personTarget(person),
          { team: teamTarget(department, teamId).label },
          null,
        );
      }
      yield* takeEffect(changed);
      return yield* departments.find(department.id);
    }),
    profiles: Effect.fn("Administration.profiles")(function* (actor: AdminActor) {
      const reached = yield* reachedDepartments(actor, "departments:manage");
      const ids: Array<ControlProfileId> = reached.all ? ["company"] : [];
      for (const department of reached.departments) {
        ids.push(
          `department:${department.id}`,
          ...department.teams.map((team) => `team:${team.id}` as const),
        );
      }
      return yield* profiles.list(ids).pipe(Effect.catchTags({ ControlProfileError: Effect.die }));
    }),
    previewProfile: Effect.fn("Administration.previewProfile")(function* (
      actor: AdminActor,
      profileId: ControlProfileId,
      settings: ControlProfileSettings,
    ) {
      yield* requireProfile(actor, profileId);
      return yield* profiles.preview(profileId, settings);
    }),
    saveProfile: Effect.fn("Administration.saveProfile")(function* (
      actor: AdminActor,
      input: {
        readonly profileId: ControlProfileId;
        readonly settings: ControlProfileSettings;
        readonly note: string;
        readonly testWith: ReadonlyArray<string> | null;
      },
    ) {
      yield* requireProfile(actor, input.profileId);
      const step = yield* profiles.save({
        id: input.profileId,
        settings: input.settings,
        note: input.note,
        testWith: input.testWith,
        by: actor.who.label,
        guard: sharedBudgetsGuard(actor, input.profileId),
      });
      return yield* finishStep(
        actor,
        input.testWith === null ? "profile.publish" : "profile.test",
        step,
        input.testWith === null
          ? { note: input.note.trim() || null }
          : { note: input.note.trim() || null, testers: input.testWith.length },
      );
    }),
    publishTest: Effect.fn("Administration.publishTest")(function* (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) {
      yield* requireProfile(actor, profileId);
      const step = yield* profiles.publishTest(profileId, sharedBudgetsGuard(actor, profileId));
      return yield* finishStep(actor, "profile.publish", step);
    }),
    discardTest: Effect.fn("Administration.discardTest")(function* (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) {
      yield* requireProfile(actor, profileId);
      const step = yield* profiles.discardTest(profileId, sharedBudgetsGuard(actor, profileId));
      return yield* finishStep(actor, "profile.discard", step);
    }),
    rollBackProfile: Effect.fn("Administration.rollBackProfile")(function* (
      actor: AdminActor,
      profileId: ControlProfileId,
    ) {
      yield* requireProfile(actor, profileId);
      const step = yield* profiles.rollBack(
        profileId,
        actor.who.label,
        sharedBudgetsGuard(actor, profileId),
      );
      const restored = step.profile.versions.find(({ version }) => version === step.to?.version);
      return yield* finishStep(actor, "profile.rollback", step, {
        note: restored?.note ?? null,
      });
    }),
    personProfile: Effect.fn("Administration.personProfile")(function* (
      actor: AdminActor,
      personId: string,
      departmentId: string | null,
    ) {
      yield* requireManaged(actor, personId);
      return yield* profiles.effective(personId, departmentId);
    }),
    exceptions: Effect.fn("Administration.exceptions")(function* (actor: AdminActor) {
      const reached = yield* reachedDepartments(actor, "people:manage");
      const all = yield* profiles.exceptions;
      if (reached.all) return all;
      const theirs = new Set(reached.departments.map((department) => department.id));
      const people = new Set(reached.departments.flatMap((department) => department.members));
      return all.filter((exception) =>
        exception.departmentId === null
          ? people.has(exception.personId)
          : theirs.has(exception.departmentId),
      );
    }),
    addException: Effect.fn("Administration.addException")(function* (
      actor: AdminActor,
      input: {
        readonly personId: string;
        readonly departmentId: string | null;
        readonly settings: ControlProfileSettings;
        readonly reason: string;
        readonly endsAt: string;
      },
    ) {
      const person = yield* requireManaged(actor, input.personId);
      yield* requireExceptionPlace(actor, input.departmentId);
      const { exception, changed } = yield* profiles.addException({
        ...input,
        by: actor.who.label,
      });
      yield* record(actor, "exception.create", personTarget(person), null, {
        department: yield* exceptionPlace(exception.departmentId),
        reason: exception.reason,
        endsAt: exception.endsAt,
        changes: describeLayerChange(null, exception.settings) || null,
      });
      yield* takeEffect(changed);
      return exception;
    }),
    endException: Effect.fn("Administration.endException")(function* (
      actor: AdminActor,
      exceptionId: string,
    ) {
      const exception = (yield* profiles.exceptions).find(({ id }) => id === exceptionId);
      if (exception === undefined) {
        return yield* new ControlProfileError({ reason: "not-found" });
      }
      const person = yield* requireManaged(actor, exception.personId);
      yield* requireExceptionPlace(actor, exception.departmentId);
      const { changed } = yield* profiles.endException(exceptionId);
      yield* record(
        actor,
        "exception.end",
        personTarget(person),
        {
          department: yield* exceptionPlace(exception.departmentId),
          reason: exception.reason,
          endsAt: exception.endsAt,
        },
        null,
      );
      yield* takeEffect(changed);
    }),
    ssoConnections: Effect.fn("Administration.ssoConnections")(function* (actor: AdminActor) {
      yield* requireSecurity(actor);
      return yield* ssoConnections.list;
    }),
    createSsoConnection: Effect.fn("Administration.createSsoConnection")(function* (
      actor: AdminActor,
      protocol: ControlSsoProtocol,
      settings: ControlSsoSettings,
    ) {
      yield* requireSecurity(actor);
      const created = yield* ssoConnections.create(protocol, settings);
      yield* record(actor, "sso.create", ssoTarget(created), null, ssoValues(created));
      return created;
    }),
    updateSsoConnection: Effect.fn("Administration.updateSsoConnection")(function* (
      actor: AdminActor,
      connectionId: string,
      settings: ControlSsoSettings,
    ) {
      yield* requireSecurity(actor);
      const before = (yield* ssoConnections.list).find(({ id }) => id === connectionId);
      const updated = yield* ssoConnections.update(connectionId, settings);
      yield* record(
        actor,
        "sso.update",
        ssoTarget(updated),
        before === undefined ? null : ssoValues(before),
        ssoValues(updated),
      );
      return updated;
    }),
    deleteSsoConnection: Effect.fn("Administration.deleteSsoConnection")(function* (
      actor: AdminActor,
      connectionId: string,
    ) {
      yield* requireSecurity(actor);
      const removed = yield* ssoConnections.remove(connectionId);
      yield* record(actor, "sso.delete", ssoTarget(removed), ssoValues(removed), null);
    }),
    aiAccounts: Effect.fn("Administration.aiAccounts")(function* (actor: AdminActor) {
      yield* requireAi(actor);
      return yield* aiAccounts.list;
    }),
    createAiAccount: Effect.fn("Administration.createAiAccount")(function* (
      actor: AdminActor,
      settings: ControlAiAccountSettings,
    ) {
      yield* requireAi(actor);
      const created = yield* aiAccounts.create(settings);
      yield* record(
        actor,
        "ai-account.create",
        aiAccountTarget(created),
        null,
        aiAccountValues(created),
      );
      return created;
    }),
    updateAiAccount: Effect.fn("Administration.updateAiAccount")(function* (
      actor: AdminActor,
      accountId: string,
      settings: ControlAiAccountSettings,
    ) {
      yield* requireAi(actor);
      const before = (yield* aiAccounts.list).find(({ id }) => id === accountId);
      const updated = yield* aiAccounts.update(accountId, settings);
      yield* record(
        actor,
        "ai-account.update",
        aiAccountTarget(updated),
        before === undefined ? null : aiAccountValues(before),
        aiAccountValues(updated),
      );
      return updated;
    }),
    deleteAiAccount: Effect.fn("Administration.deleteAiAccount")(function* (
      actor: AdminActor,
      accountId: string,
    ) {
      yield* requireAi(actor);
      const removed = yield* aiAccounts.remove(accountId);
      yield* record(
        actor,
        "ai-account.delete",
        aiAccountTarget(removed),
        aiAccountValues(removed),
        null,
      );
    }),
    budgetRequests: Effect.fn("Administration.budgetRequests")(function* (actor: AdminActor) {
      const reached = yield* reachedDepartments(actor, "departments:manage");
      const levels: Array<ControlBudgetRequestLevel> = ["person-month", "person-day"];
      if (decidesForDepartments(actor, yield* budgetApprovers)) levels.push("department-month");
      return yield* budgetRequests.list({
        departments: reached.all ? null : reached.departments.map(({ id }) => id),
        levels,
        exceptPersonId: actor.who.kind === "person" ? actor.who.id : null,
      });
    }),
    decideBudgetRequest: Effect.fn("Administration.decideBudgetRequest")(function* (
      actor: AdminActor,
      requestId: string,
      approve: boolean,
    ) {
      const request = yield* budgetRequests.find(requestId);
      if (actor.who.kind === "person" && actor.who.id === request.personId) {
        return yield* new ControlBudgetError({ reason: "own-request" });
      }
      if (request.level === "department-month") {
        if (!decidesForDepartments(actor, yield* budgetApprovers)) {
          return yield* new ControlForbiddenError({});
        }
      } else if (request.departmentId === null) {
        if ((yield* reachOf(actor, "departments:manage")) !== "all") {
          return yield* new ControlForbiddenError({});
        }
      } else {
        yield* requireDepartment(actor, request.departmentId);
      }
      const decided = yield* budgetRequests.decide({ requestId, approve, by: actor.who.label });
      yield* record(
        actor,
        approve ? "budget-request.approve" : "budget-request.decline",
        { kind: "budget-request", id: decided.id, label: decided.personName },
        null,
        {
          level: decided.level,
          period: decided.period,
          amountUsd: decided.amountUsd,
          department: decided.departmentName,
          reason: decided.reason,
        },
      );
      return decided;
    }),
    setEmergency: Effect.fn("Administration.setEmergency")(function* (
      actor: AdminActor,
      input: { readonly personId: string; readonly emergency: boolean },
    ) {
      yield* requireSecurity(actor);
      const person = yield* requireManaged(actor, input.personId);
      if (person.emergency === input.emergency) {
        return person;
      }
      if (input.emergency && person.role !== "owner") {
        return yield* new ControlSsoError({ reason: "not-owner" });
      }
      if (
        !input.emergency &&
        !(yield* ssoConnections.ownerKeepsPassword({ notEmergency: person.id }))
      ) {
        return yield* new ControlSsoError({ reason: "no-emergency-owner" });
      }
      const after = yield* accounts.setEmergency(input);
      yield* record(
        actor,
        "person.emergency",
        personTarget(after),
        { emergency: person.emergency },
        { emergency: after.emergency },
      );
      return after;
    }),
    provisioning: Effect.fn("Administration.provisioning")(function* (actor: AdminActor) {
      yield* requireSecurity(actor);
      return yield* provisioningOverview;
    }),
    createProvisioningToken: Effect.fn("Administration.createProvisioningToken")(function* (
      actor: AdminActor,
    ) {
      yield* requireSecurity(actor);
      const replaced = yield* provisioningTokens.current;
      const token = yield* provisioningTokens.issue(actor.who.label);
      yield* record(
        actor,
        "provisioning.token-create",
        PROVISIONING_TARGET,
        replaced === null ? null : { createdAt: replaced.createdAt, createdBy: replaced.createdBy },
        null,
      );
      return { token, provisioning: yield* provisioningOverview };
    }),
    revokeProvisioningToken: Effect.fn("Administration.revokeProvisioningToken")(function* (
      actor: AdminActor,
    ) {
      yield* requireSecurity(actor);
      const revoked = yield* provisioningTokens.current;
      if (yield* provisioningTokens.revoke) {
        yield* record(
          actor,
          "provisioning.token-revoke",
          PROVISIONING_TARGET,
          revoked === null ? null : { createdAt: revoked.createdAt, createdBy: revoked.createdBy },
          null,
        );
      }
      return yield* provisioningOverview;
    }),
    audit: Effect.fn("Administration.audit")(function* (actor: AdminActor, before: number | null) {
      const reached = yield* reachedDepartments(actor, "audit:read");
      if (reached.all) return yield* auditLog.list(before);
      // Entries by or about their departments, their people and their teams.
      const about = reached.departments.flatMap((department) => [
        department.id,
        ...department.members,
        ...department.teams.map((team) => team.id),
      ]);
      return yield* auditLog.list(before, [...new Set(about)]);
    }),
  });
});

export const layer = Layer.effect(Administration, make);
