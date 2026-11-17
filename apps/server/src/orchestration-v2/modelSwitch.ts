import {
  isCompactionCommandMessage,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@codenine/contracts";
import { modelSelectionsEqual } from "@codenine/shared/model";
import { runRanAfter } from "@codenine/shared/orchestrationV2ThreadError";

type UserMessageItem = Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
type Run = OrchestrationV2ThreadProjection["runs"][number];

// Clients hide pending queued messages, fold async answers into their question, and replace
// `/compact` with a compaction row.
function shownUserMessages(
  turnItems: OrchestrationV2ThreadProjection["turnItems"],
): ReadonlyMap<MessageId, UserMessageItem> {
  const shown = new Map<MessageId, UserMessageItem>();
  for (const item of turnItems) {
    if (
      item.type === "user_message" &&
      !(item.inputIntent === "queued_turn" && item.status === "pending") &&
      !item.messageId.startsWith("async-answer:") &&
      !isCompactionCommandMessage({ role: "user", ...item })
    ) {
      shown.set(item.messageId, item);
    }
  }
  return shown;
}

/**
 * The model or effort change a new run brings, measured from the latest run the timeline shows
 * through its message or its handoff row, so consecutive dividers always chain. `baseline` stands
 * in when there is none, such as a fork's source run. Callers skip starts with a context handoff;
 * the handoff item already shows those.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
  baseline?: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  const shown = shownUserMessages(projection.turnItems);
  let previous: Run | undefined;
  for (const run of projection.runs) {
    if (run.status === "rolled_back" || run.status === "queued") continue;
    // A wake shows as a notification, but its context handoff row still shows the swap.
    if (!shown.has(run.userMessageId) && run.contextHandoffId === null) continue;
    if (previous === undefined || runRanAfter(run, previous)) previous = run;
  }
  const from = previous?.modelSelection ?? baseline;
  return from === undefined || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}

/**
 * The chat's agent for a new message, and the hand-off from the agent of the latest message the
 * timeline shows. A first message records none: the chat's header names its agent.
 */
export function agentSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems">,
): Pick<UserMessageItem, "agent" | "agentSwitch"> {
  const shown = shownUserMessages(projection.turnItems);
  let previous: { readonly run: Run; readonly message: UserMessageItem } | undefined;
  for (const run of projection.runs) {
    if (run.status === "rolled_back" || run.status === "queued") continue;
    const message = shown.get(run.userMessageId);
    if (message === undefined) continue;
    if (previous === undefined || runRanAfter(run, previous.run)) previous = { run, message };
  }
  const to = projection.thread.agent ?? null;
  const from = previous === undefined ? undefined : (previous.message.agent ?? null);
  return {
    ...(to === null ? {} : { agent: to }),
    ...(from === undefined || from === to ? {} : { agentSwitch: { from, to } }),
  };
}
