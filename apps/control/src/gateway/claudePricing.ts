/**
 * What Claude calls cost, in US dollars per million tokens, from Anthropic's
 * pricing page on 15 November 2026. Cache writes cost 1.25 times the input
 * price for five minutes and twice it for an hour, on every model. Totals made
 * from these are estimates; the provider's invoice is what the company pays.
 */
export const CLAUDE_PRICES_VERSION = "anthropic-2026-11-15";

interface TokenPrices {
  readonly input: number;
  readonly output: number;
  /** Cache hits and refreshes, which no longer follow one ratio across models. */
  readonly cacheRead: number;
}

interface ClaudeModelPrices extends TokenPrices {
  /** Fast mode's input and output; cache prices scale from its input as they do from the base. */
  readonly fast?: { readonly input: number; readonly output: number };
  /** Higher prices for a prompt over this many tokens, cache reads and writes included. */
  readonly longPrompt?: TokenPrices & { readonly over: number };
  /** US-only inference costs 1.1 times as much on Claude 4.6 and later. */
  readonly usOnlyPremium: boolean;
}

const MODELS: Readonly<Record<string, ClaudeModelPrices>> = {
  "claude-fable-5-2": {
    input: 8,
    output: 40,
    cacheRead: 0.2,
    fast: { input: 16, output: 80 },
    usOnlyPremium: true,
  },
  "claude-mythos-5-2": {
    input: 8,
    output: 40,
    cacheRead: 0.2,
    fast: { input: 16, output: 80 },
    usOnlyPremium: true,
  },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, usOnlyPremium: true },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, usOnlyPremium: true },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, usOnlyPremium: true },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, usOnlyPremium: true },
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    fast: { input: 8, output: 40 },
    usOnlyPremium: true,
  },
  "claude-opus-5": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    fast: { input: 10, output: 50 },
    usOnlyPremium: true,
  },
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    fast: { input: 10, output: 50 },
    usOnlyPremium: true,
  },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, usOnlyPremium: true },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, usOnlyPremium: true },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, usOnlyPremium: false },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, usOnlyPremium: false },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, usOnlyPremium: false },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, usOnlyPremium: true },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, usOnlyPremium: true },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, usOnlyPremium: true },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, usOnlyPremium: false },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, usOnlyPremium: false },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
    usOnlyPremium: true,
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, usOnlyPremium: false },
};

const WEB_SEARCH_DOLLARS = 0.01;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const US_ONLY = 1.1;

/** What one model reported using for one attempt. */
export interface ClaudeTokens {
  readonly inputTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly webSearches: number;
  readonly fast: boolean;
  readonly usOnly: boolean;
}

/**
 * The name Anthropic prices a model under, from the names the Claude API,
 * Bedrock, Vertex AI, Foundry and Anthropic-compatible gateways give it.
 */
export const claudeModelKey = (model: string) => {
  const name = model
    .trim()
    .toLowerCase()
    // Claude Code's context variants, such as [1m].
    .replace(/\[[^\]]*\]$/u, "");
  return (
    name
      // Gateways name the maker first: anthropic/claude-opus-4.5.
      .slice(name.lastIndexOf("/") + 1)
      // Bedrock: us.anthropic.claude-opus-5-5, and a version at the end.
      .replace(/^(?:[a-z]+\.)?anthropic\./u, "")
      .replace(/-v\d+(?::\d+)?$/u, "")
      // Snapshots: claude-opus-4-5@20251101 on Vertex AI, claude-sonnet-4-5-20250929 elsewhere.
      .replace(/[@-]\d{8}$/u, "")
      .replace(/-latest$/u, "")
      .replace(/(\d)\.(\d)/gu, "$1-$2")
  );
};

const pricesFor = (model: string) => {
  const key = claudeModelKey(model);
  const found = MODELS[key];
  if (found !== undefined) return { prices: found, fastByName: false };
  // Foundry deploys fast mode as its own model.
  const fast = key.endsWith("-fast") ? MODELS[key.slice(0, -"-fast".length)] : undefined;
  return fast === undefined ? null : { prices: fast, fastByName: true };
};

/** Whether the price table knows a model. */
export const isPricedClaudeModel = (model: string) => pricesFor(model) !== null;

/** What an attempt cost, in millionths of a dollar, or null for a model with no price. */
export const claudeCostMicros = (model: string, tokens: ClaudeTokens): number | null => {
  const found = pricesFor(model);
  if (found === null) return null;
  const { prices, fastByName } = found;
  const promptTokens =
    tokens.inputTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens +
    tokens.cacheReadTokens;
  const tier =
    prices.longPrompt !== undefined && promptTokens > prices.longPrompt.over
      ? prices.longPrompt
      : prices;
  const fast = (tokens.fast || fastByName) && prices.fast !== undefined ? prices.fast : null;
  const input = fast?.input ?? tier.input;
  const output = fast?.output ?? tier.output;
  const cacheRead = (tier.cacheRead / tier.input) * input;
  const tokenDollars =
    (tokens.inputTokens * input +
      tokens.cacheWrite5mTokens * input * CACHE_WRITE_5M +
      tokens.cacheWrite1hTokens * input * CACHE_WRITE_1H +
      tokens.cacheReadTokens * cacheRead +
      tokens.outputTokens * output) /
    1_000_000;
  const geography = tokens.usOnly && prices.usOnlyPremium ? US_ONLY : 1;
  return Math.round((tokenDollars * geography + tokens.webSearches * WEB_SEARCH_DOLLARS) * 1e6);
};
