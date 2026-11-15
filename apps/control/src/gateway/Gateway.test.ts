import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { Accounts } from "../accounts/Accounts.ts";
import { Departments } from "../departments/Departments.ts";
import { LicenceService } from "../licence/LicenceService.ts";
import { layerTestServices } from "../testing/layerTestServices.ts";
import { signTestLicence, testClaims, testKeyPair } from "../testing/testLicence.ts";
import * as WorkspaceTokens from "../workspaces/WorkspaceTokens.ts";
import { AiAccounts } from "./AiAccounts.ts";
import { AiUsage, type AiUsageRow } from "./AiUsage.ts";
import * as Gateway from "./Gateway.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the provider was asked: the address and headers, and the body as text. */
interface Asked {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const START = [
  "event: message_start",
  `data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":1}}}`,
  "",
  "",
].join("\n");
const REST = [
  "event: content_block_delta",
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
  "",
  "event: message_delta",
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57,"server_tool_use":{"web_search_requests":2}}}`,
  "",
  "event: message_stop",
  `data: {"type":"message_stop"}`,
  "",
  "",
].join("\n");

const sse = (chunks: ReadonlyArray<string>, end = true) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (end) controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } },
  );

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "";

/**
 * The gateway on real services and a fake provider. Usage rows land in a
 * queue, so a test waits for the one a call writes after its reply ends.
 */
const withGateway = <A, E, R>(
  respond: (asked: Asked) => Response,
  body: (context: {
    readonly asked: Array<Asked>;
    readonly rows: Queue.Queue<AiUsageRow>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const keys = yield* testKeyPair;
    yield* TestClock.setTime(Date.parse("2026-12-10T12:00:00Z"));
    const licence = yield* signTestLicence(testClaims({ seats: 10 }), keys.privateKey);
    const asked: Array<Asked> = [];
    const rows = yield* Queue.unbounded<AiUsageRow>();
    const provider = HttpClient.make((request) =>
      Effect.sync(() => {
        const call = { url: request.url, headers: request.headers, body: bodyText(request) };
        asked.push(call);
        return HttpClientResponse.fromWeb(request, respond(call));
      }),
    );
    return yield* Effect.gen(function* () {
      yield* (yield* LicenceService).install(licence);
      return yield* body({ asked, rows });
    }).pipe(
      Effect.provide(
        Gateway.layer.pipe(
          Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, provider)),
          Layer.provideMerge(
            Layer.succeed(
              AiUsage,
              AiUsage.of({ record: (row) => Queue.offer(rows, row).pipe(Effect.asVoid) }),
            ),
          ),
          Layer.provideMerge(WorkspaceTokens.layer),
          Layer.provideMerge(layerTestServices(keys.publicKey)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/** Ada, active in Design, and the token her Design workspace calls the gateway with. */
const adaInDesign = Effect.gen(function* () {
  const accounts = yield* Accounts;
  const departments = yield* Departments;
  const person = yield* accounts.addPerson({ email: "ada@acme.test", displayName: "Ada" });
  yield* accounts.activate(person.id);
  const design = yield* departments.create("Design");
  yield* departments.addMember(design.id, person.id);
  const key = { personId: person.id, departmentId: design.id };
  const token = yield* (yield* WorkspaceTokens.WorkspaceTokens).gatewayToken(key);
  return { key, token, departmentId: design.id };
});

const companyAccount = Effect.gen(function* () {
  return yield* (yield* AiAccounts).create({
    name: "Claude API",
    kind: "anthropic",
    baseUrl: null,
    priceAdjustment: 0,
    isDefault: true,
    apiKey: "sk-ant-company-key",
  });
});

const messages = (token: string) => ({
  method: "POST",
  path: "/v1/messages",
  search: "?beta=true",
  headers: Headers.fromInput({
    "x-api-key": token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-claude-code-session-id": "session-1",
    "content-type": "application/json",
    "accept-encoding": "gzip, br",
  }),
  body: encoder.encode(JSON.stringify({ model: "claude-opus-5-5", stream: true, max_tokens: 8 })),
});

const readAll = (reply: Gateway.GatewayReply) =>
  reply.body instanceof Uint8Array
    ? Effect.succeed(decoder.decode(reply.body))
    : Stream.mkString(Stream.decodeText(reply.body)).pipe(Effect.orDie);

describe("Gateway", () => {
  it.effect("passes a stream on unchanged with the company's key, then records its cost", () =>
    withGateway(
      () => sse([START, REST.slice(0, 40), REST.slice(40)]),
      ({ asked, rows }) =>
        Effect.gen(function* () {
          const account = yield* companyAccount;
          const ada = yield* adaInDesign;
          const gateway = yield* Gateway.Gateway;

          const reply = yield* gateway.claude(messages(ada.token));
          expect(reply.status).toBe(200);
          expect(yield* readAll(reply)).toBe(START + REST);

          const [call] = asked;
          expect(call?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
          expect(call?.headers).toMatchObject({
            "x-api-key": "sk-ant-company-key",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
            "x-claude-code-session-id": "session-1",
            "accept-encoding": "identity",
          });
          expect(Object.values(call?.headers ?? {}).join(" ")).not.toContain(ada.token);
          expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ model: "claude-opus-5-5" });

          // $4 in, $5 and $8 to write the cache, $0.20 to read it and $20 out per
          // million, plus a cent for each web search.
          expect(yield* Queue.take(rows)).toMatchObject({
            personId: ada.key.personId,
            departmentId: ada.departmentId,
            accountId: account.id,
            provider: "claude",
            model: "claude-opus-5-5",
            inputTokens: 12,
            cacheWriteTokens: 300,
            cacheReadTokens: 4000,
            outputTokens: 57,
            webSearches: 2,
            costMicros: 48 + 500 + 1600 + 800 + 1140 + 20_000,
            priced: true,
            outcome: "ok",
            status: 200,
            sessionId: "session-1",
            requestId: "req_1",
          });
        }),
    ),
  );

  it.effect("records what a stream used so far when the workspace stops reading", () =>
    withGateway(
      () => sse([START], false),
      ({ rows }) =>
        Effect.gen(function* () {
          yield* companyAccount;
          const ada = yield* adaInDesign;
          const reply = yield* (yield* Gateway.Gateway).claude(messages(ada.token));
          const first = yield* Deferred.make<void>();
          const reading = yield* Stream.runForEach(
            reply.body instanceof Uint8Array ? Stream.empty : reply.body,
            () => Deferred.succeed(first, undefined),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(first);
          yield* Fiber.interrupt(reading);

          expect(yield* Queue.take(rows)).toMatchObject({
            outcome: "cancelled",
            inputTokens: 12,
            outputTokens: 1,
          });
        }),
    ),
  );

  it.effect("passes the provider's errors on as they are, and records them at no cost", () =>
    withGateway(
      () =>
        Response.json(
          { type: "error", error: { type: "rate_limit_error", message: "Slow down" } },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      ({ rows }) =>
        Effect.gen(function* () {
          yield* companyAccount;
          const ada = yield* adaInDesign;
          const reply = yield* (yield* Gateway.Gateway).claude(messages(ada.token));
          expect(reply.status).toBe(429);
          expect(reply.headers["retry-after"]).toBe("30");
          expect(JSON.parse(yield* readAll(reply))).toMatchObject({
            error: { type: "rate_limit_error" },
          });
          expect(yield* Queue.take(rows)).toMatchObject({
            outcome: "failed",
            status: 429,
            costMicros: 0,
          });
        }),
    ),
  );

  it.effect("counts tokens for free and never asks the provider for an unknown path", () =>
    withGateway(
      () => Response.json({ input_tokens: 42 }),
      ({ asked, rows }) =>
        Effect.gen(function* () {
          yield* companyAccount;
          const ada = yield* adaInDesign;
          const gateway = yield* Gateway.Gateway;
          const counted = yield* gateway.claude({
            ...messages(ada.token),
            path: "/v1/messages/count_tokens",
          });
          expect(JSON.parse(yield* readAll(counted))).toEqual({ input_tokens: 42 });

          const batch = yield* gateway.claude({
            ...messages(ada.token),
            path: "/v1/messages/batches",
          });
          expect(batch.status).toBe(404);
          expect(asked.map(({ url }) => new URL(url).pathname)).toEqual([
            "/v1/messages/count_tokens",
          ]);
          expect(yield* Queue.size(rows)).toBe(0);
        }),
    ),
  );

  it.effect("turns workspaces away once their person may not work there", () =>
    withGateway(
      () => sse([START, REST]),
      ({ asked }) =>
        Effect.gen(function* () {
          const ada = yield* adaInDesign;
          const gateway = yield* Gateway.Gateway;
          const refusedWith = (token: string) =>
            gateway
              .claude(messages(token))
              .pipe(
                Effect.flatMap((reply) =>
                  readAll(reply).pipe(
                    Effect.map((text) => [reply.status, JSON.parse(text).error.type]),
                  ),
                ),
              );

          // No company account yet: a clear, final refusal rather than one to retry.
          expect(yield* refusedWith(ada.token)).toEqual([403, "permission_error"]);
          yield* companyAccount;

          expect(yield* refusedWith("sk-ant-a-real-looking-key")).toEqual([
            401,
            "authentication_error",
          ]);
          // A token for her browser is not one for the gateway.
          const browserToken = yield* (yield* WorkspaceTokens.WorkspaceTokens).mint({
            personId: ada.key.personId,
            sessionId: "ses_1",
            name: "Ada",
            workspaceId: "wks_1",
            scopes: [],
          });
          expect(yield* refusedWith(browserToken)).toEqual([401, "authentication_error"]);

          // Out of Design, her Design workspace's token stops working within half a minute.
          const departments = yield* Departments;
          yield* departments.removeMember(ada.departmentId, ada.key.personId);
          yield* TestClock.adjust("31 seconds");
          expect(yield* refusedWith(ada.token)).toEqual([401, "authentication_error"]);

          // Back in Design, but the licence and its grace have ended: no work, so no AI.
          yield* departments.addMember(ada.departmentId, ada.key.personId);
          yield* TestClock.adjust("400 days");
          expect(yield* refusedWith(ada.token)).toEqual([403, "permission_error"]);
          expect(asked).toEqual([]);
        }),
    ),
  );
});
