import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ControlSsoSettings } from "@codenine/contracts/control";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { Accounts } from "../accounts/Accounts.ts";
import * as Administration from "../admin/Administration.ts";
import { ON_THE_SERVER } from "../audit/AuditLog.ts";
import { Departments } from "../departments/Departments.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { codeNow, fromBase32 } from "../testing/authenticator.ts";
import {
  SAML_IDP_CERTIFICATE,
  samlResponse,
  TEST_OIDC_ISSUER,
  TEST_SAML_ISSUER,
  testOidcProvider,
} from "../testing/identityProviders.ts";
import { layerTestServices, TEST_PUBLIC_URL } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import { type WorkspaceKey, WorkspaceManager } from "../workspaces/WorkspaceManager.ts";
import * as WorkspaceRetention from "../workspaces/WorkspaceRetention.ts";
import * as SingleSignOn from "./SingleSignOn.ts";
import { ssoAddresses } from "./SsoConnections.ts";

const provider = testOidcProvider();
const owner = Administration.operatorActor("test");

const withSingleSignOn = <A, E, R>(
  body: (context: { readonly retired: ReadonlyArray<WorkspaceKey> }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const retired: Array<WorkspaceKey> = [];
    const manager = WorkspaceManager.of({
      ...WorkspaceManager.none,
      retire: Effect.fn("test.retire")((key: WorkspaceKey) =>
        Effect.sync(() => retired.push(key) > 0),
      ),
    });
    return yield* Effect.gen(function* () {
      yield* (yield* LicenceService).install(
        yield* signTestLicence(testClaims({ seats: 10 }), keys.privateKey),
      );
      return yield* body({ retired });
    }).pipe(
      Effect.provide(
        SingleSignOn.layer.pipe(
          Layer.provideMerge(Administration.layer),
          Layer.provideMerge(WorkspaceRetention.layer),
          Layer.provideMerge(layerTestServices(keys.publicKey)),
          Layer.provideMerge(Layer.succeed(WorkspaceManager, manager)),
          Layer.provideMerge(Layer.succeed(SingleSignOn.SsoFetch, provider.fetch)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const settings = (more: Partial<ControlSsoSettings>): ControlSsoSettings => ({
  name: "Acme",
  domains: ["acme.test"],
  required: false,
  createPeople: true,
  groupsClaim: "groups",
  roleGroups: [],
  ...more,
});

const OIDC = { issuer: TEST_OIDC_ISSUER, clientId: "codenine", clientSecret: "secret" };

/** Someone who set up a password and an authenticator from a link. */
const withPassword = Effect.fn("test.withPassword")(function* (email: string, owner: boolean) {
  const accounts = yield* Accounts;
  const { token, person } = owner
    ? yield* accounts.inviteOwner({ email, displayName: email })
    : yield* accounts.invite({ email, displayName: email, role: "member" });
  const enrolment = yield* accounts.startEnrolment(token);
  yield* accounts.finishEnrolment({
    token,
    password: "a long enough test password",
    code: yield* codeNow(fromBase32(enrolment.authenticator?.secret ?? "")),
  });
  return person;
});

const reasonOf = <A, R>(effect: Effect.Effect<A, SingleSignOn.SsoSignInError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

describe("SingleSignOn", () => {
  it.effect("signs people in through OIDC, from its domains only, with their groups", () =>
    withSingleSignOn(({ retired }) =>
      Effect.gen(function* () {
        const sso = yield* SingleSignOn.SingleSignOn;
        const admin = yield* Administration.Administration;
        const accounts = yield* Accounts;
        const design = yield* (yield* Departments).create("Design");
        const connection = yield* admin.createSsoConnection(
          owner,
          "oidc",
          settings({ oidc: OIDC, roleGroups: [{ group: "codenine-admins", role: "admin" }] }),
        );
        const signIn = Effect.fn("test.signIn")(function* (
          claims: Readonly<Record<string, unknown>>,
          options: { readonly otherBrowser?: boolean } = {},
        ) {
          const started = yield* sso.start(connection.id, "/admin/desktop-code?state=s");
          const sent = new URL(started.location);
          expect(sent.searchParams.get("code_challenge_method")).toBe("S256");
          expect(sent.searchParams.get("redirect_uri")).toBe(connection.redirectUrl);
          provider.answerWith({
            aud: "codenine",
            nonce: sent.searchParams.get("nonce"),
            ...claims,
          });
          const back = new URL(connection.redirectUrl);
          back.searchParams.set("code", "code");
          back.searchParams.set("state", sent.searchParams.get("state") ?? "");
          const binding = options.otherBrowser === true ? "another browser" : started.binding;
          return {
            back,
            binding,
            result: sso.oidcCallback(connection.id, back, binding, ON_THE_SERVER),
          };
        });
        const kai = { sub: "kai", email: "kai@acme.test", name: "Kai" };

        // Kai is new: added as he signs in, an admin through his group, in Design.
        const first = yield* signIn({ ...kai, groups: ["Design", "codenine-admins"] });
        const { personId, next } = yield* first.result;
        expect(next).toBe("/admin/desktop-code?state=s");
        expect(yield* accounts.findPerson(personId)).toMatchObject({
          email: "kai@acme.test",
          role: "admin",
          status: "active",
        });
        expect(yield* (yield* Departments).ofPerson(personId)).toEqual([design.id]);
        // Its answer works once.
        expect(
          yield* reasonOf(
            sso.oidcCallback(connection.id, first.back, first.binding, ON_THE_SERVER),
          ),
        ).toBe("failed");

        // His groups change, and so do his department and role; a new email follows him.
        const moved = yield* signIn({ ...kai, email: "kai.n@acme.test", groups: [] });
        expect((yield* moved.result).personId).toBe(personId);
        expect(yield* accounts.findPerson(personId)).toMatchObject({
          email: "kai.n@acme.test",
          role: "member",
        });
        expect(retired).toEqual([{ personId, departmentId: design.id }]);

        // Nobody finishes it in another browser, and no address outside its domains gets in.
        expect(yield* reasonOf((yield* signIn(kai, { otherBrowser: true })).result)).toBe("failed");
        expect(
          yield* reasonOf((yield* signIn({ sub: "eve", email: "eve@elsewhere.test" })).result),
        ).toBe("not-in-domain");

        yield* admin.deactivate(owner, personId);
        expect(yield* reasonOf((yield* signIn(kai)).result)).toBe("deactivated");
      }),
    ),
  );

  it.effect("accepts only signed SAML assertions that answer this browser's own request", () =>
    withSingleSignOn(() =>
      Effect.gen(function* () {
        const sso = yield* SingleSignOn.SingleSignOn;
        const admin = yield* Administration.Administration;
        const connection = yield* admin.createSsoConnection(
          owner,
          "saml",
          settings({
            saml: {
              entryPoint: "https://idp.acme.test/saml/sign-in",
              issuer: TEST_SAML_ISSUER,
              certificate: SAML_IDP_CERTIFICATE,
            },
          }),
        );
        const addresses = ssoAddresses(TEST_PUBLIC_URL, connection.id, "saml");
        const start = Effect.gen(function* () {
          const started = yield* sso.start(connection.id, "/");
          const requestId = new URL(started.location).searchParams.get("RelayState") ?? "";
          return { ...started, requestId };
        });
        const response = (
          answering: string,
          change: (xml: string) => string = (xml) => xml,
          signed = true,
        ) =>
          Buffer.from(
            change(
              samlResponse({
                inResponseTo: `_${answering}`,
                acs: addresses.redirectUrl,
                audience: addresses.serviceEntityId ?? "",
                nameId: "sam-1",
                email: "sam@acme.test",
                groups: [],
                signed,
              }),
            ),
          ).toString("base64");
        const post = (requestId: string, samlResponse: string) =>
          sso.samlResponse(connection.id, { samlResponse, relayState: requestId }, ON_THE_SERVER);

        const metadata = yield* sso.samlMetadata(connection.id);
        expect(metadata).toContain(`entityID="${addresses.serviceEntityId}"`);
        expect(metadata).toContain(`Location="${addresses.redirectUrl}"`);

        const first = yield* start;
        expect(
          yield* reasonOf(
            post(
              first.requestId,
              response(first.requestId, (xml) => xml.replace("sam@", "eve@")),
            ),
          ),
        ).toBe("failed");
        expect(
          yield* reasonOf(
            post(
              first.requestId,
              response(first.requestId, (xml) => xml, false),
            ),
          ),
        ).toBe("failed");
        const other = yield* start;
        expect(yield* reasonOf(post(first.requestId, response(other.requestId)))).toBe("failed");

        const answered = yield* post(first.requestId, response(first.requestId));
        expect(yield* reasonOf(sso.finish(answered, "another browser"))).toBe("failed");
        const again = yield* start;
        const signedIn = yield* sso.finish(
          yield* post(again.requestId, response(again.requestId)),
          again.binding,
        );
        expect((yield* (yield* Accounts).findPerson(signedIn.personId)).email).toBe(
          "sam@acme.test",
        );
      }),
    ),
  );

  it.effect("requires single sign-on for its domains, apart from emergency owners", () =>
    withSingleSignOn(() =>
      Effect.gen(function* () {
        const admin = yield* Administration.Administration;
        const accounts = yield* Accounts;
        const olu = yield* withPassword("olu@acme.test", true);
        const kai = yield* withPassword("kai@acme.test", false);
        const required = settings({ oidc: OIDC, required: true });

        // Requiring it would leave no owner able to sign in if the provider failed.
        expect(
          yield* Effect.flip(admin.createSsoConnection(owner, "oidc", required)),
        ).toMatchObject({
          reason: "no-emergency-owner",
        });
        expect(
          yield* Effect.flip(admin.setEmergency(owner, { personId: kai.id, emergency: true })),
        ).toMatchObject({ reason: "not-owner" });
        yield* admin.setEmergency(owner, { personId: olu.id, emergency: true });
        yield* admin.createSsoConnection(owner, "oidc", required);

        const password = { password: "a long enough test password" };
        expect(
          yield* Effect.flip(accounts.signIn({ email: "kai@acme.test", ...password })),
        ).toMatchObject({
          reason: "single-sign-on",
        });
        expect(
          (yield* accounts.signIn({ email: "olu@acme.test", ...password })).ticket,
        ).toBeTruthy();
        expect(
          yield* Effect.flip(admin.setEmergency(owner, { personId: olu.id, emergency: false })),
        ).toMatchObject({ reason: "no-emergency-owner" });
      }),
    ),
  );
});
