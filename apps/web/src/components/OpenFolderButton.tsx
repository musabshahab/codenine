import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@codenine/contracts";
import type { ReactNode } from "react";

import { commandErrorMessage } from "../lib/commandError";
import { useRemoteOpenResolution } from "../remoteOpen";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { shellEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The file manager opens on the environment's machine, so a client elsewhere has nothing to see.
function useHostFolderAccess(environmentId: EnvironmentId): "hidden" | "denied" | "allowed" {
  const hasFileManager = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.availableEditors.includes("file-manager") === true,
  );
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  if (!hasFileManager || !remoteOpen.isResolved || remoteOpen.state.mode !== "local-exec") {
    return "hidden";
  }
  return canOperate ? "allowed" : "denied";
}

/** Opens a folder on the environment's machine in its file manager. */
export function OpenFolderButton({
  environmentId,
  path,
  failureTitle,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly failureTitle: string;
  readonly children: ReactNode;
}) {
  const access = useHostFolderAccess(environmentId);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  if (access === "hidden") return null;

  const openFolder = async () => {
    const result = await openInEditor({
      environmentId,
      input: { cwd: path, editor: "file-manager" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: commandErrorMessage(result, "Try again."),
      });
    }
  };
  const button = (
    <Button
      variant="outline"
      size="sm"
      disabled={access === "denied"}
      onClick={() => void openFolder()}
    >
      {children}
    </Button>
  );
  return access === "allowed" ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipPopup side="top">This connection lacks permission to open folders.</TooltipPopup>
    </Tooltip>
  );
}
