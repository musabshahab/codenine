import {
  type MediaAspectRatio,
  type MediaImageModel,
  type MediaProvider,
  type MediaProviderFailure,
  MediaProviderError,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type HttpClient, HttpClientResponse } from "effect/http";

import * as ConnectorStore from "../connectors/ConnectorStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export const MEBIBYTE = 1024 * 1024;

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

export interface MediaAdapterInputImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** An image a provider made: where to fetch it, or the bytes it sent in its answer. */
export type MediaAdapterImage =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly mimeType: string };

export interface MediaAdapterRequest {
  /** Redacted so that it prints as a placeholder wherever a request is logged or traced. */
  readonly apiKey: Redacted.Redacted<string>;
  /** One of the adapter's own `models`, already checked against the request. */
  readonly model: MediaImageModel;
  readonly prompt: string;
  readonly aspectRatio: MediaAspectRatio | undefined;
  readonly count: number;
  readonly seed: number | undefined;
  /** Set for an edit. */
  readonly source: MediaAdapterInputImage | undefined;
  readonly mask: MediaAdapterInputImage | undefined;
  readonly progress: (step: {
    readonly phase: "queued" | "running";
    readonly queuePosition?: number;
  }) => Effect.Effect<void>;
  /**
   * What the provider charged for a request that ends without images. Until an adapter says, such
   * a request counts at its estimate: say 0 only where the provider refused or stopped the work.
   */
  readonly charged: (costUsd: number) => Effect.Effect<void>;
}

export interface MediaAdapterResult {
  readonly images: ReadonlyArray<MediaAdapterImage>;
  /** What the provider says it charged for the whole request, when it says. */
  readonly costUsd: number | undefined;
  readonly seed: number | undefined;
}

/**
 * One image provider. The Media service is everything else: limits, files, records and
 * progress. A new provider is one file with one of these, and an entry in `MediaProviders.ts`.
 */
export interface MediaAdapter extends Pick<MediaProvider, "id" | "name" | "setup" | "keyUrl"> {
  readonly models: ReadonlyArray<MediaImageModel>;
  /** The key the user saved for this provider, from wherever Codenine already keeps it. */
  readonly key: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    never,
    ConnectorStore.ConnectorStore | ServerSettings.ServerSettingsService
  >;
  /**
   * Makes the images. Interrupting it must also stop the provider's work where the provider
   * can be told, and call `charged(0)` only when the provider confirmed it had not begun.
   */
  readonly run: (
    request: MediaAdapterRequest,
  ) => Effect.Effect<MediaAdapterResult, MediaProviderError, HttpClient.HttpClient>;
}

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? Option.none() : Option.some(Redacted.make(trimmed));
};

const noKey = Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>());

/** The token pasted into the first connection of a catalogue connector. */
export const connectorToken = Effect.fn("MediaAdapter.connectorToken")(function* (
  catalogId: string,
) {
  const store = yield* ConnectorStore.ConnectorStore;
  for (const connection of yield* store.list) {
    if (connection.catalogId !== catalogId) continue;
    const key = nonEmpty((yield* store.readSecrets(connection.id)).token);
    if (Option.isSome(key)) return key;
  }
  return Option.none();
}, noKey);

/** The token of the first Claude account that is on and sends its requests to a matching address. */
export const claudeAccountToken = Effect.fn("MediaAdapter.claudeAccountToken")(function* (
  matches: (baseUrl: string) => boolean,
) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== "claudeAgent" || instance.enabled === false) continue;
    // A value kept by an outside secret provider is a reference here, not text.
    const variable = (name: string) => {
      const value = instance.environment?.find((entry) => entry.name === name)?.value;
      return typeof value === "string" ? value : undefined;
    };
    if (!matches(variable("ANTHROPIC_BASE_URL") ?? "")) continue;
    const key = nonEmpty(variable("ANTHROPIC_AUTH_TOKEN"));
    if (Option.isSome(key)) return key;
  }
  return Option.none();
}, noKey);

export const mediaFailure = (provider: string, reason: MediaProviderFailure, detail?: string) =>
  new MediaProviderError({
    provider,
    reason,
    ...(detail === undefined || detail.trim() === ""
      ? {}
      : { detail: detail.trim().slice(0, 300) }),
  });

/** A request that got no answer: the provider was not reached, or took too long. */
export const transportFailure = (provider: string) => (cause: unknown) =>
  mediaFailure(provider, Cause.isTimeoutError(cause) ? "timed-out" : "unavailable");

/** What a provider's error status means when its body says nothing more exact. */
export const statusFailure = (status: number): MediaProviderFailure => {
  switch (status) {
    case 401:
    case 403:
      return "key-rejected";
    case 402:
      return "out-of-credit";
    case 408:
    case 504:
      return "timed-out";
    case 413:
      return "too-large";
    case 429:
      return "rate-limited";
    default:
      return "unavailable";
  }
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A response body as JSON, or null when it is not JSON or is larger than `maxBytes`. */
export const jsonBody = (response: HttpClientResponse.HttpClientResponse, maxBytes: number) =>
  Effect.suspend(() => {
    let received = 0;
    return response.stream.pipe(
      Stream.mapEffect((chunk) => {
        received += chunk.byteLength;
        return received > maxBytes ? Effect.fail("too-large") : Effect.succeed(chunk);
      }),
      Stream.runCollect,
      Effect.flatMap((chunks) => decodeJson(Buffer.concat(chunks).toString("utf8"))),
      Effect.orElseSucceed((): unknown => null),
    );
  });

export const dataUri = (image: MediaAdapterInputImage) =>
  `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
