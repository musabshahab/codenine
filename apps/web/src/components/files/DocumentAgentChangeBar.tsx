import type { EnvironmentId, ThreadId } from "@codenine/contracts";
import { ProjectWriteFileConflictError } from "@codenine/contracts";
import { executeAtomQuery, squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSurfaceBar } from "./fileSurfaceChrome";

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);

/**
 * Keep or Discard for a document the agent changed in its last turn and that is not text, such
 * as a PDF or a deck: it cannot be compared here, so it is kept or put back whole.
 */
export function DocumentAgentChangeBar(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly canDiscard: boolean;
  readonly onKeep: () => void;
  /** The file was put back, so the view must read it again. */
  readonly onDiscarded: () => void;
}) {
  const { environmentId, cwd, relativePath, threadId, turnCount } = props;
  const revertFileChange = useAtomCommand(projectEnvironment.revertFileChange, {
    reportFailure: false,
  });
  const [discarding, setDiscarding] = useState(false);

  const discard = async () => {
    setDiscarding(true);
    // The file as it is now, so a write that lands while it is put back is refused, not lost.
    const baseline = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFileBaseline({
        environmentId,
        input: { cwd, relativePath, source: { kind: "turn", threadId, turnCount } },
      }),
      { refresh: true, reportFailure: false, reportDefect: false },
    );
    const expectedVersion = baseline._tag === "Success" ? baseline.value.currentVersion : undefined;
    const result =
      expectedVersion === undefined
        ? null
        : await revertFileChange({
            environmentId,
            input: { cwd, relativePath, threadId, turnCount, expectedVersion },
          });
    setDiscarding(false);
    if (result?._tag === "Success") {
      props.onDiscarded();
      props.onKeep();
      return;
    }
    const failure = result === null ? null : squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not discard the changes",
      description: isWriteConflict(failure)
        ? "The file changed while it was being put back. Try again."
        : failure instanceof Error
          ? failure.message
          : "The earlier contents of this file could not be read. Try again.",
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
            disabled={!props.canDiscard || discarding}
            onClick={() => void discard()}
          >
            Discard changes
          </Button>
          <Button type="button" size="micro" variant="ghost-muted" onClick={props.onKeep}>
            Keep
          </Button>
        </>
      }
    >
      The agent changed this file in its last turn. Discarding puts the whole file back as it was
      before that turn, without anything saved to it since.
    </FileSurfaceBar>
  );
}
