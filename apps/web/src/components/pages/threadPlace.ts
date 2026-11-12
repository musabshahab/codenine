import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

type PlacedThread = Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "folder">;

/** The project group each thread belongs to, by `environmentId:projectId`. */
export function useThreadProjectGroup() {
  const groups = useSidebarProjectGroups();
  const groupByProject = new Map<string, SidebarProjectSnapshot>(
    groups.flatMap((group) =>
      group.memberProjectRefs.map(
        (projectRef) => [`${projectRef.environmentId}:${projectRef.projectId}`, group] as const,
      ),
    ),
  );
  return (thread: Pick<PlacedThread, "environmentId" | "projectId">) =>
    groupByProject.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
}

/** Where a thread lives, as a page row names it: its project, or Chats and its folder. */
export function useThreadPlaceLabel() {
  const groupOf = useThreadProjectGroup();
  return (thread: PlacedThread) => {
    const group = groupOf(thread);
    if (group === null) return "";
    if (!group.isScratch) return group.displayName;
    return thread.folder ? `Chats · ${thread.folder}` : "Chats";
  };
}
