import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@codenine/contracts";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@codenine/client-runtime/provider-instance-ids";
import { isOpenRouterProvider } from "@codenine/shared/openRouter";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { codenineFolderPath } from "../../lib/codenineFolder";
import { readCodexSetupMode } from "./CodexSetupSection.logic";

/** Accounts that sign in with the provider's own login command. */
export type SignInAccountDriver = "claudeAgent" | "codex";

export interface PlannedAccount {
  readonly operation: "create" | "upsert";
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

type Instances = ServerSettings["providerInstances"];

const homePathOf = (driver: SignInAccountDriver, config: unknown): string =>
  (driver === "claudeAgent"
    ? Option.map(decodeClaudeSettings(config ?? {}), (settings) => settings.homePath)
    : Option.map(decodeCodexSettings(config ?? {}), (settings) => settings.homePath)
  ).pipe(Option.getOrElse(() => ""));

const shadowHomePathOf = (config: unknown): string =>
  decodeCodexSettings(config ?? {}).pipe(
    Option.map((settings) => settings.shadowHomePath),
    Option.getOrElse(() => ""),
  );

/** Every configured instance of one driver, including the built-in default slot. */
function instancesOf(
  driver: SignInAccountDriver,
  instances: Instances,
): ReadonlyArray<readonly [string, ProviderInstanceConfig]> {
  const entries = Object.entries(instances).filter(([, instance]) => instance.driver === driver);
  const defaultSlot: ProviderInstanceConfig = { driver: ProviderDriverKind.make(driver) };
  return entries.some(([id]) => id === driver) ? entries : [[driver, defaultSlot], ...entries];
}

/** Where Codenine keeps account folders on a machine. */
export function codenineAccountsFolder(config: Parameters<typeof codenineFolderPath>[0]): string {
  return `${codenineFolderPath(config)}/accounts`;
}

const objectConfig = (config: unknown): Record<string, unknown> =>
  typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};

/** A login command path no other instance uses, so a new account never signs into an old one. */
function freeFolder(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

/**
 * Where a new sign-in account goes. The computer's own login (~/.claude, ~/.codex) is reused while
 * no account uses it and its folder already exists; every other account gets a folder inside
 * Codenine's folder. Codex CLI accounts keep their own auth in a shadow home and share Codex
 * history, so a thread can move between them.
 */
export function planSignInAccount(input: {
  readonly driver: SignInAccountDriver;
  readonly name: string;
  readonly providerInstances: Instances;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** From codenineAccountsFolder. */
  readonly accountsFolder: string;
  /** Agents whose own login folder exists on the machine; unknown reuses it as before. */
  readonly agentHomesFound: ReadonlyArray<string> | undefined;
}): PlannedAccount {
  const { driver, accountsFolder } = input;
  const name = input.name.trim();
  const ownLoginExists = input.agentHomesFound?.includes(driver) ?? true;
  const defaultId = ProviderInstanceId.make(driver);
  const existingDefault = input.providerInstances[defaultId];
  const defaultProvider = input.providers.find((provider) => provider.instanceId === defaultId);
  const siblings = instancesOf(driver, input.providerInstances);
  const codenineCodexHome = `${accountsFolder}/codex/shared`;
  // An account folder inside Codenine's folder, free of every other account's.
  const placement = (slug: string, placedId?: string): Record<string, unknown> => {
    if (driver === "claudeAgent") {
      return {
        homePath: freeFolder(
          `${accountsFolder}/claude/${slug}`,
          new Set(siblings.map(([, instance]) => homePathOf(driver, instance.config))),
        ),
      };
    }
    // The first Codex CLI login owns the shared home; managed ChatGPT accounts have their own.
    const appLogins = siblings.filter(
      ([id, instance]) =>
        id !== placedId &&
        readCodexSetupMode(instance.config) === "existing" &&
        shadowHomePathOf(instance.config) === "",
    );
    const sharedHome =
      appLogins[0] !== undefined
        ? homePathOf(driver, appLogins[0][1].config)
        : !ownLoginExists ||
            siblings.some(
              ([, instance]) => homePathOf(driver, instance.config) === codenineCodexHome,
            )
          ? codenineCodexHome
          : null;
    return sharedHome === null
      ? { setupMode: "existing" }
      : {
          setupMode: "existing",
          homePath: sharedHome,
          shadowHomePath: freeFolder(
            `${accountsFolder}/codex/${slug}`,
            new Set(siblings.map(([, instance]) => shadowHomePathOf(instance.config))),
          ),
        };
  };
  const slugOf = (instanceId: string) =>
    instanceId.slice(driver.length + 1).replaceAll("_", "-") || "account";

  const defaultIsFree =
    defaultProvider?.auth.status !== "authenticated" &&
    (defaultProvider === undefined || !isOpenRouterProvider(defaultProvider)) &&
    homePathOf(driver, existingDefault?.config) === "" &&
    (driver === "claudeAgent" ||
      (readCodexSetupMode(existingDefault?.config) === "existing" &&
        shadowHomePathOf(existingDefault?.config) === ""));
  if (defaultIsFree) {
    return {
      operation: "upsert",
      instanceId: defaultId,
      instance: {
        ...existingDefault,
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        ...(name ? { displayName: name } : {}),
        ...(ownLoginExists
          ? {}
          : {
              config: {
                ...objectConfig(existingDefault?.config),
                ...placement(
                  slugOf(deriveInstanceId(driver, name) || `${driver}_account`),
                  defaultId,
                ),
              },
            }),
      },
    };
  }

  const takenIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(input.providerInstances),
    ...input.providers.map((provider) => provider.instanceId),
  ]);
  const instanceId = deriveAvailableInstanceId(
    (label) => deriveInstanceId(driver, label) || `${driver}_account`,
    name,
    takenIds,
  );
  return {
    operation: "create",
    instanceId: ProviderInstanceId.make(instanceId),
    instance: {
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      ...(name ? { displayName: name } : {}),
      config: placement(slugOf(instanceId)),
    },
  };
}
