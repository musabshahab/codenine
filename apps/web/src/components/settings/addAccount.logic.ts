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

/** A login command path no other instance uses, so a new account never signs into an old one. */
function freeFolder(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

/**
 * Where a new sign-in account goes: the computer's own login while no account uses it, otherwise
 * a folder Codenine names. Extra Codex CLI accounts keep their own auth in a shadow home and share
 * Codex history with the first one, so a thread can move between them.
 */
export function planSignInAccount(input: {
  readonly driver: SignInAccountDriver;
  readonly name: string;
  readonly providerInstances: Instances;
  readonly providers: ReadonlyArray<ServerProvider>;
}): PlannedAccount {
  const { driver } = input;
  const name = input.name.trim();
  const defaultId = ProviderInstanceId.make(driver);
  const existingDefault = input.providerInstances[defaultId];
  const defaultProvider = input.providers.find((provider) => provider.instanceId === defaultId);
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
  const slug = instanceId.slice(driver.length + 1).replaceAll("_", "-");
  const siblings = instancesOf(driver, input.providerInstances);
  const config =
    driver === "claudeAgent"
      ? {
          homePath: freeFolder(
            `~/.claude-${slug}`,
            new Set(siblings.map(([, instance]) => homePathOf(driver, instance.config))),
          ),
        }
      : (() => {
          // The first Codex CLI account owns the shared home; managed ChatGPT accounts have their own.
          const appLogins = siblings.filter(
            ([, instance]) =>
              readCodexSetupMode(instance.config) === "existing" &&
              shadowHomePathOf(instance.config) === "",
          );
          const sharedHome = appLogins[0];
          return sharedHome === undefined
            ? { setupMode: "existing" }
            : {
                setupMode: "existing",
                homePath: homePathOf(driver, sharedHome[1].config),
                shadowHomePath: freeFolder(
                  `~/.codex-codenine/${slug}`,
                  new Set(siblings.map(([, instance]) => shadowHomePathOf(instance.config))),
                ),
              };
        })();
  return {
    operation: "create",
    instanceId: ProviderInstanceId.make(instanceId),
    instance: {
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      ...(name ? { displayName: name } : {}),
      config,
    },
  };
}
