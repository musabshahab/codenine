import {
  assignableRoles,
  type ControlAccountError,
  type ControlAuditAction,
  type ControlAuditPage,
  type ControlAuditValues,
  type ControlDepartment,
  type ControlDepartmentError,
  ControlForbiddenError,
  ControlLicenceInstallError,
  type ControlLicenceOverview,
  type ControlMe,
  type ControlPermission,
  type ControlPerson,
  type ControlRole,
  permissionReach,
} from "@codenine/contracts/control";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Accounts, type IssuedLink } from "../accounts/Accounts.ts";
import {
  type AuditActor,
  AuditLog,
  type AuditRecord,
  ON_THE_SERVER,
  type RequestSource,
} from "../audit/AuditLog.ts";
import { Departments } from "../departments/Departments.ts";
import { type LicenceInstallResult, LicenceService } from "../licence/LicenceService.ts";
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

type PersonError = ControlForbiddenError | ControlAccountError;
type DepartmentError = ControlForbiddenError | ControlDepartmentError;
type MembershipError = DepartmentError | ControlAccountError;

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
    readonly createDepartment: (
      actor: AdminActor,
      name: string,
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
    ) {
      if ((yield* reachOf(actor, "departments:manage")) !== "all") {
        return yield* new ControlForbiddenError({});
      }
      const department = yield* departments.create(name);
      yield* record(actor, "department.create", departmentTarget(department), null, {
        name: department.name,
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
      if (yield* departments.addMember(departmentId, personId)) {
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
      const after = yield* departments.removeTeam(teamId);
      yield* record(
        actor,
        "team.delete",
        teamTarget(department, teamId),
        { name: teamOf(department, teamId)?.name ?? null },
        null,
      );
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
      if (yield* departments.addTeamMember(teamId, personId)) {
        yield* record(actor, "team.add-member", personTarget(person), null, {
          team: teamTarget(department, teamId).label,
        });
      }
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
      if (yield* departments.removeTeamMember(teamId, personId)) {
        yield* record(
          actor,
          "team.remove-member",
          personTarget(person),
          { team: teamTarget(department, teamId).label },
          null,
        );
      }
      return yield* departments.find(department.id);
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
