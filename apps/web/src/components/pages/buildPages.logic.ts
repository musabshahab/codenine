import { resolveProviderInstanceDisplayName } from "@codenine/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ServerProvider } from "@codenine/contracts";

export interface ProviderOnMachine {
  readonly key: string;
  readonly provider: ServerProvider;
  readonly name: string;
  /** The machine's name, only when the providers come from more than one machine. */
  readonly machineLabel: string | null;
}

/** Every provider of every connected machine, in machine order, named the way Settings names it. */
export function listProvidersOnMachines(input: {
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
}): ProviderOnMachine[] {
  const withProviders = input.machines.filter(
    (machine) => (input.providersByEnvironment.get(machine.environmentId)?.length ?? 0) > 0,
  );
  return withProviders.flatMap((machine) =>
    (input.providersByEnvironment.get(machine.environmentId) ?? []).map((provider) => ({
      key: `${machine.environmentId}:${provider.instanceId}`,
      provider,
      name: resolveProviderInstanceDisplayName(provider),
      machineLabel: withProviders.length > 1 ? machine.label : null,
    })),
  );
}

export interface SkillRow {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
}

/** A provider's skills by name; providers with none are left out. */
export function skillsByProvider(
  providers: ReadonlyArray<ProviderOnMachine>,
): Array<ProviderOnMachine & { readonly skills: SkillRow[] }> {
  return providers.flatMap((entry) => {
    const skills = entry.provider.skills
      .map((skill) => ({
        key: `${entry.key}:${skill.path}`,
        name: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? null,
        enabled: skill.enabled,
      }))
      .toSorted((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
    return skills.length === 0 ? [] : [{ ...entry, skills }];
  });
}

export type ConnectionState = "connected" | "signed-out" | "attention" | "off" | "missing";

/** Where a provider's connection stands, and the account it uses when there is one. */
export function providerConnection(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status" | "auth">,
): { readonly state: ConnectionState; readonly account: string | null } {
  if (!provider.enabled) return { state: "off", account: null };
  if (!provider.installed) return { state: "missing", account: null };
  if (provider.auth.status === "unauthenticated") return { state: "signed-out", account: null };
  if (provider.status === "error") return { state: "attention", account: null };
  return { state: "connected", account: provider.auth.email ?? provider.auth.label ?? null };
}
