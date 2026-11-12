import { ProviderDriverKind } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOpenRouterBaseUrl, isOpenRouterProvider, openRouterModelName } from "./openRouter.ts";

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

describe("openRouterModelName", () => {
  it.each([
    ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", "Anthropic"],
    ["openai/gpt-6.1-terra", "GPT-6.1 Terra", "OpenAI"],
    ["openai/gpt-6-luna", "GPT-6 Luna", "OpenAI"],
    ["google/gemini-4-argon", "Gemini 4 Argon", "Google"],
    ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "DeepSeek"],
    ["z-ai/glm-5.3", "GLM-5.3", "Z.ai"],
    ["moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro", "Moonshot AI"],
    ["cohere/command-a", "Command A", "Cohere"],
  ])("shows %s as %s from %s", (slug, name, subProvider) => {
    expect(openRouterModelName({ slug, name: slug })).toEqual({
      name,
      shortName: name,
      subProvider,
    });
  });

  it("keeps the user's name, and IDs that are not maker/model", () => {
    expect(
      openRouterModelName({ slug: "anthropic/claude-sonnet-5.5", name: "Sonnet (team)" }),
    ).toEqual({ name: "Sonnet (team)", shortName: "Sonnet (team)", subProvider: "Anthropic" });
    const named = (slug: string) => openRouterModelName({ slug, name: slug });
    expect(named("claude-sonnet-5-5")).toBeNull();
    expect(named("deepseek/deepseek-v4.1-flash:free")).toBeNull();
  });
});
