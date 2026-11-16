import { scopeProjectRef, scopeThreadRef } from "@codenine/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@codenine/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import type { ProviderInstanceId, ScopedThreadRef, ServerProvider } from "@codenine/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import type { AccountSwitchRequest } from "./accountSwitch.logic";

/**
 * Moving a started chat to an account with its own history: branch a copy of the conversation
 * there, or start empty. The original chat stays on its account either way.
 */
export function AccountSwitchDialog({
  threadRef,
  request,
  providerStatuses,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly request: AccountSwitchRequest;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const forkFromLatest = useAtomCommand(threadEnvironment.forkFromLatest, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const nameOf = (instanceId: ProviderInstanceId) => {
    const provider = providerStatuses.find((candidate) => candidate.instanceId === instanceId);
    return provider === undefined ? instanceId : resolveProviderInstanceDisplayName(provider);
  };
  const fromName = nameOf(request.from);
  const toName = nameOf(request.selection.instanceId);

  // Same as picking the account in the composer: it waits there for the next message.
  const continueOnAccount = (target: ComposerThreadTarget) => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(target, request.selection, { explicit: true, replaceOptions: true });
    store.setStickyModelSelection(request.selection);
  };

  // Each action resolves true once the dialog has done its job.
  const branch = async () => {
    const targetRef = scopeThreadRef(threadRef.environmentId, newThreadId());
    const fork = await forkFromLatest({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId: targetRef.threadId },
    });
    if (fork._tag === "Failure") {
      if (isAtomCommandInterrupted(fork)) return false;
      const error = squashAtomCommandFailure(fork);
      // A fork starts from the last finished reply; the first one may still be running.
      const replyFinished = readThreadShell(threadRef)?.latestRun?.status === "completed";
      toastManager.add({
        type: "error",
        title: "Could not branch this chat",
        description: replyFinished
          ? error instanceof Error
            ? error.message
            : "Try again."
          : "A branch starts from a finished reply. Wait for this one, or start a new chat.",
      });
      return false;
    }
    if (!(await waitForThreadShell(targetRef))) {
      toastManager.add({
        type: "error",
        title: "Could not open the branch",
        description:
          "The branch was created, but it did not reach this client. Reconnect and open it from the sidebar.",
      });
      return true;
    }
    continueOnAccount(targetRef);
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) });
    return true;
  };

  const newChat = async () => {
    const thread = readThreadShell(threadRef);
    if (thread === null) return true;
    const opened = await handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId));
    if (opened !== null) continueOnAccount(opened.draftId);
    return true;
  };

  const run = (action: () => Promise<boolean>) => {
    setPending(true);
    void action().then(
      (done) => (done ? onClose() : setPending(false)),
      (error: unknown) => {
        setPending(false);
        throw error;
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue on {toName}?</DialogTitle>
          <DialogDescription>
            Each account keeps its own chat history, so this chat stays on {fromName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-2">
            <ChoiceRow
              icon={<GitBranchIcon aria-hidden className="size-4" />}
              title="Branch this chat"
              description={`Copy this conversation into a new chat on ${toName}. The history goes with your next message, so it counts toward ${toName}'s usage.`}
              disabled={pending}
              onClick={() => run(branch)}
            />
            <ChoiceRow
              icon={<SquarePenIcon aria-hidden className="size-4" />}
              title="New chat"
              description={`Start an empty chat on ${toName} in this workspace.`}
              disabled={pending}
              onClick={() => run(newChat)}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost-muted" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChoiceRow(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{props.icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </span>
    </button>
  );
}
