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
  welcomeContinueWithout,
  welcomeExistingProjects,
  welcomeProjectSources,
  welcomeStepIndicator,
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

  it("names the card Continue leaves out only when exactly one card is ready", () => {
    const cards = (claude: boolean, codex: boolean) => [
      { name: "Claude Code", ready: claude },
      { name: "Codex", ready: codex },
    ];
    expect(welcomeContinueWithout(cards(true, false))).toBe("Codex");
    expect(welcomeContinueWithout(cards(false, true))).toBe("Claude Code");
    expect(welcomeContinueWithout(cards(true, true))).toBeNull();
    expect(welcomeContinueWithout(cards(false, false))).toBeNull();
  });
});

describe("project step", () => {
  it("marks agents done once the project step is current", () => {
    expect(welcomeStepIndicator("agents").map((step) => step.state)).toEqual([
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(welcomeStepIndicator("project").map((step) => step.state)).toEqual([
      "done",
      "current",
      "upcoming",
    ]);
  });

  it("offers a new project only where the computer has a folder for new projects", () => {
    expect(welcomeProjectSources("/home/user/codenine-projects")).toEqual([
      "new",
      "folder",
      "clone",
    ]);
    expect(welcomeProjectSources(null)).toEqual(["folder", "clone"]);
  });

  it("lists this computer's three latest projects, without archived ones or the no-project home", () => {
    const project = (id: string, updatedAt: string, extra: object = {}) => ({
      id,
      environmentId: "local",
      updatedAt,
      archivedAt: null,
      ...extra,
    });
    const listed = welcomeExistingProjects(
      [
        project("old", "2026-01-01T00:00:00.000Z"),
        project("new", "2026-04-01T00:00:00.000Z"),
        project("scratch", "2026-05-01T00:00:00.000Z", { isScratch: true }),
        project("archived", "2026-05-01T00:00:00.000Z", { archivedAt: "2026-05-02T00:00:00.000Z" }),
        project("remote", "2026-05-01T00:00:00.000Z", { environmentId: "remote" }),
        project("mid", "2026-03-01T00:00:00.000Z"),
        project("older", "2026-02-01T00:00:00.000Z"),
      ],
      "local",
    );
    expect(listed.map((entry) => entry.id)).toEqual(["new", "mid", "older"]);
  });
});
