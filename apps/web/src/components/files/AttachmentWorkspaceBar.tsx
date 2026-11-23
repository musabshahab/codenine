import { AuthFilesystemWriteScope, type EnvironmentId } from "@codenine/contracts";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSurfaceBar } from "./fileSurfaceChrome";

/**
 * Over a file attached to a chat, which opens read only: saves a copy into the workspace folder
 * and opens that, so it can be edited. Absent where the server cannot copy or the connection
 * cannot write.
 */
export function AttachmentWorkspaceBar(props: {
  readonly environmentId: EnvironmentId;
  /** Empty in a chat without a workspace. */
  readonly cwd: string;
  readonly attachment: { readonly id: string; readonly name: string };
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const { environmentId, cwd, attachment } = props;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const copyAttachment = useAtomCommand(projectEnvironment.copyAttachment, {
    reportFailure: false,
  });
  const [copying, setCopying] = useState(false);
  if (cwd === "" || !canWrite || serverConfig?.environment.capabilities.attachmentCopies !== true) {
    return null;
  }
  const copy = async () => {
    setCopying(true);
    const result = await copyAttachment({
      environmentId,
      input: { cwd, attachmentId: attachment.id, name: attachment.name },
    });
    setCopying(false);
    if (result._tag !== "Success") {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save a copy",
        description: failure instanceof Error ? failure.message : "Try again.",
      });
      return;
    }
    if (result.value.relativePath !== attachment.name) {
      toastManager.add({
        type: "success",
        title: `Saved as ${result.value.relativePath}`,
        description: "A file with the attachment's name was already in the workspace.",
      });
    }
    props.onOpenFile(result.value.relativePath);
  };
  return (
    <FileSurfaceBar
      actions={
        <Button type="button" size="micro" disabled={copying} onClick={() => void copy()}>
          Edit in workspace
        </Button>
      }
    >
      Attached to this chat, so it opens read only. Editing saves a copy in the workspace folder.
    </FileSurfaceBar>
  );
}
