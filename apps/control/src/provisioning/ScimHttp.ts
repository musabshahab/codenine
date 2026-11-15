import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { provisioningActor, SCIM_PATH } from "../admin/Administration.ts";
import { ControlPublicUrl } from "../config.ts";
import { requestSource } from "../http/ControlHttp.ts";
import { Directory } from "./Directory.ts";
import { ProvisioningTokens } from "./ProvisioningTokens.ts";
import * as Scim from "./scim.ts";

const respond = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, contentType: Scim.SCIM_CONTENT_TYPE });

const USER_FILTERS = ["id", "username", "externalid", "emails", "emails.value"];
const GROUP_FILTERS = ["id", "displayname", "externalid"];

/**
 * SCIM 2.0 under `/control/scim/v2`, for Microsoft Entra ID, Okta and others.
 * Every route needs the provisioning token; changes go through the same
 * audited administration as the admin pages.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const tokens = yield* ProvisioningTokens;
    const directory = yield* Directory;
    const base = `${(yield* ControlPublicUrl).origin}${SCIM_PATH}`;

    /** Checks the token, then answers; whatever is refused goes back as a SCIM error. */
    const scim = Effect.fn("ScimHttp.scim")(
      function* <R>(
        handle: (
          request: HttpServerRequest.HttpServerRequest,
        ) => Effect.Effect<unknown, Scim.ScimError, R>,
        status = 200,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = /^Bearer\s+(\S+)$/iu.exec(request.headers["authorization"] ?? "")?.[1];
        if (token === undefined || !(yield* tokens.authenticate(token))) {
          return yield* new Scim.ScimError({
            status: 401,
            detail: "Send the provisioning token as a Bearer token.",
          });
        }
        const body = yield* handle(request);
        return body === null ? HttpServerResponse.empty({ status: 204 }) : respond(body, status);
      },
      Effect.catchTags({
        ScimError: (error) => Effect.succeed(respond(Scim.errorBody(error), error.status)),
      }),
    );

    const query = (request: HttpServerRequest.HttpServerRequest) =>
      Object.fromEntries(new URL(request.url, "http://control").searchParams);
    const idOf = HttpRouter.params.pipe(Effect.map((params) => params["id"] ?? ""));
    const bodyOf = (request: HttpServerRequest.HttpServerRequest) =>
      request.json.pipe(
        Effect.mapError(
          () =>
            new Scim.ScimError({ status: 400, scimType: "invalidSyntax", detail: "Send JSON." }),
        ),
      );
    const actorOf = (request: HttpServerRequest.HttpServerRequest) =>
      provisioningActor(requestSource(request));
    const page = Effect.fn("ScimHttp.page")(function* (
      request: HttpServerRequest.HttpServerRequest,
      supported: ReadonlyArray<string>,
    ) {
      const params = query(request);
      const filter = yield* Effect.fromResult(Scim.parseFilter(params["filter"], supported));
      return { filter, ...Scim.pageOf(params), membersLeftOut: leavesOutMembers(params) };
    });
    const leavesOutMembers = (params: Readonly<Record<string, string>>) =>
      (params["excludedAttributes"] ?? "")
        .split(",")
        .some((name) => name.trim().toLowerCase() === "members");

    yield* router.add(
      "GET",
      `${SCIM_PATH}/ServiceProviderConfig`,
      scim(() => Effect.succeed(Scim.serviceProviderConfig(base))),
    );
    yield* router.add(
      "GET",
      `${SCIM_PATH}/ResourceTypes`,
      scim(() => {
        const types = Scim.resourceTypes(base);
        return Effect.succeed(Scim.listResponse(types, types.length, 1));
      }),
    );
    yield* router.add(
      "GET",
      `${SCIM_PATH}/Schemas`,
      scim(() =>
        Effect.succeed(Scim.listResponse(Scim.schemaDefinitions, Scim.schemaDefinitions.length, 1)),
      ),
    );

    yield* router.add(
      "GET",
      `${SCIM_PATH}/Users`,
      scim((request) =>
        Effect.gen(function* () {
          const asked = yield* page(request, USER_FILTERS);
          const { total, users } = yield* directory.users(asked);
          return Scim.listResponse(
            users.map((user) => Scim.userResource(user, base)),
            total,
            asked.startIndex,
          );
        }),
      ),
    );
    yield* router.add(
      "POST",
      `${SCIM_PATH}/Users`,
      scim(
        (request) =>
          Effect.gen(function* () {
            const fields = yield* Effect.fromResult(
              Scim.userFieldsFromResource(yield* bodyOf(request)),
            );
            return Scim.userResource(yield* directory.createUser(actorOf(request), fields), base);
          }),
        201,
      ),
    );
    yield* router.add(
      "GET",
      `${SCIM_PATH}/Users/:id`,
      scim(() =>
        Effect.flatMap(idOf, directory.user).pipe(
          Effect.map((user) => Scim.userResource(user, base)),
        ),
      ),
    );
    yield* router.add(
      "PUT",
      `${SCIM_PATH}/Users/:id`,
      scim((request) =>
        Effect.gen(function* () {
          const fields = yield* Effect.fromResult(
            Scim.userFieldsFromResource(yield* bodyOf(request)),
          );
          const { email, displayName, ...rest } = fields;
          const user = yield* directory.changeUser(actorOf(request), yield* idOf, {
            ...rest,
            ...(email === null ? {} : { email }),
            ...(displayName === null ? {} : { displayName }),
          });
          return Scim.userResource(user, base);
        }),
      ),
    );
    yield* router.add(
      "PATCH",
      `${SCIM_PATH}/Users/:id`,
      scim((request) =>
        Effect.gen(function* () {
          const change = yield* Effect.fromResult(Scim.userChangeFromPatch(yield* bodyOf(request)));
          const user = yield* directory.changeUser(actorOf(request), yield* idOf, change);
          return Scim.userResource(user, base);
        }),
      ),
    );
    yield* router.add(
      "DELETE",
      `${SCIM_PATH}/Users/:id`,
      scim((request) =>
        Effect.flatMap(idOf, (id) => directory.removeUser(actorOf(request), id)).pipe(
          Effect.as(null),
        ),
      ),
    );

    yield* router.add(
      "GET",
      `${SCIM_PATH}/Groups`,
      scim((request) =>
        Effect.gen(function* () {
          const asked = yield* page(request, GROUP_FILTERS);
          const { total, groups } = yield* directory.groups(asked);
          return Scim.listResponse(
            groups.map((group) => Scim.groupResource(group, base, !asked.membersLeftOut)),
            total,
            asked.startIndex,
          );
        }),
      ),
    );
    yield* router.add(
      "POST",
      `${SCIM_PATH}/Groups`,
      scim(
        (request) =>
          Effect.gen(function* () {
            const fields = yield* Effect.fromResult(
              Scim.groupFieldsFromResource(yield* bodyOf(request)),
            );
            return Scim.groupResource(yield* directory.createGroup(actorOf(request), fields), base);
          }),
        201,
      ),
    );
    yield* router.add(
      "GET",
      `${SCIM_PATH}/Groups/:id`,
      scim((request) =>
        Effect.flatMap(idOf, directory.group).pipe(
          Effect.map((group) => Scim.groupResource(group, base, !leavesOutMembers(query(request)))),
        ),
      ),
    );
    yield* router.add(
      "PUT",
      `${SCIM_PATH}/Groups/:id`,
      scim((request) =>
        Effect.gen(function* () {
          const body = yield* bodyOf(request);
          const fields = yield* Effect.fromResult(Scim.groupFieldsFromResource(body));
          // Members are replaced only when sent, so a rename alone keeps them.
          const sendsMembers =
            typeof body === "object" &&
            body !== null &&
            Object.keys(body).some((key) => key.toLowerCase() === "members");
          const group = yield* directory.changeGroup(actorOf(request), yield* idOf, {
            displayName: fields.displayName,
            externalId: fields.externalId,
            members: sendsMembers ? [{ replace: fields.members }] : [],
          });
          return Scim.groupResource(group, base);
        }),
      ),
    );
    yield* router.add(
      "PATCH",
      `${SCIM_PATH}/Groups/:id`,
      scim((request) =>
        Effect.gen(function* () {
          const change = yield* Effect.fromResult(
            Scim.groupChangeFromPatch(yield* bodyOf(request)),
          );
          const group = yield* directory.changeGroup(actorOf(request), yield* idOf, change);
          return Scim.groupResource(group, base);
        }),
      ),
    );
    yield* router.add(
      "DELETE",
      `${SCIM_PATH}/Groups/:id`,
      scim((request) =>
        Effect.flatMap(idOf, (id) => directory.removeGroup(actorOf(request), id)).pipe(
          Effect.as(null),
        ),
      ),
    );
  }),
);
