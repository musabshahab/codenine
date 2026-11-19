import { useAtomValue } from "@effect/atom-react";
import { BackupError, type EnvironmentId } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { isElectron } from "../../env";
import { fetchSessionState } from "../../environments/primary";
import { backupEnvironment } from "../../state/backup";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

// False while the server is down or still the one from before the restart.
const browserSignedOut = Effect.promise(() =>
  fetchSessionState().then(
    (session) => !session.authenticated,
    () => false,
  ),
);

/** The server said no. Any other failure may have left the restore running: it outlives its request. */
export function refusedByServer(result: { readonly cause: Cause.Cause<unknown> }): boolean {
  return Option.exists(Cause.findErrorOption(result.cause), Schema.is(BackupError));
}

/**
 * After a restore, or its undo, says Codenine is restarting: waits until it is back, then
 * reloads the app from the start so nothing from before the restore stays in memory. A
 * browser the restore signed out lands on the pairing screen. Resolves false when Codenine
 * did not come back in time.
 */
export function useAwaitRestartThenReload(environmentId: EnvironmentId) {
  const awaitRestart = useAtomCommand(backupEnvironment.awaitRestart, { reportFailure: false });
  const resumeRestore = useAtomCommand(backupEnvironment.resumeRestore, { reportFailure: false });
  const report = useAtomValue(backupEnvironment.restoreReport({ environmentId, input: {} }));
  const lastRestoredAt = AsyncResult.getOrElse(report, () => null)?.report?.restoredAt ?? null;
  const navigate = useNavigate();
  // Only the browser's own server knows it by a cookie; every other connection is told.
  const signedOut = () =>
    !isElectron && environmentId === readPrimaryEnvironmentId()
      ? { signedOut: browserSignedOut }
      : {};
  const reload = async () => {
    await navigate({ to: "/", replace: true });
    window.location.reload();
  };
  return {
    awaitRestart: async (): Promise<boolean> => {
      const input = signedOut();
      const result = await awaitRestart({
        environmentId,
        input: input.signedOut === undefined ? undefined : input,
      });
      if (result._tag !== "Success" || !result.value) return false;
      await reload();
      return true;
    },
    /**
     * For a restore or undo whose request failed without the server refusing it. Reloads
     * like `awaitRestart` when the restore went through; otherwise says how it ended.
     */
    resume: async () => {
      const result = await resumeRestore({
        environmentId,
        input: { ...signedOut(), lastRestoredAt },
      });
      if (result._tag !== "Success") return { outcome: "notBack" as const };
      if (result.value.outcome === "restarted") await reload();
      return result.value;
    },
  };
}
