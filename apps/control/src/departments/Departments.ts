import { type ControlDepartment, ControlDepartmentError } from "@codenine/contracts/control";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Layer from "effect/Layer";

import { ControlDb } from "../db.ts";
import {
  controlDepartmentMembers,
  controlDepartments,
  controlProfiles,
  controlTeamMembers,
  controlTeams,
} from "../persistence/schema.ts";

const MAX_NAME_LENGTH = 128;

/** Departments and their teams. Changing who may do what is `Administration`'s job. */
export class Departments extends Context.Service<
  Departments,
  {
    readonly list: Effect.Effect<ReadonlyArray<ControlDepartment>>;
    readonly find: (
      departmentId: string,
    ) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    /** The department a team belongs to. */
    readonly ofTeam: (teamId: string) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    /** The IDs of the departments a person is in, the one they joined first first. */
    readonly ofPerson: (personId: string) => Effect.Effect<ReadonlyArray<string>>;
    /**
     * The department a person works in: `preferred` while they are in it,
     * otherwise the one they joined first, or none when they are in none.
     */
    readonly pick: (personId: string, preferred: string | null) => Effect.Effect<string | null>;
    /** The departments a person is in, by name, the one they joined first first. */
    readonly named: (
      personId: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>>;
    readonly create: (name: string) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    readonly rename: (
      departmentId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    /** Only an empty department can go. */
    readonly remove: (departmentId: string) => Effect.Effect<void, ControlDepartmentError>;
    /** Whether they were not in it already. */
    readonly addMember: (
      departmentId: string,
      personId: string,
    ) => Effect.Effect<boolean, ControlDepartmentError>;
    /** Takes them out of the department's teams too; whether they were in it. */
    readonly removeMember: (
      departmentId: string,
      personId: string,
    ) => Effect.Effect<boolean, ControlDepartmentError>;
    readonly createTeam: (
      departmentId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    readonly renameTeam: (
      teamId: string,
      name: string,
    ) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    readonly removeTeam: (
      teamId: string,
    ) => Effect.Effect<ControlDepartment, ControlDepartmentError>;
    /** Only a member of the team's department can join; whether they were not in it already. */
    readonly addTeamMember: (
      teamId: string,
      personId: string,
    ) => Effect.Effect<boolean, ControlDepartmentError>;
    readonly removeTeamMember: (
      teamId: string,
      personId: string,
    ) => Effect.Effect<boolean, ControlDepartmentError>;
  }
>()("@codenine/control/departments/Departments") {}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const validName = (raw: string) => {
  const name = raw.trim();
  return name.length === 0 || name.length > MAX_NAME_LENGTH
    ? Effect.fail(new ControlDepartmentError({ reason: "invalid-name" }))
    : Effect.succeed(name);
};

/** PostgreSQL's unique_violation, from a name another department or team has. */
const nameTaken = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === "23505") return true;
  return "cause" in cause && nameTaken(cause.cause);
};

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const random = yield* SecureRandom.SecureRandom;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = (prefix: string) =>
    random.randomBytes(8).pipe(Effect.map((bytes) => `${prefix}_${Hex.encode(bytes)}`));

  const load = Effect.fn("Departments.load")(function* (
    departmentIds: ReadonlyArray<string> | null,
  ) {
    const departments = yield* db
      .select()
      .from(controlDepartments)
      .where(
        departmentIds === null ? undefined : inArray(controlDepartments.id, [...departmentIds]),
      )
      .orderBy(asc(controlDepartments.name));
    if (departments.length === 0) return [];
    const ids = departments.map((department) => department.id);
    const members = yield* db
      .select()
      .from(controlDepartmentMembers)
      .where(inArray(controlDepartmentMembers.departmentId, ids))
      .orderBy(asc(controlDepartmentMembers.createdAt));
    const teams = yield* db
      .select()
      .from(controlTeams)
      .where(inArray(controlTeams.departmentId, ids))
      .orderBy(asc(controlTeams.name));
    const teamMembers =
      teams.length === 0
        ? []
        : yield* db
            .select()
            .from(controlTeamMembers)
            .where(
              inArray(
                controlTeamMembers.teamId,
                teams.map((team) => team.id),
              ),
            )
            .orderBy(asc(controlTeamMembers.createdAt));
    return departments.map((department): ControlDepartment => ({
      id: department.id,
      name: department.name,
      members: members
        .filter((member) => member.departmentId === department.id)
        .map((member) => member.personId),
      teams: teams
        .filter((team) => team.departmentId === department.id)
        .map((team) => ({
          id: team.id,
          name: team.name,
          members: teamMembers
            .filter((member) => member.teamId === team.id)
            .map((member) => member.personId),
        })),
    }));
  });

  const find = Effect.fn("Departments.find")(function* (departmentId: string) {
    const [department] = yield* load([departmentId]);
    if (department === undefined) {
      return yield* new ControlDepartmentError({ reason: "not-found" });
    }
    return department;
  });

  const teamDepartment = Effect.fn("Departments.teamDepartment")(function* (teamId: string) {
    const [team] = yield* db
      .select({ departmentId: controlTeams.departmentId })
      .from(controlTeams)
      .where(eq(controlTeams.id, teamId));
    if (team === undefined) {
      return yield* new ControlDepartmentError({ reason: "not-found" });
    }
    return team.departmentId;
  });

  const ofPerson = Effect.fn("Departments.ofPerson")(function* (personId: string) {
    const rows = yield* db
      .select({ departmentId: controlDepartmentMembers.departmentId })
      .from(controlDepartmentMembers)
      .where(eq(controlDepartmentMembers.personId, personId))
      .orderBy(asc(controlDepartmentMembers.createdAt), asc(controlDepartmentMembers.departmentId));
    return rows.map((row) => row.departmentId);
  });

  const taken = (error: unknown) =>
    nameTaken(error)
      ? Effect.fail(new ControlDepartmentError({ reason: "name-taken" }))
      : Effect.die(error);

  return Departments.of({
    list: load(null).pipe(dieOnDatabaseError),
    find: Effect.fn("Departments.findDepartment")(function* (departmentId: string) {
      return yield* find(departmentId);
    }, dieOnDatabaseError),
    ofTeam: Effect.fn("Departments.ofTeam")(function* (teamId: string) {
      return yield* find(yield* teamDepartment(teamId));
    }, dieOnDatabaseError),
    ofPerson: Effect.fn("Departments.personDepartments")(function* (personId: string) {
      return yield* ofPerson(personId);
    }, dieOnDatabaseError),
    named: Effect.fn("Departments.named")(function* (personId: string) {
      return yield* db
        .select({ id: controlDepartments.id, name: controlDepartments.name })
        .from(controlDepartmentMembers)
        .innerJoin(
          controlDepartments,
          eq(controlDepartments.id, controlDepartmentMembers.departmentId),
        )
        .where(eq(controlDepartmentMembers.personId, personId))
        .orderBy(asc(controlDepartmentMembers.createdAt), asc(controlDepartments.id));
    }, dieOnDatabaseError),
    pick: Effect.fn("Departments.pick")(function* (personId: string, preferred: string | null) {
      const theirs = yield* ofPerson(personId);
      return preferred !== null && theirs.includes(preferred) ? preferred : (theirs[0] ?? null);
    }, dieOnDatabaseError),
    create: Effect.fn("Departments.create")(function* (raw: string) {
      const name = yield* validName(raw);
      const now = yield* nowIso;
      const id = yield* newId("dep");
      yield* db
        .insert(controlDepartments)
        .values({ id, name, createdAt: now, updatedAt: now })
        .pipe(Effect.catchTags({ EffectDrizzleQueryError: taken }));
      return yield* find(id);
    }, dieOnDatabaseError),
    rename: Effect.fn("Departments.rename")(function* (departmentId: string, raw: string) {
      const name = yield* validName(raw);
      yield* find(departmentId);
      yield* db
        .update(controlDepartments)
        .set({ name, updatedAt: yield* nowIso })
        .where(eq(controlDepartments.id, departmentId))
        .pipe(Effect.catchTags({ EffectDrizzleQueryError: taken }));
      return yield* find(departmentId);
    }, dieOnDatabaseError),
    remove: Effect.fn("Departments.remove")(function* (departmentId: string) {
      const department = yield* find(departmentId);
      if (department.members.length > 0) {
        return yield* new ControlDepartmentError({ reason: "not-empty" });
      }
      // Profiles are keyed by name, not by a foreign key, so they go by hand.
      yield* db
        .delete(controlProfiles)
        .where(
          inArray(controlProfiles.id, [
            `department:${departmentId}`,
            ...department.teams.map((team) => `team:${team.id}`),
          ]),
        );
      yield* db.delete(controlDepartments).where(eq(controlDepartments.id, departmentId));
    }, dieOnDatabaseError),
    addMember: Effect.fn("Departments.addMember")(function* (
      departmentId: string,
      personId: string,
    ) {
      yield* find(departmentId);
      const added = yield* db
        .insert(controlDepartmentMembers)
        .values({ departmentId, personId, createdAt: yield* nowIso })
        .onConflictDoNothing()
        .returning({ personId: controlDepartmentMembers.personId });
      return added.length > 0;
    }, dieOnDatabaseError),
    removeMember: Effect.fn("Departments.removeMember")(function* (
      departmentId: string,
      personId: string,
    ) {
      const department = yield* find(departmentId);
      const teamIds = department.teams.map((team) => team.id);
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          if (teamIds.length > 0) {
            yield* db
              .delete(controlTeamMembers)
              .where(
                and(
                  inArray(controlTeamMembers.teamId, teamIds),
                  eq(controlTeamMembers.personId, personId),
                ),
              );
          }
          const removed = yield* db
            .delete(controlDepartmentMembers)
            .where(
              and(
                eq(controlDepartmentMembers.departmentId, departmentId),
                eq(controlDepartmentMembers.personId, personId),
              ),
            )
            .returning({ personId: controlDepartmentMembers.personId });
          return removed.length > 0;
        }),
      );
    }, dieOnDatabaseError),
    createTeam: Effect.fn("Departments.createTeam")(function* (departmentId: string, raw: string) {
      const name = yield* validName(raw);
      yield* find(departmentId);
      const now = yield* nowIso;
      yield* db
        .insert(controlTeams)
        .values({ id: yield* newId("team"), departmentId, name, createdAt: now, updatedAt: now })
        .pipe(Effect.catchTags({ EffectDrizzleQueryError: taken }));
      return yield* find(departmentId);
    }, dieOnDatabaseError),
    renameTeam: Effect.fn("Departments.renameTeam")(function* (teamId: string, raw: string) {
      const name = yield* validName(raw);
      const departmentId = yield* teamDepartment(teamId);
      yield* db
        .update(controlTeams)
        .set({ name, updatedAt: yield* nowIso })
        .where(eq(controlTeams.id, teamId))
        .pipe(Effect.catchTags({ EffectDrizzleQueryError: taken }));
      return yield* find(departmentId);
    }, dieOnDatabaseError),
    removeTeam: Effect.fn("Departments.removeTeam")(function* (teamId: string) {
      const departmentId = yield* teamDepartment(teamId);
      yield* db.delete(controlProfiles).where(eq(controlProfiles.id, `team:${teamId}`));
      yield* db.delete(controlTeams).where(eq(controlTeams.id, teamId));
      return yield* find(departmentId);
    }, dieOnDatabaseError),
    addTeamMember: Effect.fn("Departments.addTeamMember")(function* (
      teamId: string,
      personId: string,
    ) {
      const department = yield* find(yield* teamDepartment(teamId));
      if (!department.members.includes(personId)) {
        return yield* new ControlDepartmentError({ reason: "not-in-department" });
      }
      const added = yield* db
        .insert(controlTeamMembers)
        .values({ teamId, personId, createdAt: yield* nowIso })
        .onConflictDoNothing()
        .returning({ personId: controlTeamMembers.personId });
      return added.length > 0;
    }, dieOnDatabaseError),
    removeTeamMember: Effect.fn("Departments.removeTeamMember")(function* (
      teamId: string,
      personId: string,
    ) {
      yield* teamDepartment(teamId);
      const removed = yield* db
        .delete(controlTeamMembers)
        .where(
          and(eq(controlTeamMembers.teamId, teamId), eq(controlTeamMembers.personId, personId)),
        )
        .returning({ personId: controlTeamMembers.personId });
      return removed.length > 0;
    }, dieOnDatabaseError),
  });
});

export const layer = Layer.effect(Departments, make);
