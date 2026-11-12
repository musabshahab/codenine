import { ProviderDriverKind } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOpenRouterBaseUrl, isOpenRouterProvider } from "./openRouter.ts";

describe("isOpenRouterBaseUrl", () => {
  it.each([
    ["https://openrouter.ai/api", true],
    [" https://OpenRouter.ai/api/ ", true],
    ["https://eu.openrouter.ai/api", true],
    ["https://openrouter.ai./api", true],
    // Claude Code cannot use a base URL without a scheme.
    ["openrouter.ai/api", false],
    ["https://openrouter.ai.example.com/api", false],
    ["https://notopenrouter.ai/api", false],
    ["https://api.anthropic.com", false],
    ["", false],
    [undefined, false],
  ])("%j is OpenRouter: %s", (baseUrl, expected) => {
    expect(isOpenRouterBaseUrl(baseUrl)).toBe(expected);
  });
});

describe("isOpenRouterProvider", () => {
  it("needs a Claude instance the server marked as OpenRouter", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const marked = { status: "unknown", type: "openrouter" } as const;
    expect(isOpenRouterProvider({ driver: claude, auth: marked })).toBe(true);
    expect(isOpenRouterProvider({ driver: codex, auth: marked })).toBe(false);
    expect(
      isOpenRouterProvider({ driver: claude, auth: { status: "authenticated", type: "apiKey" } }),
    ).toBe(false);
  });
});
