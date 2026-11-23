import type { MediaAspectRatio, MediaImageModel } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  connectorToken,
  dataUri,
  jsonBody,
  type MediaAdapter,
  type MediaAdapterRequest,
  MEBIBYTE,
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
/** How often in a row a question about an accepted job may go unanswered before it is given up. */
const MAX_TRIES = 5;
/** fal answers with short JSON: the images themselves are fetched from the addresses it names. */
const MAX_ANSWER_BYTES = MEBIBYTE;

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

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

const answerFailure = ({ status, body }: Answer) => {
  const { text, types } = errorDetail(body);
  if (/content_policy|safety|nsfw/i.test(`${types} ${text}`)) {
    return mediaFailure(ID, "content-refused", text);
  }
  // fal locks an account that ran out of credit and answers 403, as it does for a bad key.
  if (status === 403 && /balance|billing|locked/i.test(text)) {
    return mediaFailure(ID, "out-of-credit");
  }
  const reason = statusFailure(status);
  return mediaFailure(ID, reason, reason === "unavailable" ? text : undefined);
};

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
  // One limit covers the answer's headers and its body, so a body that never ends cannot hold a job.
  const send = (outgoing: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(
        outgoing.pipe(
          HttpClientRequest.setHeader("authorization", `Key ${Redacted.value(request.apiKey)}`),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          jsonBody(response, MAX_ANSWER_BYTES).pipe(
            Effect.map((body): Answer => ({ status: response.status, body })),
          ),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(transportFailure(ID)),
      );

  const submitAnswer = yield* send(
    HttpClientRequest.post(`${QUEUE_ORIGIN}/${model.id}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(model.input(request)),
    ),
  ).pipe(
    // A request that failed at once was not taken. One that timed out may have been.
    Effect.tapError((error) => (error.reason === "timed-out" ? Effect.void : request.charged(0))),
  );
  if (submitAnswer.status !== 200) {
    yield* request.charged(0);
    return yield* answerFailure(submitAnswer);
  }
  const submitted = decodeSubmitted(submitAnswer.body);
  if (submitted._tag === "None") return yield* mediaFailure(ID, "unavailable");
  const { request_id: requestId } = submitted.value;
  const address = (named: string | undefined, tail: string) =>
    requestUrl(named, model.id, requestId, tail);

  /**
   * Asks about the accepted job, and asks again when the question got no usable answer: fal goes
   * on working, and bills, whether or not one status or result request reaches it.
   */
  const ask = Effect.fnUntraced(function* <A>(
    url: string,
    read: (answer: Answer) => A | undefined,
    refused: (answer: Answer) => Effect.Effect<void>,
  ) {
    for (let attempt = 1; ; attempt++) {
      const answer = yield* send(HttpClientRequest.get(url)).pipe(Effect.result);
      let failure = mediaFailure(ID, "unavailable");
      if (answer._tag === "Failure") {
        failure = answer.failure;
      } else if (answer.success.status === 200 || answer.success.status === 202) {
        const value = read(answer.success);
        if (value !== undefined) return value;
      } else {
        const { status } = answer.success;
        failure = answerFailure(answer.success);
        if (status < 500 && status !== 408 && status !== 429) {
          yield* refused(answer.success);
          return yield* failure;
        }
      }
      if (attempt >= MAX_TRIES) return yield* failure;
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  let begun = false;
  // fal stops a request that is still in its queue. One it has begun runs on and is billed.
  const cancel = send(HttpClientRequest.put(address(submitted.value.cancel_url, "/cancel"))).pipe(
    Effect.flatMap((answer) =>
      !begun && (answer.status === 200 || answer.status === 202) ? request.charged(0) : Effect.void,
    ),
    Effect.ignore,
  );

  const wait = Effect.gen(function* () {
    let lastReported = "";
    while (true) {
      // 202 is how fal answers while the request is still queued or running.
      const status = yield* ask(
        address(submitted.value.status_url, "/status"),
        (answer) => Option.getOrUndefined(decodeStatus(answer.body)),
        () => Effect.void,
      );
      const queued = status.status === "IN_QUEUE";
      if (!queued) begun = true;
      if (status.status === "COMPLETED") return;
      const position = queued ? status.queue_position : undefined;
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
      orElse: () => Effect.fail(mediaFailure(ID, "timed-out")),
    }),
    // However the wait ends short of a result, the job is not left running at fal.
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cancel)),
  );

  // A request that failed is also COMPLETED: its result is then the error.
  const output = yield* ask(
    address(submitted.value.response_url, ""),
    (answer) =>
      answer.status === 200 ? Option.getOrUndefined(decodeOutput(answer.body)) : undefined,
    // fal bills a request that made a result, not one it turned down as invalid.
    (answer) => (answer.status === 400 || answer.status === 422 ? request.charged(0) : Effect.void),
  );
  const flagged = output.has_nsfw_concepts ?? [];
  const images = output.images.filter((_, index) => flagged[index] !== true);
  if (images.length === 0) {
    return yield* mediaFailure(ID, output.images.length > 0 ? "content-refused" : "unavailable");
  }
  return {
    images: images.map((image) => ({ kind: "url" as const, url: image.url })),
    // fal's result carries no price; the service records the estimate.
    costUsd: undefined,
    seed: output.seed ?? undefined,
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
