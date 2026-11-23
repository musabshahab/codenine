import type { EnvironmentId } from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import type { FolderBrowserMachine } from "./FolderBrowserDialog";

/** What the folder browser needs to list a machine's folders, or null until its config is known. */
export function useFolderBrowserMachine(environmentId: EnvironmentId): FolderBrowserMachine | null {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const label = useEnvironments().environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  if (config === null) return null;
  return {
    environmentId,
    label: label ?? config.environment.label,
    platform: getEnvironmentBrowsePlatform(config.environment.platform.os),
    homeDirectory: config.homeDirectory ?? null,
    newProjectsRoot: config.newProjectsRoot ?? null,
    addProjectBaseDirectory: config.settings.addProjectBaseDirectory,
    folderCreation: config.environment.capabilities.folderCreation === true,
  };
}
