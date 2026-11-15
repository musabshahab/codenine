import { describe, expect, it } from "@effect/vitest";

import { type OpenAiTokens, openAiCostMicros, openAiModelKey } from "./openaiPricing.ts";

const none: OpenAiTokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  serviceTier: "default",
};

describe("openAiModelKey", () => {
  it.each([
    ["gpt-5.5", "gpt-5.5"],
    ["openai/gpt-5-nano", "gpt-5-nano"],
    ["gpt-5-2025-08-07", "gpt-5"],
    ["GPT-5.4-mini", "gpt-5.4-mini"],
  ])("prices %s as %s", (model, key) => {
    expect(openAiModelKey(model)).toBe(key);
  });
});

describe("openAiCostMicros", () => {
  it.each<[string, string, Partial<OpenAiTokens>, number | null]>([
    // $5 in, $0.50 cached in and $30 out per million; cached tokens are part of the input count.
    [
      "input, cached input and output",
      "gpt-5.5",
      { inputTokens: 10_000, cachedInputTokens: 8000, outputTokens: 1000 },
      10_000 + 4_000 + 30_000,
    ],
    [
      "the fast tier",
      "gpt-5.4",
      { inputTokens: 1000, outputTokens: 1000, serviceTier: "priority" },
      5_000 + 30_000,
    ],
    ["the flex tier", "gpt-5-nano", { inputTokens: 1_000_000, serviceTier: "flex" }, 25_000],
    // Past 272,000 input tokens the whole request costs more.
    ["a long request", "gpt-5.5", { inputTokens: 272_001 }, 2_720_010],
    ["a long request on a model with one price", "gpt-5-mini", { inputTokens: 300_000 }, 75_000],
    ["web searches", "gpt-6-luna", { webSearches: 2 }, 20_000],
    ["a Codex version of an earlier model", "gpt-5.1-codex", { outputTokens: 1000 }, 10_000],
    ["a model with no price", "o1", { inputTokens: 1000 }, null],
  ])("%s", (_name, model, tokens, micros) => {
    expect(openAiCostMicros(model, { ...none, ...tokens })).toBe(micros);
  });
});
