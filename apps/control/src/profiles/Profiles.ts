import {
  type ControlDepartment,
  type ControlEffectiveProfile,
  type ControlProfile,
  ControlProfileError,
  type ControlProfileException,
  type ControlProfileId,
  type ControlProfilePreview,
  type ControlProfileSettings,
} from "@codenine/contracts/control";
import { and, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";

import { Accounts } from "../accounts/Accounts.ts";
import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import {
  controlProfileExceptions,
  controlProfiles,
  controlProfileVersions,
} from "../persistence/schema.ts";
import type { WorkspaceKey } from "../workspaces/WorkspaceManager.ts";
import { WorkspaceSizeConfig } from "../workspaces/workspaceSpec.ts";
import { type ProfileDefaults, resolveProfile, summarizeChanges } from "./layering.ts";

const EXCEPTION_DAYS = 90;

/** A workspace a change made different, as it was and as it is now. */
export interface WorkspaceChange {
  readonly key: WorkspaceKey;
  readonly before: ControlEffectiveProfile;
  readonly after: ControlEffectiveProfile;
}

/** A version that took effect or stopped, for the audit log. */
export interface ProfileStep {
  readonly profile: ControlProfile;
  readonly from: { readonly version: number; readonly settings: ControlProfileSettings } | null;
  readonly to: { readonly version: number; readonly settings: ControlProfileSettings } | null;
  readonly changed: ReadonlyArray<WorkspaceChange>;
}

export interface ExceptionStep {
  readonly exception: ControlProfileException;
  readonly changed: ReadonlyArray<WorkspaceChange>;
}

/**
 * Workspace profiles: the company's layer, each department's and each team's,
 * their versions, and people's exceptions. `effective` is what a person's
 * workspace in one department is made from.
 */
export class Profiles extends Context.Service<
  Profiles,
  {
    readonly list: (
      ids: ReadonlyArray<ControlProfileId>,
    ) => Effect.Effect<ReadonlyArray<ControlProfile>, ControlProfileError>;
    /** The department a department or team profile belongs to; null for the company's. */
    readonly departmentOf: (
      id: ControlProfileId,
    ) => Effect.Effect<string | null, ControlProfileError>;
    /** A new version, for everyone or first for `testWith`. */
    readonly save: (input: {
      readonly id: ControlProfileId;
      readonly settings: ControlProfileSettings;
      readonly note: string;
      readonly testWith: ReadonlyArray<string> | null;
      readonly by: string;
    }) => Effect.Effect<ProfileStep, ControlProfileError>;
    readonly publishTest: (id: ControlProfileId) => Effect.Effect<ProfileStep, ControlProfileError>;
    readonly discardTest: (id: ControlProfileId) => Effect.Effect<ProfileStep, ControlProfileError>;
    /** Gives everyone the version they had before the current one, as a new version. */
    readonly rollBack: (
      id: ControlProfileId,
      by: string,
    ) => Effect.Effect<ProfileStep, ControlProfileError>;
    readonly preview: (
      id: ControlProfileId,
      settings: ControlProfileSettings,
    ) => Effect.Effect<ControlProfilePreview, ControlProfileError>;
    readonly effective: (
      personId: string,
      departmentId: string | null,
    ) => Effect.Effect<ControlEffectiveProfile>;
    /** Those that have not ended. */
    readonly exceptions: Effect.Effect<ReadonlyArray<ControlProfileException>>;
    readonly addException: (input: {
      readonly personId: string;
      readonly departmentId: string | null;
      readonly settings: ControlProfileSettings;
      readonly reason: string;
      readonly endsAt: string;
      readonly by: string;
    }) => Effect.Effect<ExceptionStep, ControlProfileError>;
    readonly endException: (
      exceptionId: string,
    ) => Effect.Effect<ExceptionStep, ControlProfileError>;
    /** Runs a change made elsewhere, such as to a team, and finds which of these workspaces it made different. */
    readonly measure: <A, E, R>(
      keys: ReadonlyArray<WorkspaceKey>,
      change: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      { readonly result: A; readonly changed: ReadonlyArray<WorkspaceChange> },
      E,
      R
    >;
  }
>()("@codenine/control/profiles/Profiles") {}

const dieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchTags({ EffectDrizzleQueryError: Effect.die, SqlError: Effect.die }));

const notFound = () => new ControlProfileError({ reason: "not-found" });

interface LayerVersions {
  readonly published: ControlProfileSettings | null;
  readonly test: {
    readonly settings: ControlProfileSettings;
    readonly people: ReadonlySet<string>;
  } | null;
}

/** Everything `effective` reads, loaded once for however many people. */
interface Snapshot {
  readonly layers: ReadonlyMap<string, LayerVersions>;
  readonly departments: ReadonlyArray<ControlDepartment>;
  readonly exceptions: ReadonlyArray<ControlProfileException>;
}

const effectiveIn = (
  snapshot: Snapshot,
  defaults: ProfileDefaults,
  personId: string,
  departmentId: string | null,
  draft?: { readonly id: ControlProfileId; readonly settings: ControlProfileSettings },
) => {
  const department = snapshot.departments.find(({ id }) => id === departmentId);
  const ids: Array<string> =
    department === undefined
      ? ["company"]
      : [
          "company",
          `department:${department.id}`,
          ...department.teams
            .filter((team) => team.members.includes(personId))
            .map((team) => `team:${team.id}`),
        ];
  const layer = (id: string): ControlProfileSettings => {
    if (draft?.id === id) return draft.settings;
    const versions = snapshot.layers.get(id);
    if (versions?.test?.people.has(personId)) return versions.test.settings;
    return versions?.published ?? {};
  };
  const exceptions = snapshot.exceptions.filter(
    (exception) =>
      exception.personId === personId &&
      (exception.departmentId === null || exception.departmentId === departmentId),
  );
  return resolveProfile(
    [...ids.map(layer), ...exceptions.map((exception) => exception.settings)],
    defaults,
  );
};

/** What a step does to a profile, given where its versions stand. */
type ProfileChange<E> = (current: {
  readonly published: number | null;
  readonly testVersion: number | null;
  readonly latest: number;
  readonly now: string;
}) => Effect.Effect<
  {
    readonly insert?: {
      readonly settings: ControlProfileSettings;
      readonly note: string;
      readonly by: string;
      readonly published: boolean;
    };
    readonly set: Partial<typeof controlProfiles.$inferInsert>;
    readonly publish?: number;
    readonly from: number | null;
    readonly to: number | null;
  },
  E
>;

export const make = Effect.gen(function* () {
  const db = yield* ControlDb;
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const random = yield* SecureRandom.SecureRandom;
  const defaults: ProfileDefaults = yield* WorkspaceSizeConfig;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** What a profile is called, the people it applies to, and the department they work in. */
  const scopeOf = Effect.fn("Profiles.scopeOf")(function* (id: ControlProfileId) {
    if (id === "company") {
      const people = (yield* accounts.listPeople)
        .filter((person) => person.status !== "deactivated")
        .map((person) => person.id);
      return { name: "Company", people, departmentId: null };
    }
    if (id.startsWith("department:")) {
      const department = yield* departments
        .find(id.slice("department:".length))
        .pipe(Effect.mapError(notFound));
      return { name: department.name, people: department.members, departmentId: department.id };
    }
    const teamId = id.slice("team:".length);
    const department = yield* departments.ofTeam(teamId).pipe(Effect.mapError(notFound));
    const team = department.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return yield* notFound();
    return {
      name: `${department.name} / ${team.name}`,
      people: team.members,
      departmentId: department.id,
    };
  });

  const rowsOf = Effect.fn("Profiles.rowsOf")(function* (ids: ReadonlyArray<string>) {
    if (ids.length === 0) return { rows: [], versions: [] };
    const rows = yield* db
      .select()
      .from(controlProfiles)
      .where(inArray(controlProfiles.id, [...ids]));
    const versions = yield* db
      .select()
      .from(controlProfileVersions)
      .where(inArray(controlProfileVersions.profileId, [...ids]))
      .orderBy(desc(controlProfileVersions.version));
    return { rows, versions };
  });

  const toProfile = (
    id: ControlProfileId,
    name: string,
    loaded: Effect.Success<ReturnType<typeof rowsOf>>,
  ): ControlProfile => {
    const row = loaded.rows.find((candidate) => candidate.id === id);
    return {
      id,
      name,
      published: row?.published ?? null,
      test:
        row?.testVersion === null || row?.testVersion === undefined
          ? null
          : { version: row.testVersion, people: row.testPeople ?? [] },
      versions: loaded.versions
        .filter((version) => version.profileId === id)
        .map(({ version, settings, note, createdBy, createdAt }) => ({
          version,
          settings,
          note,
          createdBy,
          createdAt,
        })),
    };
  };

  const get = Effect.fn("Profiles.get")(function* (id: ControlProfileId) {
    const { name } = yield* scopeOf(id);
    return toProfile(id, name, yield* rowsOf([id]));
  });

  const activeExceptions = Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(controlProfileExceptions)
      .where(
        and(
          isNull(controlProfileExceptions.endedAt),
          gt(controlProfileExceptions.endsAt, yield* nowIso),
        ),
      )
      .orderBy(controlProfileExceptions.createdAt);
    return rows.map(
      ({ id, personId, departmentId, settings, reason, endsAt, createdBy, createdAt }) => ({
        id,
        personId,
        departmentId,
        settings,
        reason,
        endsAt,
        createdBy,
        createdAt,
      }),
    );
  });

  /** The layers, departments and exceptions; with `only`, just what one workspace needs. */
  const snapshot = Effect.fn("Profiles.snapshot")(function* (only?: {
    readonly personId: string;
    readonly departmentId: string | null;
  }) {
    const department =
      only?.departmentId === null || only === undefined
        ? null
        : yield* departments.find(only.departmentId).pipe(Effect.option);
    const ids =
      only === undefined
        ? null
        : [
            "company",
            ...(department === null || department._tag === "None"
              ? []
              : [
                  `department:${department.value.id}`,
                  ...department.value.teams
                    .filter((team) => team.members.includes(only.personId))
                    .map((team) => `team:${team.id}`),
                ]),
          ];
    const rows = yield* db
      .select()
      .from(controlProfiles)
      .where(ids === null ? undefined : inArray(controlProfiles.id, ids));
    const wanted = rows.flatMap((row) =>
      [row.published, row.testVersion].flatMap((version) =>
        version === null
          ? []
          : [
              and(
                eq(controlProfileVersions.profileId, row.id),
                eq(controlProfileVersions.version, version),
              ),
            ],
      ),
    );
    const versions =
      wanted.length === 0
        ? []
        : yield* db
            .select()
            .from(controlProfileVersions)
            .where(or(...wanted));
    const settingsOf = (id: string, version: number | null) =>
      versions.find((candidate) => candidate.profileId === id && candidate.version === version)
        ?.settings ?? null;
    const layers = new Map(
      rows.map((row): [string, LayerVersions] => [
        row.id,
        {
          published: settingsOf(row.id, row.published),
          test:
            row.testVersion === null
              ? null
              : {
                  settings: settingsOf(row.id, row.testVersion) ?? {},
                  people: new Set(row.testPeople ?? []),
                },
        },
      ]),
    );
    const exceptions = yield* activeExceptions;
    return {
      layers,
      departments:
        only === undefined
          ? yield* departments.list
          : department === null || department._tag === "None"
            ? []
            : [department.value],
      exceptions:
        only === undefined
          ? exceptions
          : exceptions.filter((exception) => exception.personId === only.personId),
    } satisfies Snapshot;
  });

  /** Adds a version under the profile's lock and applies `apply` to its pointers. */
  const changeProfile = <E>(id: ControlProfileId, change: ProfileChange<E>) =>
    db.transaction(() =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* db
          .insert(controlProfiles)
          .values({ id, published: null, testVersion: null, testPeople: null, updatedAt: now })
          .onConflictDoNothing();
        const [row] = yield* db
          .select()
          .from(controlProfiles)
          .where(eq(controlProfiles.id, id))
          .for("update");
        const [latest] = yield* db
          .select({ version: controlProfileVersions.version })
          .from(controlProfileVersions)
          .where(eq(controlProfileVersions.profileId, id))
          .orderBy(desc(controlProfileVersions.version))
          .limit(1);
        const plan = yield* change({
          published: row?.published ?? null,
          testVersion: row?.testVersion ?? null,
          latest: latest?.version ?? 0,
          now,
        });
        if (plan.insert !== undefined) {
          yield* db.insert(controlProfileVersions).values({
            profileId: id,
            version: (latest?.version ?? 0) + 1,
            settings: plan.insert.settings,
            note: plan.insert.note.trim().slice(0, 500),
            createdBy: plan.insert.by.slice(0, 512),
            createdAt: now,
            publishedAt: plan.insert.published ? now : null,
          });
        }
        if (plan.publish !== undefined) {
          yield* db
            .update(controlProfileVersions)
            .set({ publishedAt: now })
            .where(
              and(
                eq(controlProfileVersions.profileId, id),
                eq(controlProfileVersions.version, plan.publish),
              ),
            );
        }
        yield* db
          .update(controlProfiles)
          .set({ ...plan.set, updatedAt: now })
          .where(eq(controlProfiles.id, id));
        return { from: plan.from, to: plan.to };
      }),
    );

  /** A person's workspaces a layer reaches: the one in its department, or all of theirs. */
  const workspacesOf = (
    loaded: Snapshot,
    personId: string,
    departmentId: string | null,
  ): ReadonlyArray<WorkspaceKey> => {
    if (departmentId !== null) return [{ personId, departmentId }];
    const theirs = loaded.departments
      .filter((department) => department.members.includes(personId))
      .map((department) => department.id);
    return (theirs.length === 0 ? [null] : theirs).map((id) => ({ personId, departmentId: id }));
  };

  /** Runs `change`, then finds which of the workspaces `reach` names it made different. */
  const measured = Effect.fn("Profiles.measured")(function* <A, E, R>(
    change: Effect.Effect<A, E, R>,
    reach: (result: A, loaded: Snapshot) => ReadonlyArray<WorkspaceKey>,
  ) {
    const before = yield* dieOnDatabaseError(snapshot());
    const result = yield* change;
    const after = yield* dieOnDatabaseError(snapshot());
    const changed = reach(result, after).flatMap((key): ReadonlyArray<WorkspaceChange> => {
      const was = effectiveIn(before, defaults, key.personId, key.departmentId);
      const now = effectiveIn(after, defaults, key.personId, key.departmentId);
      return Equal.equals(was, now) ? [] : [{ key, before: was, after: now }];
    });
    return { result, changed };
  });

  /** Moves a profile between versions, finding whose workspaces that changed. */
  const step = Effect.fn("Profiles.step")(function* <E>(
    id: ControlProfileId,
    change: ProfileChange<E>,
  ) {
    const scope = yield* scopeOf(id);
    const { result, changed } = yield* measured(changeProfile(id, change), (_, loaded) =>
      scope.people.flatMap((personId) => workspacesOf(loaded, personId, scope.departmentId)),
    );
    return yield* stepped(id, result, changed);
  });

  /** The profile after a change, with the settings of the versions it went between. */
  const stepped = Effect.fn("Profiles.stepped")(function* (
    id: ControlProfileId,
    moved: { readonly from: number | null; readonly to: number | null },
    changed: ReadonlyArray<WorkspaceChange>,
  ) {
    const profile = yield* get(id);
    const at = (version: number | null) => {
      const found = profile.versions.find((candidate) => candidate.version === version);
      return found === undefined ? null : { version: found.version, settings: found.settings };
    };
    return { profile, from: at(moved.from), to: at(moved.to), changed };
  });

  return Profiles.of({
    list: Effect.fn("Profiles.list")(function* (ids: ReadonlyArray<ControlProfileId>) {
      const loaded = yield* rowsOf(ids);
      return yield* Effect.forEach(ids, (id) =>
        scopeOf(id).pipe(Effect.map(({ name }) => toProfile(id, name, loaded))),
      );
    }, dieOnDatabaseError),
    departmentOf: Effect.fn("Profiles.departmentOf")(function* (id: ControlProfileId) {
      return (yield* scopeOf(id)).departmentId;
    }, dieOnDatabaseError),
    save: Effect.fn("Profiles.save")(function* (input: {
      readonly id: ControlProfileId;
      readonly settings: ControlProfileSettings;
      readonly note: string;
      readonly testWith: ReadonlyArray<string> | null;
      readonly by: string;
    }) {
      const scope = yield* scopeOf(input.id);
      const testWith = input.testWith;
      if (
        testWith !== null &&
        (testWith.length === 0 || testWith.some((id) => !scope.people.includes(id)))
      ) {
        return yield* new ControlProfileError({ reason: "outside-profile" });
      }
      return yield* step(input.id, (current) =>
        Effect.succeed({
          insert: {
            settings: input.settings,
            note: input.note,
            by: input.by,
            published: testWith === null,
          },
          set:
            testWith === null
              ? { published: current.latest + 1, testVersion: null, testPeople: null }
              : { testVersion: current.latest + 1, testPeople: [...new Set(testWith)] },
          from: current.published,
          to: current.latest + 1,
        }),
      );
    }, dieOnDatabaseError),
    publishTest: Effect.fn("Profiles.publishTest")(function* (id: ControlProfileId) {
      return yield* step(id, (current) =>
        current.testVersion === null
          ? Effect.fail(new ControlProfileError({ reason: "nothing-to-test" }))
          : Effect.succeed({
              set: { published: current.testVersion, testVersion: null, testPeople: null },
              publish: current.testVersion,
              from: current.published,
              to: current.testVersion,
            }),
      );
    }, dieOnDatabaseError),
    discardTest: Effect.fn("Profiles.discardTest")(function* (id: ControlProfileId) {
      return yield* step(id, (current) =>
        current.testVersion === null
          ? Effect.fail(new ControlProfileError({ reason: "nothing-to-test" }))
          : Effect.succeed({
              set: { testVersion: null, testPeople: null },
              from: current.testVersion,
              to: null,
            }),
      );
    }, dieOnDatabaseError),
    rollBack: Effect.fn("Profiles.rollBack")(function* (id: ControlProfileId, by: string) {
      return yield* step(id, (current) =>
        Effect.gen(function* () {
          const [published] = yield* db
            .select()
            .from(controlProfileVersions)
            .where(
              and(
                eq(controlProfileVersions.profileId, id),
                eq(controlProfileVersions.version, current.published ?? 0),
              ),
            );
          const [previous] =
            published?.publishedAt === null || published === undefined
              ? []
              : yield* db
                  .select()
                  .from(controlProfileVersions)
                  .where(
                    and(
                      eq(controlProfileVersions.profileId, id),
                      // Two publications in the same millisecond still have an order.
                      or(
                        lt(controlProfileVersions.publishedAt, published.publishedAt),
                        and(
                          eq(controlProfileVersions.publishedAt, published.publishedAt),
                          lt(controlProfileVersions.version, published.version),
                        ),
                      ),
                    ),
                  )
                  .orderBy(
                    desc(controlProfileVersions.publishedAt),
                    desc(controlProfileVersions.version),
                  )
                  .limit(1);
          if (previous === undefined) {
            return yield* new ControlProfileError({ reason: "nothing-to-roll-back" });
          }
          return {
            insert: {
              settings: previous.settings,
              note: `Rolled back to version ${previous.version}`,
              by,
              published: true,
            },
            set: { published: current.latest + 1 },
            from: current.published,
            to: current.latest + 1,
          };
        }),
      );
    }, dieOnDatabaseError),
    preview: Effect.fn("Profiles.preview")(function* (
      id: ControlProfileId,
      settings: ControlProfileSettings,
    ) {
      const scope = yield* scopeOf(id);
      const loaded = yield* snapshot();
      return summarizeChanges(
        scope.people.map((personId) =>
          workspacesOf(loaded, personId, scope.departmentId).map(({ departmentId }) => ({
            before: effectiveIn(loaded, defaults, personId, departmentId),
            after: effectiveIn(loaded, defaults, personId, departmentId, { id, settings }),
          })),
        ),
      );
    }, dieOnDatabaseError),
    effective: Effect.fn("Profiles.effective")(function* (
      personId: string,
      departmentId: string | null,
    ) {
      return effectiveIn(
        yield* snapshot({ personId, departmentId }),
        defaults,
        personId,
        departmentId,
      );
    }, dieOnDatabaseError),
    exceptions: activeExceptions.pipe(dieOnDatabaseError, Effect.withSpan("Profiles.exceptions")),
    addException: Effect.fn("Profiles.addException")(function* (input: {
      readonly personId: string;
      readonly departmentId: string | null;
      readonly settings: ControlProfileSettings;
      readonly reason: string;
      readonly endsAt: string;
      readonly by: string;
    }) {
      const reason = input.reason.trim();
      if (reason === "") {
        return yield* new ControlProfileError({ reason: "needs-reason" });
      }
      const now = yield* DateTime.now;
      const latest = DateTime.add(now, { days: EXCEPTION_DAYS });
      const ends = DateTime.make(input.endsAt);
      if (
        ends._tag === "None" ||
        !DateTime.isGreaterThan(ends.value, now) ||
        DateTime.isGreaterThan(ends.value, latest)
      ) {
        return yield* new ControlProfileError({ reason: "invalid-end" });
      }
      if (input.departmentId !== null) {
        const department = yield* departments
          .find(input.departmentId)
          .pipe(Effect.mapError(notFound));
        if (!department.members.includes(input.personId)) {
          return yield* new ControlProfileError({ reason: "outside-profile" });
        }
      }
      const exception: ControlProfileException = {
        id: `exc_${Hex.encode(yield* random.randomBytes(8))}`,
        personId: input.personId,
        departmentId: input.departmentId,
        settings: input.settings,
        reason: reason.slice(0, 500),
        endsAt: DateTime.formatIso(ends.value),
        createdBy: input.by.slice(0, 512),
        createdAt: DateTime.formatIso(now),
      };
      const { changed } = yield* measured(
        db.insert(controlProfileExceptions).values(exception),
        (_, loaded) => workspacesOf(loaded, exception.personId, exception.departmentId),
      );
      return { exception, changed } satisfies ExceptionStep;
    }, dieOnDatabaseError),
    endException: Effect.fn("Profiles.endException")(function* (exceptionId: string) {
      const { result: ended, changed } = yield* measured(
        Effect.gen(function* () {
          const [row] = yield* db
            .update(controlProfileExceptions)
            .set({ endedAt: yield* nowIso })
            .where(
              and(
                eq(controlProfileExceptions.id, exceptionId),
                isNull(controlProfileExceptions.endedAt),
              ),
            )
            .returning();
          return row;
        }),
        (row, loaded) =>
          row === undefined ? [] : workspacesOf(loaded, row.personId, row.departmentId),
      );
      if (ended === undefined) {
        return yield* notFound();
      }
      const { id, personId, departmentId, settings, reason, endsAt, createdBy, createdAt } = ended;
      return {
        exception: { id, personId, departmentId, settings, reason, endsAt, createdBy, createdAt },
        changed,
      } satisfies ExceptionStep;
    }, dieOnDatabaseError),
    measure: Effect.fn("Profiles.measure")(
      <A, E, R>(keys: ReadonlyArray<WorkspaceKey>, change: Effect.Effect<A, E, R>) =>
        measured(change, () => keys),
    ),
  });
});

export const layer = Layer.effect(Profiles, make);
