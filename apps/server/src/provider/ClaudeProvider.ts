import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderResetCredits,
  type ServerProviderUsageLimits,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@codenine/shared/model";
import {
  isOpenRouterBaseUrl,
  OPENROUTER_ACTIVITY_URL,
  OPENROUTER_AUTH_TYPE,
  openRouterModelName,
} from "@codenine/shared/openRouter";
import { resolveSpawnCommand } from "@codenine/shared/shell";
import {
  query as claudeQuery,
  type ModelInfo as ClaudeModelInfo,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@codenine/provider-core/server/snapshotProbe";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { hasClaudeManagedMcpConfig, makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { discoverClaudeSkills, readClaudeSettingsEnv } from "./Drivers/ClaudeSkills.ts";
import type { ProviderWorkspaceSnapshot } from "@codenine/provider-core/server/driver";
import { makeUnavailableUsageLimits } from "@codenine/provider-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  claudeReportedModels,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
  withUltracodeToggle,
} from "./ClaudeModelCatalog.ts";
import { checkOpenRouterKey } from "./OpenRouterKey.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function claudeProviderModels(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ClaudeSettings["customModels"],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  ).map((model) =>
    model.isCustom ? { ...model, capabilities: withUltracodeToggle(model.capabilities) } : model,
  );
}

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const OPENROUTER_PRESENTATION = { ...CLAUDE_PRESENTATION, displayName: "OpenRouter" } as const;
const OPENROUTER_AUTH = { type: OPENROUTER_AUTH_TYPE, label: "OpenRouter" } as const;

/** OpenRouter routes the model IDs its users add; the built-in Claude slugs do not route reliably. */
function claudeInstanceModels(
  openRouter: boolean,
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ClaudeSettings["customModels"],
): ReadonlyArray<ServerProviderModel> {
  if (!openRouter) return claudeProviderModels(builtInModels, customModels);
  return claudeProviderModels([], customModels).map((model) => {
    const shown = openRouterModelName(model);
    return shown === null ? model : { ...model, ...shown };
  });
}

function openRouterUsageLimits(checkedAt: string): ServerProviderUsageLimits {
  return {
    ...makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "OpenRouter charges per request and has no subscription limits.",
    }),
    externalUsage: { label: "OpenRouter activity", url: OPENROUTER_ACTIVITY_URL },
  };
}

function openRouterAuthLabel(limitRemaining: number | null): string {
  return limitRemaining === null
    ? OPENROUTER_AUTH.label
    : `${OPENROUTER_AUTH.label} · $${Math.max(0, limitRemaining).toFixed(2)} left`;
}

/** Where Claude Code sends requests, and with which token: its settings `env` wins over the process's. */
export const resolveClaudeEndpoint = Effect.fn("resolveClaudeEndpoint")(function* (
  claudeSettings: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const settingsEnv = yield* readClaudeSettingsEnv(claudeSettings, cwd, environment);
  const baseUrl = settingsEnv.ANTHROPIC_BASE_URL ?? environment.ANTHROPIC_BASE_URL;
  return {
    baseUrl,
    openRouter: isOpenRouterBaseUrl(baseUrl),
    authToken: (settingsEnv.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_AUTH_TOKEN)?.trim(),
  };
});

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
    case "claudemax5xsubscription":
      return "Max";
    case "claudemax20xsubscription":
      return "Ultra";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
    case "max5":
      return "Max";
    case "max20":
      return "Ultra";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/** Probe completion only proves Claude started. Only tokenSource: "none" disproves auth. */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // API keys can authenticate with tokenSource: none; also check key and account fields.
  const hasApiKey = Boolean(capabilities.apiKeySource) && capabilities.apiKeySource !== "none";
  return hasApiKey || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// Bedrock initialization includes backend startup and awsAuthRefresh, taking longer than first-party auth.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
// Native CLI startup on Windows can exceed the shared probe deadline.
const CLAUDE_VERSION_CHECK_TIMEOUT_MS = 20_000;

const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly managedMcpConfig: boolean;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // Keep settings for slash-command discovery, but disable hooks so health checks do not run SessionStart repeatedly.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Exclude filesystem MCP servers; omit strict mode when managed-mcp.json already excludes them and forbids the flag.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...input.environment,
      // Disable claude.ai MCP separately; it is discovered outside filesystem config.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // Skipping this avoids a Windows tasklist | findstr process tree on every refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  /** OAuth applies only to firstParty; Bedrock uses external AWS credentials and omits subscription/token fields. */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly models?: ReadonlyArray<ClaudeModelInfo>;
  /** Undefined means get_usage failed; absent windows on success mean no subscription windows, as with API keys. */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly usageCheckedAt?: string;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * With gateway model discovery on, Claude Code refreshes its model cache in the background after
 * initialization, so the probe subprocess outlives init by Claude Code's discovery timeout.
 */
function claudeGatewayDiscoveryGraceMs(environment: Readonly<Record<string, unknown>>): number {
  const enabled = String(environment.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "")
    .trim()
    .toLowerCase();
  if (!enabled || enabled === "0" || enabled === "false") return 0;
  if (!String(environment.ANTHROPIC_BASE_URL ?? "").trim()) return 0;
  const configured = Number(environment.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3_000;
}

class ClaudeCapabilitiesProbeSdkError extends Schema.TaggedError<ClaudeCapabilitiesProbeSdkError>()(
  "ClaudeCapabilitiesProbeSdkError",
  { operation: Schema.Literals(["initialize", "usage"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude capability probe ${this.operation} failed.`;
  }
}

/** A never-yielding prompt allows local initialization IPC without sending an Anthropic request. */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeUsage = true,
) => {
  const abort = new AbortController();
  const abortProbe = Effect.sync(() => {
    if (!abort.signal.aborted) abort.abort();
  });
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
    // Workspace probes (no usage) discard models; the machine probe refreshes the shared cache.
    const graceMs = includeUsage
      ? claudeGatewayDiscoveryGraceMs({
          ...claudeEnvironment,
          ...(yield* readClaudeSettingsEnv(claudeSettings, cwd, claudeEnvironment)),
        })
      : 0;
    return yield* Effect.tryPromise({
      try: async () => {
        const q = claudeQuery({
          // oxlint-disable-next-line require-yield -- never yields, so no prompt reaches the API
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await waitForAbortSignal(abort.signal);
          })(),
          options: buildClaudeCapabilitiesProbeQueryOptions({
            executablePath,
            abortController: abort,
            environment: claudeEnvironment,
            cwd,
            managedMcpConfig,
          }),
        });
        const init = await q.initializationResult();
        return { q, init, graceMs };
      },
      catch: (cause) => new ClaudeCapabilitiesProbeSdkError({ operation: "initialize", cause }),
    });
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap(({ q, init, graceMs }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const usageResult = includeUsage
          ? yield* Effect.tryPromise({
              try: () =>
                q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                  skipBehaviors: true,
                }),
              catch: (cause) => new ClaudeCapabilitiesProbeSdkError({ operation: "usage", cause }),
            }).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
          : undefined;
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(init.models?.length ? { models: init.models } : {}),
          ...(usage ? { usage, usageCheckedAt } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }).pipe(
        Effect.tap(() =>
          graceMs > 0
            ? Effect.sleep(graceMs).pipe(Effect.andThen(abortProbe), Effect.forkDetach)
            : abortProbe,
        ),
      ),
    ),
    Effect.onError(() => abortProbe),
    Effect.tapError((error) =>
      Effect.logWarning("Claude capability probe failed.", { errorTag: error._tag }),
    ),
  );
};

type ClaudeCapabilitiesProbeError = Effect.Error<ReturnType<typeof probeClaudeCapabilities>>;

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const probeClaudeWorkspaceSnapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
  claudeSettings: ClaudeSettings,
  machineSnapshot: ServerProvider,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> {
  if (!claudeSettings.enabled) return machineSnapshot;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
  const fileSystem = yield* FileSystem.FileSystem;
  // A deleted worktree can never answer the probe. Pending would make clients rescan it forever.
  const cwdExists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true));
  const probeResult = cwdExists
    ? yield* probeClaudeCapabilities(claudeSettings, environment, cwd, false).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  return {
    ...machineSnapshot,
    skills,
    slashCommands: dedupeSlashCommands([
      COMPACT_SLASH_COMMAND,
      ...(capabilities?.slashCommands ?? []),
    ]),
    slashCommandsPending: cwdExists && !capabilities,
  };
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined, ClaudeCapabilitiesProbeError>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  resolveResetCredits?: (version: string) => Effect.Effect<ServerProviderResetCredits | undefined>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const endpoint = yield* resolveClaudeEndpoint(claudeSettings, cwd, resolvedEnvironment);
  const { openRouter } = endpoint;
  const presentation = openRouter ? OPENROUTER_PRESENTATION : CLAUDE_PRESENTATION;
  const unknownAuth = openRouter
    ? { status: "unknown" as const, ...OPENROUTER_AUTH }
    : { status: "unknown" as const };
  const allModels = claudeInstanceModels(
    openRouter,
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: unknownAuth,
        message: `${presentation.displayName} is disabled in Codenine settings.`,
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
    cwd,
  ).pipe(Effect.timeoutOption(CLAUDE_VERSION_CHECK_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: unknownAuth,
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: unknownAuth,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: unknownAuth,
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  // Built-in model notices are about Claude's own catalog, which OpenRouter instances do not list.
  const updateRequiredModels = openRouter
    ? []
    : resolveClaudeUpdateRequiredModels(modelCatalog, parsedVersion);
  const versionUpgradeMessage = openRouter
    ? undefined
    : formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  // Checked before Claude Code starts, which a rejected or missing key would make pointless.
  const openRouterKey = !openRouter
    ? undefined
    : endpoint.authToken
      ? yield* checkOpenRouterKey(endpoint.authToken)
      : ({ status: "missing" } as const);
  if (openRouterKey?.status === "rejected" || openRouterKey?.status === "missing") {
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated", ...OPENROUTER_AUTH },
        message:
          openRouterKey.status === "rejected"
            ? "OpenRouter rejected this API key. Check it in Settings → Providers."
            : "Add your OpenRouter API key as ANTHROPIC_AUTH_TOKEN in Settings → Providers.",
      },
    });
  }

  const probeResult = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  const probeFailure =
    probeResult && Result.isFailure(probeResult) ? probeResult.failure : undefined;
  // Gateway model discovery would list OpenRouter's whole catalog.
  const models = openRouter
    ? allModels
    : claudeProviderModels(
        [
          ...resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
          ...claudeReportedModels(modelCatalog, claudeSettings.customModels, capabilities?.models),
        ],
        claudeSettings.customModels,
      );
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: unknownAuth,
        message: probeFailure
          ? Cause.isTimeoutError(probeFailure)
            ? `Timed out after ${CAPABILITIES_PROBE_TIMEOUT_MS / 1_000}s while checking Claude account status.`
            : "Claude Agent CLI failed while checking account status."
          : "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  if (openRouterKey) {
    // Claude Code's account fields describe a Claude login, not the OpenRouter key.
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: {
          status: "authenticated",
          ...OPENROUTER_AUTH,
          ...(openRouterKey.status === "valid"
            ? { label: openRouterAuthLabel(openRouterKey.limitRemaining) }
            : {}),
        },
        ...(openRouterKey.status === "unreachable"
          ? { message: "Could not reach OpenRouter to check the API key." }
          : {}),
        usageLimits: openRouterUsageLimits(checkedAt),
      },
    });
  }

  // First-party account fields cannot verify custom endpoint credentials.
  const endpointUrl = URL.parse(endpoint.baseUrl?.trim() ?? "");
  const customApiEndpoint =
    endpointUrl !== null &&
    (endpointUrl.protocol === "http:" || endpointUrl.protocol === "https:") &&
    endpointUrl.hostname !== "" &&
    endpointUrl.hostname !== "api.anthropic.com";
  if (!customApiEndpoint && claudeAuthStatus(capabilities) === "unauthenticated") {
    return buildServerProvider({
      presentation,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      },
    });
  }

  // A proxy's ANTHROPIC_AUTH_TOKEN reads as an API key; the endpoint is what the token is for.
  const authMetadata =
    apiProviderAuthMetadata(capabilities.apiProvider) ??
    (customApiEndpoint ? { type: "customEndpoint", label: "Custom API endpoint" } : undefined) ??
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    });
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        })
      : claudeUsageResponseToLimits({
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        }).limits;
  const resetCredits =
    resolveResetCredits &&
    capabilities.subscriptionType &&
    !usageLimits.unavailable &&
    parsedVersion
      ? yield* resolveResetCredits(parsedVersion)
      : undefined;
  return buildServerProvider({
    presentation,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(capabilities.workspaceId ? { workspaceId: capabilities.workspaceId } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      usageLimits: resetCredits ? { ...usageLimits, resetCredits } : usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = Effect.fn("ClaudeProvider.makePendingClaudeProvider")(
  function* (
    claudeSettings: ClaudeSettings,
    modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
    openRouter = false,
  ): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* nowIso;
    const presentation = openRouter ? OPENROUTER_PRESENTATION : CLAUDE_PRESENTATION;
    const auth = openRouter
      ? { status: "unknown" as const, ...OPENROUTER_AUTH }
      : { status: "unknown" as const };
    const models = claudeInstanceModels(
      openRouter,
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth,
          message: `${presentation.displayName} is disabled in Codenine settings.`,
        },
      });
    }

    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth,
        message: `${presentation.displayName} provider status has not been checked in this session yet.`,
      },
    });
  },
);

export { probeClaudeCapabilities };
