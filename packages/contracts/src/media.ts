import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const MEDIA_PATH_MAX_LENGTH = 512;
export const MEDIA_PROMPT_MAX_LENGTH = 4000;
/** The most images one request may ask for, whatever the model allows. */
export const MEDIA_MAX_IMAGE_COUNT = 8;

/** An adapter's id, such as `fal`. Open, so a server can offer providers a client has not met. */
export const MediaProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type MediaProviderId = typeof MediaProviderId.Type;

/** A model as its provider names it. */
export const MediaModelId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export type MediaModelId = typeof MediaModelId.Type;

export const MediaModelRef = Schema.Struct({ provider: MediaProviderId, model: MediaModelId });
export type MediaModelRef = typeof MediaModelRef.Type;

export const MediaAspectRatio = Schema.Literals(["1:1", "4:3", "3:4", "16:9", "9:16"]);
export type MediaAspectRatio = typeof MediaAspectRatio.Type;

export const MediaImageModel = Schema.Struct({
  id: MediaModelId,
  name: TrimmedNonEmptyString,
  textToImage: Schema.Boolean,
  imageEdit: Schema.Boolean,
  /** An edit may name the area to change. */
  mask: Schema.Boolean,
  /** Empty when the model chooses the shape itself, as an edit that follows its source does. */
  aspectRatios: Schema.Array(MediaAspectRatio),
  maxCount: PositiveInt,
  /** US dollars for one image, where the provider publishes a price. */
  estimatedUsdPerImage: Schema.NullOr(Schema.Number),
});
export type MediaImageModel = typeof MediaImageModel.Type;

export const MediaProvider = Schema.Struct({
  id: MediaProviderId,
  name: TrimmedNonEmptyString,
  /** A key for it is saved on the server. The key itself never leaves the server. */
  configured: Schema.Boolean,
  /** The settings page that holds its key, and what to do there. */
  setup: Schema.Struct({
    where: Schema.Literals(["connectors", "accounts"]),
    hint: TrimmedNonEmptyString,
  }),
  /** Where the provider hands out keys. */
  keyUrl: TrimmedNonEmptyString,
  models: Schema.Array(MediaImageModel),
});
export type MediaProvider = typeof MediaProvider.Type;

const UsdLimit = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }));

const DEFAULT_MEDIA_MONTHLY_LIMIT_USD = 5;
const DEFAULT_MEDIA_REQUEST_LIMIT_USD = 0.5;

/** The server's media settings. Limits are US dollars; zero turns generation off. */
export const MediaSettings = Schema.Struct({
  monthlyLimitUsd: UsdLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MEDIA_MONTHLY_LIMIT_USD)),
  ),
  perRequestLimitUsd: UsdLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MEDIA_REQUEST_LIMIT_USD)),
  ),
  /** Null picks the cheapest model of a provider that has a key. */
  defaultModel: Schema.NullOr(MediaModelRef).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type MediaSettings = typeof MediaSettings.Type;

export const MediaSettingsPatch = Schema.Struct({
  monthlyLimitUsd: Schema.optionalKey(UsdLimit),
  perRequestLimitUsd: Schema.optionalKey(UsdLimit),
  defaultModel: Schema.optionalKey(Schema.NullOr(MediaModelRef)),
});

export const MediaUsage = Schema.Struct({
  /** The calendar month counted, in UTC, as `YYYY-MM`. */
  month: TrimmedNonEmptyString,
  spentUsd: Schema.Number,
  images: NonNegativeInt,
});
export type MediaUsage = typeof MediaUsage.Type;

export const MediaOverview = Schema.Struct({
  providers: Schema.Array(MediaProvider),
  /** The model a request without one uses now. Null while no provider has a key. */
  defaultModel: Schema.NullOr(MediaModelRef),
  limits: Schema.Struct({ monthlyLimitUsd: Schema.Number, perRequestLimitUsd: Schema.Number }),
  usage: MediaUsage,
});
export type MediaOverview = typeof MediaOverview.Type;

/** Chosen by the caller, so it can follow the job's progress and cancel it. */
export const MediaJobId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type MediaJobId = typeof MediaJobId.Type;

const MediaPath = TrimmedNonEmptyString.check(Schema.isMaxLength(MEDIA_PATH_MAX_LENGTH));

const imageRequestFields = {
  jobId: MediaJobId,
  cwd: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(MEDIA_PROMPT_MAX_LENGTH)),
  /** Both or neither. Without them the default model is used. */
  provider: Schema.optionalKey(MediaProviderId),
  model: Schema.optionalKey(MediaModelId),
  aspectRatio: Schema.optionalKey(MediaAspectRatio),
  count: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(MEDIA_MAX_IMAGE_COUNT))),
  seed: Schema.optionalKey(NonNegativeInt),
  /** A folder inside the workspace. Default: `media`. */
  folder: Schema.optionalKey(MediaPath),
};

export const MediaGenerateInput = Schema.Struct(imageRequestFields);
export type MediaGenerateInput = typeof MediaGenerateInput.Type;

export const MediaEditInput = Schema.Struct({
  ...imageRequestFields,
  /** The image to change, inside the workspace. It is left as it is. */
  sourcePath: MediaPath,
  /** An image of the same size whose white area is what may change. */
  maskPath: Schema.optionalKey(MediaPath),
});
export type MediaEditInput = typeof MediaEditInput.Type;

export const MediaImageFile = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  /** The content version a read of the file returns. */
  version: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type MediaImageFile = typeof MediaImageFile.Type;

export const MediaImageResult = Schema.Struct({
  jobId: MediaJobId,
  provider: MediaProviderId,
  model: MediaModelId,
  files: Schema.Array(MediaImageFile),
  costUsd: Schema.Number,
  /** False when the provider reported what it charged. */
  costEstimated: Schema.Boolean,
  usage: MediaUsage,
});
export type MediaImageResult = typeof MediaImageResult.Type;

export const MediaCancelInput = Schema.Struct({ jobId: MediaJobId });
export type MediaCancelInput = typeof MediaCancelInput.Type;

export const MediaCancelResult = Schema.Struct({
  /** False when no such job was running. */
  cancelled: Schema.Boolean,
});
export type MediaCancelResult = typeof MediaCancelResult.Type;

export const MediaJobPhase = Schema.Literals([
  "queued",
  "running",
  "saving",
  "completed",
  "failed",
  "cancelled",
]);
export type MediaJobPhase = typeof MediaJobPhase.Type;

/** One step of a job. Images are read from the workspace, never sent with the event. */
export const MediaJobEvent = Schema.Struct({
  jobId: MediaJobId,
  cwd: TrimmedNonEmptyString,
  kind: Schema.Literals(["generate", "edit"]),
  phase: MediaJobPhase,
  /** Requests ahead of this one in the provider's queue. */
  queuePosition: Schema.optionalKey(NonNegativeInt),
  /** With `completed`: the saved files, relative to `cwd`. */
  files: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** With `failed`: why. */
  message: Schema.optionalKey(Schema.String),
});
export type MediaJobEvent = typeof MediaJobEvent.Type;

export const MediaImageRecordInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: MediaPath,
});
export type MediaImageRecordInput = typeof MediaImageRecordInput.Type;

/** How a saved image was made, kept so it can be made again or varied. */
export const MediaImageRecord = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  kind: Schema.Literals(["generate", "edit"]),
  provider: MediaProviderId,
  model: MediaModelId,
  prompt: Schema.String,
  aspectRatio: Schema.NullOr(Schema.String),
  seed: Schema.NullOr(Schema.Number),
  costUsd: Schema.Number,
  costEstimated: Schema.Boolean,
  sourcePath: Schema.NullOr(Schema.String),
  maskPath: Schema.NullOr(Schema.String),
  createdAt: TrimmedNonEmptyString,
});
export type MediaImageRecord = typeof MediaImageRecord.Type;

export const MediaProviderFailure = Schema.Literals([
  "not-configured",
  "key-rejected",
  "out-of-credit",
  "content-refused",
  "rate-limited",
  "timed-out",
  "too-large",
  "unavailable",
]);
export type MediaProviderFailure = typeof MediaProviderFailure.Type;

const PROVIDER_FAILURE_TEXT: Readonly<Record<MediaProviderFailure, string>> = {
  "not-configured":
    "No image provider has a key yet. Add one in Settings, under Media, then try again.",
  "key-rejected": "The provider rejected the saved key. Check it in Settings, under Media.",
  "out-of-credit": "The provider account is out of credit. Add credit with the provider.",
  "content-refused": "The provider refused this request because of its content rules.",
  "rate-limited": "The provider is limiting requests right now. Try again in a moment.",
  "timed-out": "The provider took too long to answer, so the request was stopped.",
  "too-large": "The image is larger than can be sent or saved here.",
  unavailable: "The provider could not make the image.",
};

/** A provider could not be used or did not make the image. Nothing was saved. */
export class MediaProviderError extends Schema.TaggedError<MediaProviderError>()(
  "MediaProviderError",
  {
    /** Empty when no provider was chosen, as with nothing configured. */
    provider: Schema.String,
    reason: MediaProviderFailure,
    /** What the provider said, when it helps. */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const text = PROVIDER_FAILURE_TEXT[this.reason];
    return this.detail === undefined || this.detail === "" ? text : `${text} (${this.detail})`;
  }
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** The request would pass a spending limit, so no provider was called. */
export class MediaLimitError extends Schema.TaggedError<MediaLimitError>()("MediaLimitError", {
  scope: Schema.Literals(["request", "month"]),
  limitUsd: Schema.Number,
  /** What this request is estimated to cost. */
  requestUsd: Schema.Number,
  /** Spent this month, with requests still running counted at their estimate. */
  spentUsd: Schema.Number,
}) {
  override get message(): string {
    return this.scope === "request"
      ? `This request is estimated at ${usd(this.requestUsd)}, over the limit of ${usd(this.limitUsd)} for one request. Ask for fewer images or a cheaper model, or raise the limit in Settings, under Media.`
      : `This request is estimated at ${usd(this.requestUsd)}, and ${usd(this.spentUsd)} of this month's ${usd(this.limitUsd)} image limit is spent. Raise the limit in Settings, under Media.`;
  }
}

/** The request cannot be carried out as asked. The message says what to change. */
export class MediaRequestError extends Schema.TaggedError<MediaRequestError>()(
  "MediaRequestError",
  {
    reason: Schema.Literals(["model", "unsupported", "source", "job", "save"]),
    message: TrimmedNonEmptyString,
  },
) {}

export class MediaCancelledError extends Schema.TaggedError<MediaCancelledError>()(
  "MediaCancelledError",
  {},
) {
  override get message(): string {
    return "The request was cancelled.";
  }
}

export const MediaImageErrors = [
  MediaProviderError,
  MediaLimitError,
  MediaRequestError,
  MediaCancelledError,
] as const;
export type MediaImageError =
  | MediaProviderError
  | MediaLimitError
  | MediaRequestError
  | MediaCancelledError;
