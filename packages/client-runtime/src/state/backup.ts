import { type EnvironmentId, WS_METHODS } from "@codenine/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  type AtomCommand,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "./runtime.ts";
import {
  nudgeReconnectDuringUpdateRestart,
  waitForEnvironmentAnswerAfterRestart,
} from "./server.ts";

// Long enough for a large restore to apply before the server opens its data again.
const RESTART_TIMEOUT = Duration.minutes(10);

const awaitRestart = Effect.fn("Backup.awaitRestart")(function* (
  input: { readonly signedOut?: Effect.Effect<boolean> } | undefined,
  _registry: unknown,
  environmentId: EnvironmentId,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* nudgeReconnectDuringUpdateRestart({
    stateChanges: registry.stateChanges(environmentId),
    retryNow: registry.retryNow(environmentId),
  }).pipe(Effect.forkChild);
  return yield* waitForEnvironmentAnswerAfterRestart(
    registry.stateChanges(environmentId),
    input?.signedOut,
  ).pipe(Effect.timeoutOption(RESTART_TIMEOUT), Effect.map(Option.isSome));
});

const perEnvironment = {
  mode: "singleFlight" as const,
  key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
};

/** A guarded read held in an atom: commands carry the permission check queries cannot. */
function commandAtom<W, A, E, B>(
  label: string,
  command: AtomCommand<W, A, E>,
  target: W,
  select: (value: A) => B,
  revision?: Atom.Atom<unknown>,
) {
  return Atom.make((get) => {
    if (revision !== undefined) get(revision);
    return Effect.promise(() =>
      runAtomCommand(get.registry, command, target, { reportFailure: false }),
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "Success"
          ? Effect.succeed(select(result.value))
          : Effect.failCause(result.cause),
      ),
    );
  }).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(label));
}

export function createBackupEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  // Emits the current status, then every change, backup progress included.
  const status = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:backup:status",
    tag: WS_METHODS.subscribeBackupStatus,
  });
  const listRefresh = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`backup-list-refresh:${environmentId}`)),
  );
  // Changes when a backup lands or one is deleted, so open lists read the folder again.
  const listRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const current = AsyncResult.getOrElse(get(status({ environmentId, input: {} })), () => null);
      return JSON.stringify([
        get(listRefresh(environmentId)),
        current?.lastSuccessAt ?? null,
        current?.lastFile?.path ?? null,
      ]);
    }).pipe(Atom.withLabel(`backup-list-revision:${environmentId}`)),
  );

  const list = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:backup:list",
    tag: WS_METHODS.backupList,
  });
  const suggestFolders = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:backup:suggest-folders",
    tag: WS_METHODS.backupSuggestFolders,
  });
  const restoreReport = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:backup:restore-report",
    tag: WS_METHODS.backupRestoreReport,
  });

  const listFamily = Atom.family((key: string) => {
    const [environmentId, includeSuggestedFolders] = JSON.parse(key) as [EnvironmentId, boolean];
    return commandAtom(
      `environment-data:backup:list-atom:${key}`,
      list,
      {
        environmentId,
        input: includeSuggestedFolders ? { includeSuggestedFolders: true } : {},
      },
      (result) => result.backups,
      listRevision(environmentId),
    );
  });
  const suggestedFoldersFamily = Atom.family((environmentId: EnvironmentId) =>
    commandAtom(
      `environment-data:backup:suggested-folders:${environmentId}`,
      suggestFolders,
      { environmentId, input: {} },
      (result) => result.folders,
    ),
  );

  return {
    status,
    // A boolean, so readers skip the status changes that progress makes.
    needsAttention: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => {
        const current = AsyncResult.getOrElse(
          get(status({ environmentId, input: {} })),
          () => null,
        );
        return current?.configured === true && current.needsAttention;
      }).pipe(Atom.withLabel(`backup-needs-attention:${environmentId}`)),
    ),
    restoreReport,
    /** Backups in the folder; with suggested folders too, as restoring on a new computer looks. */
    backups: (
      environmentId: EnvironmentId,
      options?: { readonly includeSuggestedFolders?: boolean },
    ) => listFamily(JSON.stringify([environmentId, options?.includeSuggestedFolders === true])),
    suggestedFolders: suggestedFoldersFamily,
    // Returns once the backup starts; progress arrives on `status`.
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:create",
      tag: WS_METHODS.backupCreate,
      concurrency: perEnvironment,
    }),
    // Serial, so a second password never resolves with the answer to the first.
    setPassword: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:set-password",
      tag: WS_METHODS.backupSetPassword,
      concurrency: { ...perEnvironment, mode: "serial" },
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:delete",
      tag: WS_METHODS.backupDelete,
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(listRefresh(environmentId), (count) => count + 1)),
    }),
    downloadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:download-url",
      tag: WS_METHODS.backupDownloadUrl,
    }),
    inspect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:inspect",
      tag: WS_METHODS.backupInspect,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:restore",
      tag: WS_METHODS.backupRestore,
      concurrency: perEnvironment,
    }),
    undoRestore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:undo-restore",
      tag: WS_METHODS.backupUndoRestore,
      concurrency: perEnvironment,
    }),
    dismissRestoreReport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backup:dismiss-restore-report",
      tag: WS_METHODS.backupDismissRestoreReport,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(restoreReport({ environmentId, input: {} }))),
    }),
    /**
     * After a restore or its undo said it is restarting: true once the server is back, even
     * when it no longer accepts this client, false when it has not come back in time. A
     * cookie client passes `signedOut`, which asks the server whether its session is gone.
     */
    awaitRestart: createEnvironmentCommand(runtime, {
      label: "environment-data:backup:await-restart",
      concurrency: perEnvironment,
      execute: awaitRestart,
    }),
  };
}
