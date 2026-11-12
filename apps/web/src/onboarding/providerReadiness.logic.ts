import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  isProviderAvailable,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@codenine/contracts";
import { isLoopbackHost } from "@codenine/shared/loopbackHost";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getProviderVersionLabel } from "../components/settings/providerStatus";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const SAFE_SHELL_BINARY_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_BINARY_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

export type OnboardingProviderState = ReturnType<typeof getOnboardingProviderState>;

/** A CLI the server knows is too old or otherwise broken for Codenine; Settings updates it. */
export function isBrokenVersion(provider: ServerProvider) {
  return provider.installed && provider.compatibilityAdvisory?.status === "broken";
}

// These need no Node/npm and install where provider maintenance recognizes native binaries.
const NATIVE_INSTALL_COMMANDS = {
  claudeAgent: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    windows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
} as const;

/** The agents Codenine sets up from a terminal: their own CLIs, installed and signed in. */
export type AgentSetupDriver = keyof typeof NATIVE_INSTALL_COMMANDS;

/** The agents the Welcome page and the setup dialog always show, in order. */
export const AGENT_SETUP_DRIVERS = [
  "claudeAgent",
  "codex",
] as const satisfies ReadonlyArray<AgentSetupDriver>;

export const isAgentSetupDriver = (driver: string): driver is AgentSetupDriver =>
  Object.hasOwn(NATIVE_INSTALL_COMMANDS, driver);

function resolveOnboardingProviderInstallCommand(
  driver: AgentSetupDriver,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const commands = NATIVE_INSTALL_COMMANDS[driver];
  return platform === "windows" ? commands.windows : commands.posix;
}

/**
 * `codex login` waits for the browser to return to a port on the server, which a browser on
 * another device cannot reach; the device code flow only needs a link and a code. `claude auth
 * login` already accepts a pasted code.
 */
export function resolveOnboardingProviderLoginCommand(
  provider: { readonly instanceId: ProviderInstanceId; readonly driver: string },
  settings: Pick<ServerSettings, "providerInstances">,
  platform: ExecutionEnvironmentPlatformOs,
  options: { readonly browserOnServer?: boolean } = {},
): string {
  const instance = settings.providerInstances[provider.instanceId];

  if (provider.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance?.config ?? {});
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "claude";
    return `${quoteProviderBinary(binaryPath, "claude", platform)} auth login`;
  }

  if (provider.driver === "codex") {
    const config = decodeCodexSettings(instance?.config ?? {});
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "codex";
    const login = `${quoteProviderBinary(binaryPath, "codex", platform)} login`;
    return options.browserOnServer === false ? `${login} --device-auth` : login;
  }

  return provider.driver;
}

export type AgentTerminalStep = "install" | "signIn";

export function resolveAgentSetupCommand(input: {
  readonly step: AgentTerminalStep;
  readonly provider: { readonly instanceId: ProviderInstanceId; readonly driver: AgentSetupDriver };
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly platform: ExecutionEnvironmentPlatformOs;
  readonly browserOnServer: boolean;
}): string {
  return input.step === "install"
    ? resolveOnboardingProviderInstallCommand(input.provider.driver, input.platform)
    : resolveOnboardingProviderLoginCommand(input.provider, input.settings, input.platform, {
        browserOnServer: input.browserOnServer,
      });
}

/**
 * Whether the browser runs on the server's machine, so a sign-in that waits for the browser on a
 * local port can finish. When unsure, it is not.
 */
export function isBrowserOnServerMachine(input: {
  readonly connection: {
    readonly kind: "primary" | "bearer" | "desktopLocal" | "relay" | "ssh";
    readonly httpBaseUrl: string;
  } | null;
  readonly pageHostname: string;
  readonly desktopRenderer: boolean;
}): boolean {
  const { connection } = input;
  if (connection === null) return false;
  if (connection.kind === "desktopLocal") return true;
  // An SSH forward and a relay end on loopback or a tunnel, not on the server's machine.
  if (connection.kind === "relay" || connection.kind === "ssh") return false;
  let serverHost: string;
  try {
    serverHost = new URL(connection.httpBaseUrl).hostname;
  } catch {
    return false;
  }
  return (
    isLoopbackHost(serverHost) && (input.desktopRenderer || isLoopbackHost(input.pageHostname))
  );
}

export type AgentCheck =
  | { readonly status: "pending" | "skip" }
  | { readonly status: "pass"; readonly detail: string | null; readonly email?: string }
  | { readonly status: "fail"; readonly detail: string };

export interface AgentChecks {
  readonly installed: AgentCheck;
  readonly signedIn: AgentCheck;
  readonly ready: AgentCheck;
}

const PENDING: AgentCheck = { status: "pending" };
const SKIP: AgentCheck = { status: "skip" };

/**
 * The three checks an agent card lists, in order. A later check that an earlier failure leaves
 * unknown is skipped rather than failed; a turned-off agent is not checked at all.
 */
export function agentSetupChecks(
  provider: ServerProvider | undefined,
  state: OnboardingProviderState,
): AgentChecks | null {
  if (state === "disabled") return null;
  if (provider === undefined || state === "checking") {
    return { installed: PENDING, signedIn: PENDING, ready: PENDING };
  }
  if (!isProviderAvailable(provider)) {
    const detail = provider.unavailableReason ?? provider.message ?? "Could not load";
    return { installed: SKIP, signedIn: SKIP, ready: { status: "fail", detail } };
  }
  const version =
    provider.installedVersion !== undefined ? provider.installedVersion : provider.version;
  const installed: AgentCheck = provider.installed
    ? { status: "pass", detail: getProviderVersionLabel(version) }
    : { status: "fail", detail: "Not installed" };
  const { auth } = provider;
  const signedIn: AgentCheck =
    auth.status === "authenticated"
      ? auth.email
        ? { status: "pass", detail: null, email: auth.email }
        : { status: "pass", detail: auth.label ?? auth.type ?? null }
      : auth.status === "unauthenticated"
        ? { status: "fail", detail: "Signed out" }
        : // Some agents cannot report an account; one that works is signed in.
          state === "ready"
          ? { status: "pass", detail: null }
          : SKIP;
  const ready: AgentCheck =
    state === "ready"
      ? { status: "pass", detail: "Works" }
      : state === "attention"
        ? {
            status: "fail",
            detail:
              (isBrokenVersion(provider) ? provider.compatibilityAdvisory?.message : null) ??
              provider.message ??
              (provider.status === "warning" ? "Needs attention" : "Not working"),
          }
        : SKIP;
  return { installed, signedIn, ready };
}

export type AgentSetupAction = "turnOn" | "install" | "signIn" | "update" | "details";

/**
 * The one next step a card offers. A broken version is updated from Settings, the way it was
 * installed; an agent that failed for another reason opens its Settings page.
 */
export function agentSetupAction(
  provider: ServerProvider | undefined,
  state: OnboardingProviderState,
): AgentSetupAction | null {
  if (provider === undefined) return null;
  switch (state) {
    case "checking":
    case "ready":
      return null;
    case "disabled":
      return "turnOn";
    case "install":
      return "install";
    case "signIn":
    case "attention":
      if (isBrokenVersion(provider)) return "update";
      // A check that failed without an account still gets the sign-in command.
      return state === "signIn" ||
        (isProviderAvailable(provider) &&
          provider.installed &&
          provider.auth.status !== "authenticated")
        ? "signIn"
        : "details";
  }
}

/** Whether a not-ready agent is one a terminal can fix: a missing or signed-out CLI. */
export function canSetUpInTerminal(provider: ServerProvider): boolean {
  if (!isAgentSetupDriver(provider.driver)) return false;
  // ChatGPT sign-in runs Codex for the user; it is set up in its own panel.
  if (provider.setup?.canAuthenticate === true) return false;
  const action = agentSetupAction(provider, getOnboardingProviderState(provider));
  return action === "install" || action === "signIn";
}

export type AgentCommandOutcome =
  | { readonly type: "ready" }
  | { readonly type: "next"; readonly step: AgentTerminalStep }
  | { readonly type: "unchanged" }
  | { readonly type: "stop" };

/** What the setup terminal does once a command finishes and the agent was checked again. */
export function agentStepAfterCommand(
  typed: AgentTerminalStep,
  state: OnboardingProviderState,
  action: AgentSetupAction | null,
): AgentCommandOutcome {
  if (state === "ready") return { type: "ready" };
  if (action === "install" || action === "signIn") {
    return action === typed ? { type: "unchanged" } : { type: "next", step: action };
  }
  return { type: "stop" };
}

// Line editors (zsh, fish, bash 5.1+) turn bracketed paste on while they read a command and off
// once they run it, so the shell's own output says when it waits for input.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const LINE_LIMIT = 1_024;
const PROMPT_END = /[$#%>❯›»λ]\s*$/u;

/**
 * What the setup terminal has shown so far. `command` follows one command from typed to finished:
 * `waiting` until the shell takes the line, `running` until the prompt returns.
 */
export interface SetupTerminalWatch {
  readonly lineEditor: "reading" | "running" | null;
  /** Raw output since the last newline, for spotting a prompt. */
  readonly line: string;
  readonly busy: boolean;
  readonly sawBusy: boolean;
  readonly command: "idle" | "waiting" | "running" | "finished";
}

export const INITIAL_SETUP_TERMINAL_WATCH: SetupTerminalWatch = {
  lineEditor: null,
  line: "",
  busy: false,
  sawBusy: false,
  command: "idle",
};

function stripTerminalControl(text: string): string {
  return text
    .replace(
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function lastLine(text: string): string {
  return text.slice(text.lastIndexOf("\n") + 1).slice(-LINE_LIMIT);
}

/** Restored output, as after a reconnect: it sets the shell's state but starts no command. */
export function resetSetupTerminalOutput(
  watch: SetupTerminalWatch,
  text: string,
): SetupTerminalWatch {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return {
    ...watch,
    line: lastLine(text),
    lineEditor: on === off ? watch.lineEditor : on > off ? "reading" : "running",
  };
}

export function watchSetupTerminalOutput(
  watch: SetupTerminalWatch,
  data: string,
): SetupTerminalWatch {
  // Markers can split across chunks; only those that end in the new data are new.
  const text = watch.line + data;
  const freshFrom = watch.line.length;
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  const lineEditor = on === off ? watch.lineEditor : on > off ? "reading" : "running";
  // Without a line editor, Enter shows as the line ending.
  const tookLine =
    lineEditor === null
      ? data.includes("\n")
      : off >= 0 && off + BRACKETED_PASTE_OFF.length > freshFrom;
  const line = lastLine(text);
  let { command } = watch;
  if (command === "waiting" && tookLine) command = "running";
  // A command shorter than one subprocess check, or one the shell runs itself (PowerShell's
  // installers), only shows as the prompt coming back.
  if (
    command === "running" &&
    !watch.sawBusy &&
    !watch.busy &&
    (lineEditor === null ? showsPrompt(line) : lineEditor === "reading")
  ) {
    command = "finished";
  }
  return { ...watch, line, lineEditor, command };
}

export function watchSetupTerminalBusy(
  watch: SetupTerminalWatch,
  busy: boolean,
): SetupTerminalWatch {
  if (busy === watch.busy) return watch;
  let { command, sawBusy } = watch;
  if (busy && (command === "waiting" || command === "running")) {
    command = "running";
    sawBusy = true;
  } else if (!busy && command === "running" && sawBusy) {
    command = "finished";
  }
  return { ...watch, busy, sawBusy, command };
}

/** A command was typed or may be run again: follow the next run. */
export function followSetupTerminalCommand(watch: SetupTerminalWatch): SetupTerminalWatch {
  return { ...watch, command: watch.busy ? "running" : "waiting", sawBusy: watch.busy };
}

export function stopFollowingSetupTerminal(watch: SetupTerminalWatch): SetupTerminalWatch {
  return { ...watch, command: "idle", sawBusy: false };
}

/**
 * Whether the shell waits for a command, so typed text lands on its prompt. A line editor says so
 * itself; other shells show a prompt. Text before then is read by startup scripts or echoed
 * over the prompt.
 */
export function isSetupShellReady(watch: SetupTerminalWatch): boolean {
  return watch.lineEditor !== null ? watch.lineEditor === "reading" : showsPrompt(watch.line);
}

function showsPrompt(rawLine: string): boolean {
  const visible = stripTerminalControl(rawLine);
  const line = visible.slice(visible.lastIndexOf("\r") + 1).trimEnd();
  // zsh pads a lone `%` before its prompt; a real prompt has more to it.
  return line.length >= 2 && PROMPT_END.test(line);
}
