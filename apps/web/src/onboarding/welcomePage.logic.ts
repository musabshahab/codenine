import {
  defaultInstanceIdForDriver,
  isProviderAvailable,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@codenine/contracts";

import { readCodexSetupMode } from "../components/settings/CodexSetupSection.logic";
import { type AgentSetupDriver, getOnboardingProviderState } from "./providerReadiness.logic";

type ComputerSettings = Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;

// Ready agents first, then ones that need a sign-in or a look. Never ranked by vendor.
const FOUND_ORDER = { ready: 0, signIn: 1, attention: 2 } as const;
type FoundState = keyof typeof FOUND_ORDER;

const isFoundState = (state: string): state is FoundState => state in FOUND_ORDER;

/**
 * An agent's state for new threads on this computer. The server also lists agents that only some
 * projects turn on, lists an agent it could not load as off, which Turn on cannot fix, and can pass
 * a CLI whose version it knows is broken.
 */
export function welcomeAgentState(
  provider: ServerProvider,
  settings: ComputerSettings | null | undefined,
) {
  if (!isProviderAvailable(provider)) return "attention";
  if (settings && !resolveProjectProviderInstanceEnabled(settings, null, provider.instanceId)) {
    return "disabled";
  }
  const state = getOnboardingProviderState(provider);
  if (state === "ready" && provider.compatibilityAdvisory?.status === "broken") return "attention";
  return state;
}

/**
 * Splits a computer's providers into agents already on it and agents the user can add.
 * Order inside each group is by state, then by the name the user sees. Agents still being
 * checked are listed with the ones to add, so a slow check never drops an agent.
 */
export function groupWelcomeAgents(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  settings: ComputerSettings | null | undefined,
  nameOf: (provider: ServerProvider) => string,
) {
  const found: Array<{ readonly provider: ServerProvider; readonly state: FoundState }> = [];
  const available: ServerProvider[] = [];
  let checking = providers == null;
  let readyCount = 0;
  for (const provider of providers ?? []) {
    const state = welcomeAgentState(provider, settings);
    if (state === "ready") readyCount += 1;
    if (state === "checking") checking = true;
    if (isFoundState(state)) found.push({ provider, state });
    else available.push(provider);
  }
  const byName = (a: ServerProvider, b: ServerProvider) => nameOf(a).localeCompare(nameOf(b));
  found.sort(
    (a, b) => FOUND_ORDER[a.state] - FOUND_ORDER[b.state] || byName(a.provider, b.provider),
  );
  available.sort(byName);
  return { checking, readyCount, found: found.map((entry) => entry.provider), available };
}

/** Older settings can also keep `enabled: false` inside `config`, which still turns the agent off. */
export function turnedOnInstance(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  const { config } = instance;
  const configOff =
    typeof config === "object" &&
    config !== null &&
    "enabled" in config &&
    config.enabled === false;
  return {
    ...instance,
    enabled: true,
    ...(configOff ? { config: { ...config, enabled: true } } : {}),
  };
}

/**
 * A card's state. After a switch from ChatGPT sign-in to the CLI, the old runtime's status stays
 * until Codex is checked again; only that runtime reports `setup.canAuthenticate`.
 */
export function agentSetupState(
  provider: ServerProvider | undefined,
  settings: ComputerSettings | null | undefined,
) {
  if (provider === undefined) return "checking";
  if (
    provider.driver === "codex" &&
    provider.setup?.canAuthenticate === true &&
    readCodexSetupMode(settings?.providerInstances[provider.instanceId]?.config) === "existing"
  ) {
    return "checking";
  }
  return welcomeAgentState(provider, settings);
}

/**
 * The instance a fixed card shows: a ready one of its driver, so a signed-in second account is
 * not hidden behind a signed-out default, else the default.
 */
export function welcomeCardInstanceId(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  driver: AgentSetupDriver,
  settings: ComputerSettings | null | undefined,
): ProviderInstanceId {
  const ready = providers?.find(
    (provider) => provider.driver === driver && welcomeAgentState(provider, settings) === "ready",
  );
  return ready?.instanceId ?? defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
}

/** Continue names the agent it leaves out when only one of the two cards is ready. */
export function welcomeContinueWithout(
  cards: ReadonlyArray<{ readonly name: string; readonly ready: boolean }>,
): string | null {
  const missing = cards.filter((card) => !card.ready);
  return missing.length === 1 && cards.length - missing.length === 1 ? missing[0]!.name : null;
}

export type WelcomeStep = "agents" | "project";

const WELCOME_STEP_LABELS = ["Agents", "Project", "First task"] as const;

/** The step indicator. The first task is the start screen that setup lands on. */
export function welcomeStepIndicator(step: WelcomeStep) {
  const current = step === "agents" ? 0 : 1;
  return WELCOME_STEP_LABELS.map((label, index) => ({
    label,
    state:
      index < current
        ? ("done" as const)
        : index === current
          ? ("current" as const)
          : ("upcoming" as const),
  }));
}

export type WelcomeProjectSource = "new" | "folder" | "clone";

/** A new project needs the folder this computer makes projects in; the others work anywhere. */
export function welcomeProjectSources(
  newProjectsRoot: string | null | undefined,
): ReadonlyArray<WelcomeProjectSource> {
  return newProjectsRoot == null ? ["folder", "clone"] : ["new", "folder", "clone"];
}

/** Projects this computer already has, most recently changed first, to continue with one. */
export function welcomeExistingProjects<
  T extends {
    readonly environmentId: string;
    readonly isScratch?: true;
    readonly archivedAt?: string | null | undefined;
    readonly updatedAt: string;
  },
>(projects: ReadonlyArray<T>, environmentId: string): ReadonlyArray<T> {
  return projects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        project.isScratch !== true &&
        project.archivedAt == null,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
}
