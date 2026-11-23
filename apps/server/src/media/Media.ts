// @effect-diagnostics nodeBuiltinImport:off - record ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  type MediaEditInput,
  type MediaGenerateInput,
  type MediaImageError,
  type MediaImageFile,
  type MediaImageModel,
  type MediaImageRecord,
  type MediaImageRecordInput,
  type MediaImageResult,
  type MediaJobEvent,
  type MediaJobId,
  type MediaModelRef,
  type MediaOverview,
  type MediaUsage,
  MediaCancelledError,
  MediaLimitError,
  MediaModelId,
  MediaProviderError,
  MediaProviderId,
  MediaRequestError,
} from "@codenine/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@codenine/shared/hostClassification";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as ConnectorStore from "../connectors/ConnectorStore.ts";
import * as FileVersions from "../fileVersions/FileVersions.ts";
import * as ServerSettings from "../serverSettings.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import {
  type MediaAdapter,
  type MediaAdapterImage,
  type MediaAdapterInputImage,
  mediaFailure,
  transportFailure,
} from "./MediaAdapter.ts";
import { MediaAdapters } from "./MediaProviders.ts";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_FOLDER = "media";
const MAX_NAME_ATTEMPTS = 500;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** How large an image may be coming in from a provider, and going out to one for an edit. */
export const MediaLimits = Context.Reference<{
  readonly maxImageBytes: number;
  readonly maxSourceBytes: number;
  readonly downloadTimeout: `${number} seconds`;
}>("codenine/media/MediaLimits", {
  defaultValue: () => ({
    maxImageBytes: 20 * MEBIBYTE,
    maxSourceBytes: 10 * MEBIBYTE,
    downloadTimeout: "60 seconds",
  }),
});

export interface MediaRunOptions {
  /** True when an agent asks during its turn, so the files are recorded as that turn's change. */
  readonly duringTurn?: boolean | undefined;
}

/**
 * Images made by outside providers and saved into the workspace. This is the only part of the
 * server that spends the user's money with a provider it was not started for, so every request
 * passes the spending limits here, whoever asks: a client, or an agent through its tools.
 */
export class Media extends Context.Service<
  Media,
  {
    /** Providers with their models, the limits, and this month's spending. Calls no provider. */
    readonly overview: Effect.Effect<MediaOverview>;
    readonly generate: (
      input: MediaGenerateInput,
      options?: MediaRunOptions,
    ) => Effect.Effect<MediaImageResult, MediaImageError>;
    /** Makes new files from an image in the workspace. The source is left as it is. */
    readonly edit: (
      input: MediaEditInput,
      options?: MediaRunOptions,
    ) => Effect.Effect<MediaImageResult, MediaImageError>;
    /** Stops a running job and tells its provider to stop. False when no such job runs. */
    readonly cancel: (jobId: MediaJobId) => Effect.Effect<boolean>;
    /** Every job's steps from now on. */
    readonly jobs: Stream.Stream<MediaJobEvent>;
    /** How the image at a path was made. Null for a file this server did not make. */
    readonly imageRecord: (input: MediaImageRecordInput) => Effect.Effect<MediaImageRecord | null>;
  }
>()("codenine/media/Media") {}

const micros = (usd: number) => Math.round(usd * 1_000_000);
const dollars = (value: number) => value / 1_000_000;

/** A file name from the prompt's first words, so a folder of results can be told apart. */
const mediaFileStem = (prompt: string) => {
  const stem = prompt
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return stem === "" ? "image" : stem;
};

const supports = (model: MediaImageModel, need: { edit: boolean; mask: boolean }) =>
  need.edit ? model.imageEdit && (!need.mask || model.mask) : model.textToImage;

interface Available {
  readonly adapter: MediaAdapter;
  readonly key: Option.Option<Redacted.Redacted<string>>;
}

/** The cheapest model that can do the work, among providers that have a key. */
const cheapest = (
  available: ReadonlyArray<Available>,
  need: { edit: boolean; mask: boolean },
): { readonly adapter: MediaAdapter; readonly model: MediaImageModel } | undefined =>
  available
    .filter((entry) => Option.isSome(entry.key))
    .flatMap(({ adapter }) =>
      adapter.models.filter((model) => supports(model, need)).map((model) => ({ adapter, model })),
    )
    .toSorted(
      (left, right) =>
        (left.model.estimatedUsdPerImage ?? Number.POSITIVE_INFINITY) -
        (right.model.estimatedUsdPerImage ?? Number.POSITIVE_INFINITY),
    )[0];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const connectors = yield* ConnectorStore.ConnectorStore;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const fileVersions = yield* FileVersions.FileVersions;
  const http = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const adapters = yield* MediaAdapters;
  const limits = yield* MediaLimits;
  const scope = yield* Effect.scope;
  const events = yield* PubSub.sliding<MediaJobEvent>(256);
  // One request at a time decides whether it fits, so two cannot both take the last of a limit.
  const admission = yield* Semaphore.make(1);
  let reservedMicros = 0;
  const running = new Map<string, Deferred.Deferred<void>>();

  const mediaSettings = settings.getSettings.pipe(
    Effect.map((current) => current.media),
    Effect.orDie,
  );

  const available = Effect.forEach(adapters, (adapter) =>
    adapter.key.pipe(
      Effect.map((key): Available => ({ adapter, key })),
      Effect.provideService(ConnectorStore.ConnectorStore, connectors),
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    ),
  );

  const currentMonth = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now).slice(0, 7)));

  const usageOf = (month: string) =>
    sql<{ readonly spent: number; readonly images: number }>`
      SELECT COALESCE(SUM(cost_usd), 0) AS spent, COUNT(relative_path) AS images
      FROM media_generations WHERE month = ${month}
    `.pipe(
      Effect.map((rows): MediaUsage => {
        const row = rows[0];
        return {
          month,
          spentUsd: dollars(micros(Number(row?.spent ?? 0))),
          images: Number(row?.images ?? 0),
        };
      }),
      Effect.orDie,
    );

  const usage = currentMonth.pipe(Effect.flatMap(usageOf));

  const effectiveDefault = (
    saved: MediaModelRef | null,
    entries: ReadonlyArray<Available>,
    need: { edit: boolean; mask: boolean },
  ) => {
    const chosen =
      saved === null
        ? undefined
        : entries
            .filter((entry) => Option.isSome(entry.key) && entry.adapter.id === saved.provider)
            .flatMap(({ adapter }) =>
              adapter.models
                .filter((model) => model.id === saved.model && supports(model, need))
                .map((model) => ({ adapter, model })),
            )[0];
    return chosen ?? cheapest(entries, need);
  };

  const overview: Media["Service"]["overview"] = Effect.gen(function* () {
    const entries = yield* available;
    const current = yield* mediaSettings;
    const fallback = effectiveDefault(current.defaultModel, entries, { edit: false, mask: false });
    return {
      providers: entries.map(({ adapter, key }) => ({
        id: MediaProviderId.make(adapter.id),
        name: adapter.name,
        configured: Option.isSome(key),
        setup: adapter.setup,
        keyUrl: adapter.keyUrl,
        models: adapter.models,
      })),
      defaultModel:
        fallback === undefined
          ? null
          : { provider: MediaProviderId.make(fallback.adapter.id), model: fallback.model.id },
      limits: {
        monthlyLimitUsd: current.monthlyLimitUsd,
        perRequestLimitUsd: current.perRequestLimitUsd,
      },
      usage: yield* usage,
    };
  }).pipe(Effect.withSpan("Media.overview"));

  const requestError = (reason: MediaRequestError["reason"], message: string) =>
    new MediaRequestError({ reason, message });

  /** The provider, key and model for a request, or why there is none. */
  const choose = Effect.fn("Media.choose")(function* (
    input: MediaGenerateInput,
    need: { edit: boolean; mask: boolean },
  ) {
    const entries = yield* available;
    const work = need.mask ? "edit with a mask" : need.edit ? "edit an image" : "make an image";
    if (input.provider === undefined && input.model === undefined) {
      if (!entries.some((entry) => Option.isSome(entry.key))) {
        return yield* mediaFailure("", "not-configured");
      }
      const current = yield* mediaSettings;
      const chosen = effectiveDefault(current.defaultModel, entries, need);
      if (chosen === undefined) {
        return yield* requestError(
          "unsupported",
          `No provider with a key has a model that can ${work}.`,
        );
      }
      const key = entries.find((entry) => entry.adapter === chosen.adapter)?.key;
      return { ...chosen, key: Option.getOrThrow(key ?? Option.none()) };
    }
    const entry = entries.find((candidate) => candidate.adapter.id === input.provider);
    const model = entry?.adapter.models.find((candidate) => candidate.id === input.model);
    if (entry === undefined || model === undefined) {
      return yield* requestError(
        "model",
        "Name a provider and one of its models together, or neither to use the default.",
      );
    }
    if (Option.isNone(entry.key)) return yield* mediaFailure(entry.adapter.id, "not-configured");
    if (!supports(model, need)) {
      return yield* requestError("unsupported", `${model.name} cannot ${work}.`);
    }
    return { adapter: entry.adapter, model, key: entry.key.value };
  });

  /**
   * Holds the request's estimated cost against both limits until `release`. Refused requests
   * hold nothing. A model without a published price holds the whole per-request limit.
   */
  const reserve = (model: MediaImageModel, count: number) =>
    admission.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* mediaSettings;
        const perRequest = micros(current.perRequestLimitUsd);
        const request =
          model.estimatedUsdPerImage === null
            ? perRequest
            : micros(model.estimatedUsdPerImage) * count;
        const spent = micros((yield* usage).spentUsd) + reservedMicros;
        const refusal = (scope: MediaLimitError["scope"], limit: number) =>
          new MediaLimitError({
            scope,
            limitUsd: dollars(limit),
            requestUsd: dollars(request),
            spentUsd: dollars(spent),
          });
        if (perRequest <= 0 || request > perRequest) return yield* refusal("request", perRequest);
        const monthly = micros(current.monthlyLimitUsd);
        if (spent + request > monthly) return yield* refusal("month", monthly);
        reservedMicros += request;
        return {
          estimateUsd: dollars(request),
          release: Effect.sync(() => {
            reservedMicros -= request;
          }),
        };
      }),
    );

  const readInput = Effect.fn("Media.readInput")(function* (cwd: string, relativePath: string) {
    const file = yield* workspaceFileSystem
      .readFileBytes({ cwd, relativePath, maxBytes: limits.maxSourceBytes })
      .pipe(Effect.mapError((cause) => requestError("source", cause.message)));
    if (file.kind === "absent") {
      return yield* requestError("source", `'${relativePath}' was not found in the workspace.`);
    }
    if (file.kind === "too-large") {
      return yield* requestError(
        "source",
        `'${relativePath}' is larger than ${limits.maxSourceBytes / MEBIBYTE} MB, the most an edit can send.`,
      );
    }
    const mimeType = fileHeaderMimeType(file.bytes.subarray(0, 32));
    if (mimeType === undefined || EXTENSIONS[mimeType] === undefined) {
      return yield* requestError("source", `'${relativePath}' is not a PNG, JPEG or WebP image.`);
    }
    return { bytes: file.bytes, mimeType } satisfies MediaAdapterInputImage;
  });

  /** Fetches a result without the provider key, and only from a public HTTPS address. */
  const download = Effect.fn("Media.download")(function* (provider: string, address: string) {
    const url = URL.parse(address);
    if (
      url === null ||
      url.protocol !== "https:" ||
      isLocalLoopbackHost(url.hostname) ||
      isPrivateNetworkHost(url.hostname)
    ) {
      return yield* mediaFailure(provider, "unavailable");
    }
    const response = yield* http
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.timeout(limits.downloadTimeout), Effect.mapError(transportFailure(provider)));
    if (response.status !== 200) return yield* mediaFailure(provider, "unavailable");
    if (!(response.headers["content-type"] ?? "").toLowerCase().startsWith("image/")) {
      return yield* mediaFailure(provider, "unavailable", "The result was not an image.");
    }
    if (Number(response.headers["content-length"]) > limits.maxImageBytes) {
      return yield* mediaFailure(provider, "too-large");
    }
    let received = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapError(transportFailure(provider)),
      Stream.mapEffect((chunk) => {
        received += chunk.byteLength;
        return received > limits.maxImageBytes
          ? Effect.fail(mediaFailure(provider, "too-large"))
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
      Effect.timeoutOrElse({
        duration: limits.downloadTimeout,
        orElse: () => Effect.fail(mediaFailure(provider, "timed-out")),
      }),
    );
    return Buffer.concat(chunks);
  });

  const imageBytes = Effect.fn("Media.imageBytes")(function* (
    provider: string,
    image: MediaAdapterImage,
  ) {
    const bytes = image.kind === "bytes" ? image.bytes : yield* download(provider, image.url);
    if (bytes.byteLength > limits.maxImageBytes) return yield* mediaFailure(provider, "too-large");
    // The type comes from the bytes: what a provider calls a file does not decide its extension.
    const mimeType = fileHeaderMimeType(bytes.subarray(0, 32));
    const extension = mimeType === undefined ? undefined : EXTENSIONS[mimeType];
    if (mimeType === undefined || extension === undefined) {
      return yield* mediaFailure(provider, "unavailable", "The result was not an image.");
    }
    return { bytes, mimeType, extension };
  });

  /** Writes under the first name that is free: `stem.png`, then `stem-2.png`, and so on. */
  const saveImage = Effect.fn("Media.saveImage")(function* (input: {
    readonly cwd: string;
    readonly folder: string;
    readonly stem: string;
    readonly extension: string;
    readonly bytes: Uint8Array;
    readonly duringTurn: boolean;
  }) {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const name = `${input.stem}${attempt === 1 ? "" : `-${attempt}`}.${input.extension}`;
      const written = yield* fileVersions
        .writeFileBytes({
          cwd: input.cwd,
          relativePath: `${input.folder}/${name}`,
          bytes: input.bytes,
          // The file system refuses a name that is taken, so two jobs never share one.
          createOnly: true,
          duringTurn: input.duringTurn,
        })
        .pipe(
          Effect.catchTags({ WorkspaceFileConflictError: () => Effect.succeed(null) }),
          Effect.mapError((cause) => requestError("save", cause.message)),
        );
      if (written !== null) {
        return {
          relativePath: written.relativePath,
          version: written.version ?? WorkspaceFileSystem.fileVersion(input.bytes),
        };
      }
    }
    return yield* requestError("save", `'${input.folder}' has too many files named alike.`);
  });

  const emit = (event: MediaJobEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  // Traced by its callers, `Media.generate` and `Media.edit`.
  const run = Effect.fnUntraced(function* (
    kind: "generate" | "edit",
    input: MediaGenerateInput & { readonly sourcePath?: string; readonly maskPath?: string },
    options: MediaRunOptions | undefined,
  ) {
    // Checked first: a result that cannot be saved must not be paid for.
    yield* knownWorkspaces
      .assertContains(input.cwd)
      .pipe(Effect.mapError((cause) => requestError("save", cause.message)));
    const folder = (input.folder ?? DEFAULT_FOLDER).replaceAll("\\", "/").replace(/\/+$/g, "");
    if (path.isAbsolute(folder) || folder.split("/").some((part) => part === ".." || part === "")) {
      return yield* requestError("save", `'${folder}' is not a folder inside the workspace.`);
    }
    const need = { edit: kind === "edit", mask: input.maskPath !== undefined };
    const { adapter, model, key } = yield* choose(input, need);
    const count = input.count ?? 1;
    if (count > model.maxCount) {
      return yield* requestError(
        "unsupported",
        `${model.name} makes at most ${model.maxCount} ${model.maxCount === 1 ? "image" : "images"} in one request.`,
      );
    }
    if (input.aspectRatio !== undefined && !model.aspectRatios.includes(input.aspectRatio)) {
      return yield* requestError(
        "unsupported",
        model.aspectRatios.length === 0
          ? `${model.name} keeps the shape of the image it edits.`
          : `${model.name} makes ${model.aspectRatios.join(", ")}.`,
      );
    }
    const source =
      input.sourcePath === undefined ? undefined : yield* readInput(input.cwd, input.sourcePath);
    const mask =
      input.maskPath === undefined ? undefined : yield* readInput(input.cwd, input.maskPath);
    if (running.has(input.jobId)) {
      return yield* requestError("job", "A job with this id is already running.");
    }
    const cancelled = yield* Deferred.make<void>();
    running.set(input.jobId, cancelled);
    const finished = Effect.sync(() => {
      if (running.get(input.jobId) === cancelled) running.delete(input.jobId);
    });
    const reservation = yield* reserve(model, count).pipe(Effect.onError(() => finished));

    const step = (event: Omit<MediaJobEvent, "jobId" | "cwd" | "kind">) =>
      emit({ jobId: input.jobId, cwd: input.cwd, kind, ...event });
    // A provider's text is the only place a key could come back in, so it is taken out.
    const withoutKey = (error: MediaProviderError) =>
      error.detail === undefined
        ? error
        : new MediaProviderError({
            provider: error.provider,
            reason: error.reason,
            detail: error.detail.replaceAll(Redacted.value(key), "[key]"),
          });

    const job = Effect.gen(function* () {
      yield* step({ phase: "queued" });
      const made = yield* adapter
        .run({
          apiKey: key,
          model,
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          count,
          seed: input.seed,
          source,
          mask,
          progress: step,
        })
        .pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.mapError(withoutKey),
          Effect.raceFirst(
            Deferred.await(cancelled).pipe(Effect.andThen(Effect.fail(new MediaCancelledError()))),
          ),
        );
      // From here the provider has charged, so the rest runs to its end and is recorded.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* step({ phase: "saving" });
          const images = made.images.slice(0, count);
          const stem = mediaFileStem(input.prompt);
          const files: Array<MediaImageFile> = [];
          let failure: MediaImageError | undefined;
          for (const image of images) {
            const saved = yield* imageBytes(adapter.id, image).pipe(
              Effect.flatMap((content) =>
                saveImage({
                  cwd: input.cwd,
                  folder,
                  stem,
                  extension: content.extension,
                  bytes: content.bytes,
                  duringTurn: options?.duringTurn === true,
                }).pipe(
                  Effect.map((written) => ({
                    ...written,
                    mimeType: content.mimeType,
                    byteLength: content.bytes.byteLength,
                  })),
                ),
              ),
              Effect.exit,
            );
            if (Exit.isSuccess(saved)) files.push(saved.value);
            else failure ??= Option.getOrUndefined(Exit.findErrorOption(saved));
          }
          const costUsd = made.costUsd ?? (reservation.estimateUsd / count) * images.length;
          const costEstimated = made.costUsd === undefined;
          const each = images.length === 0 ? 0 : costUsd / images.length;
          const unsaved = images.length - files.length;
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const record = (relativePath: string | null, cost: number) => sql`
            INSERT INTO media_generations (
              generation_id, job_id, created_at, month, workspace_root, relative_path, kind,
              provider, model, prompt, aspect_ratio, seed, cost_usd, cost_estimated,
              source_path, mask_path
            ) VALUES (
              ${NodeCrypto.randomUUID()}, ${input.jobId}, ${createdAt}, ${createdAt.slice(0, 7)},
              ${path.resolve(input.cwd)}, ${relativePath}, ${kind}, ${adapter.id}, ${model.id},
              ${input.prompt}, ${input.aspectRatio ?? null}, ${made.seed ?? input.seed ?? null},
              ${cost}, ${costEstimated ? 1 : 0}, ${input.sourcePath ?? null},
              ${input.maskPath ?? null}
            )
          `;
          yield* Effect.forEach(files, (file) => record(file.relativePath, each), {
            discard: true,
          }).pipe(Effect.orDie);
          if (unsaved > 0 || images.length === 0) {
            yield* record(null, images.length === 0 ? costUsd : each * unsaved).pipe(Effect.orDie);
          }
          if (files.length === 0) {
            return yield* failure ?? mediaFailure(adapter.id, "unavailable");
          }
          return {
            jobId: input.jobId,
            provider: MediaProviderId.make(adapter.id),
            model: MediaModelId.make(model.id),
            files,
            costUsd: dollars(micros(each * files.length)),
            costEstimated,
          };
        }),
      );
    }).pipe(
      Effect.tap((result) =>
        step({ phase: "completed", files: result.files.map((file) => file.relativePath) }),
      ),
      Effect.tapError((error) =>
        error._tag === "MediaCancelledError"
          ? step({ phase: "cancelled" })
          : step({ phase: "failed", message: error.message }),
      ),
      // The record is written before the hold is dropped, so the limit never sees neither.
      Effect.ensuring(reservation.release),
      Effect.ensuring(finished),
    );
    // Not tied to the caller: a client that goes away must not lose an image it paid for.
    const fiber = yield* job.pipe(Effect.forkIn(scope));
    const result = yield* Fiber.join(fiber);
    return { ...result, usage: yield* usage };
  });

  const imageRecord: Media["Service"]["imageRecord"] = Effect.fn("Media.imageRecord")(
    function* (input) {
      const rows = yield* sql<Omit<MediaImageRecord, "costEstimated"> & { costEstimated: number }>`
        SELECT
          relative_path AS "relativePath", kind, provider, model, prompt,
          aspect_ratio AS "aspectRatio", seed, cost_usd AS "costUsd",
          cost_estimated AS "costEstimated", source_path AS "sourcePath",
          mask_path AS "maskPath", created_at AS "createdAt"
        FROM media_generations
        WHERE workspace_root = ${path.resolve(input.cwd)} AND relative_path = ${input.relativePath}
        ORDER BY created_at DESC LIMIT 1
      `.pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined ? null : { ...row, costEstimated: row.costEstimated === 1 };
    },
  );

  return Media.of({
    overview,
    generate: Effect.fn("Media.generate")((input, options) => run("generate", input, options)),
    edit: Effect.fn("Media.edit")((input, options) => run("edit", input, options)),
    cancel: Effect.fn("Media.cancel")((jobId) => {
      const cancelled = running.get(jobId);
      return cancelled === undefined
        ? Effect.succeed(false)
        : Deferred.succeed(cancelled, undefined);
    }),
    jobs: Stream.fromPubSub(events),
    imageRecord,
  });
});

export const layer = Layer.effect(Media, make);
