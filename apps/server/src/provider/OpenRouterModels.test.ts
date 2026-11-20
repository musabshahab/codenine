import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  fetchOpenRouterModelInfo,
  openRouterModelInfo,
  withOpenRouterModelInfo,
} from "./OpenRouterModels.ts";

// Trimmed from the shape of GET https://openrouter.ai/api/v1/models.
const MODEL_LIST = {
  data: [
    {
      id: "acme/coder-large",
      canonical_slug: "acme/coder-large-20261001",
      name: "Acme: Coder Large",
      architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
      pricing: { prompt: "0.000003", completion: "0.000015", request: "0" },
      supported_parameters: ["max_tokens", "temperature", "tools", "tool_choice"],
    },
    {
      id: "acme/chat-small",
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["max_tokens"],
    },
    {
      id: "openrouter/auto",
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "-1", completion: "-1" },
    },
    { name: "an entry without an id" },
  ],
};

it("reads what each model can do and costs per million tokens", () => {
  const info = openRouterModelInfo(MODEL_LIST);
  assert.deepEqual(info.get("acme/coder-large"), {
    usesTools: true,
    readsImages: true,
    price: { input: 3, output: 15 },
  });
  assert.deepEqual(info.get("acme/chat-small"), {
    usesTools: false,
    readsImages: false,
    price: { input: 0, output: 0 },
  });
  // A router's price depends on the model it picks; a list without parameters says nothing.
  assert.deepEqual(info.get("openrouter/auto"), {
    usesTools: null,
    readsImages: true,
    price: null,
  });
  assert.equal(info.size, 3);
  assert.equal(openRouterModelInfo({ error: "rate limited" }).size, 0);

  const models = withOpenRouterModelInfo(
    [
      { slug: "acme/coder-large", name: "Coder Large", isCustom: true, capabilities: null },
      { slug: "acme/unlisted", name: "Unlisted", isCustom: true, capabilities: null },
    ],
    info,
  );
  assert.deepEqual(
    models.map((model) => model.info),
    [
      { usesTools: true, readsImages: true, price: { input: 3, output: 15 } },
      { usesTools: null, readsImages: null, price: null },
    ],
  );
});

it.effect("asks OpenRouter's public list without a key, and fails on an error answer", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const answer = (status: number) =>
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({
            url: request.url,
            ...(request.headers.authorization === undefined
              ? {}
              : { authorization: request.headers.authorization }),
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(MODEL_LIST), { status }),
          );
        }),
      );

    const info = yield* fetchOpenRouterModelInfo().pipe(
      Effect.provideService(HttpClient.HttpClient, answer(200)),
    );
    assert.equal(info.get("acme/coder-large")?.usesTools, true);
    assert.deepEqual(requests, [{ url: "https://openrouter.ai/api/v1/models" }]);

    const failed = yield* fetchOpenRouterModelInfo().pipe(
      Effect.provideService(HttpClient.HttpClient, answer(503)),
      Effect.flip,
    );
    assert.equal(failed._tag, "OpenRouterModelsError");
  }),
);
