import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlRole } from "@codenine/contracts/control";
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
import { WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import * as WorkspaceRetention from "../workspaces/WorkspaceRetention.ts";
import * as Administration from "./Administration.ts";

const withAdministration = <A, E, R>(
  body: (licences: {
    readonly sign: (claims: LicenceClaims) => ReturnType<typeof signTestLicence>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const sign = (claims: LicenceClaims) => signTestLicence(claims, keys.privateKey);
    return yield* Effect.gen(function* () {
      yield* (yield* LicenceService).install(yield* sign(testClaims({ seats: 10 })));
      return yield* body({ sign });
    }).pipe(
      Effect.provide(
        Administration.layer.pipe(
          Layer.provideMerge(WorkspaceRetention.layer),
          Layer.provideMerge(layerTestServices(keys.publicKey)),
          Layer.provideMerge(Layer.succeed(WorkspaceManager, WorkspaceManager.none)),
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

        // Members and auditors manage nobody; department admins only their own departments.
        for (const actor of [cy, eve, dee]) {
          expect(yield* refused(admin.issueReset(actor, bea.id))).toBe("ControlForbiddenError");
        }
        expect(yield* refused(admin.people(eve))).toBe("ControlForbiddenError");
        expect(yield* admin.people(dee)).toEqual([]);
        expect((yield* admin.people(bea)).map((listed) => listed.email)).toContain("ada@acme.test");
      }),
    ),
  );

  it.effect("applies a new role to open connections at once", () =>
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
        const changes = [
          [
            admin.invite(ada, { email: "fay@acme.test", displayName: "Fay", role: "member" }),
            { action: "person.invite", before: null, after: { role: "member" } },
          ],
          [
            admin.setRole(ada, { personId: cy.id, role: "restricted" }),
            { action: "person.role", before: { role: "member" }, after: { role: "restricted" } },
          ],
          [
            admin.unlock(ada, cy.id),
            {
              action: "person.unlock",
              before: { lockedUntil: null },
              after: { lockedUntil: null },
            },
          ],
          [
            admin.issueReset(ada, cy.id),
            { action: "person.reset", before: { canSignIn: false }, after: { canSignIn: false } },
          ],
          [
            admin.deactivate(ada, cy.id),
            {
              action: "person.deactivate",
              before: { status: "active" },
              after: { status: "deactivated" },
            },
          ],
          [
            admin.reactivate(ada, cy.id),
            {
              action: "person.reactivate",
              before: { status: "deactivated" },
              after: { status: "invited" },
            },
          ],
          [
            admin.installLicence(ada, renewal),
            {
              action: "licence.install",
              target: { kind: "licence", id: "lic_second" },
              before: { applied: "lic_first" },
              after: { applied: "lic_second" },
            },
          ],
        ] as const;
        for (const [change, entry] of changes) {
          const before = (yield* newest).length;
          yield* change;
          const entries = yield* newest;
          expect(entries.length).toBe(before + 1);
          expect(entries[0]).toMatchObject({
            actor: { kind: "person", id: ada.id, label: "ada@acme.test" },
            source: FROM,
            ...entry,
          });
        }

        // Nothing changed, nothing written: the same role again, or a refused change.
        const count = (yield* newest).length;
        yield* admin.setRole(ada, { personId: cy.id, role: "restricted" });
        yield* Effect.flip(admin.installLicence(cy, renewal));
        expect((yield* newest).length).toBe(count);
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
