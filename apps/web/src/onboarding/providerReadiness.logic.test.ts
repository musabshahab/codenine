import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentSetupAction,
  agentSetupChecks,
  agentStepAfterCommand,
  followSetupTerminalCommand,
  getOnboardingProviderState,
  INITIAL_SETUP_TERMINAL_WATCH,
  isBrowserOnServerMachine,
  isSetupShellReady,
  resetSetupTerminalOutput,
  resolveAgentSetupCommand,
  resolveOnboardingProviderLoginCommand,
  type SetupTerminalWatch,
  stopFollowingSetupTerminal,
  watchSetupTerminalBusy,
  watchSetupTerminalOutput,
} from "./providerReadiness.logic";
import { agentSetupState } from "./welcomePage.logic";

const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyCodex, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyCodex, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyCodex, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyCodex, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyCodex, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyCodex, installed: false, status: "error" })).toBe(
      "install",
    );
  });
});

describe("resolveOnboardingProviderLoginCommand", () => {
  it("uses the selected Codex account binary", () => {
    const provider = { ...readyCodex, instanceId: ProviderInstanceId.make("codex_work") };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/codex-work/bin/codex" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/codex-work/bin/codex login");
  });

  it("quotes a Codex path with spaces for PowerShell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "C:\\Program Files\\Codex & Tools\\codex.exe",
              },
            },
          },
        },
        "windows",
      ),
    ).toBe("& 'C:\\Program Files\\Codex & Tools\\codex.exe' login");
  });

  it("quotes a Claude path with shell metacharacters on POSIX", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("claude")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: {
                binaryPath: "/opt/Claude Tools/$current/claude",
              },
            },
          },
        },
        "linux",
      ),
    ).toBe("'/opt/Claude Tools/$current/claude' auth login");
  });

  it.each([
    ["~/my tools/codex", "~/'my tools/codex' login"],
    ["~\\my tools/codex", "~/'my tools/codex' login"],
    ["~/tools/codex's build", `~/'tools/codex'"'"'s build' login`],
    ["~\\tools\\codex's build", `~/'tools\\codex'"'"'s build' login`],
    ["~/tools/codex; echo unsafe", "~/'tools/codex; echo unsafe' login"],
  ])("keeps the home prefix expandable while quoting %s", (binaryPath, expectedCommand) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath,
              },
            },
          },
        },
        "linux",
      ),
    ).toBe(expectedCommand);
  });

  it("signs Codex in with a device code when the browser is not on the server's machine", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { binaryPath: "C:\\Tools\\codex.exe" },
        },
      },
    };
    const login = (browserOnServer: boolean, platform: "linux" | "windows") =>
      resolveOnboardingProviderLoginCommand(readyCodex, settings, platform, { browserOnServer });

    expect(login(false, "windows")).toBe("C:\\Tools\\codex.exe login --device-auth");
    expect(login(true, "windows")).toBe("C:\\Tools\\codex.exe login");
    // Claude's own sign-in already prints a link and takes a pasted code.
    expect(
      resolveOnboardingProviderLoginCommand(
        { instanceId: ProviderInstanceId.make("claudeAgent"), driver: "claudeAgent" },
        DEFAULT_SERVER_SETTINGS,
        "linux",
        { browserOnServer: false },
      ),
    ).toBe("claude auth login");
  });

  it("uses the default command when an old server reports an unknown shell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: {
                binaryPath: "/opt/Codex Tools/codex",
              },
            },
          },
        },
        "unknown",
      ),
    ).toBe("codex login");
  });
});

const codex = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  ...readyCodex,
  auth: { status: "authenticated", email: "dev@example.com" },
  ...overrides,
});
const broken = {
  status: "broken",
  message: "Update Codex to 0.170 or later.",
  recommendedVersion: "0.170.0",
  recommendedRange: null,
} as const;

describe("agent card", () => {
  it.each<[string, ServerProvider | undefined, unknown, ReturnType<typeof agentSetupAction>]>([
    [
      "pending while the server checks it",
      codex({ installed: false, status: "warning", auth: { status: "unknown" } }),
      { installed: "pending", signedIn: "pending", ready: "pending" },
      null,
    ],
    ["pending before the server lists it", undefined, { installed: "pending" }, null],
    [
      "missing",
      codex({ installed: false, status: "error", auth: { status: "unknown" } }),
      { installed: ["fail", "Not installed"], signedIn: "skip", ready: "skip" },
      "install",
    ],
    [
      "signed out",
      codex({ status: "error", auth: { status: "unauthenticated" }, installedVersion: "0.5.0" }),
      { installed: ["pass", "v0.5.0"], signedIn: ["fail", "Signed out"], ready: "skip" },
      "signIn",
    ],
    [
      "ready",
      codex(),
      {
        installed: ["pass", "v1.0.0"],
        signedIn: ["pass", null, "dev@example.com"],
        ready: ["pass", "Works"],
      },
      null,
    ],
    [
      "ready without an account to report",
      codex({ auth: { status: "unknown" }, version: null }),
      { installed: ["pass", null], signedIn: ["pass", null], ready: ["pass", "Works"] },
      null,
    ],
    [
      "failing a check without an account",
      codex({ status: "error", auth: { status: "unknown" }, message: "Codex timed out." }),
      { signedIn: "skip", ready: ["fail", "Codex timed out."] },
      "signIn",
    ],
    [
      "signed in but failing",
      codex({ status: "warning" }),
      { signedIn: ["pass", null, "dev@example.com"], ready: ["fail", "Needs attention"] },
      "details",
    ],
    [
      "on a broken version",
      codex({ compatibilityAdvisory: broken, status: "error" }),
      { installed: ["pass", "v1.0.0"], ready: ["fail", "Update Codex to 0.170 or later."] },
      "update",
    ],
    [
      "signed out on a broken version",
      codex({ compatibilityAdvisory: broken, auth: { status: "unauthenticated" } }),
      { signedIn: ["fail", "Signed out"] },
      "update",
    ],
    [
      "unable to load",
      codex({
        enabled: false,
        installed: false,
        status: "error",
        availability: "unavailable",
        unavailableReason: "Invalid config.",
      }),
      { installed: "skip", signedIn: "skip", ready: ["fail", "Invalid config."] },
      "details",
    ],
    ["turned off", codex({ enabled: false }), null, "turnOn"],
  ])("shows an agent %s", (_, provider, expected, action) => {
    const state = agentSetupState(provider, undefined);
    const checks = agentSetupChecks(provider, state);
    const flatten = (check: NonNullable<typeof checks>["installed"]) =>
      !("detail" in check)
        ? check.status
        : "email" in check && check.email
          ? [check.status, check.detail, check.email]
          : [check.status, check.detail];
    const flat =
      checks === null
        ? null
        : {
            installed: flatten(checks.installed),
            signedIn: flatten(checks.signedIn),
            ready: flatten(checks.ready),
          };
    if (expected === null) expect(flat).toBeNull();
    else expect(flat).toMatchObject(expected as object);
    expect(agentSetupAction(provider, state)).toBe(action);
  });

  it("types the next step's command once a command finishes", () => {
    expect(agentStepAfterCommand("install", "signIn", "signIn")).toEqual({
      type: "next",
      step: "signIn",
    });
    expect(agentStepAfterCommand("signIn", "ready", null)).toEqual({ type: "ready" });
    expect(agentStepAfterCommand("install", "install", "install")).toEqual({
      type: "unchanged",
    });
    expect(agentStepAfterCommand("signIn", "attention", "update")).toEqual({ type: "stop" });
    expect(agentStepAfterCommand("signIn", "checking", null)).toEqual({ type: "stop" });
  });

  it.each([
    ["install", "claudeAgent", "linux", true, "curl -fsSL https://claude.ai/install.sh | bash"],
    ["install", "claudeAgent", "windows", true, "irm https://claude.ai/install.ps1 | iex"],
    ["install", "codex", "darwin", true, "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    ["install", "codex", "windows", false, "irm https://chatgpt.com/codex/install.ps1 | iex"],
    ["signIn", "codex", "linux", true, "/opt/codex login"],
    ["signIn", "codex", "linux", false, "/opt/codex login --device-auth"],
    ["signIn", "claudeAgent", "darwin", false, "'/opt/My Claude/claude' auth login"],
  ] as const)(
    "runs %s for %s on %s (browser on server: %s)",
    (step, driver, platform, local, command) => {
      const instanceId = ProviderInstanceId.make(driver);
      expect(
        resolveAgentSetupCommand({
          step,
          provider: { instanceId, driver },
          settings: {
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make(driver),
                config: { binaryPath: driver === "codex" ? "/opt/codex" : "/opt/My Claude/claude" },
              },
            },
          },
          platform,
          browserOnServer: local,
        }),
      ).toBe(command);
    },
  );
});

describe("isBrowserOnServerMachine", () => {
  it.each([
    ["the desktop app's own server", "desktopLocal", "http://127.0.0.1:3773", "app", true, true],
    ["a local browser", "primary", "http://localhost:5733", "localhost", false, true],
    [
      "a browser on another device",
      "primary",
      "https://box.tailnet.ts.net",
      "box.tailnet.ts.net",
      false,
      false,
    ],
    [
      "a browser using a loopback server it cannot be on",
      "bearer",
      "http://127.0.0.1:3773",
      "laptop.lan",
      false,
      false,
    ],
    [
      "the desktop app on a saved loopback connection",
      "bearer",
      "http://localhost:3773",
      "app",
      true,
      true,
    ],
    ["an SSH forward", "ssh", "http://127.0.0.1:40123", "app", true, false],
    ["a relay", "relay", "https://relay.example", "app", true, false],
  ] as const)("treats %s", (_, kind, httpBaseUrl, pageHostname, desktopRenderer, expected) => {
    expect(
      isBrowserOnServerMachine({
        connection: { kind, httpBaseUrl },
        pageHostname,
        desktopRenderer,
      }),
    ).toBe(expected);
  });

  it("treats an unknown connection as remote", () => {
    expect(
      isBrowserOnServerMachine({
        connection: null,
        pageHostname: "localhost",
        desktopRenderer: true,
      }),
    ).toBe(false);
  });
});

describe("setup terminal", () => {
  const PASTE_ON = "\x1b[?2004h";
  const PASTE_OFF = "\x1b[?2004l";
  const output = (watch: SetupTerminalWatch, ...chunks: ReadonlyArray<string>) =>
    chunks.reduce(watchSetupTerminalOutput, watch);

  it("waits for the shell's line editor before typing", () => {
    const starting = output(INITIAL_SETUP_TERMINAL_WATCH, "Last login: Tue on ttys001\r\n");
    expect(isSetupShellReady(starting)).toBe(false);
    // The marker can arrive in two chunks.
    const split = output(starting, "\x1b[?20", "04h%n@host ~ % ");
    expect(isSetupShellReady(split)).toBe(true);
    expect(isSetupShellReady(output(starting, `${PASTE_ON}`))).toBe(true);
    // Once a line editor shows, a prompt-looking line alone does not count.
    expect(isSetupShellReady(output(split, PASTE_OFF, "running> "))).toBe(false);
  });

  it("falls back to the prompt for shells without a line editor", () => {
    expect(isSetupShellReady(output(INITIAL_SETUP_TERMINAL_WATCH, "me@box:~$ "))).toBe(true);
    expect(
      isSetupShellReady(output(INITIAL_SETUP_TERMINAL_WATCH, "\x1b[2J\x1b[HPS C:\\Users\\me> ")),
    ).toBe(true);
    expect(isSetupShellReady(output(INITIAL_SETUP_TERMINAL_WATCH, "Installing nvm...\r\n"))).toBe(
      false,
    );
    // zsh's lone padding mark before its prompt.
    expect(isSetupShellReady(output(INITIAL_SETUP_TERMINAL_WATCH, "\x1b[7m%\x1b[27m       "))).toBe(
      false,
    );
  });

  it("finishes a short command when the line editor takes the line and reads again", () => {
    const typed = followSetupTerminalCommand(
      output(INITIAL_SETUP_TERMINAL_WATCH, `${PASTE_ON}$ `, "codex login"),
    );
    expect(typed.command).toBe("waiting");
    const running = output(typed, `${PASTE_OFF}\r\n`);
    expect(running.command).toBe("running");
    expect(output(running, "Not found\r\n", `${PASTE_ON}$ `).command).toBe("finished");
    // Both in one chunk.
    expect(output(typed, `${PASTE_OFF}\r\nNot found\r\n${PASTE_ON}$ `).command).toBe("finished");
  });

  it("finishes a long command when the server sees its process end", () => {
    const typed = followSetupTerminalCommand(output(INITIAL_SETUP_TERMINAL_WATCH, `${PASTE_ON}$ `));
    const running = watchSetupTerminalBusy(output(typed, `${PASTE_OFF}\r\n`), true);
    expect(running.command).toBe("running");
    // A program that turns bracketed paste on is not the prompt coming back.
    const prompting = output(running, `${PASTE_ON}Paste code here > `);
    expect(prompting.command).toBe("running");
    expect(watchSetupTerminalBusy(prompting, false).command).toBe("finished");
  });

  it("follows the next run after a check, even one already running", () => {
    const busy = watchSetupTerminalBusy(INITIAL_SETUP_TERMINAL_WATCH, true);
    expect(busy.command).toBe("idle");
    const following = followSetupTerminalCommand(busy);
    expect(following.command).toBe("running");
    expect(watchSetupTerminalBusy(following, false).command).toBe("finished");
    expect(stopFollowingSetupTerminal(following).command).toBe("idle");
  });

  it("reads restored output for the shell's state without starting a command", () => {
    const typed = followSetupTerminalCommand(INITIAL_SETUP_TERMINAL_WATCH);
    const restored = resetSetupTerminalOutput(
      typed,
      `${PASTE_ON}$ ls\r\n${PASTE_OFF}a b\r\n${PASTE_ON}$ `,
    );
    expect(restored.command).toBe("waiting");
    expect(isSetupShellReady(restored)).toBe(true);
  });
});
