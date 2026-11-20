import {
  type DesktopWslState,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@codenine/contracts";

import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { readLocalApi } from "../localApi";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../wslPaths";

export type PickedProjectFolder =
  | {
      readonly kind: "picked";
      /** A WSL folder picked from Windows belongs to that distro's machine. */
      readonly environmentId: EnvironmentId;
      readonly path: string;
      readonly platform: string;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

async function readWslState(): Promise<DesktopWslState | null> {
  return (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
}

function readPrimaryRunningDistro(): string | null {
  try {
    return (
      window.desktopBridge
        ?.getLocalEnvironmentBootstraps()
        .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ?? null
    );
  } catch {
    return null;
  }
}

/** The desktop app's own folder picker, for machines that run on this computer. */
export function useProjectFolderPicker() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopLocalBootstraps = useDesktopLocalBootstraps();

  // pickFolder routes desktop-local environments by pool id, not catalog environmentId.
  const desktopInstanceIdFor = (environmentId: EnvironmentId): string | null => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (
      environment === undefined ||
      !isDesktopLocalConnectionTarget(environment.entry.target) ||
      environment.displayUrl === null
    ) {
      return null;
    }
    return (
      desktopLocalBootstraps.find((bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl)
        ?.id ?? null
    );
  };

  const canPickFolder = (environmentId: EnvironmentId | null): boolean =>
    environmentId !== null &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    (environmentId === primaryEnvironmentId || desktopInstanceIdFor(environmentId) !== null);

  const pickFolder = async (input: {
    readonly environmentId: EnvironmentId;
    readonly platform: string;
    readonly initialPath?: string | undefined;
  }): Promise<PickedProjectFolder> => {
    const api = readLocalApi();
    if (!api || !canPickFolder(input.environmentId)) return { kind: "cancelled" };
    const wslState =
      input.environmentId === primaryEnvironmentId && input.platform === "Linux"
        ? await readWslState()
        : null;
    // WSL-only primaries need their pool id from desktop settings; the picker converts WSL UNC paths.
    const targetEnvironmentId = resolveProjectPickerTarget({
      browseEnvironmentId: input.environmentId,
      primaryEnvironmentId,
      desktopInstanceId: desktopInstanceIdFor(input.environmentId),
      wslConfiguration: wslState,
    });
    const options = {
      ...(input.initialPath ? { initialPath: input.initialPath } : {}),
      ...(targetEnvironmentId ? { targetEnvironmentId } : {}),
    };
    const picked = await api.dialogs
      .pickFolder(Object.keys(options).length > 0 ? options : undefined)
      .catch(() => null);
    if (!picked) return { kind: "cancelled" };
    if (!parseWslUncPath(picked)) {
      return {
        kind: "picked",
        environmentId: input.environmentId,
        path: picked,
        platform: input.platform,
      };
    }
    const pickedWslState = wslState ?? (await readWslState());
    const selection = resolveWslProjectSelection(
      picked,
      applyWslEnvironmentConfiguration(
        environments.flatMap((environment) => {
          const backendId = desktopLocalBackendId(environment.entry.target);
          if (!backendId) return [];
          const bootstrap = desktopLocalBootstraps.find(
            (candidate) => candidate.httpBaseUrl === environment.displayUrl,
          );
          return [
            {
              environmentId: environment.environmentId,
              backendId,
              runningDistro: bootstrap?.runningDistro ?? null,
            },
          ];
        }),
        primaryEnvironmentId,
        pickedWslState,
        readPrimaryRunningDistro(),
      ),
    );
    return selection
      ? {
          kind: "picked",
          environmentId: selection.environmentId,
          path: selection.linuxPath,
          platform: "Linux",
        }
      : {
          kind: "failed",
          message: "Start the matching WSL backend, then choose the folder again.",
        };
  };

  return { canPickFolder, pickFolder };
}
