import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as Scope from "effect/Scope";

import { Gateway, type GatewayCall } from "./Gateway.ts";
import * as GatewayHttp from "./GatewayHttp.ts";

const encoder = new TextEncoder();

describe("GatewayHttp", () => {
  it.effect("hands each agent's calls to the gateway without the prefix, and streams replies", () =>
    Effect.gen(function* () {
      const calls: Array<GatewayCall & { readonly agent: string }> = [];
      const answer = (agent: string) => (call: GatewayCall) =>
        Effect.sync(() => {
          calls.push({ ...call, agent });
          return {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: Stream.make(encoder.encode("data: one\n\n"), encoder.encode("data: two\n\n")),
          };
        });
      const gateway = Gateway.of({ claude: answer("claude"), codex: answer("codex") });
      const handler = HttpEffect.toWebHandlerWith<
        never,
        HttpServerRequest.HttpServerRequest | Scope.Scope
      >(yield* Effect.context<never>())(
        yield* HttpRouter.toHttpEffect(GatewayHttp.layerRoutes).pipe(
          Effect.provideService(Gateway, gateway),
        ),
      );
      const send = (body: Uint8Array, path = "/anthropic/v1/messages?beta=true") =>
        Effect.promise(() =>
          handler(
            new Request(`http://gateway.test${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          ),
        );

      const reply = yield* send(encoder.encode('{"model":"claude-opus-5-5"}'));
      expect(reply.headers.get("content-type")).toBe("text/event-stream");
      expect(yield* Effect.promise(() => reply.text())).toBe("data: one\n\ndata: two\n\n");
      yield* send(encoder.encode('{"model":"gpt-5.5"}'), "/openai/v1/responses");
      expect(calls.map(({ agent, method, path, search }) => [agent, method, path, search])).toEqual(
        [
          ["claude", "POST", "/v1/messages", "?beta=true"],
          ["codex", "POST", "/v1/responses", ""],
        ],
      );
      expect(new TextDecoder().decode(calls[0]?.body ?? new Uint8Array())).toBe(
        '{"model":"claude-opus-5-5"}',
      );

      // Anthropic's own limit on one request is 32 MB.
      const tooLarge = yield* send(new Uint8Array(32 * 1024 * 1024 + 1));
      expect(tooLarge.status).toBe(413);
      expect(calls).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(HttpServer.layerServices)),
  );
});
