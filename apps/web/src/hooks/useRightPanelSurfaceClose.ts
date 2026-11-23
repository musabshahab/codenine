import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type ScopedThreadRef,
} from "@codenine/contracts";
import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { getTerminalLabel } from "@codenine/shared/terminalLabels";
import { useThreadTerminalActions } from "../components/terminal/useThreadTerminalActions";
import { discardFileDraft } from "../components/files/fileSaveSessions";
import { hasProjectFileConflict } from "../components/files/projectFilesQueryState";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { readLocalApi } from "../localApi";
import { focusPanelTerminalAfterClose } from "../lib/terminalFocus";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useStableCallback } from "./useStableCallback";

async function confirmDiscardFileEdits(paths: ReadonlyArray<string>): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  const names = paths.map((path) => `"${path.split(/[\\/]/).at(-1) ?? path}"`).join(", ");
  try {
    return await localApi.dialogs.confirm(
      [
        paths.length === 1 ? `Close ${names} without saving?` : "Close without saving?",
        paths.length === 1
          ? "Your edits were not saved because the file changed on disk. Closing discards them."
          : `Your edits to ${names} were not saved because the files changed on disk. Closing discards them.`,
      ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  }
}

/**
 * Closing releases terminal sessions and deletes a side chat that never ran. Terminal tabs
 * require confirmation, and so does a file whose edits a save conflict left unsaved.
 */
export function useRightPanelSurfaceClose(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  /** The folder file tabs are relative to. */
  readonly fileWorkspaceRoot: string | undefined;
}) {
  const { threadRef, terminalLabelsById, fileWorkspaceRoot } = input;
  const deleteThread = useAtomCommand(threadEnvironment.delete, "side chat delete");
  const terminalActions = useThreadTerminalActions(threadRef);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );

  const releaseSurfaceResources = (ref: ScopedThreadRef, surface: RightPanelSurface) => {
    if (
      surface.kind === "terminal" &&
      readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)
    ) {
      for (const terminalId of surface.terminalIds) {
        storeCloseTerminal(ref, terminalId);
        terminalActions.closeTerminalSession(terminalId, ref);
      }
    }
    if (
      surface.kind === "side-chat" &&
      readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope) &&
      // A live shell without the side chat means it is already deleted.
      !(
        appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live" &&
        readThreadShell(scopeThreadRef(ref.environmentId, surface.threadId)) === null
      )
    ) {
      // The server keeps a side chat with a run or message. Reopen skips one it deleted.
      void deleteThread({
        environmentId: ref.environmentId,
        input: { threadId: surface.threadId, onlyIfUnused: true },
      });
    }
  };
  // The active surface closes last so the panel does not flash through it.
  const finishClose = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    const store = useRightPanelStore.getState();
    const activeId = selectThreadRightPanelState(store.byThreadKey, threadRef).activeSurfaceId;
    const ordered = toClose.toSorted(
      (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
    );
    for (const surface of ordered) {
      store.closeSurface(threadRef, surface.id);
      releaseSurfaceResources(threadRef, surface);
    }
    focusPanelTerminalAfterClose(threadRef, activeId);
  };
  const labelFor = (terminalId: string) =>
    terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
  const closeSurfaces = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    const unsavedPaths = toClose.flatMap((surface) =>
      surface.kind === "file" &&
      surface.attachment === undefined &&
      fileWorkspaceRoot !== undefined &&
      hasProjectFileConflict(threadRef.environmentId, fileWorkspaceRoot, surface.relativePath)
        ? [surface.relativePath]
        : [],
    );
    if (unsavedPaths.length === 0 || fileWorkspaceRoot === undefined) {
      finishClose(toClose);
      return;
    }
    void confirmDiscardFileEdits(unsavedPaths).then((confirmed) => {
      if (!confirmed) return;
      for (const relativePath of unsavedPaths) {
        discardFileDraft({
          environmentId: threadRef.environmentId,
          cwd: fileWorkspaceRoot,
          relativePath,
        });
      }
      finishClose(toClose);
    });
  };

  const closeSurface = useStableCallback((surface: RightPanelSurface) => {
    if (!threadRef) return;
    if (
      surface.kind !== "terminal" ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    ) {
      closeSurfaces([surface]);
      return;
    }
    const otherLabels = surface.terminalIds
      .filter((terminalId) => terminalId !== surface.activeTerminalId)
      .map(labelFor);
    void confirmTerminalClose([labelFor(surface.activeTerminalId), ...otherLabels]).then(
      (confirmed) => {
        if (confirmed) finishClose([surface]);
      },
    );
  });
  const closeOtherSurfaces = useStableCallback((surface: RightPanelSurface) =>
    closeSurfaces(surfaces.filter((entry) => entry.id !== surface.id)),
  );
  const closeSurfacesToRight = useStableCallback((surface: RightPanelSurface) => {
    const surfaceIndex = surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;
    closeSurfaces(surfaces.slice(surfaceIndex + 1));
  });
  const closeAllSurfaces = useStableCallback(() => closeSurfaces(surfaces));

  return { closeSurface, closeOtherSurfaces, closeSurfacesToRight, closeAllSurfaces };
}
