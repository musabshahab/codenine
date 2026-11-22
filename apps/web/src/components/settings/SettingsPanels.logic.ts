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
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@codenine/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { isDeviceSettingKey } from "./scopedSettings";

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
  readonly label: string;
  readonly keys: readonly (keyof ClientSettings)[];
}> = [
  { label: "Contrast", keys: ["appearanceContrast"] },
  { label: "Glass opacity", keys: ["glassOpacity"] },
  { label: "Diff colors", keys: ["diffColorScheme"] },
  { label: "Chat width", keys: ["chatWidth"] },
  { label: "Effort display", keys: ["effortDisplay"] },
  { label: "Render math", keys: ["mathRenderingEnabled"] },
  { label: "Panel animations", keys: ["panelAnimationDurationMs"] },
  { label: "Environment identification", keys: ["environmentIdentificationMode"] },
  { label: "Thread details", keys: ["threadDetailsItems"] },
  { label: "Time format", keys: ["timestampFormat"] },
  { label: "Thread notifications", keys: ["notificationMode"] },
  { label: "In-app notifications", keys: ["inAppNotificationsEnabled"] },
  { label: "Workspace grouping", keys: ["sidebarProjectGroupingMode"] },
  { label: "Workspace order", keys: ["sidebarProjectSortOrder"] },
  { label: "Group chats by workspace", keys: ["sidebarGroupByProject"] },
  { label: "Working section", keys: ["sidebarWorkingShelfEnabled"] },
  { label: "Two-line chat rows", keys: ["sidebarTwoLineRows"] },
  { label: "Word wrap", keys: ["wordWrap"] },
  { label: "Composer context", keys: ["persistComposerContextStrip"] },
  { label: "Interface font", keys: ["fontFamilySans", "fontSizeInterface"] },
  { label: "Prompt font", keys: ["fontFamilyComposer", "fontSizePrompt"] },
  { label: "Code font", keys: ["fontFamilyCode", "fontSizeCode"] },
  { label: "Terminal font", keys: ["fontFamilyTerminal", "fontSizeTerminal"] },
  { label: "Font smoothing", keys: ["fontSmoothing"] },
  { label: "Default diff file state", keys: ["diffFilesCollapsed"] },
  { label: "Diff whitespace changes", keys: ["diffIgnoreWhitespace"] },
  { label: "Diff layout", keys: ["diffLayout"] },
  { label: "Open pull requests and changes panels proactively", keys: ["proactivePanelsEnabled"] },
  { label: "Show skills in slash menu", keys: ["showSkillsInSlashMenu"] },
  { label: "Rich text composer", keys: ["composerRichTextEnabled"] },
  { label: "Send shortcut", keys: ["sendShortcut"] },
  { label: "Follow-up behavior", keys: ["followUpBehavior"] },
  { label: "Tool calls in chat", keys: ["toolCallVisibility"] },
  { label: "Unpin confirmation", keys: ["confirmThreadUnpin"] },
  { label: "Archive confirmation", keys: ["confirmThreadArchive"] },
  { label: "Delete confirmation", keys: ["confirmThreadDelete"] },
  { label: "Quit shortcut", keys: ["confirmQuit"] },
];

/** The labels to confirm and the patch that resets exactly those rows on this device. */
export function planDeviceSettingsRestore(settings: ClientSettings) {
  const changedRows = DEVICE_RESTORE_ROWS.map((row) => ({
    label: row.label,
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

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
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
