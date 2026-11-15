import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { Accounts } from "../accounts/Accounts.ts";
import { Sessions } from "../accounts/Sessions.ts";
import * as Administration from "../admin/Administration.ts";
import { AuditLog, ON_THE_SERVER } from "../audit/AuditLog.ts";
import { Departments } from "../departments/Departments.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { codeNow, fromBase32 } from "../testing/authenticator.ts";
import { layerTestServices, TEST_PUBLIC_URL } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { type WorkspaceKey, WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import * as WorkspaceRetention from "../workspaces/WorkspaceRetention.ts";
import * as Directory from "./Directory.ts";
import * as ScimHttp from "./ScimHttp.ts";

interface Scim {
  readonly status: number;
  readonly body: Record<string, unknown> & { readonly id?: string };
}

/** The SCIM routes on real services, with an owner's provisioning token. */
const withScim = <A, E, R>(
  body: (context: {
    readonly call: (
      method: string,
      path: string,
      payload?: unknown,
      token?: string,
    ) => Effect.Effect<Scim>;
    /** Workspaces stopped one at a time, and all of someone's at once. */
    readonly retired: ReadonlyArray<WorkspaceKey>;
    readonly retiredAll: ReadonlyArray<string>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const retired: Array<WorkspaceKey> = [];
    const retiredAll: Array<string> = [];
    const manager = WorkspaceManager.of({
      ...WorkspaceManager.none,
      retire: Effect.fn("test.retire")((key: WorkspaceKey) =>
        Effect.sync(() => retired.push(key) > 0),
      ),
      retireAll: Effect.fn("test.retireAll")((personId: string) =>
        Effect.sync(() => retiredAll.push(personId) > 0),
      ),
    });
    return yield* Effect.gen(function* () {
      yield* (yield* LicenceService).install(
        yield* signTestLicence(testClaims({ seats: 10 }), keys.privateKey),
      );
      const { token } = yield* (yield* Administration.Administration).createProvisioningToken(
        Administration.operatorActor("test"),
      );
      const httpEffect = yield* HttpRouter.toHttpEffect(ScimHttp.layer);
      const handler = HttpEffect.toWebHandlerWith<
        never,
        HttpServerRequest.HttpServerRequest | Scope.Scope
      >(yield* Effect.context<never>())(httpEffect);
      const call = (method: string, path: string, payload?: unknown, bearer = token) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`${TEST_PUBLIC_URL}${Administration.SCIM_PATH}${path}`, {
              method,
              headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/scim+json",
              },
              ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            }),
          );
          const text = await response.text();
          return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
        });
      return yield* body({ call, retired, retiredAll });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Directory.layer.pipe(
          Layer.provideMerge(Administration.layer),
          Layer.provideMerge(WorkspaceRetention.layer),
          Layer.provideMerge(
            layerTestServices(keys.publicKey).pipe(
              Layer.provideMerge(HttpServer.layerServices),
              Layer.provideMerge(Layer.succeed(WorkspaceManager, manager)),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const PATCH_OP = ["urn:ietf:params:scim:api:messages:2.0:PatchOp"];

/** Someone provisioned sets up their sign-in from a link, which makes them active. */
const signsUp = Effect.fn("test.signsUp")(function* (personId: string) {
  const accounts = yield* Accounts;
  const { token } = yield* accounts.issueReset(personId);
  const enrolment = yield* accounts.startEnrolment(token);
  yield* accounts.finishEnrolment({
    token,
    password: "a long enough test password",
    code: yield* codeNow(fromBase32(enrolment.authenticator?.secret ?? "")),
  });
});

/** Waits, in the background, for the person's next session to end or reconnect. */
const openSession = Effect.fn("test.openSession")(function* (personId: string) {
  const sessions = yield* Sessions;
  const { token } = yield* sessions.create({ personId, source: ON_THE_SERVER, method: "password" });
  const session = Option.getOrThrow(yield* sessions.authenticate(token));
  return yield* Effect.forkChild(sessions.awaitEnd(session), { startImmediately: true });
});

describe("ScimHttp", () => {
  it.effect("moves people between departments, and ends their access, as Entra ID asks", () =>
    withScim(({ call, retired, retiredAll }) =>
      Effect.gen(function* () {
        const departments = yield* Departments;
        expect((yield* call("GET", "/Users", undefined, "codenine_scim_wrong")).status).toBe(401);

        // Ada is known to Entra ID by her user principal name, which is not her email.
        const created = yield* call("POST", "/Users", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          externalId: "entra-ada",
          userName: "ada@acme.onmicrosoft.com",
          active: true,
          displayName: "Ada Lovelace",
          emails: [{ primary: true, type: "work", value: "ada@acme.test" }],
          name: { givenName: "Ada", familyName: "Lovelace" },
        });
        expect(created.status).toBe(201);
        const adaId = created.body.id ?? "";
        const filter = encodeURIComponent('userName eq "ADA@acme.onmicrosoft.com"');
        expect((yield* call("GET", `/Users?filter=${filter}`)).body).toMatchObject({
          totalResults: 1,
          Resources: [{ id: adaId, emails: [{ value: "ada@acme.test" }], active: true }],
        });
        expect(
          (yield* call("POST", "/Users", { userName: "ada@acme.onmicrosoft.com" })).body,
        ).toMatchObject({ status: "409", scimType: "uniqueness" });

        // Groups are departments.
        const design = yield* call("POST", "/Groups", {
          displayName: "Design",
          externalId: "entra-design",
          members: [{ value: adaId }],
        });
        const sales = yield* call("POST", "/Groups", { displayName: "Sales" });
        expect([design.status, sales.status]).toEqual([201, 201]);
        const designId = design.body.id ?? "";
        const salesId = sales.body.id ?? "";
        expect(yield* departments.ofPerson(adaId)).toEqual([designId]);

        // Moving her to Sales stops her Design workspace, and her open windows reconnect.
        yield* signsUp(adaId);
        const moving = yield* openSession(adaId);
        yield* call("PATCH", `/Groups/${salesId}`, {
          schemas: PATCH_OP,
          Operations: [{ op: "Add", path: "members", value: [{ value: adaId }] }],
        });
        yield* call("PATCH", `/Groups/${designId}`, {
          schemas: PATCH_OP,
          Operations: [{ op: "Remove", path: "members", value: [{ value: adaId }] }],
        });
        yield* Fiber.join(moving);
        expect(yield* departments.ofPerson(adaId)).toEqual([salesId]);
        expect(retired).toEqual([{ personId: adaId, departmentId: designId }]);

        // A new email from Entra ID reaches her account.
        yield* call("PATCH", `/Users/${adaId}`, {
          schemas: PATCH_OP,
          Operations: [
            { op: "Replace", path: 'emails[type eq "work"].value', value: "ada.l@acme.test" },
          ],
        });
        expect((yield* (yield* Accounts).findPerson(adaId)).email).toBe("ada.l@acme.test");

        // Unassigning her ends her sessions and stops her workspaces; deleting her hides her.
        const leaving = yield* openSession(adaId);
        const off = yield* call("PATCH", `/Users/${adaId}`, {
          schemas: PATCH_OP,
          Operations: [{ op: "Replace", path: "active", value: "False" }],
        });
        expect(off.body).toMatchObject({ active: false });
        yield* Fiber.join(leaving);
        expect(retiredAll).toEqual([adaId]);
        expect((yield* call("DELETE", `/Users/${adaId}`)).status).toBe(204);
        expect((yield* call("GET", `/Users/${adaId}`)).status).toBe(404);
        expect((yield* (yield* Accounts).findPerson(adaId)).status).toBe("deactivated");

        // Provisioned again later, she is the same person, back with her files.
        const back = yield* call("POST", "/Users", {
          userName: "ada@acme.onmicrosoft.com",
          emails: [{ primary: true, value: "ada.l@acme.test" }],
        });
        expect([back.status, back.body.id, back.body["active"]]).toEqual([201, adaId, true]);

        // Each change names provisioning as its actor.
        const { entries } = yield* (yield* AuditLog).list(null);
        expect(
          entries
            .filter(({ actor }) => actor.kind === "provisioning")
            .map(({ action }) => action)
            .toReversed(),
        ).toEqual([
          "person.provision",
          "department.create",
          "department.add-member",
          "department.create",
          "department.add-member",
          "department.remove-member",
          "person.update",
          "person.deactivate",
          "person.reactivate",
        ]);
      }),
    ),
  );

  it.effect("keeps the last owner, and a group's members only when they are users", () =>
    withScim(({ call }) =>
      Effect.gen(function* () {
        // The owner who set Codenine up is matched by email, not made twice.
        const { person } = yield* (yield* Accounts).inviteOwner({
          email: "olu@acme.test",
          displayName: "Olu",
        });
        yield* signsUp(person.id);
        const linked = yield* call("POST", "/Users", {
          userName: "olu@acme.test",
          emails: [{ value: "olu@acme.test" }],
        });
        expect([linked.status, linked.body.id]).toEqual([201, person.id]);
        const refused = yield* call("PATCH", `/Users/${person.id}`, {
          schemas: PATCH_OP,
          Operations: [{ op: "replace", value: { active: false } }],
        });
        expect(refused.body).toMatchObject({ status: "400", scimType: "mutability" });

        const group = yield* call("POST", "/Groups", {
          displayName: "Design",
          members: [{ value: "per_nobody" }],
        });
        expect(group.body).toMatchObject({ status: "400", scimType: "invalidValue" });
        expect((yield* (yield* Departments).list).map(({ name }) => name)).toEqual([]);
      }),
    ),
  );
});
