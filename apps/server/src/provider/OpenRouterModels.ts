import type { ServerProviderModel, ServerProviderModelInfo } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const UNKNOWN_INFO: ServerProviderModelInfo = { usesTools: null, readsImages: null, price: null };

const OpenRouterModels = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const OpenRouterModel = Schema.Struct({
  id: Schema.String,
  supported_parameters: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  architecture: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        input_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  pricing: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        prompt: Schema.optional(Schema.NullOr(Schema.String)),
        completion: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeModels = Schema.decodeUnknownOption(OpenRouterModels);
const decodeModel = Schema.decodeUnknownOption(OpenRouterModel);

// OpenRouter prices in US dollars per token, as text; a negative price means it varies.
const perMillionTokens = (price: string | null | undefined) => {
  const value = price === undefined || price === null ? Number.NaN : Number(price);
  return Number.isFinite(value) && value >= 0
    ? Number((value * 1_000_000).toPrecision(12))
    : undefined;
};

/** What OpenRouter's public model list says each model can do and costs, by model id. */
export function openRouterModelInfo(body: unknown): ReadonlyMap<string, ServerProviderModelInfo> {
  const info = new Map<string, ServerProviderModelInfo>();
  for (const entry of Option.match(decodeModels(body), {
    onNone: () => [],
    onSome: (models) => models.data,
  })) {
    const model = Option.getOrUndefined(decodeModel(entry));
    if (model === undefined) continue;
    const input = perMillionTokens(model.pricing?.prompt);
    const output = perMillionTokens(model.pricing?.completion);
    info.set(model.id, {
      usesTools: Array.isArray(model.supported_parameters)
        ? model.supported_parameters.includes("tools")
        : null,
      readsImages: Array.isArray(model.architecture?.input_modalities)
        ? model.architecture.input_modalities.includes("image")
        : null,
      price: input === undefined || output === undefined ? null : { input, output },
    });
  }
  return info;
}

class OpenRouterModelsError extends Schema.TaggedError<OpenRouterModelsError>()(
  "OpenRouterModelsError",
  { status: Schema.optional(Schema.Number), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Codenine could not read OpenRouter's model list.";
  }
}

/** Fetches OpenRouter's public model list; it needs no key, so none is sent. */
export const fetchOpenRouterModelInfo = Effect.fn("fetchOpenRouterModelInfo")(
  function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(OPENROUTER_MODELS_URL));
    if (response.status !== 200) {
      return yield* new OpenRouterModelsError({ status: response.status });
    }
    return openRouterModelInfo(yield* response.json);
  },
  Effect.timeout("15 seconds"),
  Effect.mapError((cause) =>
    cause._tag === "OpenRouterModelsError" ? cause : new OpenRouterModelsError({ cause }),
  ),
);

/** An OpenRouter account's models with what the model list says about them; unknown otherwise. */
export const withOpenRouterModelInfo = (
  models: ReadonlyArray<ServerProviderModel>,
  info: ReadonlyMap<string, ServerProviderModelInfo>,
): ReadonlyArray<ServerProviderModel> =>
  models.map((model) => ({ ...model, info: info.get(model.slug) ?? UNKNOWN_INFO }));
