import type { EnvironmentId } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";

import { backupEnvironment } from "../../state/backup";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * After a restore, or its undo, says Codenine is restarting: waits until it is back, then
 * reloads the app from the start so nothing from before the restore stays in memory. Resolves
 * false when Codenine did not come back in time.
 */
export function useAwaitRestartThenReload(environmentId: EnvironmentId) {
  const awaitRestart = useAtomCommand(backupEnvironment.awaitRestart, { reportFailure: false });
  const navigate = useNavigate();
  return async (): Promise<boolean> => {
    const result = await awaitRestart({ environmentId, input: undefined });
    if (result._tag !== "Success" || !result.value) return false;
    await navigate({ to: "/", replace: true });
    window.location.reload();
    return true;
  };
}
