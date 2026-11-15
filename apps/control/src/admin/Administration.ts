import {
  assignableRoles,
  type ControlAccountError,
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
import { LicenceService } from "../licence/LicenceService.ts";
import { WorkspaceRetention } from "../workspaces/WorkspaceRetention.ts";

/** Who asks for an admin action. */
export interface AdminActor {
  readonly person: ControlMe;
}

type PersonError = ControlForbiddenError | ControlAccountError;

/**
 * Licence and people changes, each checked against the role of whoever asks.
 * Someone manages a person only if they could give that person's role, so an
 * admin cannot reset an owner's sign-in and take over their account.
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
    ) => Effect.Effect<ControlLicenceOverview, ControlForbiddenError | ControlLicenceInstallError>;
    /** Everyone within the actor's reach, including people they cannot change. */
    readonly people: (
      actor: AdminActor,
    ) => Effect.Effect<ReadonlyArray<ControlPerson>, ControlForbiddenError>;
    readonly invite: (
      actor: AdminActor,
      input: { readonly email: string; readonly displayName: string; readonly role: ControlRole },
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
  }
>()("@codenine/control/admin/Administration") {}

export const make = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const licence = yield* LicenceService;
  const retention = yield* WorkspaceRetention;

  const reachOf = (actor: AdminActor, permission: ControlPermission) => {
    const reach = permissionReach(actor.person.role, permission);
    return reach === null ? Effect.fail(new ControlForbiddenError({})) : Effect.succeed(reach);
  };

  const canGive = (actor: AdminActor, role: ControlRole) =>
    assignableRoles(actor.person.role).includes(role);

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
      const { overview } = yield* licence
        .install(token)
        .pipe(
          Effect.mapError((error) => new ControlLicenceInstallError({ problem: error.reason })),
        );
      return overview;
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
      return yield* accounts.invite(input);
    }),
    setRole: Effect.fn("Administration.setRole")(function* (
      actor: AdminActor,
      input: { readonly personId: string; readonly role: ControlRole },
    ) {
      yield* requireManaged(actor, input.personId);
      if (!canGive(actor, input.role)) {
        return yield* new ControlForbiddenError({});
      }
      return yield* accounts.setRole(input);
    }),
    deactivate: Effect.fn("Administration.deactivate")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      yield* requireManaged(actor, personId);
      yield* retention.deactivate(personId);
    }),
    reactivate: Effect.fn("Administration.reactivate")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      yield* requireManaged(actor, personId);
      return yield* accounts.reactivate(personId);
    }),
    issueReset: Effect.fn("Administration.issueReset")(function* (
      actor: AdminActor,
      personId: string,
    ) {
      yield* requireManaged(actor, personId);
      return yield* accounts.issueReset(personId);
    }),
    unlock: Effect.fn("Administration.unlock")(function* (actor: AdminActor, personId: string) {
      yield* requireManaged(actor, personId);
      yield* accounts.unlock(personId);
    }),
  });
});

export const layer = Layer.effect(Administration, make);
