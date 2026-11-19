import type { EnvironmentId } from "@codenine/contracts";
import { useState } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveAccessEnvironmentId } from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/**
 * The environments Sharing & access manages, the one `requested` resolves to, and its name.
 * The MCP wizard uses the same, so both name an environment alike. A requested environment
 * always counts, so a thread on a second WSL backend opens on that backend.
 */
export function useAccessEnvironment(requested: EnvironmentId | null) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId === primaryEnvironmentId ||
      environment.environmentId === requested ||
      (environment.entry.enabled && !isDesktopLocalConnectionTarget(environment.entry.target)),
  );
  const environmentId = resolveAccessEnvironmentId({
    primaryEnvironmentId,
    environments: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
    })),
    selected: requested,
  });
  const environment =
    candidates.find((candidate) => candidate.environmentId === environmentId) ?? null;
  return {
    candidates,
    environment,
    label: environment ? settingsScopeEnvironmentLabel(environment, candidates) : null,
  };
}

/**
 * True once `environmentId` has been connected while the page was open. An editor page stays open
 * on it from then on, so a dropped connection does not unmount a form with unsaved edits.
 */
export function useOpenedEnvironment(
  environmentId: EnvironmentId | null,
  connected: boolean,
): boolean {
  const [opened, setOpened] = useState<EnvironmentId | null>(null);
  if (connected && environmentId !== null && opened !== environmentId) setOpened(environmentId);
  return environmentId !== null && (connected || opened === environmentId);
}
