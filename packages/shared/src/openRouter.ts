import type { ServerProvider } from "@codenine/contracts";

import { normalizeHostname } from "./hostClassification.ts";

/** OpenRouter's Anthropic-compatible API, which Claude Code runs against with any OpenRouter model. */
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

export const OPENROUTER_AUTH_TYPE = "openrouter";

export const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/activity";

/** Whether a Claude `ANTHROPIC_BASE_URL` sends Claude Code's requests to OpenRouter. */
export function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  const url = URL.parse(baseUrl?.trim() ?? "");
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  const host = normalizeHostname(url.hostname);
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

/**
 * A Claude instance whose resolved base URL is OpenRouter. The server gives every snapshot of one
 * this auth type, so a client can tell without reading the instance's environment.
 */
export function isOpenRouterProvider(provider: Pick<ServerProvider, "driver" | "auth">): boolean {
  return provider.driver === "claudeAgent" && provider.auth.type === OPENROUTER_AUTH_TYPE;
}

const VENDOR_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  qwen: "Qwen",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
};

// Words OpenRouter IDs spell in lower case that their makers write otherwise.
const MODEL_WORDS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  gpt: "GPT",
};

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * How to show an OpenRouter model: `anthropic/claude-sonnet-5.5` reads as Claude Sonnet 5.5 from
 * Anthropic. A name the user gave the model wins. The short name keeps the family, which the
 * OpenRouter logo beside it does not show. Null for an ID that is not `maker/model`.
 */
export function openRouterModelName(model: {
  readonly slug: string;
  readonly name: string;
}): { readonly name: string; readonly shortName: string; readonly subProvider: string } | null {
  const match = /^([a-z0-9-]+)\/([a-z0-9.-]+)$/u.exec(model.slug);
  if (match === null) return null;
  const [, vendor = "", id = ""] = match;
  const words = id
    .split("-")
    .filter((word) => word !== "")
    .map((word) => MODEL_WORDS[word] ?? capitalize(word));
  const name = words
    // GPT-6.1 and GLM-5.3 keep the hyphen before their version.
    .map((word, index) =>
      index > 0 && /^\d/u.test(word) && /^(?:GPT|GLM)$/u.test(words[index - 1]!)
        ? `-${word}`
        : index > 0
          ? ` ${word}`
          : word,
    )
    .join("");
  const shown = model.name === model.slug ? name : model.name;
  return {
    name: shown,
    shortName: shown,
    subProvider: VENDOR_NAMES[vendor] ?? capitalize(vendor),
  };
}
