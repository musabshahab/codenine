import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

const OpenRouterKeyInfo = Schema.Struct({
  data: Schema.Struct({
    // Null when the key has no spending limit.
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});

/** Asks OpenRouter whether it accepts a key, and what is left of the key's spending limit. */
export const checkOpenRouterKey = Effect.fn("checkOpenRouterKey")(
  function* (apiKey: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(OPENROUTER_KEY_URL).pipe(HttpClientRequest.bearerToken(apiKey)),
    );
    if (response.status === 401 || response.status === 403) return { status: "rejected" } as const;
    if (response.status !== 200) return { status: "unreachable" } as const;
    const info = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OpenRouterKeyInfo)),
      Effect.option,
    );
    const remaining = Option.getOrUndefined(info)?.data.limit_remaining;
    return {
      status: "valid",
      limitRemaining:
        typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null,
    } as const;
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => ({ status: "unreachable" }) as const),
);
