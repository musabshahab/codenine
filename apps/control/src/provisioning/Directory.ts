import type {
  ControlAccountError,
  ControlDepartmentError,
  ControlForbiddenError,
} from "@codenine/contracts/control";
import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type AdminActor, Administration } from "../admin/Administration.ts";
import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import {
  controlDepartmentMembers,
  controlDepartments,
  controlDirectoryGroups,
  controlDirectoryPeople,
  controlPeople,
} from "../persistence/schema.ts";
import {
  applyMemberSteps,
  type GroupChange,
  type GroupFields,
  ScimError,
  type ScimFilter,
  type ScimGroup,
  type ScimUser,
  type UserChange,
  type UserFields,
} from "./scim.ts";

export interface Page {
  readonly filter: ScimFilter | null;
  readonly startIndex: number;
  readonly count: number;
}

/** What an identity provider sees through SCIM: people as users, departments as groups. */
export class Directory extends Context.Service<
  Directory,
  {
    readonly users: (
      page: Page,
    ) => Effect.Effect<{ readonly total: number; readonly users: ReadonlyArray<ScimUser> }>;
    readonly user: (id: string) => Effect.Effect<ScimUser, ScimError>;
    /** Takes over someone it removed, or someone with the same email it never knew. */
    readonly createUser: (
      actor: AdminActor,
      fields: UserFields,
    ) => Effect.Effect<ScimUser, ScimError>;
    readonly changeUser: (
      actor: AdminActor,
      id: string,
      change: UserChange,
    ) => Effect.Effect<ScimUser, ScimError>;
    /** Deactivates them; they stay in Codenine, but the identity provider no longer finds them. */
    readonly removeUser: (actor: AdminActor, id: string) => Effect.Effect<void, ScimError>;
    readonly groups: (
      page: Page,
    ) => Effect.Effect<{ readonly total: number; readonly groups: ReadonlyArray<ScimGroup> }>;
    readonly group: (id: string) => Effect.Effect<ScimGroup, ScimError>;
    readonly createGroup: (
      actor: AdminActor,
      fields: GroupFields,
    ) => Effect.Effect<ScimGroup, ScimError>;
    readonly changeGroup: (
      actor: AdminActor,
      id: string,
      change: GroupChange,
    ) => Effect.Effect<ScimGroup, ScimError>;
    /** Takes everyone out of the department, stopping their workspaces in it, then deletes it. */
    readonly removeGroup: (actor: AdminActor, id: string) => Effect.Effect<void, ScimError>;
  }
>()("@codenine/control/provisioning/Directory") {}

const notFound = (kind: "User" | "Group", id: string) =>
  new ScimError({ status: 404, detail: `${kind} ${id} not found.` });

const taken = (detail: string) => new ScimError({ status: 409, scimType: "uniqueness", detail });

/** What Codenine refused, as the identity provider should read it. */
const asScimError = (
  error: ControlForbiddenError | ControlAccountError | ControlDepartmentError | ScimError,
) => {
  switch (error._tag) {
    case "ScimError":
      return error;
    case "ControlForbiddenError":
      return new ScimError({ status: 403, detail: error.message });
    case "ControlAccountError":
      switch (error.reason) {
        case "email-taken":
          return taken(error.message);
        case "not-found":
          return new ScimError({ status: 404, detail: error.message });
        case "no-free-seat":
          return new ScimError({ status: 403, detail: error.message });
        case "last-owner":
          return new ScimError({ status: 400, scimType: "mutability", detail: error.message });
        default:
          return new ScimError({ status: 400, scimType: "invalidValue", detail: error.message });
      }
    case "ControlDepartmentError":
      switch (error.reason) {
        case "name-taken":
          return taken(error.message);
        case "not-found":
          return new ScimError({ status: 404, detail: error.message });
        default:
          return new ScimError({ status: 400, scimType: "invalidValue", detail: error.message });
      }
  }
};

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const lower = (value: string) => value.trim().toLowerCase();

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const admin = yield* Administration;
  const departments = yield* Departments;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // Everyone but those the identity provider removed.
  const visible = isNull(controlDirectoryPeople.removedAt);
  const userFilter = (filter: ScimFilter | null): SQL | undefined => {
    if (filter === null) return visible;
    switch (filter.attribute) {
      case "id":
        return and(visible, eq(controlPeople.id, filter.value));
      case "username":
        // Known by its user name, or never known and using it as their email.
        return and(
          visible,
          or(
            eq(sql`lower(${controlDirectoryPeople.userName})`, lower(filter.value)),
            and(
              isNull(controlDirectoryPeople.personId),
              eq(sql`lower(${controlPeople.email})`, lower(filter.value)),
            ),
          ),
        );
      case "externalid":
        return and(visible, eq(controlDirectoryPeople.externalId, filter.value));
      default:
        return and(visible, eq(sql`lower(${controlPeople.email})`, lower(filter.value)));
    }
  };

  const selectUsers = () =>
    db
      .select({ person: controlPeople, link: controlDirectoryPeople })
      .from(controlPeople)
      .leftJoin(controlDirectoryPeople, eq(controlDirectoryPeople.personId, controlPeople.id));

  const toUser = (row: {
    readonly person: typeof controlPeople.$inferSelect;
    readonly link: typeof controlDirectoryPeople.$inferSelect | null;
  }): ScimUser => ({
    id: row.person.id,
    userName: row.link?.userName ?? row.person.email,
    externalId: row.link?.externalId ?? null,
    email: row.person.email,
    displayName: row.person.displayName,
    givenName: row.link?.givenName ?? null,
    familyName: row.link?.familyName ?? null,
    active: row.person.status !== "deactivated",
    createdAt: row.person.createdAt,
    updatedAt: row.person.updatedAt,
  });

  const user = Effect.fn("Directory.user")(function* (id: string) {
    const [row] = yield* selectUsers().where(userFilter({ attribute: "id", value: id }));
    if (row === undefined) {
      return yield* notFound("User", id);
    }
    return toUser(row);
  }, dieOnDatabaseError);

  /** Records how the identity provider knows them, and that it knows them again. */
  const link = Effect.fn("Directory.link")(function* (
    personId: string,
    values: {
      readonly userName: string;
      readonly externalId: string | null;
      readonly givenName: string | null;
      readonly familyName: string | null;
      readonly removedAt?: string | null;
    },
  ) {
    const set = { ...values, removedAt: values.removedAt ?? null };
    const [holder] = yield* db
      .select({ personId: controlDirectoryPeople.personId })
      .from(controlDirectoryPeople)
      .where(eq(sql`lower(${controlDirectoryPeople.userName})`, lower(values.userName)));
    if (holder !== undefined && holder.personId !== personId) {
      return yield* taken(`Another user has the userName ${values.userName}.`);
    }
    yield* db
      .insert(controlDirectoryPeople)
      .values({ personId, ...set })
      .onConflictDoUpdate({ target: controlDirectoryPeople.personId, set });
  }, dieOnDatabaseError);

  /** Turns them on or off as the identity provider says. */
  const setActive = Effect.fn("Directory.setActive")(function* (
    actor: AdminActor,
    current: ScimUser,
    active: boolean,
  ) {
    if (active && !current.active) {
      yield* admin.reactivate(actor, current.id);
    } else if (!active && current.active) {
      yield* admin.deactivate(actor, current.id);
    }
  });

  const changeUser = Effect.fn("Directory.changeUser")(function* (
    actor: AdminActor,
    id: string,
    change: UserChange,
  ) {
    const current = yield* user(id);
    const next = {
      userName: change.userName ?? current.userName,
      externalId: change.externalId === undefined ? current.externalId : change.externalId,
      givenName: change.givenName === undefined ? current.givenName : change.givenName,
      familyName: change.familyName === undefined ? current.familyName : change.familyName,
    };
    if (
      next.userName !== current.userName ||
      next.externalId !== current.externalId ||
      next.givenName !== current.givenName ||
      next.familyName !== current.familyName
    ) {
      yield* link(id, next);
    }
    if (change.email !== undefined || change.displayName !== undefined) {
      yield* admin.updatePerson(actor, {
        personId: id,
        ...(change.email === undefined ? {} : { email: change.email }),
        ...(change.displayName === undefined ? {} : { displayName: change.displayName }),
      });
    }
    if (change.active !== undefined) {
      yield* setActive(actor, current, change.active);
    }
    return yield* user(id);
  }, Effect.mapError(asScimError));

  const createUser = Effect.fn("Directory.createUser")(
    function* (actor: AdminActor, fields: UserFields) {
      if (fields.email === null) {
        return yield* new ScimError({
          status: 400,
          scimType: "invalidValue",
          detail: "Give the user an email address, in emails or as its userName.",
        });
      }
      const [known] = yield* db
        .select()
        .from(controlDirectoryPeople)
        .where(eq(sql`lower(${controlDirectoryPeople.userName})`, lower(fields.userName)));
      if (known !== undefined && known.removedAt === null) {
        return yield* taken(`A user with the userName ${fields.userName} exists.`);
      }
      const [sameEmail] = yield* selectUsers().where(
        eq(sql`lower(${controlPeople.email})`, lower(fields.email)),
      );
      if (
        sameEmail !== undefined &&
        sameEmail.link !== null &&
        sameEmail.link.removedAt === null &&
        sameEmail.person.id !== known?.personId
      ) {
        return yield* taken(`A user with the email ${fields.email} exists.`);
      }
      const names = {
        userName: fields.userName,
        externalId: fields.externalId,
        givenName: fields.givenName,
        familyName: fields.familyName,
      };
      const existingId = known?.personId ?? sameEmail?.person.id;
      if (existingId !== undefined) {
        yield* link(existingId, names);
        return yield* changeUser(actor, existingId, {
          email: fields.email,
          ...(fields.displayName === null ? {} : { displayName: fields.displayName }),
          active: fields.active,
        });
      }
      const person = yield* admin.provisionPerson(actor, {
        email: fields.email,
        displayName: fields.displayName ?? fields.email,
      });
      yield* link(person.id, names);
      if (!fields.active) {
        yield* admin.deactivate(actor, person.id);
      }
      return yield* user(person.id);
    },
    dieOnDatabaseError,
    Effect.mapError(asScimError),
  );

  const groupMembers = (departmentIds: ReadonlyArray<string> | null) =>
    db
      .select({
        departmentId: controlDepartmentMembers.departmentId,
        id: controlPeople.id,
        displayName: controlPeople.displayName,
      })
      .from(controlDepartmentMembers)
      .innerJoin(controlPeople, eq(controlPeople.id, controlDepartmentMembers.personId))
      .leftJoin(controlDirectoryPeople, eq(controlDirectoryPeople.personId, controlPeople.id))
      .where(
        departmentIds === null
          ? visible
          : and(visible, inArray(controlDepartmentMembers.departmentId, [...departmentIds])),
      )
      .orderBy(asc(controlDepartmentMembers.createdAt), asc(controlPeople.id));

  const groupFilter = (filter: ScimFilter | null): SQL | undefined => {
    if (filter === null) return undefined;
    switch (filter.attribute) {
      case "id":
        return eq(controlDepartments.id, filter.value);
      case "externalid":
        return eq(controlDirectoryGroups.externalId, filter.value);
      default:
        return eq(sql`lower(${controlDepartments.name})`, lower(filter.value));
    }
  };

  const loadGroups = Effect.fn("Directory.loadGroups")(function* (
    filter: ScimFilter | null,
    window: { readonly offset: number; readonly limit: number } | null,
  ) {
    const query = db
      .select({ department: controlDepartments, externalId: controlDirectoryGroups.externalId })
      .from(controlDepartments)
      .leftJoin(
        controlDirectoryGroups,
        eq(controlDirectoryGroups.departmentId, controlDepartments.id),
      )
      .where(groupFilter(filter))
      .orderBy(asc(controlDepartments.createdAt), asc(controlDepartments.id));
    const rows =
      window === null ? yield* query : yield* query.offset(window.offset).limit(window.limit);
    const members =
      rows.length === 0 ? [] : yield* groupMembers(rows.map(({ department }) => department.id));
    return rows.map(({ department, externalId }): ScimGroup => ({
      id: department.id,
      displayName: department.name,
      externalId,
      members: members
        .filter((member) => member.departmentId === department.id)
        .map(({ id, displayName }) => ({ id, displayName })),
      createdAt: department.createdAt,
      updatedAt: department.updatedAt,
    }));
  });

  const group = Effect.fn("Directory.group")(function* (id: string) {
    const [found] = yield* loadGroups({ attribute: "id", value: id }, null);
    if (found === undefined) {
      return yield* notFound("Group", id);
    }
    return found;
  }, dieOnDatabaseError);

  /** Refuses members the identity provider cannot know, before anything changes. */
  const requireUsers = Effect.fn("Directory.requireUsers")(function* (ids: ReadonlyArray<string>) {
    for (const id of new Set(ids)) {
      const [row] = yield* selectUsers().where(userFilter({ attribute: "id", value: id }));
      if (row === undefined) {
        return yield* new ScimError({
          status: 400,
          scimType: "invalidValue",
          detail: `Member ${id} is not a user.`,
        });
      }
    }
  }, dieOnDatabaseError);

  const linkGroup = (departmentId: string, externalId: string | null) =>
    db
      .insert(controlDirectoryGroups)
      .values({ departmentId, externalId })
      .onConflictDoUpdate({ target: controlDirectoryGroups.departmentId, set: { externalId } });

  const setMembers = Effect.fn("Directory.setMembers")(function* (
    actor: AdminActor,
    departmentId: string,
    from: ReadonlyArray<string>,
    to: ReadonlyArray<string>,
  ) {
    for (const personId of from.filter((id) => !to.includes(id))) {
      yield* admin.removeDepartmentMember(actor, departmentId, personId);
    }
    for (const personId of to.filter((id) => !from.includes(id))) {
      yield* admin.addDepartmentMember(actor, departmentId, personId);
    }
  });

  return Directory.of({
    users: Effect.fn("Directory.users")(function* (page: Page) {
      const where = userFilter(page.filter);
      const [counted] = yield* db
        .select({ total: count() })
        .from(controlPeople)
        .leftJoin(controlDirectoryPeople, eq(controlDirectoryPeople.personId, controlPeople.id))
        .where(where);
      const rows =
        page.count === 0
          ? []
          : yield* selectUsers()
              .where(where)
              .orderBy(asc(controlPeople.createdAt), asc(controlPeople.id))
              .offset(page.startIndex - 1)
              .limit(page.count);
      return { total: counted?.total ?? 0, users: rows.map(toUser) };
    }, Effect.orDie),
    user,
    createUser,
    changeUser,
    removeUser: Effect.fn("Directory.removeUser")(function* (actor: AdminActor, id: string) {
      const current = yield* user(id);
      yield* setActive(actor, current, false);
      yield* link(id, {
        userName: current.userName,
        externalId: current.externalId,
        givenName: current.givenName,
        familyName: current.familyName,
        removedAt: yield* nowIso,
      });
    }, Effect.mapError(asScimError)),
    groups: Effect.fn("Directory.groups")(function* (page: Page) {
      const [counted] = yield* db
        .select({ total: count() })
        .from(controlDepartments)
        .leftJoin(
          controlDirectoryGroups,
          eq(controlDirectoryGroups.departmentId, controlDepartments.id),
        )
        .where(groupFilter(page.filter));
      const groups =
        page.count === 0
          ? []
          : yield* loadGroups(page.filter, { offset: page.startIndex - 1, limit: page.count });
      return { total: counted?.total ?? 0, groups };
    }, Effect.orDie),
    group,
    createGroup: Effect.fn("Directory.createGroup")(
      function* (actor: AdminActor, fields: GroupFields) {
        yield* requireUsers(fields.members);
        const department = yield* admin.createDepartment(actor, fields.displayName);
        yield* linkGroup(department.id, fields.externalId);
        yield* setMembers(actor, department.id, [], [...new Set(fields.members)]);
        return yield* group(department.id);
      },
      dieOnDatabaseError,
      Effect.mapError(asScimError),
    ),
    changeGroup: Effect.fn("Directory.changeGroup")(
      function* (actor: AdminActor, id: string, change: GroupChange) {
        const current = yield* group(id);
        const before = current.members.map((member) => member.id);
        const after = applyMemberSteps(before, change.members);
        yield* requireUsers(after.filter((member) => !before.includes(member)));
        if (change.displayName !== undefined && change.displayName !== current.displayName) {
          yield* admin.renameDepartment(actor, id, change.displayName);
        }
        if (change.externalId !== undefined && change.externalId !== current.externalId) {
          yield* linkGroup(id, change.externalId);
        }
        yield* setMembers(actor, id, before, after);
        return yield* group(id);
      },
      dieOnDatabaseError,
      Effect.mapError(asScimError),
    ),
    removeGroup: Effect.fn("Directory.removeGroup")(function* (actor: AdminActor, id: string) {
      yield* group(id);
      // Everyone, including people the identity provider removed, who it no longer sees.
      const department = yield* departments.find(id);
      for (const personId of department.members) {
        yield* admin.removeDepartmentMember(actor, id, personId);
      }
      yield* admin.deleteDepartment(actor, id);
    }, Effect.mapError(asScimError)),
  });
});

export const layer = Layer.effect(Directory, make);
