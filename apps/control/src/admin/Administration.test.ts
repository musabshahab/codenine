import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlProfileSettings, ControlRole } from "@codenine/contracts/control";
import type { LicenceClaims } from "@codenine/contracts/licence";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { Sessions } from "../accounts/Sessions.ts";
import { AuditLog, ON_THE_SERVER } from "../audit/AuditLog.ts";
import { ControlDb } from "../db.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { controlPeople } from "../persistence/schema.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { type WorkspaceKey, WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import * as WorkspaceRetention from "../workspaces/WorkspaceRetention.ts";
import * as Administration from "./Administration.ts";

const withAdministration = <A, E, R>(
  body: (context: {
    readonly sign: (claims: LicenceClaims) => ReturnType<typeof signTestLicence>;
    /** The workspaces stopped one at a time. */
    readonly retired: ReadonlyArray<WorkspaceKey>;
    /** The workspaces given new hosts, a batch at a time. */
    readonly rerouted: ReadonlyArray<ReadonlyArray<WorkspaceKey>>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const sign = (claims: LicenceClaims) => signTestLicence(claims, keys.privateKey);
    const retired: Array<WorkspaceKey> = [];
    const rerouted: Array<ReadonlyArray<WorkspaceKey>> = [];
    const manager = WorkspaceManager.of({
      ...WorkspaceManager.none,
      retire: Effect.fn("test.retire")((key: WorkspaceKey) =>
        Effect.sync(() => retired.push(key) > 0),
      ),
      applyNetwork: Effect.fn("test.applyNetwork")((keys: ReadonlyArray<WorkspaceKey>) =>
        Effect.sync(() => void rerouted.push(keys)),
      ),
    });
    return yield* Effect.gen(function* () {
      yield* (yield* LicenceService).install(yield* sign(testClaims({ seats: 10 })));
      return yield* body({ sign, retired, rerouted });
    }).pipe(
      Effect.provide(
        Administration.layer.pipe(
          Layer.provideMerge(WorkspaceRetention.layer),
          Layer.provideMerge(layerTestServices(keys.publicKey)),
          Layer.provideMerge(Layer.succeed(WorkspaceManager, manager)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const FROM = { address: "203.0.113.7", userAgent: "Test browser" };

/** An active person with this role, as an actor in a browser at `FROM`. */
const person = Effect.fn("test.person")(function* (name: string, role: ControlRole) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const id = `per_${name.toLowerCase()}`;
  const email = `${name.toLowerCase()}@acme.test`;
  yield* (yield* ControlDb).insert(controlPeople).values({
    id,
    email,
    displayName: name,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return { ...Administration.personActor({ id, email, displayName: name, role }, FROM), id };
});

const refused = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error._tag));

describe("Administration", () => {
  it.effect("keeps each role to the people and changes it may give", () =>
    withAdministration(() =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const ada = yield* person("Ada", "owner");
        const bea = yield* person("Bea", "admin");
        const cy = yield* person("Cy", "member");
        const dee = yield* person("Dee", "department-admin");
        const eve = yield* person("Eve", "auditor");

        // Only owners install licences; admins read them, auditors do not.
        expect(yield* refused(admin.installLicence(bea, "key"))).toBe("ControlForbiddenError");
        expect((yield* admin.licence(bea)).licence._tag).toBe("installed");
        expect(yield* refused(admin.licence(eve))).toBe("ControlForbiddenError");

        // An admin cannot make an owner, nor change or reset one, which would take over their account.
        const invite = { email: "fay@acme.test", displayName: "Fay" };
        expect(yield* refused(admin.invite(bea, { ...invite, role: "owner" }))).toBe(
          "ControlForbiddenError",
        );
        expect(yield* refused(admin.setRole(bea, { personId: cy.id, role: "owner" }))).toBe(
          "ControlForbiddenError",
        );
        expect(yield* refused(admin.issueReset(bea, ada.id))).toBe("ControlForbiddenError");
        expect(yield* refused(admin.deactivate(bea, ada.id))).toBe("ControlForbiddenError");
        expect((yield* admin.setRole(bea, { personId: cy.id, role: "admin" })).role).toBe("admin");
        expect((yield* admin.invite(ada, { ...invite, role: "owner" })).person.role).toBe("owner");
        // Nor create the provisioning token, which can deactivate owners.
        expect(yield* refused(admin.createProvisioningToken(bea))).toBe("ControlForbiddenError");
        expect((yield* admin.createProvisioningToken(ada)).provisioning).toMatchObject({
          url: "https://codenine.acme.test/control/scim/v2",
          token: { createdBy: "ada@acme.test", lastUsedAt: null },
        });

        // Members and auditors manage nobody, and a department admin with no department neither.
        for (const actor of [cy, eve, dee]) {
          expect(yield* refused(admin.issueReset(actor, bea.id))).toBe("ControlForbiddenError");
        }
        expect(yield* refused(admin.people(eve))).toBe("ControlForbiddenError");
        expect(yield* admin.people(dee)).toEqual([]);
        expect((yield* admin.people(bea)).map((listed) => listed.email)).toContain("ada@acme.test");
      }),
    ),
  );

  it.effect("applies a new role to open connections at once, and signs people out", () =>
    withAdministration(() =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const sessions = yield* Sessions;
        const bea = yield* person("Bea", "admin");
        const cy = yield* person("Cy", "member");
        const { token } = yield* sessions.create({
          personId: cy.id,
          source: ON_THE_SERVER,
          method: "password",
        });
        const session = Option.getOrThrow(yield* sessions.authenticate(token));
        const ended = yield* Effect.forkChild(sessions.awaitEnd(session), {
          startImmediately: true,
        });

        yield* admin.setRole(bea, { personId: cy.id, role: "restricted" });
        yield* Fiber.join(ended);
        // The session itself goes on, and the next connection carries the new role.
        const after = Option.getOrThrow(yield* sessions.authenticate(token));
        expect(after.person.role).toBe("restricted");

        // Signing them out everywhere ends the session itself.
        expect((yield* admin.personSessions(bea, cy.id)).map(({ id }) => id)).toEqual([
          after.sessionId,
        ]);
        const signedOut = yield* Effect.forkChild(sessions.awaitEnd(after), {
          startImmediately: true,
        });
        yield* admin.signOutPerson(bea, cy.id);
        yield* Fiber.join(signedOut);
        expect(Option.isNone(yield* sessions.authenticate(token))).toBe(true);
        expect(yield* admin.personSessions(bea, cy.id)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "puts terminal and host changes into effect at once for the workspaces they reach",
    () =>
      withAdministration(({ rerouted }) =>
        Effect.gen(function* () {
          const admin = yield* Administration.Administration;
          const sessions = yield* Sessions;
          const ada = yield* person("Ada", "owner");
          const cy = yield* person("Cy", "member");
          const fay = yield* person("Fay", "member");
          const design = yield* admin.createDepartment(ada, "Design");
          const sales = yield* admin.createDepartment(ada, "Sales");
          yield* admin.addDepartmentMember(ada, design.id, cy.id);
          yield* admin.addDepartmentMember(ada, sales.id, fay.id);
          const cyInDesign = { personId: cy.id, departmentId: design.id };
          const { token } = yield* sessions.create({
            personId: cy.id,
            source: ON_THE_SERVER,
            method: "password",
          });
          const session = Option.getOrThrow(yield* sessions.authenticate(token));
          const ended = yield* Effect.forkChild(sessions.awaitEnd(session), {
            startImmediately: true,
          });
          const saveDesign = (settings: ControlProfileSettings) =>
            admin.saveProfile(ada, {
              profileId: `department:${design.id}`,
              settings,
              note: "",
              testWith: null,
            });

          // Blocking the terminal reconnects Cy without it; her hosts are as they were.
          yield* saveDesign({ terminal: "block" });
          yield* Fiber.join(ended);
          expect(rerouted).toEqual([]);

          // New hosts reach Design's workspaces only, whichever change brings them.
          yield* saveDesign({ terminal: "block", blockHosts: [".github.com"] });
          const brand = (yield* admin.createTeam(ada, design.id, "Brand")).teams[0]?.id ?? "";
          yield* admin.saveProfile(ada, {
            profileId: `team:${brand}`,
            settings: { allowHosts: ["figma.com"] },
            note: "",
            testWith: null,
          });
          yield* admin.addTeamMember(ada, brand, cy.id);
          const exception = yield* admin.addException(ada, {
            personId: cy.id,
            departmentId: design.id,
            settings: { allowHosts: ["sentry.io"] },
            reason: "Tracing a crash",
            endsAt: "2026-12-17T12:00:00.000Z",
          });
          yield* admin.endException(ada, exception.id);
          yield* admin.deleteTeam(ada, brand);
          expect(rerouted).toEqual([
            [cyInDesign],
            [cyInDesign],
            [cyInDesign],
            [cyInDesign],
            [cyInDesign],
          ]);
        }),
      ),
  );

  it.effect("writes one audit entry for each change: who, from where, and what changed", () =>
    withAdministration(({ sign }) =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const newest = (yield* AuditLog).list(null).pipe(Effect.map(({ entries }) => entries));

        // The first owner comes from the server's command line.
        yield* admin.inviteOwner(Administration.operatorActor("root on control-1"), {
          email: "zed@acme.test",
          displayName: "Zed",
        });
        expect(yield* newest).toMatchObject([
          {
            actor: { kind: "operator", id: null, label: "root on control-1" },
            source: ON_THE_SERVER,
            action: "person.invite",
            target: { kind: "person", label: "zed@acme.test" },
            after: { email: "zed@acme.test", role: "owner" },
          },
        ]);

        const ada = yield* person("Ada", "owner");
        const cy = yield* person("Cy", "member");
        const renewal = yield* sign(
          testClaims({ sub: "lic_second", seats: 10, exp: testClaims().exp + 365 * 86_400 }),
        );
        const byAda = {
          actor: { kind: "person", id: ada.id, label: "ada@acme.test" },
          source: FROM,
        };
        /** Runs a change and checks that it wrote exactly one entry, matching `entry`. */
        const writesOne = <A, E, R>(change: Effect.Effect<A, E, R>, entry: object) =>
          Effect.gen(function* () {
            const before = (yield* newest)[0]?.id ?? 0;
            const result = yield* change;
            const [latest, previous] = yield* newest;
            expect([latest?.id, previous?.id]).toEqual([before + 1, before]);
            expect(latest).toMatchObject({ ...byAda, ...entry });
            return result;
          });

        yield* writesOne(
          admin.invite(ada, { email: "fay@acme.test", displayName: "Fay", role: "member" }),
          { action: "person.invite", before: null, after: { role: "member", departments: null } },
        );
        yield* writesOne(admin.setRole(ada, { personId: cy.id, role: "restricted" }), {
          action: "person.role",
          before: { role: "member" },
          after: { role: "restricted" },
        });
        yield* writesOne(admin.unlock(ada, cy.id), {
          action: "person.unlock",
          before: { lockedUntil: null },
          after: { lockedUntil: null },
        });
        yield* writesOne(admin.issueReset(ada, cy.id), {
          action: "person.reset",
          before: { canSignIn: false },
          after: { canSignIn: false },
        });
        yield* writesOne(admin.deactivate(ada, cy.id), {
          action: "person.deactivate",
          before: { status: "active" },
          after: { status: "deactivated" },
        });
        yield* writesOne(admin.reactivate(ada, cy.id), {
          action: "person.reactivate",
          before: { status: "deactivated" },
          after: { status: "invited" },
        });
        yield* writesOne(admin.installLicence(ada, renewal), {
          action: "licence.install",
          target: { kind: "licence", id: "lic_second" },
          before: { applied: "lic_first" },
          after: { applied: "lic_second" },
        });

        const design = yield* writesOne(admin.createDepartment(ada, "Design", "Product"), {
          action: "department.create",
          target: { kind: "department", label: "Design" },
          after: { name: "Design", template: "Product" },
        });
        // Its profile starts as the template, without a second entry.
        expect(
          (yield* admin.profiles(ada)).find(({ id }) => id === `department:${design.id}`)?.versions,
        ).toMatchObject([{ version: 1, note: "From the Product template", settings: { cpus: 2 } }]);
        yield* writesOne(admin.renameDepartment(ada, design.id, "Brand"), {
          action: "department.rename",
          before: { name: "Design" },
          after: { name: "Brand" },
        });
        yield* writesOne(admin.addDepartmentMember(ada, design.id, cy.id), {
          action: "department.add-member",
          target: { kind: "person", label: "cy@acme.test" },
          after: { department: "Brand" },
        });
        const withTeam = yield* writesOne(admin.createTeam(ada, design.id, "Logos"), {
          action: "team.create",
          target: { kind: "team", label: "Brand / Logos" },
          after: { name: "Logos", department: "Brand" },
        });
        const team = withTeam.teams[0]?.id ?? "";
        yield* writesOne(admin.renameTeam(ada, team, "Marks"), {
          action: "team.rename",
          before: { name: "Logos" },
          after: { name: "Marks" },
        });
        yield* writesOne(admin.addTeamMember(ada, team, cy.id), {
          action: "team.add-member",
          after: { team: "Brand / Marks" },
        });
        yield* writesOne(admin.removeTeamMember(ada, team, cy.id), {
          action: "team.remove-member",
          before: { team: "Brand / Marks" },
        });
        yield* writesOne(admin.deleteTeam(ada, team), {
          action: "team.delete",
          before: { name: "Marks" },
        });
        yield* writesOne(admin.removeDepartmentMember(ada, design.id, cy.id), {
          action: "department.remove-member",
          before: { department: "Brand" },
        });
        yield* writesOne(admin.deleteDepartment(ada, design.id), {
          action: "department.delete",
          before: { name: "Brand" },
        });

        yield* writesOne(
          admin.saveProfile(ada, {
            profileId: "company",
            settings: { cpus: 4 },
            note: "Bigger",
            testWith: null,
          }),
          {
            action: "profile.publish",
            target: { kind: "profile", id: "company", label: "Company" },
            before: null,
            after: { version: 1, changes: "cpus: unset → 4", note: "Bigger" },
          },
        );
        yield* writesOne(
          admin.saveProfile(ada, {
            profileId: "company",
            settings: { cpus: 8 },
            note: "",
            testWith: [cy.id],
          }),
          {
            action: "profile.test",
            before: { version: 1 },
            after: { version: 2, changes: "cpus: 4 → 8", testers: 1 },
          },
        );
        yield* writesOne(admin.publishTest(ada, "company"), {
          action: "profile.publish",
          before: { version: 1 },
          after: { version: 2, changes: "cpus: 4 → 8" },
        });
        yield* admin.saveProfile(ada, {
          profileId: "company",
          settings: { cpus: 16 },
          note: "",
          testWith: [cy.id],
        });
        yield* writesOne(admin.discardTest(ada, "company"), {
          action: "profile.discard",
          before: { version: 3 },
          after: null,
        });
        yield* writesOne(admin.rollBackProfile(ada, "company"), {
          action: "profile.rollback",
          before: { version: 2 },
          after: { version: 4, changes: "cpus: 8 → 4", note: "Rolled back to version 1" },
        });
        const exception = yield* writesOne(
          admin.addException(ada, {
            personId: cy.id,
            departmentId: null,
            settings: { memoryGb: 16 },
            reason: "A large data job",
            endsAt: "2026-12-17T12:00:00.000Z",
          }),
          {
            action: "exception.create",
            target: { kind: "person", label: "cy@acme.test" },
            after: {
              department: "every department",
              reason: "A large data job",
              changes: "memoryGb: unset → 16",
            },
          },
        );
        yield* writesOne(admin.endException(ada, exception.id), {
          action: "exception.end",
          before: { department: "every department", reason: "A large data job" },
          after: null,
        });

        // Nothing changed, nothing written: the same role again, or a refused change.
        const latest = (yield* newest)[0]?.id;
        yield* admin.setRole(ada, { personId: cy.id, role: "restricted" });
        yield* Effect.flip(admin.installLicence(cy, renewal));
        expect((yield* newest)[0]?.id).toBe(latest);
      }),
    ),
  );

  it.effect("lets department admins manage the people and teams of their own departments", () =>
    withAdministration(({ retired }) =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const ada = yield* person("Ada", "owner");
        const bea = yield* person("Bea", "admin");
        const cy = yield* person("Cy", "member");
        const dee = yield* person("Dee", "department-admin");
        const fay = yield* person("Fay", "member");
        const design = yield* admin.createDepartment(ada, "Design");
        const sales = yield* admin.createDepartment(ada, "Sales");
        for (const member of [bea, cy, dee]) {
          yield* admin.addDepartmentMember(ada, design.id, member.id);
        }
        yield* admin.addDepartmentMember(ada, sales.id, fay.id);

        // Dee sees Design's people and changes those whose role she could give.
        expect((yield* admin.people(dee)).map(({ email }) => email).toSorted()).toEqual([
          "bea@acme.test",
          "cy@acme.test",
          "dee@acme.test",
        ]);
        yield* admin.issueReset(dee, cy.id);
        expect(yield* refused(admin.issueReset(dee, fay.id))).toBe("ControlForbiddenError");
        expect(yield* refused(admin.issueReset(dee, bea.id))).toBe("ControlForbiddenError");
        expect(yield* refused(admin.addDepartmentMember(dee, design.id, fay.id))).toBe(
          "ControlForbiddenError",
        );
        expect((yield* admin.departments(dee)).map(({ name }) => name)).toEqual(["Design"]);
        expect(yield* refused(admin.createDepartment(dee, "Studio"))).toBe("ControlForbiddenError");

        // She invites people into her own departments only.
        const gus = { email: "gus@acme.test", displayName: "Gus", role: "member" } as const;
        expect(yield* refused(admin.invite(dee, gus))).toBe("ControlForbiddenError");
        expect(yield* refused(admin.invite(dee, { ...gus, departments: [sales.id] }))).toBe(
          "ControlForbiddenError",
        );
        const invited = yield* admin.invite(dee, { ...gus, departments: [design.id] });
        expect((yield* admin.departments(dee))[0]?.members).toContain(invited.person.id);

        // Teams hold members of their department; leaving the department leaves its teams.
        const team = (yield* admin.createTeam(dee, design.id, "Brand")).teams[0]?.id ?? "";
        yield* admin.addTeamMember(dee, team, cy.id);
        expect(yield* Effect.flip(admin.addTeamMember(ada, team, fay.id))).toMatchObject({
          reason: "not-in-department",
        });
        // Her department's profile and its teams' are hers to change; the company's is not.
        const profile = { settings: { terminal: "block" }, note: "", testWith: null } as const;
        expect(yield* refused(admin.saveProfile(dee, { ...profile, profileId: "company" }))).toBe(
          "ControlForbiddenError",
        );
        expect(
          yield* refused(
            admin.saveProfile(dee, { ...profile, profileId: `department:${sales.id}` }),
          ),
        ).toBe("ControlForbiddenError");
        yield* admin.saveProfile(dee, { ...profile, profileId: `department:${design.id}` });
        expect((yield* admin.profiles(dee)).map(({ name }) => name)).toEqual([
          "Design",
          "Design / Brand",
        ]);
        expect((yield* admin.personProfile(dee, invited.person.id, design.id)).terminal).toBe(
          false,
        );
        // An exception for all of someone's departments is for owners and admins.
        const exception = {
          personId: cy.id,
          settings: { cpus: 8 },
          reason: "A large build",
          endsAt: "2026-12-17T12:00:00.000Z",
        };
        expect(yield* refused(admin.addException(dee, { ...exception, departmentId: null }))).toBe(
          "ControlForbiddenError",
        );
        yield* admin.addException(dee, { ...exception, departmentId: design.id });
        expect((yield* admin.exceptions(dee)).map(({ personId }) => personId)).toEqual([cy.id]);

        const left = yield* admin.removeDepartmentMember(dee, design.id, cy.id);
        expect(left.teams[0]?.members).toEqual([]);
        // Cy's workspace in Design stops; her files stay in case she comes back.
        expect(retired).toEqual([{ personId: cy.id, departmentId: design.id }]);
        expect(yield* Effect.flip(admin.deleteDepartment(ada, design.id))).toMatchObject({
          reason: "not-empty",
        });

        // Her audit log is about her department and its people, not about Sales.
        const labels = (yield* admin.audit(dee, null)).entries.map(({ target }) => target?.label);
        expect(labels).toContain("Design / Brand");
        expect(labels).toContain("gus@acme.test");
        expect(labels).not.toContain("Sales");
        expect(labels).not.toContain("fay@acme.test");
      }),
    ),
  );

  it.effect("keeps at least one owner", () =>
    withAdministration(() =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const ada = yield* person("Ada", "owner");
        const bea = yield* person("Bea", "admin");

        expect(
          yield* Effect.flip(admin.setRole(ada, { personId: ada.id, role: "admin" })),
        ).toMatchObject({ _tag: "ControlAccountError", reason: "last-owner" });
        expect(yield* Effect.flip(admin.deactivate(ada, ada.id))).toMatchObject({
          reason: "last-owner",
        });

        yield* admin.setRole(ada, { personId: bea.id, role: "owner" });
        expect((yield* admin.setRole(ada, { personId: ada.id, role: "admin" })).role).toBe("admin");
      }),
    ),
  );
});
