import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlProfileId } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ControlDb } from "../db.ts";
import { Departments } from "../departments/Departments.ts";
import { controlPeople } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { testKeyPair } from "../testing/testLicence.ts";
import { Profiles } from "./Profiles.ts";

const withProfiles = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    return yield* body.pipe(Effect.provide(layerTestServices(keys.publicKey)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Ada and Bea in Design, Cy in Sales. */
const company = Effect.gen(function* () {
  const db = yield* ControlDb;
  const departments = yield* Departments;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const name of ["Ada", "Bea", "Cy"]) {
    yield* db.insert(controlPeople).values({
      id: name.toLowerCase(),
      email: `${name.toLowerCase()}@acme.test`,
      displayName: name,
      role: "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
  const design = yield* departments.create("Design");
  const sales = yield* departments.create("Sales");
  yield* departments.addMember(design.id, "ada");
  yield* departments.addMember(design.id, "bea");
  yield* departments.addMember(sales.id, "cy");
  const designProfile: ControlProfileId = `department:${design.id}`;
  return { design: design.id, sales: sales.id, designProfile };
});

describe("Profiles", () => {
  it.effect(
    "tries a version on a test group, gives it to everyone, and rolls back in one step",
    () =>
      withProfiles(
        Effect.gen(function* () {
          const profiles = yield* Profiles;
          const { design, designProfile } = yield* company;
          const cpus = (person: string) =>
            profiles.effective(person, design).pipe(Effect.map((effective) => effective.cpus));
          const save = (
            settings: { readonly cpus: number },
            testWith: ReadonlyArray<string> | null,
          ) =>
            profiles.save({ id: designProfile, settings, note: "", testWith, by: "ada@acme.test" });

          expect(yield* Effect.flip(profiles.rollBack(designProfile, "ada"))).toMatchObject({
            reason: "nothing-to-roll-back",
          });
          yield* save({ cpus: 4 }, null);
          expect([yield* cpus("ada"), yield* cpus("bea")]).toEqual([4, 4]);

          // Bea tries 8 CPUs first; nobody outside the department can be in the test.
          expect(yield* Effect.flip(save({ cpus: 8 }, ["cy"]))).toMatchObject({
            reason: "outside-profile",
          });
          const tried = yield* save({ cpus: 8 }, ["bea"]);
          expect(tried.profile).toMatchObject({
            published: 1,
            test: { version: 2, people: ["bea"] },
          });
          expect([yield* cpus("ada"), yield* cpus("bea")]).toEqual([4, 8]);
          // Each step names the workspaces it changed, as they were and are now.
          expect(tried.changed).toMatchObject([
            {
              key: { personId: "bea", departmentId: design },
              before: { cpus: 4 },
              after: { cpus: 8 },
            },
          ]);

          const published = yield* profiles.publishTest(designProfile);
          expect([yield* cpus("ada"), yield* cpus("bea")]).toEqual([8, 8]);
          expect(published.changed.map(({ key }) => key.personId)).toEqual(["ada"]);
          expect(yield* Effect.flip(profiles.discardTest(designProfile))).toMatchObject({
            reason: "nothing-to-test",
          });

          // Rolling back gives everyone what they had before, as a new version.
          const rolled = yield* profiles.rollBack(designProfile, "ada@acme.test");
          expect(rolled.profile.versions.map(({ version, note }) => [version, note])).toEqual([
            [3, "Rolled back to version 1"],
            [2, ""],
            [1, ""],
          ]);
          expect(rolled.profile.published).toBe(3);
          expect([yield* cpus("ada"), yield* cpus("bea")]).toEqual([4, 4]);

          // A test can also be dropped, leaving everyone as they were.
          yield* save({ cpus: 16 }, ["ada"]);
          yield* profiles.discardTest(designProfile);
          expect(yield* cpus("ada")).toBe(4);
        }),
      ),
  );

  it.effect("previews who a change affects, after every layer's locks and blocks", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const { designProfile } = yield* company;

        expect(yield* profiles.preview("company", { terminal: "block" })).toEqual({
          people: 3,
          affected: 3,
          changes: [{ setting: "terminal", people: 3, removed: ["allowed"], added: ["blocked"] }],
        });
        expect(yield* profiles.preview(designProfile, { memoryGb: 8 })).toEqual({
          people: 2,
          affected: 2,
          changes: [{ setting: "memoryGb", people: 2, removed: ["4"], added: ["8"] }],
        });

        // Once the company locks memory, the same department change affects nobody.
        const locked = yield* profiles.save({
          id: "company",
          settings: { lock: ["memoryGb"] },
          note: "",
          testWith: null,
          by: "ada@acme.test",
        });
        expect(locked.changed).toEqual([]);
        expect(yield* profiles.preview(designProfile, { memoryGb: 8 })).toEqual({
          people: 2,
          affected: 0,
          changes: [],
        });
      }),
    ),
  );

  it.effect("applies a person's exception until it ends", () =>
    withProfiles(
      Effect.gen(function* () {
        const profiles = yield* Profiles;
        const { design, sales } = yield* company;
        const inAWeek = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 7 }));
        const exception = {
          personId: "ada",
          departmentId: design,
          settings: { cpus: 16 },
          reason: "Profiling a build",
          endsAt: inAWeek,
          by: "bea@acme.test",
        };

        expect(
          yield* Effect.flip(profiles.addException({ ...exception, reason: " " })),
        ).toMatchObject({ reason: "needs-reason" });
        const tooLate = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 91 }));
        expect(
          yield* Effect.flip(profiles.addException({ ...exception, endsAt: tooLate })),
        ).toMatchObject({ reason: "invalid-end" });
        expect(
          yield* Effect.flip(profiles.addException({ ...exception, departmentId: sales })),
        ).toMatchObject({ reason: "outside-profile" });

        const added = yield* profiles.addException(exception);
        expect(added.changed).toMatchObject([
          { key: { personId: "ada", departmentId: design }, after: { cpus: 16 } },
        ]);
        expect((yield* profiles.effective("ada", design)).cpus).toBe(16);
        expect((yield* profiles.effective("bea", design)).cpus).toBe(2);

        yield* TestClock.adjust("8 days");
        expect((yield* profiles.effective("ada", design)).cpus).toBe(2);
        expect(yield* profiles.exceptions).toEqual([]);

        const again = yield* profiles.addException({
          ...exception,
          endsAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 7 })),
        });
        const ended = yield* profiles.endException(again.exception.id);
        expect(ended.changed).toMatchObject([{ before: { cpus: 16 }, after: { cpus: 2 } }]);
        expect((yield* profiles.effective("ada", design)).cpus).toBe(2);
      }),
    ),
  );
});
