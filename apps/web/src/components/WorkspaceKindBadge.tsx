import type { WorkspaceKind } from "@codenine/contracts";

import { workspaceKindOption } from "../workspaceKind";
import { Badge } from "./ui/badge";

/** Names a Work or Create workspace; Code is the default and stays unmarked. */
export function WorkspaceKindBadge({ kind }: { kind: WorkspaceKind }) {
  return kind === "code" ? null : (
    <Badge variant="outline" size="sm">
      {workspaceKindOption(kind).label}
    </Badge>
  );
}
