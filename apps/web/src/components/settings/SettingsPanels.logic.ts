import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ClientSettings,
  ClientSettingsPatch,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@codenine/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@codenine/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  normalizeServerBackgroundActivitySettings,
  type ResolvedBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@codenine/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { isDeviceSettingKey } from "./scopedSettings";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "codenine:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {}
}

// Restore device defaults resets these rows. Server keys are filtered out so the button
// never writes environment settings, and onboarding, favorites and per-workspace or
// per-environment maps are left out because no row here names them.
const DEVICE_RESTORE_ROWS: ReadonlyArray<{
  readonly id: SettingsSearchItemId;
  readonly keys: readonly (keyof ClientSettings)[];
}> = [
  { id: "setting-appearance-contrast", keys: ["appearanceContrast"] },
  { id: "setting-glass-opacity", keys: ["glassOpacity"] },
  { id: "diff-color-scheme", keys: ["diffColorScheme"] },
  { id: "chat-width", keys: ["chatWidth"] },
  { id: "effort-display", keys: ["effortDisplay"] },
  { id: "math-rendering", keys: ["mathRenderingEnabled"] },
  { id: "panel-animations", keys: ["panelAnimationDurationMs"] },
  { id: "environment-identification", keys: ["environmentIdentificationMode"] },
  { id: "thread-details-items", keys: ["threadDetailsItems", "threadDetailsUsageEnabled"] },
  { id: "time-format", keys: ["timestampFormat"] },
  { id: "thread-notifications", keys: ["notificationMode"] },
  { id: "in-app-notifications", keys: ["inAppNotificationsEnabled"] },
  { id: "project-grouping", keys: ["sidebarProjectGroupingMode"] },
  { id: "project-order", keys: ["sidebarProjectSortOrder"] },
  { id: "sidebar-group-by-project", keys: ["sidebarGroupByProject"] },
  { id: "working-shelf", keys: ["sidebarWorkingShelfEnabled"] },
  { id: "sidebar-two-line-rows", keys: ["sidebarTwoLineRows"] },
  { id: "word-wrap", keys: ["wordWrap"] },
  { id: "composer-context", keys: ["persistComposerContextStrip"] },
  { id: "interface-font", keys: ["fontFamilySans", "fontSizeInterface"] },
  { id: "prompt-font", keys: ["fontFamilyComposer", "fontSizePrompt"] },
  { id: "code-font", keys: ["fontFamilyCode", "fontSizeCode"] },
  { id: "terminal-font", keys: ["fontFamilyTerminal", "fontSizeTerminal"] },
  { id: "font-smoothing", keys: ["fontSmoothing"] },
  { id: "default-diff-file-state", keys: ["diffFilesCollapsed"] },
  { id: "hide-whitespace-changes", keys: ["diffHideWhitespace"] },
  { id: "diff-layout", keys: ["diffLayout"] },
  { id: "proactive-panels", keys: ["proactivePanelsEnabled"] },
  { id: "skills-in-slash-menu", keys: ["showSkillsInSlashMenu"] },
  { id: "composer-rich-text", keys: ["composerRichTextEnabled"] },
  { id: "send-shortcut", keys: ["sendShortcut"] },
  { id: "follow-up-behavior", keys: ["followUpBehavior"] },
  { id: "tool-call-visibility", keys: ["toolCallVisibility"] },
  { id: "unpin-confirmation", keys: ["confirmThreadUnpin"] },
  { id: "archive-confirmation", keys: ["confirmThreadArchive"] },
  { id: "delete-confirmation", keys: ["confirmThreadDelete"] },
  { id: "quit-confirmation", keys: ["confirmQuit"] },
];

/** The labels to confirm and the patch that resets exactly those rows on this device. */
export function planDeviceSettingsRestore(settings: ClientSettings) {
  const changedRows = DEVICE_RESTORE_ROWS.map((row) => ({
    label: searchableSetting(row.id).title,
    keys: row.keys.filter(isDeviceSettingKey),
  })).filter((row) =>
    row.keys.some((key) => !Equal.equals(settings[key], DEFAULT_CLIENT_SETTINGS[key])),
  );
  return {
    changedLabels: changedRows.map((row) => row.label),
    patch: Object.fromEntries(
      changedRows.flatMap((row) => row.keys.map((key) => [key, DEFAULT_CLIENT_SETTINGS[key]])),
    ) as ClientSettingsPatch,
  };
}

// Nothing reports low power mode, and host power reaches only servers that advertise it.
function effectiveBackgroundActivity(
  settings: ResolvedBackgroundActivitySettings,
  reportsHostPower: boolean,
): ReadonlyArray<number | boolean> {
  return [
    Duration.toMillis(settings.automaticGitFetchInterval),
    Duration.toMillis(settings.providerHealthRefreshInterval),
    ...(reportsHostPower
      ? [
          Duration.toMillis(settings.hostPowerMonitorActiveInterval),
          Duration.toMillis(settings.hostPowerMonitorIdleInterval),
          settings.pauseWhenHostLocked,
          settings.pauseWhenOnBattery,
        ]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
  reportsHostPower: boolean,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const current = effectiveBackgroundActivity(resolved, reportsHostPower);
  const profiles: ReadonlyArray<BackgroundActivityProfile> = [
    resolved.profile,
    "balanced",
    "performance",
    "battery-saver",
  ];
  return (
    profiles.find((profile) =>
      effectiveBackgroundActivity(
        getBackgroundActivityPresetSettings(profile),
        reportsHostPower,
      ).every((value, index) => value === current[index]),
    ) ?? "advanced"
  );
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}
