import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@codenine/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type {
  ConnectionId,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  SkillName,
} from "@codenine/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { setDraftChatChoices, useDraftChatChoicesStore } from "../../draftChatChoicesStore";
import { commandErrorMessage } from "../../lib/commandError";
import { connectorsEnvironment } from "../../state/connectors";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import {
  activeConnections,
  type ChatChoices,
  toggledConnections,
  withoutSkill,
  withSkill,
} from "./chatChoices.logic";

/** The chat whose connectors and kept-on skills the composer shows and changes. */
export interface ChatChoicesTarget {
  readonly environmentId: EnvironmentId;
  /** The chat's thread; for a new chat, the thread its first message creates. */
  readonly threadRef: ScopedThreadRef;
  /** False for a new chat: its choices wait with the draft until its thread exists. */
  readonly onServer: boolean;
  readonly projectId: ProjectId | null;
  readonly canChange: boolean;
}

const NO_THREAD = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("chat-choices:no-thread"),
);
const selectAppThread = (thread: EnvironmentThread | null) => thread?.projection.thread ?? null;

export function useChatChoices(target: ChatChoicesTarget) {
  const { environmentId, threadRef, onServer } = target;
  const appThread = useAtomValue(
    onServer ? environmentThreadDetails.threadAtom(threadRef) : NO_THREAD,
    selectAppThread,
  );
  // A new chat's choices; they also cover the moment its thread is created but not loaded yet.
  const draftChoices = useDraftChatChoicesStore((state) => state.byThread[threadRef.threadId]);
  const state = useEnvironmentQuery(connectorsEnvironment.state({ environmentId, input: {} }));
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Shown until the thread's next update arrives, so a toggle does not flick back meanwhile.
  const [pending, setPending] = useState<{
    readonly base: typeof appThread;
    readonly choices: ChatChoices;
  } | null>(null);

  const choices: ChatChoices =
    appThread === null
      ? (draftChoices ?? {})
      : pending !== null && pending.base === appThread
        ? pending.choices
        : { connectors: appThread.connectors, skills: appThread.skills };
  const connections = state.data?.connections ?? [];
  const canChange = target.canChange && (!onServer || appThread !== null);

  const apply = async (change: ChatChoices) => {
    if (!canChange) return;
    if (!onServer) {
      setDraftChatChoices(threadRef.threadId, (current) => ({ ...current, ...change }));
      return;
    }
    setPending({ base: appThread, choices: { ...choices, ...change } });
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        ...(change.connectors === undefined ? {} : { connectors: change.connectors }),
        ...(change.skills === undefined ? {} : { skills: change.skills }),
      },
    });
    if (result._tag === "Failure") {
      setPending(null);
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not change this chat",
          description: commandErrorMessage(result, "Try again."),
        });
      }
    }
  };

  return {
    connections,
    connectionsError: state.error,
    active: activeConnections(choices, connections),
    skills: choices.skills ?? [],
    canChange,
    toggleConnection: (connectionId: ConnectionId, on: boolean) =>
      apply({ connectors: toggledConnections(choices, connections, connectionId, on) }),
    addSkill: (name: SkillName) => apply({ skills: withSkill(choices.skills, name) }),
    removeSkill: (name: SkillName) => apply({ skills: withoutSkill(choices.skills, name) }),
  };
}
