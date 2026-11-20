import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import { PERSONAL_WORKSPACE_NAME } from "@codenine/client-runtime/state/projects";

import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

type PlacedThread = Pick<EnvironmentThreadShell, "environmentId" | "projectId">;

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
  return (thread: PlacedThread) =>
    groupByProject.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
}

/** Where a thread lives, as a page row names it: its workspace, as the sidebar names it. */
export function useThreadPlaceLabel() {
  const groupOf = useThreadProjectGroup();
  return (thread: PlacedThread) => {
    const group = groupOf(thread);
    if (group === null) return "";
    return group.isScratch ? PERSONAL_WORKSPACE_NAME : group.displayName;
  };
}
