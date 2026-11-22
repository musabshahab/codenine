import {
  type BackgroundActivitySettings,
  type ClientSettings,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  ServerSettings,
} from "@codenine/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  planDeviceSettingsRestore,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";

describe("background activity profile option", () => {
  it.each<{
    readonly change: string;
    readonly overrides: BackgroundActivitySettings["overrides"];
    readonly reportsHostPower: boolean;
    readonly option: string;
  }>([
    {
      change: "host low power pause off, host power reported",
      overrides: { pauseWhenHostLowPower: false },
      reportsHostPower: true,
      option: "balanced",
    },
    {
      change: "client low power pause off",
      overrides: { pauseWhenClientLowPower: false },
      reportsHostPower: false,
      option: "balanced",
    },
    {
      change: "lock pause off, host power reported",
      overrides: { pauseWhenHostLocked: false },
      reportsHostPower: true,
      option: "advanced",
    },
    {
      change: "lock pause off, no host power",
      overrides: { pauseWhenHostLocked: false },
      reportsHostPower: false,
      option: "balanced",
    },
    {
      change: "idle host power interval changed, no host power",
      overrides: { hostPowerMonitorIdleInterval: Duration.minutes(1) },
      reportsHostPower: false,
      option: "balanced",
    },
    {
      change: "Performance intervals, no host power",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
        providerHealthRefreshInterval: Duration.minutes(1),
      },
      reportsHostPower: false,
      option: "performance",
    },
    {
      change: "custom git fetch interval",
      overrides: { automaticGitFetchInterval: Duration.seconds(42) },
      reportsHostPower: false,
      option: "advanced",
    },
  ])("shows $option for Balanced with $change", ({ overrides, reportsHostPower, option }) => {
    expect(
      resolveBackgroundActivityProfileOption(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides,
          },
        },
        reportsHostPower,
      ),
    ).toBe(option);
  });
});

describe("device settings restore", () => {
  it("lists and resets only the device rows that changed", () => {
    const { changedLabels, patch } = planDeviceSettingsRestore({
      ...DEFAULT_CLIENT_SETTINGS,
      threadDetailsItems: { usage: true },
      sidebarProjectGroupingMode: "separate",
      sidebarTwoLineRows: true,
      fontSizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode + 1,
      fontSmoothing: false,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-5" }],
      loadBalancingWeights: { "environment-1": 50 },
      sidebarProjectGroupingOverrides: { "environment-1:/repo": "separate" },
    });

    expect(changedLabels).toEqual([
      "Thread details",
      "Workspace grouping",
      "Two-line chat rows",
      "Code font",
      "Font smoothing",
    ]);
    expect(patch).toEqual({
      threadDetailsItems: {},
      threadDetailsUsageEnabled: false,
      sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
      sidebarTwoLineRows: DEFAULT_CLIENT_SETTINGS.sidebarTwoLineRows,
      fontFamilyCode: DEFAULT_CLIENT_SETTINGS.fontFamilyCode,
      fontSizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
      fontSmoothing: DEFAULT_CLIENT_SETTINGS.fontSmoothing,
    });
    expect(
      planDeviceSettingsRestore({ ...DEFAULT_CLIENT_SETTINGS, threadDetailsUsageEnabled: true }),
    ).toEqual({
      changedLabels: ["Thread details"],
      patch: { threadDetailsItems: {}, threadDetailsUsageEnabled: false },
    });
    expect(planDeviceSettingsRestore(DEFAULT_CLIENT_SETTINGS)).toEqual({
      changedLabels: [],
      patch: {},
    });
  });

  it("covers every device setting a row shows and never an environment setting", () => {
    const everythingChanged = Object.fromEntries(
      Object.keys(DEFAULT_CLIENT_SETTINGS).map((key) => [key, Symbol(key)]),
    ) as unknown as ClientSettings;
    const leftAlone = new Set([
      "onboardingCompletedAt",
      "onboardingCompletedEnvironmentId",
      "loadBalancingEnabled",
      "loadBalancingWeights",
      "sidebarProjectGroupingOverrides",
      "sidebarThreadSortOrder",
    ]);
    const deviceKeys = Object.keys(ClientSettingsSchema.fields).filter(
      (key) => !Object.hasOwn(ServerSettings.fields, key) && !leftAlone.has(key),
    );

    const { patch } = planDeviceSettingsRestore(everythingChanged);

    expect(Object.keys(patch).toSorted()).toEqual(deviceKeys.toSorted());
    expect(patch).toEqual(
      Object.fromEntries(
        deviceKeys.map((key) => [key, DEFAULT_CLIENT_SETTINGS[key as keyof ClientSettings]]),
      ),
    );
  });
});

describe("background activity shared policy", () => {
  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});
