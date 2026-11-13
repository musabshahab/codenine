import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import {
  editTeamDraft,
  resolveTeamDraft,
  savedTeamDraftEdit,
  teamApproveCommands,
  teamCancelCommand,
  teamCommandFailure,
  teamDraftIssue,
  teamRetryCommand,
  teamSaveCommand,
  type TeamDraftChange,
  type TeamDraftEdit,
} from "@codenine/client-runtime/team";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type OrchestrationV2Command,
  type ScopedThreadRef,
  type TeamAgentId,
  type TeamPlan,
  type TeamTask,
} from "@codenine/contracts";
import { create } from "zustand";

import { readLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const CONFLICT_NOTICE =
  "The team changed before your changes reached it, so they were not applied. This is the new plan; review it and approve again.";
const OVERTAKEN_NOTICE =
  "The team changed while you were editing, so your unsaved changes were dropped. This is the new plan.";

export type TeamPlanPendingAction = "save" | "approve" | "cancel" | `retry:${string}`;

interface TeamPlanUiState {
  readonly edit: TeamDraftEdit | null;
  readonly notice: string | null;
  readonly error: string | null;
  readonly pending: TeamPlanPendingAction | null;
}

const IDLE: TeamPlanUiState = { edit: null, notice: null, error: null, pending: null };

// Shared so the thread header approves exactly the draft the Task panel shows, edits included.
const useTeamPlanUiStore = create<{
  byLead: Record<string, TeamPlanUiState>;
  patch: (leadKey: string, patch: Partial<TeamPlanUiState>) => void;
}>((set) => ({
  byLead: {},
  patch: (leadKey, patch) =>
    set((state) => ({
      byLead: { ...state.byLead, [leadKey]: { ...(state.byLead[leadKey] ?? IDLE), ...patch } },
    })),
}));

/** The lead's team plan as the user edits it, and the commands that save, approve and run it. */
export function useTeamPlanActions(leadRef: ScopedThreadRef, plan: TeamPlan) {
  const { environmentId, threadId } = leadRef;
  const leadKey = `${environmentId}:${threadId}`;
  const ui = useTeamPlanUiStore((state) => state.byLead[leadKey] ?? IDLE);
  const patch = useTeamPlanUiStore((state) => state.patch);
  const hasOperateScope = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const permitted = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(environmentId),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });

  const canOperate = hasOperateScope && permitted;
  const proposed = plan.status === "proposed";
  const resolved = resolveTeamDraft(plan, ui.edit);
  const issue = proposed ? teamDraftIssue(resolved.draft) : null;
  // While this client approves or cancels, the plan leaves `proposed` before its edits are cleared.
  const notice = ui.notice ?? (resolved.overtaken && ui.pending === null ? OVERTAKEN_NOTICE : null);
  const newCommandId = () => CommandId.make(randomUUID());

  /** Sends the commands in order and stops at the first one the server rejects. */
  const run = async (
    action: TeamPlanPendingAction,
    commands: ReadonlyArray<OrchestrationV2Command>,
  ): Promise<boolean> => {
    const current = useTeamPlanUiStore.getState().byLead[leadKey] ?? IDLE;
    if (!canOperate || current.pending !== null) return false;
    patch(leadKey, { pending: action, error: null, notice: null });
    for (const command of commands) {
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Failure") {
        patch(leadKey, { pending: null });
        if (isAtomCommandInterrupted(result)) return false;
        const failure = teamCommandFailure(squashAtomCommandFailure(result));
        patch(
          leadKey,
          failure.conflict ? { edit: null, notice: CONFLICT_NOTICE } : { error: failure.message },
        );
        return false;
      }
      if (command.type === "team.edit")
        patch(leadKey, { edit: savedTeamDraftEdit(plan, resolved) });
    }
    patch(
      leadKey,
      action === "approve" || action === "cancel"
        ? { edit: null, pending: null }
        : { pending: null },
    );
    return true;
  };

  const cancel = async () => {
    const api = readLocalApi();
    if (plan.status === "running" && api !== undefined) {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          "Cancel the team?\nRunning agents stop, and tasks that have not started will not start.",
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return false;
    }
    return run("cancel", [teamCancelCommand({ threadId, commandId: newCommandId() })]);
  };

  return {
    canOperate,
    proposed,
    resolved,
    issue,
    notice,
    error: ui.error,
    pending: ui.pending,
    busy: ui.pending !== null || !canOperate,
    // Reads the store, not this render's edit, so several changes from one handler all apply.
    change: (next: TeamDraftChange) => {
      const current = useTeamPlanUiStore.getState().byLead[leadKey] ?? IDLE;
      patch(leadKey, { notice: null, error: null, edit: editTeamDraft(plan, current.edit, next) });
    },
    discard: () => patch(leadKey, { edit: null }),
    dismissNotice: () =>
      patch(leadKey, resolved.overtaken ? { notice: null, edit: null } : { notice: null }),
    save: () => run("save", [teamSaveCommand({ threadId, resolved, commandId: newCommandId() })]),
    approve: () => run("approve", teamApproveCommands({ threadId, resolved, newCommandId })),
    cancel,
    retry: (task: TeamTask, agentId?: TeamAgentId) =>
      run(`retry:${task.id}`, [
        teamRetryCommand({
          threadId,
          task,
          ...(agentId === undefined ? {} : { agentId }),
          commandId: newCommandId(),
        }),
      ]),
  };
}
