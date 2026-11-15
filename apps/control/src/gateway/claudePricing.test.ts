import { describe, expect, it } from "@effect/vitest";

import { type ClaudeTokens, claudeCostMicros, claudeModelKey } from "./claudePricing.ts";

const none: ClaudeTokens = {
  inputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  fast: false,
  usOnly: false,
};

describe("claudeModelKey", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    ["global.anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["anthropic/claude-opus-4.5", "claude-opus-4-5"],
    ["claude-opus-5-5[1m]", "claude-opus-5-5"],
  ])("prices %s as %s", (model, key) => {
    expect(claudeModelKey(model)).toBe(key);
  });
});

describe("claudeCostMicros", () => {
  it.each<[string, string, Partial<ClaudeTokens>, number | null]>([
    // $4 in and $20 out per million.
    ["input and output", "claude-opus-5-5", { inputTokens: 1000, outputTokens: 500 }, 14_000],
    // Writes at 1.25x and 2x of $4; reads at Opus 5.5's own $0.20.
    [
      "cache writes and reads",
      "claude-opus-5-5",
      { cacheWrite5mTokens: 1000, cacheWrite1hTokens: 1000, cacheReadTokens: 10_000 },
      5_000 + 8_000 + 2_000,
    ],
    // Fast mode doubles Opus 5.5, and its cache reads keep the 0.05x ratio.
    [
      "fast mode",
      "claude-opus-5-5",
      { inputTokens: 1000, cacheReadTokens: 10_000, outputTokens: 1000, fast: true },
      8_000 + 4_000 + 40_000,
    ],
    ["fast mode as Foundry names it", "claude-opus-5-5-fast", { outputTokens: 1000 }, 40_000],
    ["US-only inference", "claude-sonnet-5-5", { inputTokens: 1_000_000, usOnly: true }, 2_200_000],
    [
      "US-only on a model without the premium",
      "claude-opus-4-5",
      { inputTokens: 1000, usOnly: true },
      5_000,
    ],
    // Haiku 5.5 charges more for the whole request once its prompt passes 100,000 tokens.
    ["a short Haiku 5.5 prompt", "claude-haiku-5-5", { inputTokens: 100_000 }, 10_000],
    [
      "a long Haiku 5.5 prompt, cache reads counted",
      "claude-haiku-5-5",
      { inputTokens: 100_000, cacheReadTokens: 1 },
      50_000,
    ],
    ["web searches", "claude-sonnet-5-5", { webSearches: 3 }, 30_000],
    [
      "a Bedrock name",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      { outputTokens: 1000 },
      5_000,
    ],
    ["a model with no price", "claude-instant-1", { inputTokens: 1000 }, null],
  ])("%s", (_name, model, tokens, micros) => {
    expect(claudeCostMicros(model, { ...none, ...tokens })).toBe(micros);
  });
});
