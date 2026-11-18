import { scopedThreadKey } from "@codenine/client-runtime/environment";
import type { RunId, ScopedThreadRef, TeamPlanId } from "@codenine/contracts";
import { useEffect, useRef } from "react";

import { observeProactivePanelUserChoice } from "../components/ChatView.logic";
import { useRightPanelStore } from "../rightPanelStore";

/**
 * Opens a lead's proposals on their own: the Task tab when a plan waits for approval or on a team's
 * thread whose panel this device never set, and the Workflow tab for each workflow draft. Each is
 * offered once, so a tab the user closed stays closed; a choice the user made since the current
 * turn started wins over the turn's proposal.
 */
export function useProactiveLeadPanels(input: {
  // Null where the panel is a sheet or absent, so nothing pops up over the conversation.
  readonly threadRef: ScopedThreadRef | null;
  readonly planId: TeamPlanId | null;
  readonly awaitingApproval: boolean;
  /** When the chat's workflow draft was proposed; null without one. */
  readonly workflowDraftAt: string | null;
  readonly runningTurnId: RunId | null;
}) {
  const { threadRef, planId, awaitingApproval, workflowDraftAt, runningTurnId } = input;
  const observationRef = useRef<ReturnType<typeof observeProactivePanelUserChoice> | null>(null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- opens the task or workflow surface in the right panel store when a lead proposes one
  useEffect(() => {
    if (threadKey === null || threadRef === null) {
      observationRef.current = null;
      return;
    }
    const panels = useRightPanelStore.getState();
    const observation = observeProactivePanelUserChoice(observationRef.current, {
      threadKey,
      runningTurnId,
      userActionRevision: panels.getUserActionRevision(threadRef),
    });
    observationRef.current = observation;
    if (planId !== null) {
      panels.openProactiveTask(
        threadRef,
        { planId, awaitingApproval },
        observation.userActionRevision,
      );
    }
    if (workflowDraftAt !== null) {
      panels.openProactiveWorkflowDraft(
        threadRef,
        { proposedAt: workflowDraftAt },
        observation.userActionRevision,
      );
    }
  }, [awaitingApproval, planId, workflowDraftAt, runningTurnId, threadKey, threadRef]);
}
