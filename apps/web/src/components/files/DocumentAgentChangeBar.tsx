import type { EnvironmentId, ThreadId } from "@codenine/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

import { discardTurnFileChange } from "./discardTurnChange";
import { FileSurfaceBar } from "./fileSurfaceChrome";

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
  const [discarding, setDiscarding] = useState(false);

  const discard = async () => {
    setDiscarding(true);
    const result = await discardTurnFileChange({
      environmentId,
      cwd,
      relativePath,
      threadId,
      turnCount,
    });
    setDiscarding(false);
    if (result.ok) {
      props.onDiscarded();
      props.onKeep();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not discard the changes",
      description: result.conflict
        ? "The file changed while it was being put back. Try again."
        : (result.message ?? "The earlier contents of this file could not be read. Try again."),
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
