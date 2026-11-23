import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { MediaImageModel, MediaJobEvent } from "@codenine/contracts";
import { MediaJobId, MediaModelId, MediaProviderId } from "@codenine/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ConnectorStore from "../connectors/ConnectorStore.ts";
import * as FileVersionStorage from "../fileVersions/FileVersionStorage.ts";
import * as FileVersions from "../fileVersions/FileVersions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Media from "./Media.ts";
import {
  type MediaAdapter,
  type MediaAdapterRequest,
  mediaFailure,
  MediaLimits,
} from "./MediaAdapter.ts";
import { MediaAdapters } from "./MediaProviders.ts";

const KEY = "key-live-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
const MAX_IMAGE_BYTES = 64;

const model = (overrides: Partial<MediaImageModel> = {}): MediaImageModel => ({
  id: MediaModelId.make("draw"),
  name: "Draw",
  textToImage: true,
  imageEdit: false,
  mask: false,
  aspectRatios: ["1:1", "16:9"],
  maxCount: 4,
  estimatedUsdPerImage: 0.1,
  ...overrides,
});
const EDIT_MODEL = model({
  id: MediaModelId.make("retouch"),
  name: "Retouch",
  textToImage: false,
  imageEdit: true,
  mask: true,
  aspectRatios: [],
  estimatedUsdPerImage: 0.2,
});

const adapter = (overrides: Partial<MediaAdapter> = {}): MediaAdapter => ({
  id: "studio",
  name: "Studio",
  setup: { where: "connectors", hint: "Add the Studio connector." },
  keyUrl: "https://studio.example/keys",
  models: [model(), EDIT_MODEL],
  key: Effect.succeedSome(Redacted.make(KEY)),
  run: (request) =>
    Effect.succeed({
      images: Array.from({ length: request.count }, () => ({
        kind: "bytes" as const,
        bytes: PNG,
        mimeType: "image/png",
      })),
      costUsd: undefined,
      seed: undefined,
    }),
  ...overrides,
});

interface Harness {
  readonly adapters?: ReadonlyArray<MediaAdapter>;
  readonly media?: { readonly monthlyLimitUsd?: number; readonly perRequestLimitUsd?: number };
  /** Answers downloads. Without it any request fails the test. */
  readonly http?: (url: string) => Response | Effect.Effect<Response>;
}

const layerWith = (harness: Harness = {}) =>
  Media.layer.pipe(
    Layer.provide(Layer.succeed(MediaAdapters, harness.adapters ?? [adapter()])),
    Layer.provide(
      Layer.succeed(MediaLimits, {
        maxImageBytes: MAX_IMAGE_BYTES,
        maxSourceBytes: 32,
        downloadTimeout: "60 seconds",
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (harness.http === undefined) {
            return Effect.die(`must not send a request: ${request.url}`);
          }
          const answer = harness.http(request.url);
          return (Effect.isEffect(answer) ? answer : Effect.succeed(answer)).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          );
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(Media.MediaHostAddresses, (hostname) =>
        Effect.succeed([hostname.startsWith("inside.") ? "10.0.0.7" : "203.0.114.9"]),
      ),
    ),
    Layer.provide(Layer.mock(ConnectorStore.ConnectorStore)({})),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        media: { monthlyLimitUsd: 5, perRequestLimitUsd: 1, ...harness.media },
      }),
    ),
    Layer.provideMerge(FileVersions.layer),
    Layer.provide(FileVersionStorage.layer),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: () => Effect.succeed(false),
      }),
    ),
    Layer.provideMerge(
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(
          Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
        ),
        Layer.provide(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        ),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "codenine-media-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const workspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "codenine-media-workspace-" });
});

/** Ids need only differ between jobs that run at once. */
const jobId = (name = "job") => MediaJobId.make(name);

const listFolder = Effect.fn(function* (cwd: string, folder = "media") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (yield* fileSystem.readDirectory(path.join(cwd, folder))).toSorted();
});

/** Every job event from now until the scope closes. */
const collectEvents = Effect.gen(function* () {
  const media = yield* Media.Media;
  const events: Array<MediaJobEvent> = [];
  const subscribed = yield* Deferred.make<void>();
  yield* media.jobs.pipe(
    Stream.onStart(Deferred.succeed(subscribed, undefined)),
    Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
    Effect.forkScoped,
  );
  yield* Deferred.await(subscribed);
  return events;
});

describe("Media", () => {
  it.effect("explains that no provider has a key, and calls nothing", () =>
    Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const error = yield* media
        .generate({ jobId: jobId(), cwd, prompt: "a kite" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MediaProviderError", reason: "not-configured" });
      expect(error.message).toContain("Settings, under Media");
      const overview = yield* media.overview;
      expect(overview.providers).toMatchObject([{ id: "studio", configured: false }]);
      expect(overview.defaultModel).toBeNull();
      expect(overview.usage).toMatchObject({ spentUsd: 0, images: 0 });
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              key: Effect.succeedNone,
              run: () => Effect.die("must not run a provider without a key"),
            }),
          ],
        }),
      ),
    ),
  );

  it.effect("saves results under free names, records how they were made and counts the cost", () =>
    Effect.gen(function* () {
      const media = yield* Media.Media;
      const fileVersions = yield* FileVersions.FileVersions;
      const cwd = yield* workspace;
      const events = yield* collectEvents;
      const request = { cwd, prompt: "A red kite, over the harbour!", count: 2, seed: 7 };

      const first = yield* media.generate({
        ...request,
        jobId: jobId("first"),
        aspectRatio: "16:9",
      });
      const second = yield* media.generate({ ...request, jobId: jobId("second") });
      expect(first.files.map((file) => file.relativePath)).toEqual([
        "media/a-red-kite-over-the-harbour.png",
        "media/a-red-kite-over-the-harbour-2.png",
      ]);
      expect(second.files.map((file) => file.relativePath)).toEqual([
        "media/a-red-kite-over-the-harbour-3.png",
        "media/a-red-kite-over-the-harbour-4.png",
      ]);
      expect(yield* listFolder(cwd)).toHaveLength(4);
      expect(first.files[0]).toMatchObject({ mimeType: "image/png", byteLength: PNG.byteLength });
      // A folder without Git keeps the new file as a version, as it does a user's save.
      const versions = yield* fileVersions.list({
        cwd,
        relativePath: first.files[0]!.relativePath,
      });
      expect(versions.versions.length).toBeGreaterThan(0);

      expect(first).toMatchObject({ costUsd: 0.2, costEstimated: true });
      expect(second.usage).toMatchObject({ spentUsd: 0.4, images: 4 });
      expect(
        yield* media.imageRecord({ cwd, relativePath: first.files[1]!.relativePath }),
      ).toMatchObject({
        kind: "generate",
        provider: "studio",
        model: "draw",
        prompt: "A red kite, over the harbour!",
        aspectRatio: "16:9",
        seed: 7,
        costUsd: 0.1,
        costEstimated: true,
      });
      expect(yield* media.imageRecord({ cwd, relativePath: "media/other.png" })).toBeNull();

      expect(events.filter((event) => event.jobId === first.jobId)).toEqual([
        { jobId: first.jobId, cwd, kind: "generate", phase: "queued" },
        { jobId: first.jobId, cwd, kind: "generate", phase: "saving" },
        {
          jobId: first.jobId,
          cwd,
          kind: "generate",
          phase: "completed",
          files: first.files.map((file) => file.relativePath),
        },
      ]);
      expect(JSON.stringify([events, first, second, yield* media.overview])).not.toContain(KEY);
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("downloads a result within its limits and records what the provider charged", () => {
    const fetched: Array<string> = [];
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const result = yield* media.generate({ jobId: jobId(), cwd, prompt: "ok", folder: "art/" });
      // The extension follows the bytes, not the address or the type the provider claimed.
      expect(result.files.map((file) => file.relativePath)).toEqual(["art/ok.jpg"]);
      expect(result).toMatchObject({ costUsd: 0.07, costEstimated: false });

      for (const [prompt, reason] of [
        ["too big", "too-large"],
        ["not an image", "unavailable"],
        ["missing", "unavailable"],
        ["local", "unavailable"],
        // A public address that sends the request on to a private one, or stands for one.
        ["redirected inside", "unavailable"],
        ["named inside", "unavailable"],
        ["redirected for ever", "unavailable"],
      ] as const) {
        const error = yield* media.generate({ jobId: jobId(), cwd, prompt }).pipe(Effect.flip);
        expect(error, prompt).toMatchObject({ _tag: "MediaProviderError", reason });
      }
      expect(yield* listFolder(cwd, "art")).toEqual(["ok.jpg"]);
      // The provider charged for every request, saved or not.
      expect((yield* media.overview).usage).toMatchObject({ spentUsd: 0.56, images: 1 });
      expect(fetched.filter((url) => !url.startsWith("https://cdn.studio.example/"))).toEqual([
        "https://files.studio.example/ok.jpg",
      ]);
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) =>
                Effect.succeed({
                  images: [
                    {
                      kind: "url",
                      url:
                        request.prompt === "local"
                          ? "https://127.0.0.1/a.png"
                          : request.prompt === "named inside"
                            ? "https://inside.studio.example/a.png"
                            : `https://cdn.studio.example/${encodeURIComponent(request.prompt)}.png`,
                    },
                  ],
                  costUsd: 0.07,
                  seed: undefined,
                }),
            }),
          ],
          http: (url) => {
            fetched.push(url);
            const image = { headers: { "content-type": "image/png" } };
            const moved = (location: string) =>
              new Response(null, { status: 302, headers: { location } });
            if (url.endsWith("/ok.png")) return moved("https://files.studio.example/ok.jpg");
            if (url.includes("redirected%20inside")) return moved("http://169.254.169.254/a.png");
            if (url.includes("for%20ever")) return moved(url);
            if (url.includes("too%20big")) {
              return new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), image);
            }
            if (url.includes("not%20an%20image")) {
              return new Response("<html>", { headers: { "content-type": "text/html" } });
            }
            if (url.includes("missing")) return new Response("", { status: 404 });
            return new Response(JPEG, image);
          },
        }),
      ),
    );
  });

  it.effect.each<
    [
      string,
      { monthly: number; perRequest: number; price: number | null; count: number },
      "request" | "month" | null,
    ]
  >([
    ["within both limits", { monthly: 1, perRequest: 0.5, price: 0.1, count: 3 }, null],
    [
      "exactly at the limit for one request",
      { monthly: 1, perRequest: 0.3, price: 0.1, count: 3 },
      null,
    ],
    [
      "over the limit for one request",
      { monthly: 1, perRequest: 0.3, price: 0.1, count: 4 },
      "request",
    ],
    ["exactly at the month's limit", { monthly: 0.7, perRequest: 0.5, price: 0.1, count: 3 }, null],
    ["over the month's limit", { monthly: 0.69, perRequest: 0.5, price: 0.1, count: 3 }, "month"],
    ["with images turned off", { monthly: 5, perRequest: 0, price: 0.1, count: 1 }, "request"],
    ["with no month's allowance", { monthly: 0, perRequest: 0.5, price: 0.1, count: 1 }, "month"],
    // A model without a published price holds the whole limit for one request.
    [
      "unpriced with room for a whole request",
      { monthly: 0.9, perRequest: 0.5, price: null, count: 1 },
      null,
    ],
    [
      "unpriced without that room",
      { monthly: 0.8, perRequest: 0.5, price: null, count: 1 },
      "month",
    ],
  ])("checks a request %s before any provider call", ([, setup, refused]) => {
    let calls = 0;
    const counting = (models: ReadonlyArray<MediaImageModel>) =>
      adapter({
        models,
        run: (request) => {
          calls++;
          return adapter().run(request);
        },
      });
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const sql = yield* SqlClient.SqlClient;
      const month = DateTime.formatIso(yield* DateTime.now).slice(0, 7);
      yield* sql`
        INSERT INTO media_generations (
          generation_id, job_id, created_at, month, workspace_root, relative_path, kind,
          provider, model, prompt, cost_usd, cost_estimated
        ) VALUES (
          'earlier', 'earlier', ${`${month}-01T00:00:00.000Z`}, ${month}, ${cwd}, 'media/a.png',
          'generate', 'studio', 'draw', 'earlier', 0.4, 1
        )
      `;
      const outcome = yield* media
        .generate({ jobId: jobId(), cwd, prompt: "now", count: setup.count })
        .pipe(Effect.result);
      if (refused === null) {
        expect(outcome._tag).toBe("Success");
        expect(calls).toBe(1);
      } else {
        expect(outcome._tag === "Failure" ? outcome.failure : undefined).toMatchObject({
          _tag: "MediaLimitError",
          scope: refused,
          spentUsd: 0.4,
        });
        expect(calls).toBe(0);
        expect((yield* media.overview).usage.spentUsd).toBe(0.4);
      }
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [counting([model({ estimatedUsdPerImage: setup.price })])],
          media: { monthlyLimitUsd: setup.monthly, perRequestLimitUsd: setup.perRequest },
        }),
      ),
    );
  });

  it.effect("lets only one of two requests made together take the last of the limit", () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let calls = 0;
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const ask = (prompt: string) =>
        media.generate({ jobId: jobId(prompt), cwd, prompt, count: 3 }).pipe(Effect.result);
      const fibers = yield* Effect.forEach(["one", "two"], (prompt) =>
        Effect.forkChild(ask(prompt)),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      const outcomes = yield* Effect.forEach(fibers, Fiber.join);
      expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual(["Failure", "Success"]);
      expect(
        outcomes.flatMap((outcome) => (outcome._tag === "Failure" ? [outcome.failure] : [])),
      ).toMatchObject([{ _tag: "MediaLimitError", scope: "month" }]);
      expect(calls).toBe(1);
      expect((yield* media.overview).usage).toMatchObject({ spentUsd: 0.3, images: 3 });
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) => {
                calls++;
                return Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(adapter().run(request)),
                );
              },
            }),
          ],
          // Room for one request of $0.30, not two.
          media: { monthlyLimitUsd: 0.5, perRequestLimitUsd: 0.5 },
        }),
      ),
    );
  });

  it.effect.each<[string, { stops: boolean }]>([
    ["a provider that stops gives the allowance back", { stops: true }],
    ["a provider that works on is counted at the estimate", { stops: false }],
  ])("cancels a running job: %s", ([, { stops }]) => {
    const started = Deferred.makeUnsafe<void>();
    const stopped = Deferred.makeUnsafe<void>();
    let hang = true;
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const events = yield* collectEvents;
      const id = jobId();
      const fiber = yield* media
        .generate({ jobId: id, cwd, prompt: "slow", count: 3 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(yield* media.cancel(id)).toBe(true);
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        _tag: "MediaCancelledError",
      });
      expect(yield* Deferred.isDone(stopped)).toBe(true);
      expect(events.map((event) => event.phase)).toEqual(["queued", "cancelled"]);
      expect(yield* media.cancel(id)).toBe(false);
      expect((yield* media.overview).usage).toMatchObject({
        spentUsd: stops ? 0 : 0.3,
        images: 0,
      });

      hang = false;
      const next = yield* media
        .generate({ jobId: id, cwd, prompt: "quick", count: 3 })
        .pipe(Effect.result);
      if (stops) expect(next._tag === "Success" ? next.success.files : []).toHaveLength(3);
      else {
        expect(next._tag === "Failure" ? next.failure : undefined).toMatchObject({
          _tag: "MediaLimitError",
          scope: "month",
        });
      }
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) =>
                hang
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        (stops ? request.charged(0) : Effect.void).pipe(
                          Effect.andThen(Deferred.succeed(stopped, undefined)),
                        ),
                      ),
                    )
                  : adapter().run(request),
            }),
          ],
          media: { monthlyLimitUsd: 0.3, perRequestLimitUsd: 0.3 },
        }),
      ),
    );
  });

  it.effect.each<[string, number | undefined, { spentUsd: number; estimated: number }]>([
    ["at its estimate when the provider says nothing", undefined, { spentUsd: 0.2, estimated: 1 }],
    ["at what the provider charged", 0.02, { spentUsd: 0.02, estimated: 0 }],
  ])("counts a request that failed after the provider took it %s", ([, charged, expected]) =>
    Effect.gen(function* () {
      const media = yield* Media.Media;
      const sql = yield* SqlClient.SqlClient;
      const cwd = yield* workspace;
      const error = yield* media
        .generate({ jobId: jobId(), cwd, prompt: "a kite", count: 2 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MediaProviderError", reason: "unavailable" });
      expect((yield* media.overview).usage).toMatchObject({
        spentUsd: expected.spentUsd,
        images: 0,
      });
      expect(yield* sql`SELECT cost_estimated AS estimated FROM media_generations`).toEqual([
        { estimated: expected.estimated },
      ]);
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) =>
                (charged === undefined ? Effect.void : request.charged(charged)).pipe(
                  Effect.andThen(Effect.fail(mediaFailure("studio", "unavailable"))),
                ),
            }),
          ],
        }),
      ),
    ),
  );

  it.effect("finishes and records a job whose caller went away", () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const subscribed = yield* Deferred.make<void>();
      const completed = yield* media.jobs.pipe(
        Stream.onStart(Deferred.succeed(subscribed, undefined)),
        Stream.filter((event) => event.phase === "completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const caller = yield* media
        .generate({ jobId: jobId(), cwd, prompt: "a kite" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(completed);
      expect(yield* listFolder(cwd)).toEqual(["a-kite.png"]);
      expect((yield* media.overview).usage).toMatchObject({ spentUsd: 0.1, images: 1 });
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(adapter().run(request)),
                ),
            }),
          ],
        }),
      ),
    );
  });

  it.effect("answers that nothing was cancelled once the provider has answered", () => {
    const downloading = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const id = jobId();
      const fiber = yield* media
        .generate({ jobId: id, cwd, prompt: "a kite" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(downloading);
      expect(yield* media.cancel(id)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fiber)).files).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: () =>
                Effect.succeed({
                  images: [{ kind: "url", url: "https://cdn.studio.example/a.png" }],
                  costUsd: undefined,
                  seed: undefined,
                }),
            }),
          ],
          http: () =>
            Deferred.succeed(downloading, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(new Response(PNG, { headers: { "content-type": "image/png" } })),
            ),
        }),
      ),
    );
  });

  it.effect("edits from a file in the workspace with a model that can", () => {
    const requests: Array<MediaAdapterRequest> = [];
    return Effect.gen(function* () {
      const media = yield* Media.Media;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* workspace;
      yield* fileSystem.writeFile(path.join(cwd, "photo.png"), PNG);
      yield* fileSystem.writeFile(path.join(cwd, "mask.png"), PNG);
      yield* fileSystem.writeFileString(path.join(cwd, "notes.txt"), "not an image");
      yield* fileSystem.writeFile(path.join(cwd, "huge.png"), new Uint8Array(64));
      const edit = { cwd, prompt: "make the sky pink", sourcePath: "photo.png" };

      const result = yield* media.edit({ ...edit, jobId: jobId(), maskPath: "mask.png" });
      // The default is the cheapest model, which cannot edit, so the one that can is used.
      expect(result).toMatchObject({ model: "retouch", costUsd: 0.2 });
      expect(requests[0]).toMatchObject({
        source: { mimeType: "image/png" },
        mask: { mimeType: "image/png" },
      });
      expect(Array.from(requests[0]!.source!.bytes)).toEqual(Array.from(PNG));
      expect(Array.from(yield* fileSystem.readFile(path.join(cwd, "photo.png")))).toEqual(
        Array.from(PNG),
      );
      expect(
        yield* media.imageRecord({ cwd, relativePath: result.files[0]!.relativePath }),
      ).toMatchObject({ kind: "edit", sourcePath: "photo.png", maskPath: "mask.png" });

      for (const [change, reason] of [
        [{ sourcePath: "gone.png" }, "source"],
        [{ sourcePath: "notes.txt" }, "source"],
        [{ sourcePath: "huge.png" }, "source"],
        [{ sourcePath: "../outside.png" }, "source"],
        [{ aspectRatio: "16:9" as const }, "unsupported"],
        [
          { model: MediaModelId.make("draw"), provider: MediaProviderId.make("studio") },
          "unsupported",
        ],
        [{ model: MediaModelId.make("draw") }, "model"],
        [{ count: 5 }, "unsupported"],
        // Refused before the provider is paid for a result that could not be saved.
        [{ folder: "../outside" }, "save"],
        [{ folder: "/tmp/outside" }, "save"],
      ] as const) {
        const error = yield* media.edit({ ...edit, jobId: jobId(), ...change }).pipe(Effect.flip);
        expect(error, JSON.stringify(change)).toMatchObject({
          _tag: "MediaRequestError",
          reason,
        });
      }
      expect(requests).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) => {
                requests.push(request);
                return adapter().run(request);
              },
            }),
          ],
        }),
      ),
    );
  });

  it.effect("keeps the key out of a provider's error and out of the job's events", () =>
    Effect.gen(function* () {
      const media = yield* Media.Media;
      const cwd = yield* workspace;
      const events = yield* collectEvents;
      const error = yield* media
        .generate({ jobId: jobId(), cwd, prompt: "a kite" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "key-rejected", detail: "Bad key [key] given" });
      expect(events.at(-1)).toMatchObject({ phase: "failed" });
      expect(JSON.stringify([error, error.message, events])).not.toContain(KEY);
      expect((yield* media.overview).usage.spentUsd).toBe(0);
    }).pipe(
      Effect.provide(
        layerWith({
          adapters: [
            adapter({
              run: (request) =>
                request
                  .charged(0)
                  .pipe(
                    Effect.andThen(
                      Effect.fail(mediaFailure("studio", "key-rejected", `Bad key ${KEY} given`)),
                    ),
                  ),
            }),
          ],
        }),
      ),
    ),
  );
});
