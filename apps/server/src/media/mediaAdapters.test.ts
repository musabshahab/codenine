import { describe, expect, it } from "@effect/vitest";
import type { MediaProviderFailure } from "@codenine/contracts";
import { ConnectionId, ConnectorCatalogId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import * as ConnectorStore from "../connectors/ConnectorStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { falMediaAdapter } from "./FalMedia.ts";
import { type MediaAdapter, type MediaAdapterRequest, MediaLimits } from "./MediaAdapter.ts";
import { openRouterMediaAdapter } from "./OpenRouterMedia.ts";

const KEY = "key-live-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A client that answers from `answer` and keeps what it was sent. Nothing reaches a network. */
const fakeHttp = (answer: (sent: Sent, index: number) => Response | Effect.Effect<Response>) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
        : undefined;
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    };
    sent.push(entry);
    const answered = answer(entry, sent.length - 1);
    return (Effect.isEffect(answered) ? answered : Effect.succeed(answered)).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    );
  });
  return { sent, client };
};

const modelOf = (adapter: MediaAdapter, id: string) =>
  adapter.models.find((model) => model.id === id)!;

const requestFor = (
  adapter: MediaAdapter,
  modelId: string,
  overrides: Partial<MediaAdapterRequest> = {},
): MediaAdapterRequest => ({
  apiKey: Redacted.make(KEY),
  model: modelOf(adapter, modelId),
  prompt: "a red kite over a harbour",
  aspectRatio: undefined,
  count: 1,
  seed: undefined,
  source: undefined,
  mask: undefined,
  progress: () => Effect.void,
  charged: () => Effect.void,
  ...overrides,
});

/** A request that keeps what the adapter said the provider charged for work without images. */
const tracked = (adapter: MediaAdapter, modelId: string) => {
  const charged: Array<number> = [];
  const request = requestFor(adapter, modelId, {
    charged: (costUsd) => Effect.sync(() => void charged.push(costUsd)),
  });
  return { charged, request };
};

const runWith = (
  adapter: MediaAdapter,
  client: HttpClient.HttpClient,
  request: MediaAdapterRequest,
) => adapter.run(request).pipe(Effect.provideService(HttpClient.HttpClient, client));

const FAL_SCHNELL = "fal-ai/flux/schnell";
const FAL_REQUESTS = "https://queue.fal.run/fal-ai/flux/requests/req-1";
const falSubmitted = () =>
  Response.json({
    request_id: "req-1",
    status_url: `${FAL_REQUESTS}/status`,
    response_url: FAL_REQUESTS,
    cancel_url: `${FAL_REQUESTS}/cancel`,
  });

describe("fal adapter", () => {
  it.effect("submits to the queue, polls until the job is done and returns its images", () =>
    Effect.gen(function* () {
      const polled = yield* Queue.unbounded<void>();
      const steps: Array<unknown> = [];
      const statuses = [
        { status: "IN_QUEUE", queue_position: 2 },
        { status: "IN_QUEUE", queue_position: 2 },
        { status: "IN_PROGRESS" },
        { status: "COMPLETED" },
      ];
      const { sent, client } = fakeHttp((request) => {
        if (request.method === "POST") return falSubmitted();
        if (request.url.endsWith("/status")) {
          return Queue.offer(polled, undefined).pipe(
            Effect.as(Response.json(statuses.shift(), { status: 202 })),
          );
        }
        return Response.json({
          images: [{ url: "https://v3.fal.media/files/a.png" }, { url: "https://v3.fal.media/b" }],
          seed: 77,
          has_nsfw_concepts: [false, false],
        });
      });
      const fiber = yield* runWith(
        falMediaAdapter,
        client,
        requestFor(falMediaAdapter, FAL_SCHNELL, {
          aspectRatio: "16:9",
          count: 2,
          seed: 5,
          progress: (step) => Effect.sync(() => void steps.push(step)),
        }),
      ).pipe(Effect.forkChild);
      for (let poll = 0; poll < 3; poll++) {
        yield* Queue.take(polled);
        yield* TestClock.adjust("1 second");
      }
      const result = yield* Fiber.join(fiber);

      expect(sent[0]).toEqual({
        method: "POST",
        url: "https://queue.fal.run/fal-ai/flux/schnell",
        authorization: `Key ${KEY}`,
        body: {
          prompt: "a red kite over a harbour",
          num_images: 2,
          seed: 5,
          image_size: "landscape_16_9",
        },
      });
      expect(sent.slice(1).map((request) => `${request.method} ${request.url}`)).toEqual([
        ...Array.from({ length: 4 }, () => `GET ${FAL_REQUESTS}/status`),
        `GET ${FAL_REQUESTS}`,
      ]);
      // An unchanged queue position is reported once.
      expect(steps).toEqual([{ phase: "queued", queuePosition: 2 }, { phase: "running" }]);
      expect(result).toEqual({
        images: [
          { kind: "url", url: "https://v3.fal.media/files/a.png" },
          { kind: "url", url: "https://v3.fal.media/b" },
        ],
        costUsd: undefined,
        seed: 77,
      });
    }),
  );

  it.effect("sends an edit's source and mask in the request", () =>
    Effect.gen(function* () {
      const { sent, client } = fakeHttp((request) =>
        request.method === "POST"
          ? falSubmitted()
          : request.url.endsWith("/status")
            ? Response.json({ status: "COMPLETED" })
            : Response.json({ images: [{ url: "https://v3.fal.media/files/edit.png" }] }),
      );
      const image = { bytes: PNG, mimeType: "image/png" };
      yield* runWith(
        falMediaAdapter,
        client,
        requestFor(falMediaAdapter, "fal-ai/flux-pro/v1/fill", { source: image, mask: image }),
      );
      expect(sent[0]?.url).toBe("https://queue.fal.run/fal-ai/flux-pro/v1/fill");
      expect(sent[0]?.body).toEqual({
        prompt: "a red kite over a harbour",
        num_images: 1,
        image_url: PNG_DATA_URL,
        mask_url: PNG_DATA_URL,
      });
    }),
  );

  it.effect.each<[string, number, unknown, MediaProviderFailure]>([
    ["a rejected key", 401, { detail: "Invalid key" }, "key-rejected"],
    [
      "an account out of credit",
      403,
      { detail: "User is locked. Reason: Exhausted balance. Top up your balance." },
      "out-of-credit",
    ],
    [
      "refused content",
      422,
      { detail: [{ msg: "The prompt was flagged.", type: "content_policy_violation" }] },
      "content-refused",
    ],
    ["a rate limit", 429, { detail: "Too many requests" }, "rate-limited"],
    ["a request that is too large", 413, {}, "too-large"],
    ["a gateway timeout", 504, {}, "timed-out"],
    ["a provider failure", 500, { detail: "boom" }, "unavailable"],
  ])("maps %s to a typed error", ([, status, body, reason]) =>
    Effect.gen(function* () {
      const { sent, client } = fakeHttp(() => Response.json(body, { status }));
      const { charged, request } = tracked(falMediaAdapter, FAL_SCHNELL);
      const error = yield* runWith(falMediaAdapter, client, request).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MediaProviderError", provider: "fal", reason });
      expect(sent).toHaveLength(1);
      // fal turned the request down, so nothing is owed.
      expect(charged).toEqual([0]);
    }),
  );

  // The last column is what the job still costs: nothing where fal refused it, else its estimate.
  it.effect.each<[string, number, unknown, MediaProviderFailure, ReadonlyArray<number>]>([
    [
      "a job that failed on content",
      422,
      { detail: [{ msg: "Blocked.", type: "content_policy_violation" }] },
      "content-refused",
      [0],
    ],
    [
      "images the safety checker blanked",
      200,
      { images: [{ url: "https://v3.fal.media/files/a.png" }], has_nsfw_concepts: [true] },
      "content-refused",
      [],
    ],
    ["a result without images", 200, { images: [] }, "unavailable", []],
  ])("maps %s to a typed error", ([, status, body, reason, owed]) =>
    Effect.gen(function* () {
      const { client } = fakeHttp((request) =>
        request.method === "POST"
          ? falSubmitted()
          : request.url.endsWith("/status")
            ? Response.json({ status: "COMPLETED" })
            : Response.json(body, { status }),
      );
      const { charged, request } = tracked(falMediaAdapter, FAL_SCHNELL);
      const error = yield* runWith(falMediaAdapter, client, request).pipe(Effect.flip);
      expect(error).toMatchObject({ provider: "fal", reason });
      expect(charged).toEqual(owed);
    }),
  );

  it.effect("asks again when a status or result request gets no usable answer", () =>
    Effect.gen(function* () {
      const asked = yield* Queue.unbounded<void>();
      const busy = () => Response.json({ detail: "Bad gateway" }, { status: 502 });
      const statuses = [busy(), new Response("<html>", { status: 200 }), busy()];
      const results = [busy()];
      const { sent, client } = fakeHttp((request) => {
        if (request.method === "POST") return falSubmitted();
        const answer = request.url.endsWith("/status")
          ? (statuses.shift() ?? Response.json({ status: "COMPLETED" }))
          : (results.shift() ??
            Response.json({ images: [{ url: "https://v3.fal.media/files/a.png" }] }));
        return Queue.offer(asked, undefined).pipe(Effect.as(answer));
      });
      const { charged, request } = tracked(falMediaAdapter, FAL_SCHNELL);
      const fiber = yield* runWith(falMediaAdapter, client, request).pipe(Effect.forkChild);
      for (let question = 0; question < 6; question++) {
        yield* Queue.take(asked);
        yield* TestClock.adjust("1 second");
      }
      expect((yield* Fiber.join(fiber)).images).toHaveLength(1);
      expect(sent.map((entry) => entry.method)).not.toContain("PUT");
      expect(charged).toEqual([]);
    }),
  );

  // fal stops a job that is still in its queue, so only that one costs nothing once cancelled.
  it.effect.each<
    ["interrupted" | "left waiting" | "not answered", "IN_QUEUE" | "IN_PROGRESS", Array<number>]
  >([
    ["interrupted", "IN_QUEUE", [0]],
    ["left waiting", "IN_QUEUE", [0]],
    ["not answered", "IN_QUEUE", [0]],
    ["interrupted", "IN_PROGRESS", []],
    ["not answered", "IN_PROGRESS", []],
  ])("tells fal to cancel a job that is %s while %s", ([ending, status, owed]) =>
    Effect.gen(function* () {
      const polled = yield* Queue.unbounded<void>();
      let polls = 0;
      const { sent, client } = fakeHttp((request) => {
        if (request.method === "POST") return falSubmitted();
        if (request.method === "PUT") {
          return Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 });
        }
        const answer =
          ending === "not answered" && polls++ > 0
            ? Response.json({ detail: "Bad gateway" }, { status: 502 })
            : Response.json({ status, queue_position: 9 }, { status: 202 });
        return Queue.offer(polled, undefined).pipe(Effect.as(answer));
      });
      const { charged, request } = tracked(falMediaAdapter, FAL_SCHNELL);
      const fiber = yield* runWith(falMediaAdapter, client, request).pipe(Effect.forkChild);
      yield* Queue.take(polled);
      if (ending === "interrupted") {
        yield* Fiber.interrupt(fiber);
      } else if (ending === "left waiting") {
        yield* TestClock.adjust("5 minutes");
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({ reason: "timed-out" });
      } else {
        // One good answer, then five that fail one after the other.
        for (let failed = 0; failed < 5; failed++) {
          yield* TestClock.adjust("1 second");
          yield* Queue.take(polled);
        }
        expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
          reason: "unavailable",
        });
      }
      expect(sent.at(-1)).toMatchObject({
        method: "PUT",
        url: `${FAL_REQUESTS}/cancel`,
        authorization: `Key ${KEY}`,
      });
      expect(charged).toEqual(owed);
    }),
  );

  it.effect("builds the request addresses itself when fal names one off its queue", () =>
    Effect.gen(function* () {
      const { sent, client } = fakeHttp((request) =>
        request.method === "POST"
          ? Response.json({
              request_id: "req-1",
              status_url: "https://elsewhere.example/status",
              response_url: "https://elsewhere.example/result",
            })
          : request.url.endsWith("/status")
            ? Response.json({ status: "COMPLETED" })
            : Response.json({ images: [{ url: "https://v3.fal.media/files/a.png" }] }),
      );
      yield* runWith(falMediaAdapter, client, requestFor(falMediaAdapter, FAL_SCHNELL));
      // The key goes only to fal's queue.
      expect(sent.slice(1).map((request) => request.url)).toEqual([
        `${FAL_REQUESTS}/status`,
        FAL_REQUESTS,
      ]);
    }),
  );

  it.effect("reads its key from the fal connector", () =>
    Effect.gen(function* () {
      const connection = (id: string, catalogId: string) => ({
        id: ConnectionId.make(id),
        catalogId: ConnectorCatalogId.make(catalogId),
      });
      const keyWith = (connections: ReadonlyArray<ReturnType<typeof connection>>) =>
        falMediaAdapter.key.pipe(
          Effect.map(Option.map(Redacted.value)),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ConnectorStore.ConnectorStore)({
                list: Effect.succeed(
                  connections as unknown as ReadonlyArray<ConnectorStore.StoredConnection>,
                ),
                readSecrets: (id) =>
                  Effect.succeed({ ...(id === "fal" ? { token: ` ${KEY} ` } : {}), inputs: {} }),
              }),
              ServerSettings.ServerSettingsService.layerTest(),
            ),
          ),
        );
      expect(yield* keyWith([connection("github", "github"), connection("fal", "fal")])).toEqual(
        Option.some(KEY),
      );
      expect(yield* keyWith([connection("github", "github")])).toEqual(Option.none());
    }),
  );
});

const OPENROUTER_MODEL = "google/gemini-2.5-flash-image";
const completion = (overrides: Record<string, unknown> = {}) => ({
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "",
        images: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }],
      },
    },
  ],
  usage: { cost: 0.0391 },
  ...overrides,
});

describe("OpenRouter adapter", () => {
  it.effect("asks for an image and reads it and its cost from the answer", () =>
    Effect.gen(function* () {
      const { sent, client } = fakeHttp(() => Response.json(completion()));
      const result = yield* runWith(
        openRouterMediaAdapter,
        client,
        requestFor(openRouterMediaAdapter, OPENROUTER_MODEL, { aspectRatio: "3:4", seed: 9 }),
      );
      expect(sent).toEqual([
        {
          method: "POST",
          url: "https://openrouter.ai/api/v1/chat/completions",
          authorization: `Bearer ${KEY}`,
          body: {
            model: OPENROUTER_MODEL,
            modalities: ["image", "text"],
            messages: [{ role: "user", content: "a red kite over a harbour" }],
            image_config: { aspect_ratio: "3:4" },
            seed: 9,
            usage: { include: true },
          },
        },
      ]);
      expect(result.costUsd).toBe(0.0391);
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatchObject({ kind: "bytes", mimeType: "image/png" });
      expect(
        result.images[0]?.kind === "bytes" ? Array.from(result.images[0].bytes) : undefined,
      ).toEqual(Array.from(PNG));
    }),
  );

  it.effect("sends an edit's source image with the prompt", () =>
    Effect.gen(function* () {
      const { sent, client } = fakeHttp(() => Response.json(completion()));
      yield* runWith(
        openRouterMediaAdapter,
        client,
        requestFor(openRouterMediaAdapter, OPENROUTER_MODEL, {
          source: { bytes: PNG, mimeType: "image/png" },
        }),
      );
      expect(sent[0]?.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a red kite over a harbour" },
              { type: "image_url", image_url: { url: PNG_DATA_URL } },
            ],
          },
        ],
      });
    }),
  );

  it.effect.each<[string, number, unknown, MediaProviderFailure, ReadonlyArray<number>]>([
    ["a rejected key", 401, { error: { code: 401, message: "No auth" } }, "key-rejected", [0]],
    ["an account out of credit", 402, { error: { code: 402, message: "x" } }, "out-of-credit", [0]],
    ["a rate limit", 429, { error: { code: 429, message: "Slow down" } }, "rate-limited", [0]],
    [
      "flagged input",
      403,
      { error: { code: 403, message: "Your input was flagged by moderation" } },
      "content-refused",
      [0],
    ],
    ["a provider timeout", 408, { error: { code: 408, message: "Timed out" } }, "timed-out", [0]],
    ["a request that is too large", 413, { error: { code: 413, message: "x" } }, "too-large", [0]],
    [
      "a provider failure",
      502,
      { error: { code: 502, message: "Bad gateway" } },
      "unavailable",
      [0],
    ],
    [
      "an error inside an answer",
      200,
      { error: { code: 402, message: "x" } },
      "out-of-credit",
      [0],
    ],
    // An answer without an image is billed: at what it says it cost, else at the estimate.
    [
      "an answer the model's filter emptied",
      200,
      { choices: [{ finish_reason: "content_filter", message: { content: "" } }] },
      "content-refused",
      [],
    ],
    [
      "an answer without an image",
      200,
      {
        choices: [{ finish_reason: "stop", message: { content: "I can only describe it." } }],
        usage: { cost: 0.0004 },
      },
      "unavailable",
      [0.0004],
    ],
  ])("maps %s to a typed error", ([, status, body, reason, owed]) =>
    Effect.gen(function* () {
      const { client } = fakeHttp(() => Response.json(body, { status }));
      const { charged, request } = tracked(openRouterMediaAdapter, OPENROUTER_MODEL);
      const error = yield* runWith(openRouterMediaAdapter, client, request).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MediaProviderError", provider: "openrouter", reason });
      expect(charged).toEqual(owed);
    }),
  );

  it.effect.each<[string, () => Response | Effect.Effect<Response>, MediaProviderFailure]>([
    ["that does not come", () => Effect.never, "timed-out"],
    ["whose body never ends", () => new Response(new ReadableStream({})), "timed-out"],
    [
      "that is larger than an image may be",
      () => Response.json(completion({ padding: "x".repeat(2 * 1024 * 1024) })),
      "unavailable",
    ],
  ])("stops waiting for an answer %s", ([, answer, reason]) =>
    Effect.gen(function* () {
      const asked = yield* Queue.unbounded<void>();
      const { client } = fakeHttp(() =>
        Queue.offer(asked, undefined).pipe(
          Effect.andThen(() => {
            const answered = answer();
            return Effect.isEffect(answered) ? answered : Effect.succeed(answered);
          }),
        ),
      );
      const { charged, request } = tracked(openRouterMediaAdapter, OPENROUTER_MODEL);
      const fiber = yield* runWith(openRouterMediaAdapter, client, request).pipe(
        Effect.provideService(MediaLimits, {
          maxImageBytes: 1024,
          maxSourceBytes: 1024,
          downloadTimeout: "60 seconds",
        }),
        Effect.forkChild,
      );
      yield* Queue.take(asked);
      yield* TestClock.adjust("3 minutes");
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({ reason });
      // OpenRouter took the request, so it stays counted at its estimate.
      expect(charged).toEqual([]);
    }),
  );

  it.effect("reads its key from an OpenRouter account that is on", () =>
    Effect.gen(function* () {
      const account = (enabled: boolean, baseUrl: string) => ({
        driver: "claudeAgent",
        enabled,
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: baseUrl, sensitive: false },
          { name: "ANTHROPIC_AUTH_TOKEN", value: KEY, sensitive: true },
        ],
      });
      const keyWith = (providerInstances: Record<string, ReturnType<typeof account>>) =>
        openRouterMediaAdapter.key.pipe(
          Effect.map(Option.map(Redacted.value)),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ConnectorStore.ConnectorStore)({}),
              ServerSettings.ServerSettingsService.layerTest({ providerInstances }),
            ),
          ),
        );
      expect(yield* keyWith({ openrouter: account(true, "https://openrouter.ai/api") })).toEqual(
        Option.some(KEY),
      );
      expect(yield* keyWith({ openrouter: account(false, "https://openrouter.ai/api") })).toEqual(
        Option.none(),
      );
      expect(yield* keyWith({ other: account(true, "https://api.anthropic.com") })).toEqual(
        Option.none(),
      );
    }),
  );
});
