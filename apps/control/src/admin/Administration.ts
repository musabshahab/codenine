import {
  assignableRoles,
  type ControlAccountError,
  type ControlAuditAction,
  type ControlAuditPage,
  type ControlAuditValues,
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
import { type AuditActor, AuditLog, ON_THE_SERVER, type RequestSource } from "../audit/AuditLog.ts";
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

/**
 * Licence and people changes, each checked against the role of whoever asks
 * and written to the audit log once it is made. Someone manages a person only
 * if they could give that person's role, so an admin cannot reset an owner's
 * sign-in and take over their account.
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
      input: { readonly email: string; readonly displayName: string; readonly role: ControlRole },
    ) => Effect.Effect<IssuedLink, PersonError>;
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

  const record = (
    actor: AdminActor,
    action: ControlAuditAction,
    target: { readonly kind: "person" | "licence"; readonly id: string; readonly label: string },
    before: ControlAuditValues | null,
    after: ControlAuditValues | null,
  ) => auditLog.record({ actor: actor.who, source: actor.source, action, target, before, after });
  const personTarget = (person: ControlPerson) =>
    ({ kind: "person", id: person.id, label: person.email }) as const;
  const appliedLicence = Effect.map(licence.overview, ({ licence: applied }) =>
    applied._tag === "missing" ? null : applied.licenceId,
  );

  const reachOf = (actor: AdminActor, permission: ControlPermission) => {
    const reach = permissionReach(actor.role, permission);
    return reach === null ? Effect.fail(new ControlForbiddenError({})) : Effect.succeed(reach);
  };

  const canGive = (actor: AdminActor, role: ControlRole) =>
    assignableRoles(actor.role).includes(role);

  /** Reaching only one's own departments covers nobody until departments exist. */
  const requireManaged = Effect.fn("Administration.requireManaged")(function* (
    actor: AdminActor,
    personId: string,
  ) {
    const reach = yield* reachOf(actor, "people:manage");
    const person = yield* accounts.findPerson(personId);
    if (reach !== "all" || !canGive(actor, person.role)) {
      return yield* new ControlForbiddenError({});
    }
    return person;
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
      const reach = yield* reachOf(actor, "people:manage");
      return reach === "all" ? yield* accounts.listPeople : [];
    }),
    invite: Effect.fn("Administration.invite")(function* (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string; readonly role: ControlRole },
    ) {
      const reach = yield* reachOf(actor, "people:manage");
      if (reach !== "all" || !canGive(actor, input.role)) {
        return yield* new ControlForbiddenError({});
      }
      const issued = yield* accounts.invite(input);
      const { email, displayName, role } = issued.person;
      yield* record(actor, "person.invite", personTarget(issued.person), null, {
        email,
        displayName,
        role,
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
    audit: Effect.fn("Administration.audit")(function* (actor: AdminActor, before: number | null) {
      const reach = yield* reachOf(actor, "audit:read");
      return reach === "all" ? yield* auditLog.list(before) : { entries: [], next: null };
    }),
  });
});

export const layer = Layer.effect(Administration, make);
