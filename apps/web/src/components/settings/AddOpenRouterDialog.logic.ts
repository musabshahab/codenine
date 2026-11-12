import { deriveAvailableInstanceId } from "@codenine/client-runtime/provider-instance-ids";
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@codenine/contracts";
import { OPENROUTER_ANTHROPIC_BASE_URL } from "@codenine/shared/openRouter";

/** One or two current models from each main vendor, checked against OpenRouter's catalog. */
export const OPENROUTER_STARTER_MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6.1-terra",
  "openai/gpt-6-luna",
  "google/gemini-4-argon",
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3",
  "moonshotai/kimi-k3.1-pro",
] as const;

/**
 * A Claude instance pointed at OpenRouter: Claude Code runs it with the API key in place of a
 * Claude sign-in. The key is sensitive, so the server stores it as a secret.
 */
export function buildOpenRouterInstance(input: {
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
  readonly settings: {
    readonly providerInstances: Readonly<Record<string, unknown>>;
    readonly textGenerators: Readonly<Record<string, unknown>>;
  };
}): { readonly instanceId: ProviderInstanceId; readonly instance: ProviderInstanceConfig } {
  const taken = new Set([
    // The default instances run before anything configures them.
    "codex",
    "claudeAgent",
    ...Object.keys(input.settings.providerInstances),
    // A text generator with this id would take the instance's place in text generation.
    ...Object.keys(input.settings.textGenerators),
  ]);
  return {
    instanceId: ProviderInstanceId.make(deriveAvailableInstanceId(() => "openrouter", "", taken)),
    instance: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      displayName: "OpenRouter",
      environment: [
        { name: "ANTHROPIC_BASE_URL", value: OPENROUTER_ANTHROPIC_BASE_URL, sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: input.apiKey.trim(), sensitive: true },
        // Empty, so an Anthropic key in the server's environment cannot take the token's place.
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ],
      config: { customModels: [...input.models] },
    },
  };
}
