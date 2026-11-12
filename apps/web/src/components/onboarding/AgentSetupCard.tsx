import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@codenine/client-runtime/connection";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@codenine/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalSessionState,
} from "@codenine/client-runtime/state/terminal";
import {
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  ProviderDriverKind,
  ThreadId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@codenine/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon, CircleDashedIcon, MinusIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  type AgentCheck,
  type AgentCommandOutcome,
  type AgentSetupDriver,
  type AgentTerminalStep,
  agentSetupAction,
  agentSetupChecks,
  agentStepAfterCommand,
  followSetupTerminalCommand,
  INITIAL_SETUP_TERMINAL_WATCH,
  isBrowserOnServerMachine,
  isSetupShellReady,
  resetSetupTerminalOutput,
  resolveAgentSetupCommand,
  stopFollowingSetupTerminal,
  watchSetupTerminalBusy,
  watchSetupTerminalOutput,
} from "../../onboarding/providerReadiness.logic";
import { agentSetupState, turnedOnInstance } from "../../onboarding/welcomePage.logic";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { attachedTerminalSessionAtom } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";

const AGENT_SETUP_THREAD_ID = ThreadId.make("onboarding-agent-setup");

const PRODUCT_NAMES: Record<AgentSetupDriver, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

/** The CLI's own name for its default instance; a second account keeps the name it was given. */
export function agentSetupName(
  driver: AgentSetupDriver,
  instanceId: ProviderInstanceId,
  provider?: Pick<ServerProvider, "displayName">,
) {
  return instanceId === driver
    ? PRODUCT_NAMES[driver]
    : resolveProviderInstanceDisplayName({
        instanceId,
        driver: ProviderDriverKind.make(driver),
        ...(provider?.displayName ? { displayName: provider.displayName } : {}),
      });
}

function connectionKind(target: ConnectionTarget) {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "primary" as const;
    case "BearerConnectionTarget":
      return isDesktopLocalConnectionTarget(target)
        ? ("desktopLocal" as const)
        : ("bearer" as const);
    case "RelayConnectionTarget":
      return "relay" as const;
    case "SshConnectionTarget":
      return "ssh" as const;
  }
}

// Read when a command is typed: the connection can change while setup runs.
function readBrowserOnServerMachine(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  return isBrowserOnServerMachine({
    connection:
      connection === null
        ? null
        : { kind: connectionKind(connection.target), httpBaseUrl: connection.httpBaseUrl },
    pageHostname: window.location.hostname,
    desktopRenderer: window.desktopBridge !== undefined,
  });
}

const ACTION_LABELS = {
  turnOn: "Turn on",
  install: "Install",
  signIn: "Sign in",
  update: "Update",
  details: "Details",
} as const;

/**
 * Claude Code or Codex on one computer: whether it is installed, signed in, and ready, with one
 * button for the next step. Install and sign-in run in a terminal inside the card.
 */
export function AgentSetupCard({
  environmentId,
  driver,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: AgentSetupDriver;
  readonly instanceId: ProviderInstanceId;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const listed = providers?.find((provider) => provider.instanceId === instanceId);
  // A rebuild drops the instance for one update; its last status keeps a sign-in in progress.
  const [lastListed, setLastListed] = useState(listed);
  if (listed !== undefined && listed !== lastListed) setLastListed(listed);
  const provider = listed ?? lastListed;
  const settings = serverConfig?.settings;
  const state = agentSetupState(provider, settings);
  const checks = agentSetupChecks(provider, state);
  const action = agentSetupAction(provider, state);
  const name = agentSetupName(driver, instanceId, provider);
  const chatGpt =
    driver === "codex" &&
    state !== "ready" &&
    state !== "disabled" &&
    readCodexSetupMode(settings?.providerInstances[instanceId]?.config) === "managed";
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [terminalStep, setTerminalStep] = useState<AgentTerminalStep | null>(null);
  const [chatGptRequested, setChatGptRequested] = useState(false);
  const terminalAction = action === "install" || action === "signIn" ? action : null;

  const refresh = () => refreshProviders({ environmentId, input: { instanceId } });

  const openTerminal = (step: AgentTerminalStep) => {
    if (serverConfig === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope))
      return;
    setTerminalStep(step);
  };

  const commandFor = (step: AgentTerminalStep) =>
    serverConfig === null
      ? null
      : resolveAgentSetupCommand({
          step,
          provider: { instanceId, driver },
          settings: serverConfig.settings,
          platform: serverConfig.environment.platform.os,
          browserOnServer: readBrowserOnServerMachine(environmentId),
        });

  const recheck = async (typed: AgentTerminalStep): Promise<AgentCommandOutcome> => {
    const result = await refresh();
    const next =
      result._tag === "Success"
        ? result.value.providers.find((candidate) => candidate.instanceId === instanceId)
        : undefined;
    const nextState = agentSetupState(next, settings);
    return agentStepAfterCommand(typed, nextState, agentSetupAction(next, nextState));
  };

  const turnOn = async () => {
    if (serverConfig === null || provider === undefined) return;
    const instance = serverConfig.settings.providerInstances[instanceId] ?? {
      driver: provider.driver,
    };
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: turnedOnInstance(instance),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not turn on ${name}`,
          ...(cause instanceof Error ? { description: cause.message } : {}),
        });
      }
      return;
    }
    void refresh();
  };

  // ChatGPT sign-in runs a Codex that Codenine manages; the CLI choice uses the user's own.
  const changeCodexMode = (setupMode: "managed" | "existing") => {
    if (serverConfig === null || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    const instance = serverConfig.settings.providerInstances[instanceId] ?? {
      driver: ProviderDriverKind.make(driver),
      config: {},
    };
    const config =
      instance.config !== null && typeof instance.config === "object" ? instance.config : {};
    if (readCodexSetupMode(config) === setupMode && provider?.enabled) return;
    setChatGptRequested(setupMode === "managed");
    // One-instance upsert keeps a provider another client added in the meantime.
    void persistProviderInstance({
      operation: "upsert",
      instanceId,
      instance: { ...instance, enabled: true, config: { ...config, enabled: true, setupMode } },
    }).then((result) => {
      if (result._tag === "Success") return;
      setChatGptRequested(false);
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save Codex setup",
        ...(cause instanceof Error ? { description: cause.message } : {}),
      });
    });
  };

  const settingsLink = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      aria-label={`${label}: ${name}`}
      render={<Link to="/settings/providers" search={{ environmentId, instanceId }} />}
    >
      {label}
    </Button>
  );
  const primary =
    state === "ready" ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
        <CheckIcon className="size-3.5" />
        Ready
      </span>
    ) : action === null || terminalStep !== null || chatGpt ? null : action === "turnOn" ? (
      <Button
        size="sm"
        aria-label={`Turn on: ${name}`}
        disabled={!canManageProviders || serverConfig === null}
        onClick={() => void turnOn()}
      >
        Turn on
      </Button>
    ) : terminalAction !== null ? (
      <Button
        size="sm"
        aria-label={`${ACTION_LABELS[terminalAction]}: ${name}`}
        disabled={!canOperateTerminal || serverConfig === null}
        onClick={() => openTerminal(terminalAction)}
      >
        {ACTION_LABELS[terminalAction]}
      </Button>
    ) : (
      settingsLink(ACTION_LABELS[action])
    );
  const offersChatGpt =
    driver === "codex" && terminalStep === null && (chatGpt || terminalAction !== null);
  const notes = [
    terminalAction !== null && !chatGpt && !canOperateTerminal
      ? "This connection cannot control terminals."
      : null,
    (action === "turnOn" || offersChatGpt) && !canManageProviders
      ? "This connection cannot manage agents."
      : null,
  ].filter((note) => note !== null);

  return (
    <section
      aria-label={name}
      className="rounded-lg border border-border bg-background px-4 py-3 text-foreground"
    >
      <div className="flex min-h-8 items-center gap-3">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make(driver)}
          displayName={name}
          iconClassName="size-[18px]"
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h3>
        <div className="shrink-0">{primary}</div>
      </div>
      {checks === null ? (
        <p className="mt-2 pl-7.5 text-xs text-muted-foreground">Turned off</p>
      ) : (
        <ul aria-label={`${name} checks`} className="mt-2 grid gap-1 pl-7.5">
          <AgentCheckRow label="Installed" check={checks.installed} />
          <AgentCheckRow label="Signed in" check={checks.signedIn} />
          <AgentCheckRow label="Ready" check={checks.ready} />
        </ul>
      )}
      {offersChatGpt || notes.length > 0 ? (
        <div className="mt-2 flex flex-col items-start gap-1 pl-7.5 text-xs">
          {offersChatGpt ? (
            <InlineButton
              tone="muted"
              disabled={!canManageProviders || serverConfig === null}
              onClick={() => changeCodexMode(chatGpt ? "existing" : "managed")}
            >
              {chatGpt ? "Use the Codex CLI instead" : "Use ChatGPT sign-in instead"}
            </InlineButton>
          ) : null}
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      {chatGpt && provider !== undefined ? (
        <div className="mt-3">
          <CodexSetupSection
            presentation="onboarding"
            environmentId={environmentId}
            instanceId={instanceId}
            provider={provider}
            mode="managed"
            enabled={provider.enabled}
            readOnly={!canManageProviders}
            displayName="ChatGPT account"
            onModeChange={changeCodexMode}
            autoStart={chatGptRequested}
            onAutoStartConsumed={() => setChatGptRequested(false)}
          />
        </div>
      ) : null}
      {terminalStep !== null && serverConfig !== null ? (
        <AgentSetupTerminal
          environmentId={environmentId}
          instanceId={instanceId}
          driver={driver}
          name={name}
          // A fresh shell starts where the user's own terminal would.
          cwd={serverConfig.homeDirectory ?? serverConfig.cwd}
          keybindings={serverConfig.keybindings}
          firstStep={terminalStep}
          commandFor={commandFor}
          recheck={recheck}
          onClose={() => {
            setTerminalStep(null);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function AgentCheckRow({ label, check }: { readonly label: string; readonly check: AgentCheck }) {
  const settled = check.status === "pass" || check.status === "fail";
  return (
    <li className="flex min-w-0 items-start gap-2 text-xs leading-5">
      <span className="flex h-5 shrink-0 items-center">
        {check.status === "pass" ? (
          <CheckIcon aria-label="Done" className="size-3.5 text-success-foreground" />
        ) : check.status === "fail" ? (
          <XIcon aria-label="Missing" className="size-3.5 text-destructive" />
        ) : check.status === "pending" ? (
          <CircleDashedIcon aria-label="Checking" className="size-3.5 text-muted-foreground" />
        ) : (
          <MinusIcon aria-label="Not checked" className="size-3.5 text-muted-foreground/60" />
        )}
      </span>
      <span className={settled ? "shrink-0 text-foreground" : "shrink-0 text-muted-foreground"}>
        {label}
      </span>
      <span className="min-w-0 line-clamp-2 break-words text-muted-foreground">
        {check.status === "pending" ? (
          "Checking…"
        ) : check.status === "pass" && check.email ? (
          <RedactedSensitiveText
            value={check.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="break-all"
          />
        ) : check.status === "pass" || check.status === "fail" ? (
          check.detail
        ) : null}
      </span>
    </li>
  );
}

type TerminalPhase =
  | { readonly kind: "opening" | "openFailed" | "ready" | "stop" }
  | {
      readonly kind: "waitShell" | "running" | "checking" | "unchanged";
      readonly step: AgentTerminalStep;
    }
  | {
      readonly kind: "typed" | "writeFailed";
      readonly step: AgentTerminalStep;
      readonly command: string;
    };

function terminalStatus(phase: TerminalPhase, name: string) {
  switch (phase.kind) {
    case "opening":
      return "Opening a terminal…";
    case "openFailed":
      return "Could not open the terminal.";
    case "waitShell":
      return "Waiting for the terminal to be ready…";
    case "typed":
      return phase.step === "install"
        ? "Review the install command, then press Enter to run it."
        : "Review the sign-in command, then press Enter to run it.";
    case "writeFailed":
      return (
        <>
          Run <code className="rounded bg-muted px-1 font-mono">{phase.command}</code> in this
          terminal.
        </>
      );
    case "running":
      return `Running. Codenine checks ${name} again when it finishes.`;
    case "checking":
      return `Checking ${name}…`;
    case "unchanged":
      return phase.step === "install"
        ? `${name} is still not installed. Check the output, then run the command again.`
        : `${name} is still signed out. Check the output, then run the command again.`;
    case "ready":
      return `${name} is ready. You can close the terminal.`;
    case "stop":
      return "Finished. The card shows what is left.";
  }
}

/**
 * A shell on the agent's computer that types each command once the prompt is up, checks the
 * agent again when the command finishes, and types the next one. The user presses Enter.
 */
function AgentSetupTerminal({
  environmentId,
  instanceId,
  driver,
  name,
  cwd,
  keybindings,
  firstStep,
  commandFor,
  recheck,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: AgentSetupDriver;
  readonly name: string;
  readonly cwd: string;
  readonly keybindings: ServerConfig["keybindings"];
  readonly firstStep: AgentTerminalStep;
  readonly commandFor: (step: AgentTerminalStep) => string | null;
  readonly recheck: (typed: AgentTerminalStep) => Promise<AgentCommandOutcome>;
  readonly onClose: () => void;
}) {
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const watchRef = useRef(INITIAL_SETUP_TERMINAL_WATCH);
  const pendingStepRef = useRef<AgentTerminalStep | null>(null);
  // Typing before the viewport's size reaches the PTY makes the shell redraw a wrapped line.
  const gridAppliedRef = useRef(false);
  const typedStepRef = useRef(firstStep);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, AGENT_SETUP_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [phase, setPhase] = useState<TerminalPhase>({ kind: "opening" });
  const opened = phase.kind !== "opening" && phase.kind !== "openFailed";
  // The same launch as the viewport's, so both share one attachment.
  const sessionAtom = attachedTerminalSessionAtom(environmentId, {
    threadId: AGENT_SETUP_THREAD_ID,
    terminalId,
    cwd,
    providerInstanceId: instanceId,
  });

  const typeCommand = async (step: AgentTerminalStep) => {
    const command = commandFor(step);
    // A check can finish after the terminal closed.
    if (command === null || activeSetupGenerationRef.current === null) return;
    pendingStepRef.current = null;
    typedStepRef.current = step;
    watchRef.current = followSetupTerminalCommand(watchRef.current);
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
      setPhase({ kind: "writeFailed", step, command });
      return;
    }
    setPhase({ kind: "typed", step, command });
    const wrote = await writeTerminal({
      environmentId,
      input: { threadId: AGENT_SETUP_THREAD_ID, terminalId, data: command },
    });
    if (wrote._tag === "Success") return;
    setPhase((current) =>
      current.kind === "typed" && current.command === command
        ? { kind: "writeFailed", step, command }
        : current,
    );
  };

  // A command typed before the prompt is read by startup scripts or drawn over the prompt.
  const typeWhenReady = (step: AgentTerminalStep) => {
    if (gridAppliedRef.current && isSetupShellReady(watchRef.current)) {
      void typeCommand(step);
      return;
    }
    pendingStepRef.current = step;
    setPhase({ kind: "waitShell", step });
  };

  const checkAfterCommand = async (step: AgentTerminalStep) => {
    setPhase({ kind: "checking", step });
    const outcome = await recheck(step);
    switch (outcome.type) {
      case "ready":
        setPhase({ kind: "ready" });
        return;
      case "stop":
        setPhase({ kind: "stop" });
        return;
      case "unchanged": {
        // The user may already be running it again.
        const watch = followSetupTerminalCommand(watchRef.current);
        watchRef.current = watch;
        setPhase({ kind: watch.command === "running" ? "running" : "unchanged", step });
        return;
      }
      case "next":
        typeWhenReady(outcome.step);
        return;
    }
  };

  const advance = useEffectEvent(() => {
    const watch = watchRef.current;
    const pending = pendingStepRef.current;
    if (pending !== null) {
      if (gridAppliedRef.current && isSetupShellReady(watch)) void typeCommand(pending);
      return;
    }
    if (watch.command === "running") {
      setPhase((current) =>
        current.kind === "typed" || current.kind === "writeFailed" || current.kind === "unchanged"
          ? { kind: "running", step: current.step }
          : current,
      );
    } else if (watch.command === "finished") {
      watchRef.current = stopFollowingSetupTerminal(watch);
      void checkAfterCommand(typedStepRef.current);
    }
  });
  const handleGridApplied = () => {
    gridAppliedRef.current = true;
    const pending = pendingStepRef.current;
    if (pending !== null && isSetupShellReady(watchRef.current)) void typeCommand(pending);
  };
  const startFirstStep = useEffectEvent(() => {
    watchRef.current = INITIAL_SETUP_TERMINAL_WATCH;
    typeWhenReady(firstStep);
  });

  // StrictMode can finish a cancelled open after its replacement; it must not close that session.
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- opens the setup PTY and closes it on cleanup
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    gridAppliedRef.current = false;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry reopens the terminal, which shows as opening until the open settles.
    setPhase({ kind: "opening" });

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setPhase({ kind: "openFailed" });
        return;
      }
      const result = await openTerminal({
        environmentId,
        input: { threadId: AGENT_SETUP_THREAD_ID, terminalId, cwd, providerInstanceId: instanceId },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      if (result._tag !== "Success") {
        setPhase({ kind: "openFailed" });
        return;
      }
      startFirstStep();
    });

    // Revocation leaves the PTY running; close only while terminal access remains.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_SETUP_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    cwd,
    environmentId,
    instanceId,
    openTerminal,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
  ]);

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- follows the shell's output and the server's subprocess check to type at the prompt and notice when a command finishes
  useEffect(() => {
    if (!opened) return;
    let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
    const follow = (session: TerminalSessionState) => {
      const update = readTerminalOutputUpdate(session.output, cursor);
      cursor = update.cursor;
      let watch = watchRef.current;
      if (update.type === "reset") watch = resetSetupTerminalOutput(watch, update.data);
      else if (update.type === "append") watch = watchSetupTerminalOutput(watch, update.data);
      watchRef.current = watchSetupTerminalBusy(watch, session.hasRunningSubprocess);
      advance();
    };
    return appAtomRegistry.subscribe(sessionAtom, follow, { immediate: true });
  }, [opened, sessionAtom]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span
          aria-live="polite"
          className={
            phase.kind === "ready"
              ? "text-2xs font-medium text-success-foreground"
              : "text-2xs font-medium text-muted-foreground"
          }
        >
          {canOperateTerminal
            ? terminalStatus(phase, name)
            : "This connection cannot control terminals."}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {phase.kind === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              Retry
            </Button>
          ) : phase.kind === "waitShell" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => void typeCommand(phase.step)}
            >
              Type it now
            </Button>
          ) : null}
          <Button
            size="xs"
            variant={phase.kind === "ready" ? "outline" : "ghost-muted"}
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {opened ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_SETUP_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`${name} setup`}
            cwd={cwd}
            providerInstanceId={instanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            onGridApplied={handleGridApplied}
            autoFocus
            visible
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
