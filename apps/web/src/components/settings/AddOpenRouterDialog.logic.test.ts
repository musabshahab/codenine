import { isOpenRouterBaseUrl } from "@codenine/shared/openRouter";
import { describe, expect, it } from "vite-plus/test";

import { buildOpenRouterInstance } from "./AddOpenRouterDialog.logic";

describe("buildOpenRouterInstance", () => {
  it("points a Claude instance at OpenRouter with the key as a secret and the checked models", () => {
    const { instanceId, instance } = buildOpenRouterInstance({
      apiKey: "  sk-or-test\n",
      models: ["anthropic/claude-sonnet-5.5", "z-ai/glm-5.3"],
      settings: { providerInstances: {}, textGenerators: {} },
    });

    expect(instanceId).toBe("openrouter");
    expect(instance).toEqual({
      driver: "claudeAgent",
      enabled: true,
      displayName: "OpenRouter",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or-test", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
      config: { customModels: ["anthropic/claude-sonnet-5.5", "z-ai/glm-5.3"] },
    });
    // The server must recognise what the dialog writes.
    expect(isOpenRouterBaseUrl(String(instance.environment?.[0]?.value))).toBe(true);
  });

  it("takes the next id no provider instance or text generator uses", () => {
    const { instanceId } = buildOpenRouterInstance({
      apiKey: "sk-or-test",
      models: [],
      settings: {
        providerInstances: { openrouter: {} },
        textGenerators: { openrouter_2: {} },
      },
    });
    expect(instanceId).toBe("openrouter_3");
  });
});
