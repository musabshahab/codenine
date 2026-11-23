import { isOpenRouterBaseUrl } from "@codenine/shared/openRouter";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { parseBase64DataUrl } from "../imageMime.ts";
import {
  claudeAccountToken,
  dataUri,
  jsonBody,
  type MediaAdapter,
  type MediaAdapterImage,
  MEBIBYTE,
  mediaFailure,
  MediaLimits,
  statusFailure,
  transportFailure,
} from "./MediaAdapter.ts";

const ID = "openrouter";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
/** The answer carries the image itself, so it comes only once the image is made. */
const REQUEST_TIMEOUT = "3 minutes";

const ErrorBody = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  message: Schema.optional(Schema.String),
});
const Completion = Schema.Struct({
  error: Schema.optional(ErrorBody),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        native_finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        error: Schema.optional(ErrorBody),
        message: Schema.optional(
          Schema.Struct({
            images: Schema.optional(
              Schema.Array(Schema.Struct({ image_url: Schema.Struct({ url: Schema.String }) })),
            ),
          }),
        ),
      }),
    ),
  ),
  usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.NullOr(Schema.Number)) })),
});
const decodeCompletion = Schema.decodeUnknownOption(Completion);

const REFUSAL = /content_filter|safety|prohibited|moderat|blocklist/i;

const errorFailure = (status: number, error: typeof ErrorBody.Type | undefined) => {
  const code = Number(error?.code);
  const text = error?.message ?? "";
  // OpenRouter answers 403 when its moderation flags the input, and 401 for a bad key.
  if (REFUSAL.test(text) || (status === 403 && /flag/i.test(text))) {
    return mediaFailure(ID, "content-refused", text);
  }
  const reason = statusFailure(Number.isInteger(code) && code >= 400 ? code : status);
  return mediaFailure(ID, reason, reason === "unavailable" ? text : undefined);
};

const run: MediaAdapter["run"] = Effect.fn("OpenRouterMedia.run")(function* (request) {
  const http = yield* HttpClient.HttpClient;
  // Base64 is a third longer than the image it carries.
  const maxAnswerBytes = Math.ceil(((yield* MediaLimits).maxImageBytes * 4) / 3) + MEBIBYTE;
  yield* request.progress({ phase: "running" });
  const answer = yield* http
    .execute(
      HttpClientRequest.post(CHAT_URL).pipe(
        HttpClientRequest.bearerToken(Redacted.value(request.apiKey)),
        HttpClientRequest.bodyJsonUnsafe({
          model: request.model.id,
          modalities: ["image", "text"],
          messages: [
            {
              role: "user",
              content:
                request.source === undefined
                  ? request.prompt
                  : [
                      { type: "text", text: request.prompt },
                      { type: "image_url", image_url: { url: dataUri(request.source) } },
                    ],
            },
          ],
          ...(request.aspectRatio === undefined
            ? {}
            : { image_config: { aspect_ratio: request.aspectRatio } }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          usage: { include: true },
        }),
      ),
    )
    .pipe(
      Effect.mapError(transportFailure(ID)),
      // A request that failed at once was not taken. One still waiting when time ran out was.
      Effect.tapError(() => request.charged(0)),
      Effect.flatMap((response) =>
        jsonBody(response, maxAnswerBytes).pipe(
          Effect.map((body) => ({ status: response.status, body })),
        ),
      ),
      // One limit covers the headers and the body, which holds the image and may come slowly.
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(mediaFailure(ID, "timed-out")),
      }),
    );
  const body = decodeCompletion(answer.body);
  const completion = body._tag === "Some" ? body.value : undefined;
  if (answer.status !== 200) {
    yield* request.charged(0);
    return yield* errorFailure(answer.status, completion?.error);
  }
  const cost = completion?.usage?.cost ?? undefined;
  const choice = completion?.choices?.[0];
  const error = completion?.error ?? choice?.error;
  if (error !== undefined) {
    yield* request.charged(cost ?? 0);
    return yield* errorFailure(answer.status, error);
  }

  const images: Array<MediaAdapterImage> = [];
  for (const image of choice?.message?.images ?? []) {
    const { url } = image.image_url;
    const inline = parseBase64DataUrl(url);
    if (inline !== null) {
      images.push({
        kind: "bytes",
        bytes: Buffer.from(inline.base64, "base64"),
        mimeType: inline.mimeType,
      });
    } else if (url.startsWith("https://")) {
      images.push({ kind: "url", url });
    }
  }
  if (images.length === 0) {
    // An answer of words alone is still billed, at what OpenRouter says it cost.
    if (cost !== undefined) yield* request.charged(cost);
    const finish = `${choice?.finish_reason ?? ""} ${choice?.native_finish_reason ?? ""}`;
    return yield* mediaFailure(ID, REFUSAL.test(finish) ? "content-refused" : "unavailable");
  }
  return {
    images,
    costUsd: cost,
    seed: request.seed,
  };
});

export const openRouterMediaAdapter: MediaAdapter = {
  id: ID,
  name: "OpenRouter",
  setup: {
    where: "accounts",
    hint: "Add an OpenRouter account with your API key. Images use the same key.",
  },
  keyUrl: "https://openrouter.ai/settings/keys",
  models: [
    {
      id: "google/gemini-2.5-flash-image",
      name: "Gemini 2.5 Flash Image",
      textToImage: true,
      imageEdit: true,
      mask: false,
      aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      // One answer carries one image.
      maxCount: 1,
      estimatedUsdPerImage: 0.04,
    },
  ],
  key: claudeAccountToken(isOpenRouterBaseUrl),
  run,
};
