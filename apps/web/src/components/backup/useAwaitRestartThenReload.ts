import type { EnvironmentId } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";

import { isElectron } from "../../env";
import { fetchSessionState } from "../../environments/primary";
import { backupEnvironment } from "../../state/backup";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * After a restore, or its undo, says Codenine is restarting: waits until it is back, then
 * reloads the app from the start so nothing from before the restore stays in memory. A
 * browser the restore signed out lands on the pairing screen. Resolves false when Codenine
 * did not come back in time.
 */
// False while the server is down or still the one from before the restart.
const browserSignedOut = Effect.promise(() =>
  fetchSessionState().then(
    (session) => !session.authenticated,
    () => false,
  ),
);

export function useAwaitRestartThenReload(environmentId: EnvironmentId) {
  const awaitRestart = useAtomCommand(backupEnvironment.awaitRestart, { reportFailure: false });
  const navigate = useNavigate();
  return async (): Promise<boolean> => {
    // Only the browser's own server knows it by a cookie; every other connection is told.
    const byCookie = !isElectron && environmentId === readPrimaryEnvironmentId();
    const result = await awaitRestart({
      environmentId,
      input: byCookie ? { signedOut: browserSignedOut } : undefined,
    });
    if (result._tag !== "Success" || !result.value) return false;
    await navigate({ to: "/", replace: true });
    window.location.reload();
    return true;
  };
}
