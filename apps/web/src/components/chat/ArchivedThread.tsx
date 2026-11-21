import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@codenine/contracts";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** The header's next step on an archived thread: bring it back. */
export function UnarchiveThreadStep(props: { threadRef: ScopedThreadRef; canOperate: boolean }) {
  const { unarchiveThread } = useThreadActions();
  const [pending, setPending] = useState(false);
  const unarchive = () => {
    setPending(true);
    void unarchiveThread(props.threadRef).then((result) => {
      setPending(false);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not unarchive the chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };
  return (
    <Button size="xs" variant="outline" disabled={!props.canOperate || pending} onClick={unarchive}>
      <ArchiveRestoreIcon aria-hidden />
      Unarchive
    </Button>
  );
}

/** Stands in for the composer: an archived thread starts no runs, so it takes no messages. */
export function ArchivedThreadNotice() {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-2xl py-2 ps-5 pe-2 text-sm text-muted-foreground">
      <ArchiveIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0">This chat is archived. Unarchive it to send a message.</span>
    </div>
  );
}
