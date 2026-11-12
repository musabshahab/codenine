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
