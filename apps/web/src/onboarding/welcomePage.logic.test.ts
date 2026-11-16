import {
  ProjectId,
  resolveProviderInstanceEnabled,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentSetupState,
  groupWelcomeAgents,
  turnedOnInstance,
  welcomeCardInstanceId,
} from "./welcomePage.logic";

function provider(name: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(name.toLowerCase()),
    driver: ProviderDriverKind.make(name.toLowerCase()),
    displayName: name,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-23T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const nameOf = (entry: ServerProvider) => entry.displayName ?? entry.driver;
const names = (entries: ReadonlyArray<ServerProvider>) => entries.map(nameOf);

describe("groupWelcomeAgents", () => {
  it("lists agents on the computer by state, then name, and everything else by name", () => {
    const groups = groupWelcomeAgents(
      [
        provider("Zeta", { auth: { status: "unauthenticated" }, status: "error" }),
        provider("Codex"),
        provider("Pi", { enabled: false, status: "disabled" }),
        provider("Grok", { installed: false, status: "error", auth: { status: "unknown" } }),
        provider("Claude"),
        provider("Cursor", { installed: false, status: "warning", auth: { status: "unknown" } }),
      ],
      undefined,
      nameOf,
    );

    expect(names(groups.found)).toEqual(["Claude", "Codex", "Zeta"]);
    // Cursor is still being checked; it stays listed instead of disappearing.
    expect(names(groups.available)).toEqual(["Cursor", "Grok", "Pi"]);
    expect(groups.checking).toBe(true);
    expect(groups.readyCount).toBe(2);
  });

  it("uses this computer's settings and keeps agents that failed to load with the found ones", () => {
    const settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> = {
      providerInstances: {
        [ProviderInstanceId.make("claude")]: {
          driver: ProviderDriverKind.make("claude"),
          enabled: false,
        },
      },
      projectSettingsOverrides: {
        [ProjectId.make("project-a")]: {
          providerInstances: { [ProviderInstanceId.make("claude")]: { enabled: true } },
        },
      },
    };
    const groups = groupWelcomeAgents(
      [
        // The server checks Claude because project A turns it on; new projects still cannot use it.
        provider("Claude"),
        provider("Broken", {
          enabled: false,
          installed: false,
          status: "error",
          availability: "unavailable",
          unavailableReason: "Invalid config for instance 'broken'.",
        }),
        // Signed in and healthy, but the server knows this CLI version is broken.
        provider("Codex", {
          compatibilityAdvisory: {
            status: "broken",
            message: "Update Codex to 0.170 or later.",
            recommendedVersion: "0.170.0",
            recommendedRange: null,
          },
        }),
      ],
      settings,
      nameOf,
    );

    expect(names(groups.found)).toEqual(["Broken", "Codex"]);
    expect(names(groups.available)).toEqual(["Claude"]);
    expect(groups.readyCount).toBe(0);
    expect(groups.checking).toBe(false);
  });

  it("reports checking before the computer has sent its providers", () => {
    expect(groupWelcomeAgents(undefined, undefined, nameOf)).toEqual({
      checking: true,
      readyCount: 0,
      found: [],
      available: [],
    });
  });
});

describe("turnedOnInstance", () => {
  it("turns an agent on even when older settings keep it off inside its config", () => {
    const pi = ProviderDriverKind.make("pi");
    expect(resolveProviderInstanceEnabled(turnedOnInstance({ driver: pi }))).toBe(true);
    const migrated = turnedOnInstance({ driver: pi, config: { enabled: false, binaryPath: "pi" } });
    expect(resolveProviderInstanceEnabled(migrated)).toBe(true);
    expect(migrated.config).toEqual({ enabled: true, binaryPath: "pi" });
  });
});

describe("agent cards", () => {
  it("shows a ready second account on its driver's card, else the default instance", () => {
    const claude = (instanceId: string, overrides: Partial<ServerProvider> = {}) =>
      provider("Claude", {
        instanceId: ProviderInstanceId.make(instanceId),
        driver: ProviderDriverKind.make("claudeAgent"),
        ...overrides,
      });
    const signedOut = { auth: { status: "unauthenticated" }, status: "error" } as const;

    expect(welcomeCardInstanceId(undefined, "claudeAgent", undefined)).toBe("claudeAgent");
    expect(
      welcomeCardInstanceId(
        [claude("claudeAgent", signedOut), claude("claude_work")],
        "claudeAgent",
        undefined,
      ),
    ).toBe("claude_work");
    expect(
      welcomeCardInstanceId(
        [claude("claudeAgent", signedOut), claude("claude_work", signedOut)],
        "claudeAgent",
        undefined,
      ),
    ).toBe("claudeAgent");
    // OpenRouter runs on Claude Code but is its own agent, never the Claude Code card.
    expect(
      welcomeCardInstanceId(
        [
          claude("claudeAgent", signedOut),
          claude("openrouter", { auth: { status: "authenticated", type: "openrouter" } }),
        ],
        "claudeAgent",
        undefined,
      ),
    ).toBe("claudeAgent");
  });

  it("checks Codex again after a switch from ChatGPT sign-in to its CLI", () => {
    const codex = provider("Codex", {
      setup: { canAuthenticate: true, canInstall: true },
      auth: { status: "unauthenticated" },
      status: "error",
    });
    const settings = (setupMode: "managed" | "existing") => ({
      providerInstances: {
        [codex.instanceId]: { driver: codex.driver, config: { setupMode } },
      },
      projectSettingsOverrides: {},
    });

    expect(agentSetupState(codex, settings("existing"))).toBe("checking");
    expect(agentSetupState(codex, settings("managed"))).toBe("signIn");
    expect(agentSetupState(undefined, settings("managed"))).toBe("checking");
  });
});
