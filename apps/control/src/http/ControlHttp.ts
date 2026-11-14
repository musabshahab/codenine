// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer listens on a Node http.Server.
import * as NodeHttp from "node:http";

import { ControlApi, ControlUnavailableError } from "@codenine/contracts/control";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { ControlDb } from "../db.ts";

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

export const layerRoutes = HttpApiBuilder.layer(ControlApi).pipe(Layer.provide(layerHealthApi));

export const layerServer = (options: { readonly host: string; readonly port: number }) =>
  HttpRouter.serve(layerRoutes).pipe(
    Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, options)),
  );
