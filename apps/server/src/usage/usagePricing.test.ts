import { describe, expect, it } from "@effect/vitest";

import type { UsageSpeed } from "@codenine/provider-core/server/usage";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseOpenRouterRateTable,
  parseRateTable,
  preferRates,
  priceUsage,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

describe("usage pricing", () => {
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };
  const record = (
    model: string,
    reportedCostUsd: number | null = null,
    speed: UsageSpeed = "standard",
  ) => ({
    model,
    totals,
    reportedCostUsd,
    speed,
  });

  it("uses custom token rates ahead of public and provider-reported costs", () => {
    const table = parseRateTable({ "example-model": rate(1) });
    const overrides = createOverrideRateTable({
      "example-model": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
    });

    for (const reportedCostUsd of [null, 99]) {
      expect(priceUsage(table, record("example-model", reportedCostUsd), overrides)).toMatchObject({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(1.5);
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, record("example-model"), overrides)).toMatchObject({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, record(" vendor/example-model[1m] ", 99), overrides)).toMatchObject({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, record(model), overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, record(model, 99), overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
        categoryCostUsd: null,
        speedPremiumUsd: 0,
      });
    }
  });

  it("prices fast-mode requests at the model's published fast multiple", () => {
    const table = parseRateTable({
      "claude-opus-5-5": { ...rate(4e-6, 2e-7), provider_specific_entry: { fast: 2, us: 1.1 } },
      "claude-fable-5-1": { ...rate(1e-5, 2.5e-7), provider_specific_entry: { us: 1.1 } },
    });
    const overrides = createOverrideRateTable({
      "claude-opus-5-5": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 20 },
    });
    const cost = (model: string, speed: UsageSpeed, custom?: typeof overrides) =>
      priceUsage(table, record(model, null, speed), custom).costUsd;

    expect(cost("claude-opus-5-5", "fast")).toBeCloseTo(2 * cost("claude-opus-5-5", "standard"));
    expect(cacheSavingsUsd(table, record("claude-opus-5-5", null, "fast"))).toBeCloseTo(
      2 * cacheSavingsUsd(table, record("claude-opus-5-5")),
    );
    expect(cost("claude-fable-5-1", "fast")).toBe(cost("claude-fable-5-1", "standard"));
    expect(cost("claude-opus-5-5", "fast", overrides)).toBe(
      cost("claude-opus-5-5", "standard", overrides),
    );
  });

  it("splits cost by category and prices the speed premium", () => {
    const table = parseRateTable({
      "claude-opus-5-5": {
        ...rate(4e-6, 4e-7),
        cache_creation_input_token_cost: 5e-6,
        provider_specific_entry: { fast: 2 },
      },
    });
    const split = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
      input: expect.closeTo(input),
      cacheRead: expect.closeTo(cacheRead),
      cacheWrite: expect.closeTo(cacheWrite),
      output: expect.closeTo(output),
    });

    expect(priceUsage(table, record("claude-opus-5-5", null, "fast"))).toEqual({
      costUsd: expect.closeTo(58.8),
      costSource: "modelPriced",
      categoryCostUsd: split(8, 0.8, 10, 40),
      speedPremiumUsd: expect.closeTo(29.4),
    });
    expect(priceUsage(table, record("claude-opus-5-5", 29.4, "fast"))).toEqual({
      costUsd: 29.4,
      costSource: "providerReported",
      categoryCostUsd: split(4, 0.4, 5, 20),
      speedPremiumUsd: expect.closeTo(14.7),
    });
    expect(priceUsage(table, record("unknown-model", 29.4, "fast"))).toMatchObject({
      costUsd: 29.4,
      categoryCostUsd: null,
      speedPremiumUsd: 0,
    });
  });

  it("prices Codex priority and ultrafast requests at their published tier rates", () => {
    const table = parseRateTable({
      "gpt-6-astra": {
        ...rate(1e-5, 1e-6),
        input_cost_per_token_priority: 2e-5,
        output_cost_per_token_priority: 1e-4,
        cache_read_input_token_cost_priority: 2e-6,
        input_cost_per_token_ultrafast: 6e-5,
        output_cost_per_token_ultrafast: 3e-4,
      },
      "gpt-6-sol": rate(2e-6, 2e-7),
    });
    const cost = (model: string, speed: UsageSpeed) =>
      priceUsage(table, record(model, null, speed)).costUsd;
    const standard = cost("gpt-6-astra", "standard");

    expect(cost("gpt-6-astra", "fast")).toBeCloseTo(2 * standard);
    expect(cost("gpt-6-astra", "ultrafast")).toBeCloseTo(6 * standard);
    expect(cacheSavingsUsd(table, record("gpt-6-astra", null, "ultrafast"))).toBeCloseTo(
      6 * cacheSavingsUsd(table, record("gpt-6-astra")),
    );
    expect(cost("gpt-6-sol", "ultrafast")).toBe(cost("gpt-6-sol", "standard"));
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "other/claude-fable-5")).toBeNull();
    }
  });

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toBeNull();
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("keeps a bare alias when a reseller entry omits the fast tier", () => {
    const table = parseRateTable({
      "provider-a/example-model": {
        ...rate(1),
        input_cost_per_token_priority: 2,
        output_cost_per_token_priority: 10,
      },
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("prices a bare name at the model maker's rate when a reseller marks it up", () => {
    const reseller = { "kyma/gemini-4-argon": rate(5.4e-6) };
    const makers = {
      "gemini/gemini-4-argon": rate(2e-6, 1e-7),
      "vertex_ai/gemini-4-argon": rate(2e-6, 1e-7),
    };

    for (const document of [
      { ...reseller, ...makers },
      { ...makers, ...reseller },
    ]) {
      const table = parseRateTable(document);
      expect(lookupRate(table, "gemini-4-argon")).toEqual(
        lookupRate(table, "gemini/gemini-4-argon"),
      );
    }
  });

  it("leaves a bare name unpriced when model makers' own entries disagree", () => {
    const table = parseRateTable({
      "openai/example-model": rate(1),
      "xai/example-model": rate(3),
      "kyma/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("reads OpenRouter's catalog prices by model ID and canonical slug", () => {
    const table = parseOpenRouterRateTable({
      data: [
        { id: "Z-AI/GLM-5.3-Flash", pricing: { prompt: "0.0000004", completion: "0.0000016" } },
        {
          id: "anthropic/claude-haiku-5.5",
          pricing: {
            prompt: "0.000001",
            completion: "0.000005",
            input_cache_read: "0.0000001",
            input_cache_write: "0.00000125",
          },
        },
        {
          id: "deepseek/deepseek-v4.1-flash",
          canonical_slug: "deepseek/deepseek-v4.1-flash-1017",
          pricing: { prompt: "0.0000002", completion: "0.0000008" },
        },
        {
          id: "nvidia/nemotron-3.5-lightning:free",
          canonical_slug: "nvidia/nemotron-3.5-lightning-0915",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "nvidia/nemotron-3.5-lightning",
          canonical_slug: "nvidia/nemotron-3.5-lightning-0915",
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
        },
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "example/no-completion", pricing: { prompt: "0.000001" } },
        { id: "example/blank-price", pricing: { prompt: "", completion: "0.000001" } },
        { id: "example/word-price", pricing: { prompt: "free", completion: "0.000001" } },
        { id: "example/no-pricing" },
      ],
    });
    const rates = (input: number, output: number, cacheRead = input, cacheWrite = input) => ({
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: cacheRead,
      cacheCreationCostPerToken: cacheWrite,
      fast: null,
      ultrafast: null,
    });

    for (const [model, expected] of [
      ["z-ai/glm-5.3-flash", rates(4e-7, 1.6e-6)],
      ["anthropic/claude-haiku-5.5", rates(1e-6, 5e-6, 1e-7, 1.25e-6)],
      ["deepseek/deepseek-v4.1-flash", rates(2e-7, 8e-7)],
      ["deepseek/deepseek-v4.1-flash-1017", rates(2e-7, 8e-7)],
      ["nvidia/nemotron-3.5-lightning:free", rates(0, 0)],
      ["nvidia/nemotron-3.5-lightning-0915:free", rates(0, 0)],
      ["nvidia/nemotron-3.5-lightning-0915", rates(1e-7, 4e-7)],
      ["openrouter/auto", null],
      ["example/no-completion", null],
      ["example/blank-price", null],
      ["example/word-price", null],
      ["example/no-pricing", null],
    ] as const) {
      expect(lookupRate(table, model), model).toEqual(expected);
    }
  });

  it("prices an OpenRouter model at OpenRouter's price ahead of LiteLLM's, after custom prices", () => {
    const table = preferRates(
      parseOpenRouterRateTable({
        data: [
          {
            id: "deepseek/deepseek-v4.1-flash",
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
      parseRateTable({ "deepseek/deepseek-v4.1-flash": rate(5e-6), "claude-fable-5": rate(1e-6) }),
    );
    const overrides = createOverrideRateTable({
      "deepseek/deepseek-v4.1-flash": {
        inputCostPerMillionTokens: 3,
        outputCostPerMillionTokens: 6,
      },
    });

    expect(priceUsage(table, record("deepseek/deepseek-v4.1-flash"))).toMatchObject({
      costUsd: expect.closeTo(5),
      costSource: "modelPriced",
    });
    expect(priceUsage(table, record("claude-fable-5")).costUsd).toBeCloseTo(8);
    expect(
      priceUsage(table, record("deepseek/deepseek-v4.1-flash"), overrides).costUsd,
    ).toBeCloseTo(15);
  });
});
