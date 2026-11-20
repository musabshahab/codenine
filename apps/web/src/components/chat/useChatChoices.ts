import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread } from "@codenine/client-runtime/state/models";
import { isAtomCommandInterrupted } from "@codenine/client-runtime/state/runtime";
import type {
  AgentName,
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
  usableConnections,
  withoutSkill,
  withSkill,
} from "./chatChoices.logic";

/** The chat whose connectors, kept-on skills and agent the composer shows and changes. */
export interface ChatChoicesTarget {
  readonly environmentId: EnvironmentId;
  /** The chat's thread; for a new chat, the thread its first message creates. */
  readonly threadRef: ScopedThreadRef;
  /** False for a new chat: its choices wait with the draft until its thread exists. */
  readonly onServer: boolean;
  readonly projectId: ProjectId | null;
  readonly canChange: boolean;
}

/** A change to the chat's choices; `agent: null` goes back to no agent. */
interface ChatChoicesChange {
  readonly connectors?: ReadonlyArray<ConnectionId>;
  readonly skills?: ReadonlyArray<SkillName>;
  readonly agent?: AgentName | null;
}

const NO_THREAD = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("chat-choices:no-thread"),
);
const selectAppThread = (thread: EnvironmentThread | null) => thread?.projection.thread ?? null;

function changedChoices(change: ChatChoicesChange): ChatChoices {
  const { agent, ...rest } = change;
  return agent === undefined ? rest : { ...rest, agent: agent ?? undefined };
}

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
        : { connectors: appThread.connectors, skills: appThread.skills, agent: appThread.agent };
  const connections = state.data?.connections ?? [];
  const canChange = target.canChange && (!onServer || appThread !== null);

  const apply = async (change: ChatChoicesChange) => {
    if (!canChange) return;
    if (!onServer) {
      setDraftChatChoices(threadRef.threadId, (current) => ({
        ...current,
        ...changedChoices(change),
      }));
      return;
    }
    setPending({ base: appThread, choices: { ...choices, ...changedChoices(change) } });
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        ...(change.connectors === undefined ? {} : { connectors: change.connectors }),
        ...(change.skills === undefined ? {} : { skills: change.skills }),
        ...(change.agent === undefined ? {} : { agent: change.agent }),
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
    /** What the chat's agents can use now, as the server attaches it. */
    usable: usableConnections(activeConnections(choices, connections)),
    skills: choices.skills ?? [],
    /** The agent the chat talks to; its connectors and skills replace the chat's own. */
    agent: choices.agent ?? null,
    canChange,
    toggleConnection: (connectionId: ConnectionId, on: boolean) =>
      apply({ connectors: toggledConnections(choices, connections, connectionId, on) }),
    addSkill: (name: SkillName) => apply({ skills: withSkill(choices.skills, name) }),
    removeSkill: (name: SkillName) => apply({ skills: withoutSkill(choices.skills, name) }),
    setAgent: (agent: AgentName | null) => apply({ agent }),
  };
}
