import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ControlEnrolment,
  ControlIssuedLink,
  ControlLicenceOverview,
  ControlMe,
  ControlPerson,
  ControlSessionEntry,
} from "@codenine/contracts/control";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { Accounts } from "../accounts/Accounts.ts";
import { Sessions } from "../accounts/Sessions.ts";
import { codeNow, fromBase32 } from "../testing/authenticator.ts";
import { layerTestServices, TEST_PUBLIC_URL } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import * as ControlHttp from "./ControlHttp.ts";

const PASSWORD = "correct horse battery staple";
const COOKIE = ControlHttp.sessionCookieName(true);

/**
 * Runs the real routes in this test's fiber, so the services and the test
 * clock are the ones the test sees.
 */
const withApi = <A, E, R>(
  body: (api: {
    readonly call: (path: string, init?: RequestInit) => Effect.Effect<Response>;
    readonly signLicence: typeof signTestLicence extends (claims: infer C, key: string) => infer O
      ? (claims: C) => O
      : never;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    return yield* Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(ControlHttp.layerRoutes);
      const handler = HttpEffect.toWebHandlerWith<
        never,
        HttpServerRequest.HttpServerRequest | Scope.Scope
      >(yield* Effect.context<never>())(httpEffect);
      const call = (path: string, init?: RequestInit) =>
        Effect.promise(() => handler(new Request(`${TEST_PUBLIC_URL}${path}`, init)));
      return yield* body({
        call,
        signLicence: (claims) => signTestLicence(claims, keys.privateKey),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTestServices(keys.publicKey).pipe(
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(WorkspaceManager, WorkspaceManager.none)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const send = (
  method: string,
  body: unknown,
  options: { readonly cookie?: string; readonly headers?: Record<string, string> } = {},
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    origin: TEST_PUBLIC_URL,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...options.headers,
  },
  body: JSON.stringify(body),
});

/** Reads a response body as the contract says it should look. */
const read =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (response: Response) =>
    Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.orDie,
    );

const sessionCookieOf = (response: Response) => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${COOKIE}=`));
  return header?.split(";")[0] ?? "";
};

/** An owner who can sign in, and a cookie for one of their sessions. */
const signedInOwner = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const { token, person } = yield* accounts.inviteOwner({
    email: "ada@acme.test",
    displayName: "Ada",
  });
  const enrolment = yield* accounts.startEnrolment(token);
  const secret = fromBase32(enrolment.authenticator?.secret ?? "");
  yield* accounts.finishEnrolment({ token, password: PASSWORD, code: yield* codeNow(secret) });
  const session = yield* (yield* Sessions).create({ personId: person.id, userAgent: null });
  return { personId: person.id, cookie: `${COOKIE}=${session.token}` };
});

describe("ControlHttp", () => {
  it.effect("sets a secure session cookie on set-up and sign-in, and signs out everywhere", () =>
    withApi(({ call }) =>
      Effect.gen(function* () {
        const { token, person } = yield* (yield* Accounts).inviteOwner({
          email: "ada@acme.test",
          displayName: "Ada",
        });
        const enrolment = yield* read(ControlEnrolment)(
          yield* call("/control/api/enrolment/start", send("POST", { token })),
        );
        const secret = fromBase32(enrolment.authenticator?.secret ?? "");
        const finished = yield* call(
          "/control/api/enrolment/finish",
          send("POST", { token, password: PASSWORD, code: yield* codeNow(secret) }),
        );
        expect(finished.status).toBe(200);
        const { recoveryCodes } = yield* read(
          Schema.Struct({ me: ControlMe, recoveryCodes: Schema.Array(Schema.String) }),
        )(finished.clone());
        expect(recoveryCodes).toHaveLength(10);
        const setCookie = finished.headers.getSetCookie().join("\n");
        expect(setCookie).toContain(`${COOKIE}=`);
        expect(setCookie).toMatch(/; HttpOnly/u);
        expect(setCookie).toMatch(/; Secure/u);
        expect(setCookie).toMatch(/; SameSite=Lax/u);
        const first = sessionCookieOf(finished);

        const me = yield* call("/control/api/me", { headers: { cookie: first } });
        expect(yield* read(ControlMe)(me)).toEqual({
          id: person.id,
          email: "ada@acme.test",
          displayName: "Ada",
          role: "owner",
        });
        expect((yield* call("/control/api/me")).status).toBe(401);

        yield* TestClock.adjust("30 seconds");
        const { ticket } = yield* read(Schema.Struct({ ticket: Schema.String }))(
          yield* call(
            "/control/api/sign-in",
            send("POST", { email: "ada@acme.test", password: PASSWORD }),
          ),
        );
        const signedIn = yield* call(
          "/control/api/sign-in/code",
          send("POST", { ticket, code: yield* codeNow(secret) }),
        );
        const second = sessionCookieOf(signedIn);
        const sessions = yield* read(Schema.Array(ControlSessionEntry))(
          yield* call("/control/api/me/sessions", { headers: { cookie: second } }),
        );
        expect(sessions.map((session) => session.current).toSorted()).toEqual([false, true]);

        const signedOut = yield* call(
          "/control/api/me/sign-out-everywhere",
          send("POST", {}, { cookie: first }),
        );
        expect(signedOut.status).toBe(200);
        expect(sessionCookieOf(signedOut)).toBe(`${COOKIE}=`);
        expect((yield* call("/control/api/me", { headers: { cookie: second } })).status).toBe(401);
      }),
    ),
  );

  it.effect("refuses changes that come from another site", () =>
    withApi(({ call }) =>
      Effect.gen(function* () {
        const credentials = { email: "ada@acme.test", password: PASSWORD };
        const fromElsewhere = yield* call(
          "/control/api/sign-in",
          send("POST", credentials, { headers: { origin: "https://evil.example" } }),
        );
        expect(fromElsewhere.status).toBe(403);
        const crossSite = yield* call(
          "/control/api/sign-in",
          send("POST", credentials, { headers: { "sec-fetch-site": "cross-site" } }),
        );
        expect(crossSite.status).toBe(403);
        expect((yield* call("/control/api/sign-in", send("POST", credentials))).status).toBe(401);
      }),
    ),
  );

  it.effect("lets only owners and admins install licences and manage people", () =>
    withApi(({ call, signLicence }) =>
      Effect.gen(function* () {
        const owner = yield* signedInOwner;
        const licence = yield* signLicence(testClaims({ seats: 5 }));
        const installed = yield* call(
          "/control/api/admin/licence",
          send("PUT", { token: licence }, { cookie: owner.cookie }),
        );
        expect(yield* read(ControlLicenceOverview)(installed)).toMatchObject({
          licence: { _tag: "installed", seats: 5, seatsUsed: 1 },
        });
        const [header, , signature] = licence.split(".");
        const altered = `${header}.${Buffer.from(JSON.stringify(testClaims({ seats: 500 }))).toString("base64url")}.${signature}`;
        const refused = yield* call(
          "/control/api/admin/licence",
          send("PUT", { token: altered }, { cookie: owner.cookie }),
        );
        expect(refused.status).toBe(400);
        expect(yield* read(Schema.Struct({ problem: Schema.String }))(refused)).toEqual({
          problem: "invalid-signature",
        });

        const invited = yield* read(ControlIssuedLink)(
          yield* call(
            "/control/api/admin/people",
            send(
              "POST",
              { email: "bea@acme.test", displayName: "Bea", role: "member" },
              { cookie: owner.cookie },
            ),
          ),
        );
        expect(invited.link).toMatch(
          new RegExp(`^${TEST_PUBLIC_URL}/admin/enrol#[A-Za-z0-9_-]{43}$`, "u"),
        );
        const accounts = yield* Accounts;
        const beaToken = invited.link.split("#")[1] ?? "";
        const enrolment = yield* accounts.startEnrolment(beaToken);
        yield* accounts.finishEnrolment({
          token: beaToken,
          password: PASSWORD,
          code: yield* codeNow(fromBase32(enrolment.authenticator?.secret ?? "")),
        });
        const bea = yield* (yield* Sessions).create({
          personId: invited.person.id,
          userAgent: null,
        });

        expect(
          (yield* call("/control/api/admin/people", {
            headers: { cookie: `${COOKIE}=${bea.token}` },
          })).status,
        ).toBe(403);
        const people = yield* read(Schema.Array(ControlPerson))(
          yield* call("/control/api/admin/people", { headers: { cookie: owner.cookie } }),
        );
        expect(people.map((person) => person.email).toSorted()).toEqual([
          "ada@acme.test",
          "bea@acme.test",
        ]);
      }),
    ),
  );
});
