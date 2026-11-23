import type { MediaAspectRatio, MediaImageModel } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import {
  connectorToken,
  dataUri,
  jsonBody,
  type MediaAdapter,
  type MediaAdapterRequest,
  mediaFailure,
  statusFailure,
  transportFailure,
} from "./MediaAdapter.ts";

const ID = "fal";
const QUEUE_ORIGIN = "https://queue.fal.run";
const REQUEST_TIMEOUT = "30 seconds";
const POLL_INTERVAL = "1 second";
/** How long a job may sit in fal's queue and run before it is cancelled. */
const JOB_TIMEOUT = "5 minutes";

const SQUARE_SIZES: Readonly<Record<MediaAspectRatio, string>> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "3:4": "portrait_4_3",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
};
const ALL_RATIOS = Object.keys(SQUARE_SIZES) as ReadonlyArray<MediaAspectRatio>;

interface FalModel extends MediaImageModel {
  /** The model's own input, which differs from one fal model to the next. */
  readonly input: (request: MediaAdapterRequest) => Record<string, unknown>;
}

const common = (request: MediaAdapterRequest) => ({
  prompt: request.prompt,
  num_images: request.count,
  ...(request.seed === undefined ? {} : { seed: request.seed }),
});

// Prices are fal's list prices for an image of one megapixel, the size asked for here.
const MODELS: ReadonlyArray<FalModel> = [
  {
    id: "fal-ai/flux/schnell",
    name: "FLUX.1 schnell",
    textToImage: true,
    imageEdit: false,
    mask: false,
    aspectRatios: ALL_RATIOS,
    maxCount: 4,
    estimatedUsdPerImage: 0.003,
    input: (request) => ({
      ...common(request),
      image_size: SQUARE_SIZES[request.aspectRatio ?? "1:1"],
    }),
  },
  {
    id: "fal-ai/flux-pro/kontext",
    name: "FLUX.1 Kontext",
    textToImage: false,
    imageEdit: true,
    mask: false,
    aspectRatios: ALL_RATIOS,
    maxCount: 4,
    estimatedUsdPerImage: 0.04,
    input: (request) => ({
      ...common(request),
      ...(request.source === undefined ? {} : { image_url: dataUri(request.source) }),
      ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    }),
  },
  {
    id: "fal-ai/flux-pro/v1/fill",
    name: "FLUX.1 Fill",
    textToImage: false,
    imageEdit: true,
    mask: true,
    // The result has the source's shape.
    aspectRatios: [],
    maxCount: 4,
    estimatedUsdPerImage: 0.05,
    input: (request) => ({
      ...common(request),
      ...(request.source === undefined ? {} : { image_url: dataUri(request.source) }),
      ...(request.mask === undefined ? {} : { mask_url: dataUri(request.mask) }),
    }),
  },
];

const Submitted = Schema.Struct({
  request_id: Schema.String,
  status_url: Schema.optional(Schema.String),
  response_url: Schema.optional(Schema.String),
  cancel_url: Schema.optional(Schema.String),
});
const Status = Schema.Struct({
  status: Schema.String,
  queue_position: Schema.optional(Schema.NullOr(Schema.Number)),
});
const Output = Schema.Struct({
  images: Schema.Array(Schema.Struct({ url: Schema.String })),
  seed: Schema.optional(Schema.NullOr(Schema.Number)),
  has_nsfw_concepts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Boolean))),
});
const decodeSubmitted = Schema.decodeUnknownOption(Submitted);
const decodeStatus = Schema.decodeUnknownOption(Status);
const decodeOutput = Schema.decodeUnknownOption(Output);

/** fal answers with `detail` as text, or as a list of validation problems with a `type`. */
const errorDetail = (body: unknown): { readonly text: string; readonly types: string } => {
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
  if (typeof detail === "string") return { text: detail, types: "" };
  if (!Array.isArray(detail)) return { text: "", types: "" };
  const field = (name: string) =>
    detail
      .map((entry: unknown) =>
        typeof entry === "object" && entry !== null && name in entry
          ? String((entry as Record<string, unknown>)[name])
          : "",
      )
      .filter((value) => value !== "")
      .join("; ");
  return { text: field("msg"), types: field("type") };
};

const responseFailure = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const { text, types } = errorDetail(yield* jsonBody(response));
  if (/content_policy|safety|nsfw/i.test(`${types} ${text}`)) {
    return mediaFailure(ID, "content-refused", text);
  }
  // fal locks an account that ran out of credit and answers 403, as it does for a bad key.
  if (response.status === 403 && /balance|billing|locked/i.test(text)) {
    return mediaFailure(ID, "out-of-credit");
  }
  const reason = statusFailure(response.status);
  return mediaFailure(ID, reason, reason === "unavailable" ? text : undefined);
});

/** The address fal named for a request, or the documented one when it named none on its queue. */
const requestUrl = (
  named: string | undefined,
  modelId: string,
  requestId: string,
  tail: string,
) => {
  if (named?.startsWith(`${QUEUE_ORIGIN}/`) === true) return named;
  // Requests live under the app, which is the model id without its sub-path.
  const app = modelId.split("/").slice(0, 2).join("/");
  return `${QUEUE_ORIGIN}/${app}/requests/${encodeURIComponent(requestId)}${tail}`;
};

const run: MediaAdapter["run"] = Effect.fn("FalMedia.run")(function* (request) {
  const http = yield* HttpClient.HttpClient;
  const model = MODELS.find((candidate) => candidate.id === request.model.id);
  if (model === undefined) return yield* mediaFailure(ID, "unavailable");
  const send = (outgoing: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(
        outgoing.pipe(
          HttpClientRequest.setHeader("authorization", `Key ${Redacted.value(request.apiKey)}`),
        ),
      )
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(transportFailure(ID)));

  const submitResponse = yield* send(
    HttpClientRequest.post(`${QUEUE_ORIGIN}/${model.id}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(model.input(request)),
    ),
  );
  if (submitResponse.status !== 200) return yield* yield* responseFailure(submitResponse);
  const submitted = decodeSubmitted(yield* jsonBody(submitResponse));
  if (submitted._tag === "None") return yield* mediaFailure(ID, "unavailable");
  const { request_id: requestId } = submitted.value;
  const address = (named: string | undefined, tail: string) =>
    requestUrl(named, model.id, requestId, tail);

  const cancel = send(HttpClientRequest.put(address(submitted.value.cancel_url, "/cancel"))).pipe(
    Effect.ignore,
  );

  const wait: Effect.Effect<void, ReturnType<typeof mediaFailure>> = Effect.gen(function* () {
    let lastReported = "";
    while (true) {
      const response = yield* send(
        HttpClientRequest.get(address(submitted.value.status_url, "/status")),
      );
      // 202 is how fal answers while the request is still queued or running.
      if (response.status !== 200 && response.status !== 202) {
        return yield* yield* responseFailure(response);
      }
      const status = decodeStatus(yield* jsonBody(response));
      if (status._tag === "None") return yield* mediaFailure(ID, "unavailable");
      if (status.value.status === "COMPLETED") return;
      const queued = status.value.status === "IN_QUEUE";
      const position = queued ? status.value.queue_position : undefined;
      const queuePosition = typeof position === "number" ? Math.max(0, position) : undefined;
      const reported = `${queued}:${queuePosition}`;
      if (reported !== lastReported) {
        lastReported = reported;
        yield* request.progress({
          phase: queued ? "queued" : "running",
          ...(queuePosition === undefined ? {} : { queuePosition }),
        });
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });
  yield* wait.pipe(
    Effect.timeoutOrElse({
      duration: JOB_TIMEOUT,
      orElse: () => cancel.pipe(Effect.andThen(Effect.fail(mediaFailure(ID, "timed-out")))),
    }),
    Effect.onInterrupt(() => cancel),
  );

  // A request that failed is also COMPLETED: its result is then the error.
  const resultResponse = yield* send(
    HttpClientRequest.get(address(submitted.value.response_url, "")),
  );
  if (resultResponse.status !== 200) return yield* yield* responseFailure(resultResponse);
  const output = decodeOutput(yield* jsonBody(resultResponse));
  if (output._tag === "None") return yield* mediaFailure(ID, "unavailable");
  const flagged = output.value.has_nsfw_concepts ?? [];
  const images = output.value.images.filter((_, index) => flagged[index] !== true);
  if (images.length === 0) {
    return yield* mediaFailure(
      ID,
      output.value.images.length > 0 ? "content-refused" : "unavailable",
    );
  }
  return {
    images: images.map((image) => ({ kind: "url" as const, url: image.url })),
    // fal's result carries no price; the service records the estimate.
    costUsd: undefined,
    seed: output.value.seed ?? undefined,
  };
});

export const falMediaAdapter: MediaAdapter = {
  id: ID,
  name: "fal",
  setup: {
    where: "connectors",
    hint: "Add the fal connector with your API key. Images use the same key.",
  },
  keyUrl: "https://fal.ai/dashboard/keys",
  // Each entry is listed without its request builder.
  models: MODELS.map(({ input: _input, ...model }) => model),
  key: connectorToken("fal"),
  run,
};
