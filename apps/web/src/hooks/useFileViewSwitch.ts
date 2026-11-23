import { scopeThreadRef } from "@codenine/client-runtime/environment";

import { type FileView, otherFileView } from "~/documentView.logic";
import { useDocumentViewStore } from "~/documentViewStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { projectPreset } from "~/workspaceKind";

import { useHandleNewThread } from "./useHandleNewThread";
import { useMediaQuery } from "./useMediaQuery";

/**
 * The open chat's file arrangement and its switch, for places outside the chat screen such as
 * the command palette. Null where the switch would change nothing on screen: no file tab is open,
 * or the screen is narrow, where an open file is always the page.
 */
export function useFileViewSwitch(): {
  readonly view: FileView;
  readonly toggle: () => void;
} | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : undefined;
  const workspaceKey = project === undefined ? null : `${project.environmentId}:${project.id}`;
  const stored = useDocumentViewStore((state) =>
    workspaceKey === null ? undefined : state.viewByWorkspace[workspaceKey],
  );
  const fileOpen = useRightPanelStore((state) => {
    if (activeThread === null || activeThread === undefined) return false;
    const panel = selectThreadRightPanelState(
      state.byThreadKey,
      scopeThreadRef(activeThread.environmentId, activeThread.id),
    );
    return panel.isOpen && panel.surfaces.some((surface) => surface.kind === "file");
  });
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  if (project === undefined || workspaceKey === null || !fileOpen || narrow) return null;
  const view = stored ?? projectPreset(project, thread?.worktreePath).fileView;
  return {
    view,
    toggle: () => useDocumentViewStore.getState().setView(workspaceKey, otherFileView(view)),
  };
}
