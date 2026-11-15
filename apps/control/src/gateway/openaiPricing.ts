/**
 * What Codex's calls cost, in US dollars per million tokens of input, cached
 * input and output, from OpenAI's pricing page on 15 November 2026. Totals are
 * estimates; the provider's invoice is what the company pays.
 */
export const OPENAI_PRICES_VERSION = "openai-2026-11-15";

/** Input, cached input and output. */
type Rates = readonly [number, number, number];

interface Tiers {
  readonly standard: Rates;
  readonly fast?: Rates;
  readonly flex?: Rates;
}

interface OpenAiModelPrices extends Tiers {
  /** Prices for a request over 272,000 input tokens. */
  readonly long?: Partial<Tiers>;
}

const LONG_CONTEXT = 272_000;
const WEB_SEARCH_DOLLARS = 0.01;

const GPT_5_1: OpenAiModelPrices = {
  standard: [1.25, 0.125, 10],
  fast: [2.5, 0.25, 20],
  flex: [0.625, 0.0625, 5],
};
const GPT_5_2: OpenAiModelPrices = {
  standard: [1.75, 0.175, 14],
  fast: [3.5, 0.35, 28],
  flex: [0.875, 0.0875, 7],
};
const GPT_5_MINI: OpenAiModelPrices = {
  standard: [0.25, 0.025, 2],
  fast: [0.45, 0.045, 3.6],
  flex: [0.125, 0.0125, 1],
};

// Models without cached prices take no cached input, so it is priced as input.
const MODELS: Readonly<Record<string, OpenAiModelPrices>> = {
  "gpt-6-astra": {
    standard: [10, 1, 50],
    fast: [20, 2, 100],
    flex: [5, 0.5, 25],
    long: { standard: [20, 2, 75], fast: [40, 4, 150], flex: [10, 1, 37.5] },
  },
  "gpt-6.1-sol": {
    standard: [2, 0.1, 10],
    fast: [4, 0.2, 20],
    flex: [1, 0.05, 5],
    long: { standard: [4, 0.2, 15], fast: [8, 0.4, 30], flex: [2, 0.1, 7.5] },
  },
  "gpt-6.1-terra": {
    standard: [1, 0.05, 5],
    fast: [2, 0.1, 10],
    flex: [0.5, 0.025, 2.5],
    long: { standard: [2, 0.1, 7.5], fast: [4, 0.2, 15], flex: [1, 0.05, 3.75] },
  },
  "gpt-6-sol": {
    standard: [2, 0.2, 10],
    fast: [4, 0.4, 20],
    flex: [1, 0.1, 5],
    long: { standard: [4, 0.4, 15], fast: [8, 0.8, 30], flex: [2, 0.2, 7.5] },
  },
  "gpt-6-luna": {
    standard: [0.1, 0.01, 0.5],
    fast: [0.2, 0.02, 1],
    flex: [0.05, 0.005, 0.25],
    long: { standard: [0.2, 0.02, 0.75], fast: [0.4, 0.04, 1.5], flex: [0.1, 0.01, 0.375] },
  },
  "gpt-5.6-sol": {
    standard: [4, 0.4, 20],
    fast: [8, 0.8, 40],
    flex: [2, 0.2, 10],
    long: { standard: [8, 0.8, 30], fast: [16, 1.6, 60], flex: [4, 0.4, 15] },
  },
  "gpt-5.6-terra": {
    standard: [2, 0.2, 12],
    fast: [4, 0.4, 24],
    flex: [1, 0.1, 6],
    long: { standard: [4, 0.4, 18], fast: [8, 0.8, 36], flex: [2, 0.2, 9] },
  },
  "gpt-5.6-luna": {
    standard: [0.2, 0.02, 1.2],
    fast: [0.4, 0.04, 2.4],
    flex: [0.1, 0.01, 0.6],
    long: { standard: [0.4, 0.04, 1.8], fast: [0.8, 0.08, 3.6], flex: [0.2, 0.02, 0.9] },
  },
  "gpt-5.5": {
    standard: [5, 0.5, 30],
    fast: [12.5, 1.25, 75],
    flex: [2.5, 0.25, 15],
    long: { standard: [10, 1, 45], flex: [5, 0.5, 22.5] },
  },
  "gpt-5.5-pro": {
    standard: [30, 30, 180],
    flex: [15, 15, 90],
    long: { standard: [60, 60, 270] },
  },
  "gpt-5.4": {
    standard: [2.5, 0.25, 15],
    fast: [5, 0.5, 30],
    flex: [1.25, 0.13, 7.5],
    long: { standard: [5, 0.5, 22.5], flex: [2.5, 0.25, 11.25] },
  },
  "gpt-5.4-pro": {
    standard: [30, 30, 180],
    flex: [15, 15, 90],
    long: { standard: [60, 60, 270], flex: [30, 30, 135] },
  },
  "gpt-5.4-mini": {
    standard: [0.75, 0.075, 4.5],
    fast: [1.5, 0.15, 9],
    flex: [0.375, 0.0375, 2.25],
  },
  "gpt-5.4-nano": { standard: [0.2, 0.02, 1.25], flex: [0.1, 0.01, 0.625] },
  "gpt-5.3-codex": { standard: [1.75, 0.175, 14], fast: [3.5, 0.35, 28] },
  "gpt-5.2": GPT_5_2,
  "gpt-5.2-pro": { standard: [21, 21, 168] },
  "gpt-5.1": GPT_5_1,
  "gpt-5": GPT_5_1,
  "gpt-5-mini": GPT_5_MINI,
  "gpt-5-nano": { standard: [0.05, 0.005, 0.4], flex: [0.025, 0.0025, 0.2] },
  "gpt-5-pro": { standard: [15, 15, 120] },
  // Codex versions of earlier models are not on the page; they cost what their base models do.
  "gpt-5.2-codex": GPT_5_2,
  "gpt-5.1-codex": GPT_5_1,
  "gpt-5.1-codex-max": GPT_5_1,
  "gpt-5.1-codex-mini": GPT_5_MINI,
  "gpt-5-codex": GPT_5_1,
};

/** What one Codex reply used. */
export interface OpenAiTokens {
  /** All input, cached input included, as the Responses API counts it. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  /** Reasoning included. */
  readonly outputTokens: number;
  readonly webSearches: number;
  /** The tier the reply says served it: `default`, `priority` or `fast`, `flex`. */
  readonly serviceTier: string | null;
}

/** The name OpenAI prices a model under: `openai/gpt-5.5` and snapshots such as `gpt-5-2025-08-07`. */
export const openAiModelKey = (model: string) => {
  const name = model.trim().toLowerCase();
  return name.slice(name.lastIndexOf("/") + 1).replace(/-\d{4}-\d{2}-\d{2}$/u, "");
};

const tierOf = (serviceTier: string | null) =>
  serviceTier === "priority" || serviceTier === "fast"
    ? "fast"
    : serviceTier === "flex"
      ? "flex"
      : "standard";

/** What a reply cost, in millionths of a dollar, or null for a model with no price. */
export const openAiCostMicros = (model: string, tokens: OpenAiTokens): number | null => {
  const prices = MODELS[openAiModelKey(model)];
  if (prices === undefined) return null;
  const tier = tierOf(tokens.serviceTier);
  const short = prices[tier] ?? prices.standard;
  const rates =
    tokens.inputTokens > LONG_CONTEXT
      ? (prices.long?.[tier] ?? prices.long?.standard ?? short)
      : short;
  const [input, cachedInput, output] = rates;
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const tokenDollars =
    ((tokens.inputTokens - cached) * input + cached * cachedInput + tokens.outputTokens * output) /
    1_000_000;
  return Math.round((tokenDollars + tokens.webSearches * WEB_SEARCH_DOLLARS) * 1e6);
};
