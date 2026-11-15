// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer listens on a Node http.Server.
import * as NodeHttp from "node:http";

import {
  ControlApi,
  ControlPrincipal,
  ControlSessionAuth,
  ControlSignedOutError,
  ControlUnavailableError,
} from "@codenine/contracts/control";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { sql } from "drizzle-orm";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as IpNetwork from "effect/net/IpNetwork";

import { Accounts, type IssuedLink } from "../accounts/Accounts.ts";
import { type SignInMethod, Sessions } from "../accounts/Sessions.ts";
import { Administration, personActor } from "../admin/Administration.ts";
import type { RequestSource } from "../audit/AuditLog.ts";
import { ControlPublicUrl, enrolmentLink } from "../config.ts";
import { ControlDb } from "../db.ts";
import { LicenceService, workspaceAccess } from "../licence/LicenceService.ts";
import {
  WorkspaceManager,
  type WorkspaceUnavailableError,
} from "../workspaces/WorkspaceManager.ts";
import { SsoConnections } from "../sso/SsoConnections.ts";
import { Workplace } from "../workspaces/Workplace.ts";
import { BudgetRequests } from "../gateway/BudgetRequests.ts";

const ok = { ok: true as const };

/** `__Host-` makes browsers refuse the cookie unless it is Secure, host-only and on `/`. */
export const sessionCookieName = (secure: boolean) =>
  secure ? "__Host-codenine_control_session" : "codenine_control_session";

const appendCookies = (cookies: Cookies.Cookies) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
  );

const setSessionCookie = (secure: boolean, token: string, expiresAt: string) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, sessionCookieName(secure), token, {
      expires: DateTime.toDate(DateTime.makeUnsafe(expiresAt)),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    }),
  ).pipe(Effect.orDie, Effect.flatMap(appendCookies));

const clearSessionCookie = (secure: boolean) =>
  Effect.fromResult(
    Cookies.expireCookie(Cookies.empty, sessionCookieName(secure), {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
    }),
  ).pipe(Effect.orDie, Effect.flatMap(appendCookies));

export const layerSessionAuth = Layer.effect(
  ControlSessionAuth,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const { secure } = yield* ControlPublicUrl;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = request.cookies[sessionCookieName(secure)];
        const session = token === undefined ? Option.none() : yield* sessions.authenticate(token);
        if (Option.isNone(session)) {
          return yield* new ControlSignedOutError({});
        }
        return yield* httpEffect.pipe(Effect.provideService(ControlPrincipal, session.value));
      });
  }),
);

const SAML_RESPONSE_PATH = /^\/control\/sso\/[^/?]+\/saml\/acs(?:\?|$)/u;

/** Starts a session for someone who just proved who they are, and sets its cookie. */
export const makeStartSession = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const { secure } = yield* ControlPublicUrl;
  return Effect.fn("ControlHttp.startSession")(function* (personId: string, method: SignInMethod) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { token, session } = yield* sessions.create({
      personId,
      source: requestSource(request),
      method,
    });
    yield* setSessionCookie(secure, token, session.expiresAt);
    const signedIn = yield* sessions.authenticate(token);
    if (Option.isNone(signedIn)) {
      return yield* Effect.die("A session made a moment ago did not authenticate.");
    }
    return signedIn.value.person;
  });
});

/**
 * Refuses requests that change something and come from another site. The
 * session cookie is SameSite=Lax as well; this also covers sign-in itself.
 */
export const layerCrossSiteGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const { origin } = yield* ControlPublicUrl;
    return Effect.fnUntraced(function* <E, R>(
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        E,
        HttpServerRequest.HttpServerRequest | R
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const changes = request.method !== "GET" && request.method !== "HEAD";
      const requestOrigin = request.headers["origin"];
      if (
        changes &&
        request.url.startsWith("/control/") &&
        // The identity provider posts SAML responses from its own site, as SAML has it.
        !SAML_RESPONSE_PATH.test(request.url) &&
        ((requestOrigin !== undefined && requestOrigin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site")
      ) {
        return HttpServerResponse.text("Requests from other sites are refused.", { status: 403 });
      }
      return yield* httpEffect;
    });
  }),
  { global: true },
);

/**
 * Takes the client's address from `X-Forwarded-For` only when the request
 * comes from a reverse proxy in `CODENINE_CONTROL_TRUSTED_PROXIES`, by default
 * one on the same machine, so the audit log records where people really are.
 */
export const layerTrustedProxies = HttpRouter.middleware(
  Effect.gen(function* () {
    const listed = yield* Config.String("CODENINE_CONTROL_TRUSTED_PROXIES").pipe(
      Config.withDefault("127.0.0.0/8, ::1/128"),
    );
    const networks: Array<IpNetwork.IpNetwork> = [];
    for (const entry of listed.split(",").map((part) => part.trim())) {
      if (entry === "") continue;
      const network = IpNetwork.fromString(entry);
      if (Result.isFailure(network)) {
        return yield* Effect.die(
          `CODENINE_CONTROL_TRUSTED_PROXIES lists ${entry}, which is not a network such as 10.0.0.0/8.`,
        );
      }
      networks.push(network.success);
    }
    return HttpMiddleware.xForwardedHeaders({ trustedProxies: networks });
  }),
  { global: true },
);

export const requestSource = (request: HttpServerRequest.HttpServerRequest): RequestSource => ({
  address: Option.getOrNull(request.remoteAddress),
  userAgent: request.headers["user-agent"] ?? null,
});

export const layerHealthApi = HttpApiBuilder.group(
  ControlApi,
  "health",
  Effect.fnUntraced(function* (handlers) {
    const db = yield* ControlDb;
    return handlers.handle(
      "health",
      Effect.fn("ControlHttp.health")(
        function* () {
          yield* db.execute(sql`select 1`);
          return { ok: true as const, service: "control" as const };
        },
        Effect.catch(() => new ControlUnavailableError({ reason: "database-unavailable" })),
      ),
    );
  }),
);

export const layerAccountApi = HttpApiBuilder.group(
  ControlApi,
  "account",
  Effect.fnUntraced(function* (handlers) {
    const accounts = yield* Accounts;
    const ssoConnections = yield* SsoConnections;
    const startSession = yield* makeStartSession;

    return handlers
      .handle("ssoChoices", () => ssoConnections.choices)
      .handle("signIn", ({ payload }) => accounts.signIn(payload))
      .handle(
        "completeSignIn",
        Effect.fn("ControlHttp.completeSignIn")(function* ({ payload }) {
          const { personId } = yield* accounts.completeSignIn(payload);
          return yield* startSession(personId, "password");
        }),
      )
      .handle(
        "desktopSignIn",
        Effect.fn("ControlHttp.desktopSignIn")(function* ({ payload }) {
          const { personId } = yield* accounts.redeemDesktopCode(payload.code);
          return yield* startSession(personId, "desktop-code");
        }),
      )
      .handle("requestPasswordReset", ({ payload }) =>
        Effect.as(accounts.requestPasswordReset(payload.email), ok),
      )
      .handle("startEnrolment", ({ payload }) => accounts.startEnrolment(payload.token))
      .handle(
        "finishEnrolment",
        Effect.fn("ControlHttp.finishEnrolment")(function* ({ payload }) {
          const { personId, recoveryCodes } = yield* accounts.finishEnrolment(payload);
          return { me: yield* startSession(personId, "set-up-link"), recoveryCodes };
        }),
      );
  }),
);

export const layerMeApi = HttpApiBuilder.group(
  ControlApi,
  "me",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions;
    const accounts = yield* Accounts;
    const licence = yield* LicenceService;
    const workspaces = yield* WorkspaceManager;
    const workplace = yield* Workplace;
    const admin = yield* Administration;
    const budgetRequests = yield* BudgetRequests;
    const { secure } = yield* ControlPublicUrl;
    const here = Effect.map(ControlPrincipal, ({ sessionId, person, departmentId, viewing }) => ({
      sessionId,
      personId: person.id,
      departmentId,
      viewing,
    }));
    const workspaceUnavailable = (error: WorkspaceUnavailableError) =>
      Effect.logError("A workspace could not be reached or started.", error).pipe(
        Effect.andThen(
          Effect.fail(new ControlUnavailableError({ reason: "workspace-unavailable" })),
        ),
      );
    return handlers
      .handle("me", () => ControlPrincipal.pipe(Effect.map((principal) => principal.person)))
      .handle("access", () =>
        licence.overview.pipe(Effect.map(({ licence: applied }) => workspaceAccess(applied))),
      )
      .handle(
        "workspace",
        Effect.fn("ControlHttp.workspace")(function* () {
          const key = yield* workplace.keyFor(yield* here);
          const asleep = yield* workspaces
            .isAsleep(key)
            .pipe(Effect.catchTags({ WorkspaceUnavailableError: workspaceUnavailable }));
          return { asleep };
        }),
      )
      .handle("departments", () => Effect.flatMap(here, workplace.departmentsOf))
      .handle("budget", () =>
        here.pipe(
          Effect.flatMap((session) => workplace.keyFor({ ...session, viewing: null })),
          Effect.flatMap(budgetRequests.mine),
        ),
      )
      .handle("askForBudget", ({ payload }) =>
        here.pipe(
          Effect.flatMap((session) => workplace.keyFor({ ...session, viewing: null })),
          Effect.flatMap((key) => budgetRequests.ask(key, payload)),
        ),
      )
      .handle(
        "leaveWorkspace",
        Effect.fn("ControlHttp.leaveWorkspace")(function* () {
          const session = yield* here;
          yield* admin.closeWorkspace(
            personActor(
              (yield* ControlPrincipal).person,
              requestSource(yield* HttpServerRequest.HttpServerRequest),
            ),
            session.sessionId,
          );
          return yield* workplace.departmentsOf({ ...session, viewing: null });
        }),
      )
      .handle("chooseDepartment", ({ payload }) =>
        Effect.flatMap(here, (session) => workplace.choose(session, payload.departmentId)),
      )
      .handle(
        "createDesktopCode",
        Effect.fn("ControlHttp.createDesktopCode")(function* () {
          const { person } = yield* ControlPrincipal;
          return yield* accounts.issueDesktopCode(person.id);
        }),
      )
      .handle(
        "wakeWorkspace",
        Effect.fn("ControlHttp.wakeWorkspace")(function* () {
          const key = yield* workplace.keyFor(yield* here);
          // Where it answered before it slept is out of date.
          yield* workspaces.forget(key);
          yield* workspaces
            .targetFor(key)
            .pipe(Effect.catchTags({ WorkspaceUnavailableError: workspaceUnavailable }));
          return ok;
        }),
      )
      .handle(
        "signOut",
        Effect.fn("ControlHttp.signOut")(function* () {
          const { sessionId, person } = yield* ControlPrincipal;
          yield* sessions.revoke({ personId: person.id, sessionId });
          yield* clearSessionCookie(secure);
          return ok;
        }),
      )
      .handle(
        "sessions",
        Effect.fn("ControlHttp.sessions")(function* () {
          const { sessionId, person } = yield* ControlPrincipal;
          const list = yield* sessions.list(person.id);
          return list.map((session) => ({ ...session, current: session.id === sessionId }));
        }),
      )
      .handle(
        "revokeSession",
        Effect.fn("ControlHttp.revokeSession")(function* ({ params }) {
          const { person } = yield* ControlPrincipal;
          yield* sessions.revoke({ personId: person.id, sessionId: params.sessionId });
          return ok;
        }),
      )
      .handle(
        "signOutEverywhere",
        Effect.fn("ControlHttp.signOutEverywhere")(function* () {
          const { person } = yield* ControlPrincipal;
          yield* sessions.revokeAll(person.id);
          yield* clearSessionCookie(secure);
          return ok;
        }),
      )
      .handle("signInMethods", () =>
        ControlPrincipal.pipe(Effect.flatMap(({ person }) => accounts.signInMethods(person.id))),
      )
      .handle("startPasskey", () =>
        ControlPrincipal.pipe(Effect.flatMap(({ person }) => accounts.startPasskey(person.id))),
      )
      .handle("addPasskey", ({ payload }) =>
        ControlPrincipal.pipe(
          Effect.flatMap(({ person }) => accounts.addPasskey({ personId: person.id, ...payload })),
        ),
      )
      .handle("removePasskey", ({ params }) =>
        ControlPrincipal.pipe(
          Effect.flatMap(({ person }) =>
            accounts.removePasskey({ personId: person.id, passkeyId: params.passkeyId }),
          ),
          Effect.as(ok),
        ),
      );
  }),
);

export const layerAdminApi = HttpApiBuilder.group(
  ControlApi,
  "admin",
  Effect.fnUntraced(function* (handlers) {
    const admin = yield* Administration;
    const workplace = yield* Workplace;
    const { origin } = yield* ControlPublicUrl;
    const actor = Effect.gen(function* () {
      const { person } = yield* ControlPrincipal;
      return personActor(person, requestSource(yield* HttpServerRequest.HttpServerRequest));
    });
    const withLink = <E, R>(issued: Effect.Effect<IssuedLink, E, R>) =>
      Effect.map(issued, ({ person, token, emailed }) => ({
        person,
        link: enrolmentLink(origin, token),
        emailed,
      }));

    return handlers
      .handle("licence", () => Effect.flatMap(actor, admin.licence))
      .handle("installLicence", ({ payload }) =>
        Effect.flatMap(actor, (by) => admin.installLicence(by, payload.token)).pipe(
          Effect.map(({ overview }) => overview),
        ),
      )
      .handle("people", () => Effect.flatMap(actor, admin.people))
      .handle("invite", ({ payload }) =>
        withLink(Effect.flatMap(actor, (by) => admin.invite(by, payload))),
      )
      .handle("setRole", ({ params, payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.setRole(by, { personId: params.personId, role: payload.role }),
        ),
      )
      .handle("deactivate", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.deactivate(by, params.personId)).pipe(Effect.as(ok)),
      )
      .handle("reactivate", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.reactivate(by, params.personId)),
      )
      .handle("reset", ({ params }) =>
        withLink(Effect.flatMap(actor, (by) => admin.issueReset(by, params.personId))),
      )
      .handle("unlock", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.unlock(by, params.personId)).pipe(Effect.as(ok)),
      )
      .handle("departments", () => Effect.flatMap(actor, admin.departments))
      .handle("createDepartment", ({ payload }) =>
        Effect.flatMap(actor, (by) => admin.createDepartment(by, payload.name, payload.template)),
      )
      .handle("renameDepartment", ({ params, payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.renameDepartment(by, params.departmentId, payload.name),
        ),
      )
      .handle("deleteDepartment", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.deleteDepartment(by, params.departmentId)).pipe(
          Effect.as(ok),
        ),
      )
      .handle("addDepartmentMember", ({ params }) =>
        Effect.flatMap(actor, (by) =>
          admin.addDepartmentMember(by, params.departmentId, params.personId),
        ),
      )
      .handle("removeDepartmentMember", ({ params }) =>
        Effect.flatMap(actor, (by) =>
          admin.removeDepartmentMember(by, params.departmentId, params.personId),
        ),
      )
      .handle("createTeam", ({ params, payload }) =>
        Effect.flatMap(actor, (by) => admin.createTeam(by, params.departmentId, payload.name)),
      )
      .handle("renameTeam", ({ params, payload }) =>
        Effect.flatMap(actor, (by) => admin.renameTeam(by, params.teamId, payload.name)),
      )
      .handle("deleteTeam", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.deleteTeam(by, params.teamId)),
      )
      .handle("addTeamMember", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.addTeamMember(by, params.teamId, params.personId)),
      )
      .handle("removeTeamMember", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.removeTeamMember(by, params.teamId, params.personId)),
      )
      .handle("profiles", () => Effect.flatMap(actor, admin.profiles))
      .handle("previewProfile", ({ params, payload }) =>
        Effect.flatMap(actor, (by) => admin.previewProfile(by, params.profileId, payload.settings)),
      )
      .handle("saveProfile", ({ params, payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.saveProfile(by, {
            profileId: params.profileId,
            settings: payload.settings,
            note: payload.note,
            testWith: payload.testWith ?? null,
          }),
        ),
      )
      .handle("publishTest", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.publishTest(by, params.profileId)),
      )
      .handle("discardTest", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.discardTest(by, params.profileId)),
      )
      .handle("rollBackProfile", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.rollBackProfile(by, params.profileId)),
      )
      .handle("personProfile", ({ params, query }) =>
        Effect.flatMap(actor, (by) =>
          admin.personProfile(by, params.personId, query.department ?? null),
        ),
      )
      .handle("exceptions", () => Effect.flatMap(actor, admin.exceptions))
      .handle("addException", ({ payload }) =>
        Effect.flatMap(actor, (by) => admin.addException(by, payload)),
      )
      .handle("endException", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.endException(by, params.exceptionId)).pipe(
          Effect.as(ok),
        ),
      )
      .handle(
        "openWorkspace",
        Effect.fn("ControlHttp.openWorkspace")(function* ({ params, payload }) {
          const principal = yield* ControlPrincipal;
          const viewing = yield* admin.openWorkspace(yield* actor, {
            sessionId: principal.sessionId,
            personId: params.personId,
            departmentId: payload.departmentId,
            reason: payload.reason,
          });
          return yield* workplace.departmentsOf({
            sessionId: principal.sessionId,
            personId: principal.person.id,
            departmentId: principal.departmentId,
            viewing,
          });
        }),
      )
      .handle("personSessions", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.personSessions(by, params.personId)),
      )
      .handle("signOutPerson", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.signOutPerson(by, params.personId)).pipe(Effect.as(ok)),
      )
      .handle("ssoConnections", () => Effect.flatMap(actor, admin.ssoConnections))
      .handle("createSsoConnection", ({ payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.createSsoConnection(by, payload.protocol, payload.settings),
        ),
      )
      .handle("updateSsoConnection", ({ params, payload }) =>
        Effect.flatMap(actor, (by) => admin.updateSsoConnection(by, params.connectionId, payload)),
      )
      .handle("deleteSsoConnection", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.deleteSsoConnection(by, params.connectionId)).pipe(
          Effect.as(ok),
        ),
      )
      .handle("aiAccounts", () => Effect.flatMap(actor, admin.aiAccounts))
      .handle("budgetRequests", () => Effect.flatMap(actor, admin.budgetRequests))
      .handle("decideBudgetRequest", ({ params, payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.decideBudgetRequest(by, params.requestId, payload.approve),
        ),
      )
      .handle("createAiAccount", ({ payload }) =>
        Effect.flatMap(actor, (by) => admin.createAiAccount(by, payload)),
      )
      .handle("updateAiAccount", ({ params, payload }) =>
        Effect.flatMap(actor, (by) => admin.updateAiAccount(by, params.accountId, payload)),
      )
      .handle("deleteAiAccount", ({ params }) =>
        Effect.flatMap(actor, (by) => admin.deleteAiAccount(by, params.accountId)).pipe(
          Effect.as(ok),
        ),
      )
      .handle("setEmergency", ({ params, payload }) =>
        Effect.flatMap(actor, (by) =>
          admin.setEmergency(by, { personId: params.personId, emergency: payload.emergency }),
        ),
      )
      .handle("provisioning", () => Effect.flatMap(actor, admin.provisioning))
      .handle("createProvisioningToken", () => Effect.flatMap(actor, admin.createProvisioningToken))
      .handle("revokeProvisioningToken", () => Effect.flatMap(actor, admin.revokeProvisioningToken))
      .handle("audit", ({ query }) =>
        Effect.flatMap(actor, (by) => admin.audit(by, query.before ?? null)),
      );
  }),
);

export const layerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(ControlApi).pipe(
    Layer.provide([layerHealthApi, layerAccountApi, layerMeApi, layerAdminApi]),
    Layer.provide(layerSessionAuth),
  ),
  layerCrossSiteGuard,
  layerTrustedProxies,
);

/**
 * Serves the built web app from `CODENINE_CONTROL_WEB_DIR`, falling back to
 * `index.html` for app routes. Managed workspaces do not serve it.
 */
export const layerWebApp = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* Config.option(Config.String("CODENINE_CONTROL_WEB_DIR"));
    return Option.isNone(root)
      ? Layer.empty
      : HttpStaticServer.layer({ root: root.value, spa: true });
  }),
);

export const layerServer = <E, R>(
  options: { readonly host: string; readonly port: number },
  moreRoutes: Layer.Layer<never, E, R>,
) =>
  HttpRouter.serve(Layer.mergeAll(layerRoutes, moreRoutes)).pipe(
    Layer.provide(
      // Compress forwarded WebSocket frames as the workspace server does.
      NodeHttpServer.layer(NodeHttp.createServer, {
        ...options,
        websocket: { perMessageDeflate: true },
      }),
    ),
  );
