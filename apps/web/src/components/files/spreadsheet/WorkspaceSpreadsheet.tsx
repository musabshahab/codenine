import type { EnvironmentId, ThreadId } from "@codenine/contracts";
import { ProjectWriteFileConflictError } from "@codenine/contracts";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSurfaceBar } from "../fileSurfaceChrome";
import { reloadProjectFileQueryData } from "../projectFilesQueryState";
import SpreadsheetEditor, { type SpreadsheetEditorState } from "./SpreadsheetEditor";
import type { SpreadsheetTransport } from "./spreadsheetSession";
import { workspaceSpreadsheetTransport } from "./workspaceSpreadsheetTransport";

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);

export interface SpreadsheetAgentChange {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly canDiscard: boolean;
  /** The user is done with this change, whichever way they settled it. */
  readonly onSettled: () => void;
}

/** A workspace spreadsheet in the file tab: the grid, and what can be done to the whole file. */
export default function WorkspaceSpreadsheet(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly readOnly: boolean;
  readonly refreshKey: string | null;
  /** True for a file the text editor can also show, whose copy there is read again after a save. */
  readonly sharedWithTextEditor: boolean;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly fallback: ReactNode;
  /** The latest turn's change to this file, when the file can be put back as it was. */
  readonly agentChange: SpreadsheetAgentChange | null;
}) {
  const { environmentId, cwd, relativePath, sharedWithTextEditor, onPendingChange } = props;
  // The parent remounts this for another file, so one transport lasts the mount.
  const [transport] = useState((): SpreadsheetTransport => {
    const base = workspaceSpreadsheetTransport({ environmentId, cwd, relativePath });
    if (!sharedWithTextEditor) return base;
    return {
      ...base,
      edit: async (operations, expectedVersion) => {
        const result = await base.edit(operations, expectedVersion);
        if (result.ok) reloadProjectFileQueryData(environmentId, cwd, relativePath);
        return result;
      },
    };
  });
  const reportPending = useStableCallback((pending: boolean) =>
    onPendingChange(relativePath, pending),
  );
  const { agentChange } = props;
  return (
    <SpreadsheetEditor
      transport={transport}
      name={relativePath.split(/[\\/]/).at(-1) ?? relativePath}
      readOnly={props.readOnly}
      refreshKey={props.refreshKey}
      onPendingChange={reportPending}
      fallback={props.fallback}
      {...(agentChange === null
        ? {}
        : {
            renderHeader: (state: SpreadsheetEditorState) => (
              <AgentChangeBar
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                change={agentChange}
                state={state}
              />
            ),
          })}
    />
  );
}

function AgentChangeBar(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly change: SpreadsheetAgentChange;
  readonly state: SpreadsheetEditorState;
}) {
  const { change, state } = props;
  const revertFileChange = useAtomCommand(projectEnvironment.revertFileChange, {
    reportFailure: false,
  });
  const [discarding, setDiscarding] = useState(false);

  const discard = async () => {
    if (state.version === undefined) return;
    setDiscarding(true);
    const result = await revertFileChange({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        relativePath: props.relativePath,
        threadId: change.threadId,
        turnCount: change.turnCount,
        expectedVersion: state.version,
      },
    });
    setDiscarding(false);
    state.reload();
    if (result._tag === "Success") {
      change.onSettled();
      return;
    }
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not discard the changes",
      description: isWriteConflict(failure)
        ? "The file changed on disk. It has been reloaded, so check it and try again."
        : failure instanceof Error
          ? failure.message
          : "Try again.",
    });
  };

  return (
    <FileSurfaceBar
      actions={
        <>
          <Button
            type="button"
            size="micro"
            variant="outline"
            // Unsaved edits would be lost with the agent's, so they are saved first.
            disabled={!change.canDiscard || discarding || state.version === undefined}
            onClick={() => void discard()}
          >
            Discard changes
          </Button>
          <Button type="button" size="micro" variant="ghost-muted" onClick={change.onSettled}>
            Keep
          </Button>
        </>
      }
    >
      The agent changed this file in its last turn. Discarding puts the whole file back as it was
      before.
    </FileSurfaceBar>
  );
}
