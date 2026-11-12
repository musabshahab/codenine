import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ServerProvider } from "@codenine/contracts";
import { scopeProjectRef } from "@codenine/client-runtime/environment";
import { resolveProviderInstanceDisplayName as agentName } from "@codenine/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import { AuthProvidersManageScope } from "@codenine/contracts";
import { Link, useBlocker } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, PlusIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  AGENT_SETUP_DRIVERS,
  type AgentSetupDriver,
  isAgentSetupDriver,
  isBrokenVersion,
} from "../../onboarding/providerReadiness.logic";
import {
  groupWelcomeAgents,
  turnedOnInstance,
  welcomeCardInstanceId,
  welcomeContinueWithout,
  type WelcomeProjectSource,
  type WelcomeStep,
  welcomeAgentState,
} from "../../onboarding/welcomePage.logic";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { useDesktopCliCommand } from "../settings/CliCommandSettingsRow";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { cn } from "../../lib/utils";
import { AgentSetupCard, agentSetupName } from "./AgentSetupCard";
import AgentSetupDialog from "./AgentSetupDialog";
import { WelcomeProjectStep, WelcomeSteps } from "./WelcomeProjectStep";

/** Opens the page setup ends on. False sends the user to the app's home instead. */
export type WelcomeLanding = () => Promise<boolean>;

/**
 * First-run page for one computer: its agents, then a project. Every part is optional except one
 * ready agent to start chatting.
 */
export function WelcomePage({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: (landing: WelcomeLanding) => void | Promise<void>;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const label = environment?.label ?? "this computer";
  const welcomeAgents = useWelcomeAgents(environmentId);
  const agentReady = welcomeAgents.readyCount > 0;
  const continueWithout = welcomeContinueWithout(welcomeAgents.cards);
  const [step, setStep] = useState<WelcomeStep>("agents");
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // `codenine` on PATH belongs to the primary computer, so only it offers that.
  const isPrimary = primaryEnvironmentId === environmentId;
  // True while setup is saved before a landing; leaving earlier would drop the landing.
  const holdPageRef = useRef(false);
  useBlocker({
    shouldBlockFn: () => {
      if (!holdPageRef.current) return false;
      toastManager.add({
        id: "welcome-finishing",
        type: "info",
        title: "Finishing setup",
        description: "One moment.",
      });
      return true;
    },
    // Electron cancels a quit silently when unload is blocked.
    enableBeforeUnload: false,
  });
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  // Without a landing, setup is saved and the page stays, for a flow that navigates on its own.
  const finish = (landing: WelcomeLanding | null) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    holdPageRef.current = true;
    const completion = completeOnboarding(primaryEnvironmentId)
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        // Release before onDone so its own navigation is not blocked.
        holdPageRef.current = false;
        if (landing !== null) await onDone(landing);
        return true;
      })
      .catch(() => {
        holdPageRef.current = false;
        const errorToast = {
          type: "error",
          title: "Could not finish setup",
          description: "Your settings could not be saved. Try again.",
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };
  const openProjectDraft = async (project: {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }) =>
    (await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    })) !== null;
  // The palette's add-project flows open the new project's start screen themselves.
  const addProject = (source: WelcomeProjectSource) => {
    void finish(null).then((saved) => {
      if (saved)
        openCommandPalette({ open: "add-project", addProjectSource: { environmentId, source } });
    });
  };
  const skip = () => {
    void finish(async () => {
      if (scratchTargetEnvironmentId === null) return false;
      const project = await openScratchProject(scratchTargetEnvironmentId);
      return project !== null && (await openProjectDraft(project));
    });
  };

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Welcome")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        {/* Keyed by step, so each step opens at its top. */}
        <div key={step} className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-12 pb-8 sm:pt-20">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Welcome to Codenine
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Setting up <span className="text-foreground">{label}</span>.
            </p>
            <WelcomeSteps step={step} />
            {step === "agents" ? (
              <>
                <div className="mt-8 border-t border-border/60">
                  <AgentsSection environmentId={environmentId} isPrimary={isPrimary} />
                </div>
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                  {!agentReady ? (
                    <Button variant="ghost-muted" onClick={() => setStep("project")}>
                      Continue without an agent
                    </Button>
                  ) : continueWithout !== null ? (
                    <p className="min-w-0 max-w-md flex-1 text-xs text-muted-foreground">
                      Teams that mix Claude and Codex need both. You can set up {continueWithout}{" "}
                      later in Settings → Providers.
                    </p>
                  ) : (
                    <span />
                  )}
                  <div className="flex items-center gap-3">
                    {agentReady ? null : (
                      <span className="text-xs text-muted-foreground">
                        Set up one agent to continue.
                      </span>
                    )}
                    <Button disabled={!agentReady} onClick={() => setStep("project")}>
                      {continueWithout !== null
                        ? `Continue without ${continueWithout}`
                        : "Continue"}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <WelcomeProjectStep
                environmentId={environmentId}
                label={label}
                newProjectsRoot={environment?.serverConfig?.newProjectsRoot}
                readyAgentNames={welcomeAgents.found
                  .filter(
                    (provider) =>
                      welcomeAgentState(provider, welcomeAgents.serverConfig?.settings) === "ready",
                  )
                  .map(agentName)}
                canChatWithoutProject={scratchTargetEnvironmentId !== null}
                onChangeAgents={() => setStep("agents")}
                onAddProject={addProject}
                onOpenProject={(projectId) =>
                  void finish(() => openProjectDraft({ environmentId, id: projectId }))
                }
                onSkip={skip}
              />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

// Each part of the page is one band: its label on the left, its rows on the right.
function WelcomeSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 border-b border-border/60 py-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <h2 className="text-sm leading-10 text-muted-foreground">{title}</h2>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// Rows share one icon column, so names, checkboxes, and steps line up down the page.
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

// Shared by the page (to enable Continue) and the agents section, so both agree on what is ready.
function useWelcomeAgents(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = serverConfig?.settings;
  const cards = AGENT_SETUP_DRIVERS.map((driver) => {
    const instanceId = welcomeCardInstanceId(providers, driver, settings);
    const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
    return {
      driver,
      instanceId,
      name: agentSetupName(driver, instanceId, provider),
      ready: provider !== undefined && welcomeAgentState(provider, settings) === "ready",
    };
  });
  return {
    serverConfig,
    cards,
    ...groupWelcomeAgents(providers, settings, agentName),
  };
}

function AgentsSection({
  environmentId,
  isPrimary,
}: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
}) {
  const { serverConfig, cards, found, available } = useWelcomeAgents(environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [moreOpen, setMoreOpen] = useState(false);
  // A second Claude or Codex account opens the same card in a dialog.
  const [setupFor, setSetupFor] = useState<{
    readonly driver: AgentSetupDriver;
    readonly instanceId: ServerProvider["instanceId"];
  } | null>(null);

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- asks the environment to refresh its provider list when the environment changes
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  // The two cards always show; other agents keep their rows.
  const isCard = (provider: ServerProvider) =>
    cards.some((card) => card.instanceId === provider.instanceId);
  const otherFound = found.filter((provider) => !isCard(provider));
  const otherAvailable = available.filter((provider) => !isCard(provider));
  const stateOf = (provider: ServerProvider) => welcomeAgentState(provider, serverConfig?.settings);

  const turnOn = async (provider: ServerProvider) => {
    if (serverConfig === null) return;
    const instance = serverConfig.settings.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
    };
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: provider.instanceId,
      instance: turnedOnInstance(instance),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not turn on ${agentName(provider)}`,
          ...(cause instanceof Error ? { description: cause.message } : {}),
        });
      }
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
  };

  // One action per agent, the same in the list and in the grid.
  const actionFor = (provider: ServerProvider) => {
    const state = stateOf(provider);
    const name = agentName(provider);
    const settingsAction = (actionLabel: string) => (
      <Button
        size="xs"
        variant="outline"
        aria-label={`${actionLabel}: ${name}`}
        render={
          <Link
            to="/settings/providers"
            search={{ environmentId, instanceId: provider.instanceId }}
          />
        }
      >
        {actionLabel}
      </Button>
    );
    if (state === "disabled") {
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Turn on: ${name}`}
          disabled={!canManageProviders || serverConfig === null}
          onClick={() => void turnOn(provider)}
        >
          Turn on
        </Button>
      );
    }
    // Settings updates a broken CLI the way it was installed, including a custom binary path.
    if (isBrokenVersion(provider)) return settingsAction("Update");
    const { driver } = provider;
    if (isAgentSetupDriver(driver) && (state === "install" || state === "signIn")) {
      return (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Set up: ${name}`}
          onClick={() => setSetupFor({ driver, instanceId: provider.instanceId })}
        >
          <TerminalIcon className="size-3.5" />
          Set up
        </Button>
      );
    }
    return settingsAction(
      state === "signIn" ? "Sign in" : state === "attention" ? "Details" : "Set up",
    );
  };

  const cannotTurnOn =
    !canManageProviders &&
    [...otherFound, ...otherAvailable].some((provider) => stateOf(provider) === "disabled");

  return (
    <WelcomeSection title="Agents">
      <div className="flex flex-col gap-3 py-1">
        {cards.map((card) => (
          <AgentSetupCard
            key={card.instanceId}
            environmentId={environmentId}
            driver={card.driver}
            instanceId={card.instanceId}
          />
        ))}
      </div>
      {otherFound.length > 0 ? (
        <div className="mt-2">
          {otherFound.map((provider) => (
            <AgentRow
              key={provider.instanceId}
              provider={provider}
              state={stateOf(provider)}
              action={actionFor(provider)}
            />
          ))}
        </div>
      ) : null}
      {cannotTurnOn ? (
        <p className="pl-8 text-xs text-muted-foreground">This connection cannot manage agents.</p>
      ) : null}
      {otherAvailable.length > 0 ? (
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger className="group mt-1 flex min-h-10 w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <RowIcon>
              <PlusIcon className="size-4" />
            </RowIcon>
            <span className="text-sm text-muted-foreground group-hover:text-foreground">
              Add more agents
            </span>
            {moreOpen ? null : <AgentLogoStack providers={otherAvailable} />}
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              {otherAvailable.map((provider) => (
                <AgentRow
                  key={provider.instanceId}
                  provider={provider}
                  state={stateOf(provider)}
                  compact
                  action={actionFor(provider)}
                />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {isPrimary ? <CliPathSetup /> : null}
      {setupFor !== null ? (
        <AgentSetupDialog
          environmentId={environmentId}
          agent={setupFor}
          onClose={() => setSetupFor(null)}
        />
      ) : null}
    </WelcomeSection>
  );
}

// A quiet preview of what the fold holds; the names are inside it.
function AgentLogoStack({ providers }: { readonly providers: ReadonlyArray<ServerProvider> }) {
  if (providers.length === 0) return null;
  return (
    <span className="flex items-center gap-2 opacity-60 grayscale" aria-hidden>
      {providers.slice(0, 6).map((provider) => (
        <ProviderInstanceIcon
          key={provider.instanceId}
          driverKind={provider.driver}
          displayName={agentName(provider)}
          iconClassName="size-3.5"
        />
      ))}
    </span>
  );
}

function AgentRow({
  provider,
  state,
  action,
  compact = false,
}: {
  readonly provider: ServerProvider;
  readonly state: ReturnType<typeof welcomeAgentState>;
  readonly action?: ReactNode;
  // A row in the "Add more agents" grid: the button carries the state, so no detail line.
  readonly compact?: boolean;
}) {
  const name = agentName(provider);
  // Claude Code and Codex rows show Set up; other agents that are on say why not.
  const brokenMessage = isBrokenVersion(provider)
    ? (provider.compatibilityAdvisory?.message ?? null)
    : null;
  const detail =
    state === "install"
      ? isAgentSetupDriver(provider.driver)
        ? null
        : "Not installed"
      : compact || state === "ready" || state === "checking"
        ? null
        : state === "attention"
          ? (provider.unavailableReason ??
            brokenMessage ??
            provider.message ??
            getProviderSummary(provider).headline)
          : (brokenMessage ?? getProviderSummary(provider).headline);
  return (
    <div className={cn("flex items-center gap-3", compact ? "min-h-9" : "min-h-10 py-1")}>
      <RowIcon>
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={name}
          iconClassName={compact ? "size-4" : "size-[18px]"}
        />
      </RowIcon>
      <div className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm text-foreground", !compact && "font-medium")}>
          {name}
        </span>
        {detail ? (
          <p className="line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        {state === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : state === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking…</span>
        ) : (
          action
        )}
      </div>
    </div>
  );
}

/** The desktop app links `codenine` on a fresh install; this puts its folder on PATH when it is not. */
function CliPathSetup() {
  const { state, busy, run } = useDesktopCliCommand();
  const setup = state?.pathSetup;
  if (!setup) return null;
  return (
    <div className="flex min-h-10 items-center gap-3">
      <RowIcon>
        <TerminalIcon className="size-4" />
      </RowIcon>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {setup.added ? (
          <>
            Added to {setup.file}. Open a new terminal to use{" "}
            <code className="font-mono">codenine</code>.
          </>
        ) : (
          <>
            Use <code className="font-mono">codenine</code> from any terminal. Adds one line to{" "}
            {setup.file}.
          </>
        )}
      </p>
      {setup.added ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
          Add to PATH
        </Button>
      )}
    </div>
  );
}
