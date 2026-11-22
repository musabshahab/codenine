import {
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpProposeTeamInput,
  OrchestratorMcpProposeTeamResult,
  OrchestratorMcpProposeWorkflowInput,
  OrchestratorMcpProposeWorkflowResult,
  OrchestratorMcpReviewStepInput,
  OrchestratorMcpReviewStepResult,
  OrchestratorMcpSaveRunNoteInput,
  OrchestratorMcpSaveRunNoteResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
  TrimmedNonEmptyString,
} from "@codenine/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];

const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List providers, models, options, and runtime modes for `delegate_task` and `propose_team`, plus the user's agents. Short list. `search` finds others. Any catalog model works. `price` is USD per million tokens, when known.",
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Start one child agent with only `task`. No parent history. Separate checkout or PR per child: `isolation:'worktree'`. Keep `taskId` for `task_status` and `task_cancel`. No secrets in `task`.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read one delegated task you started. Do not call it on a running task before its completion wakes you. `workState`: working, waiting_for_children, result_available. A finished turn with live child work is not done. `summary`: final result. Reading it marks it delivered.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Stop one delegated task by `taskId`. Stops its running and queued turns, its delegates, and its PR watches, including later runs in its child thread. A finished task keeps its result.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const ProposeTeamTool = Tool.make("propose_team", {
  description:
    "Propose a team for the user to edit and approve; nothing starts before they do. Use it when the user asks for a team, or for different models on parts of a task. Follow any split, agents or models the user named. Use one of the user's agents (`agent`, from `orchestrator_capabilities` `agents`) where one fits a part; otherwise define the member here with `role`, `target` and, when it has several tasks, `instructions`. It exists only for this team. Split the work into as many tasks as it has independent parts, each small enough for a small model to finish and check alone: one deliverable, its own files, one check in `doneWhen`. Never let two tasks edit one file, and keep a small change as one task. Give mechanical tasks the cheapest listed model at low effort; give review and integration a stronger one. Members that edit in parallel need `workspace:'worktree'` and a last `integrate` task. Order tasks with `dependsOn`. Calling again replaces a team not yet approved.",
  parameters: OrchestratorMcpProposeTeamInput,
  success: OrchestratorMcpProposeTeamResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Propose a team of agents")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const ProposeWorkflowTool = Tool.make("propose_workflow", {
  description:
    "Draft a workflow for the user to review and save: a team of the user's agents that runs on a schedule or when they start it, toward one goal. Use when the user asks for recurring or repeatable work. Each step names one of the user's agents in `agent`, from `orchestrator_capabilities` `agents`; never invent one. Where none fits, give a `suggestion` and say so. Give each step a `doneWhen` the result must meet. Order steps with `dependsOn`. Calling it again replaces this chat's draft. Nothing runs now, and nothing is saved until the user saves it in the workflow editor; if they already saved a draft from this chat, saving updates that workflow. A workflow saved from a new draft stays off until the user turns it on from this chat's Workflow tab or the workflow editor; saving changes to a saved workflow keeps it on or off as it was. A step without an agent cannot run until they give it one. You are not told whether they saved it or turned it on; the chat's Workflow tab shows them.",
  parameters: OrchestratorMcpProposeWorkflowInput,
  success: OrchestratorMcpProposeWorkflowResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Draft a workflow")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const ReviewStepTool = Tool.make("review_step", {
  description:
    "Only as a workflow run's lead, when Codenine sends you a step's result: accept it when it meets the goal and the step's Done when, or revise with notes on exactly what to fix; the step's agent gets them in its own chat. Then end your turn.",
  parameters: OrchestratorMcpReviewStepInput,
  success: OrchestratorMcpReviewStepResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Review a workflow step")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const SaveRunNoteTool = Tool.make("save_run_note", {
  description:
    "Only as a workflow run's lead, once the run finished: save a one-line headline for the run history and a short note the next run reads.",
  parameters: OrchestratorMcpSaveRunNoteInput,
  success: OrchestratorMcpSaveRunNoteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a workflow run's note")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const WorkflowStopTool = Tool.make("codenine_workflow_stop", {
  description:
    "Stop a running Claude workflow in a thread. `subagentId`: coordinator from `codenine_thread_read` 'activity'. Stops only the workflow, not the thread.",
  parameters: Schema.Struct({
    ...OrchestrationV2StopWorkflowInput.fields,
  }),
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

const BackgroundWaitTool = Tool.make("codenine_background_wait", {
  description:
    "Keep this thread in Working while background work runs. Pass its task ID after starting it. Not for work left running (dev server, watcher). `waiting=false` clears. Does not stop the task. Claude only.",
  parameters: Schema.Struct({
    taskIds: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    waiting: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    matched: Schema.Array(Schema.String),
    unmatched: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Title, "Wait on background work");

const RequestSecretTool = Tool.make("request_secret", {
  description:
    'Ask for one secret per single-line card; never combine values. Open it, don\'t offer it. Returns one-use `secretRef`, or `delivery: "file"` a file read only in its command, e.g. `adb pair <ip:port> "$(cat <file>)"`. Asked how: call now. Sign-in link: `url`. Pasted secret for child/script: `value`. Never from an old thread.',
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false)
  // Claude Code defers MCP tools behind ToolSearch; agents that never load this one ask in chat.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create new top-level threads in this checkout. Not delegation. One thread or its own worktree: `codenine_thread_launch`. Project, branch, and worktree inherit.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create Codenine threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("codenine_thread_list", {
  description:
    "List threads newest first, in one project or with `allProjects`. Page with `cursor`.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Codenine threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("codenine_thread_read", {
  description:
    "Read any thread by id. `messages` (default): user and assistant messages and plans. `activity`: all timeline items. Keep reads small: low `limit` and `maxCharsPerItem`. Page with `afterPosition=nextPosition`. Cut-off text: `itemId` with `textOffset=nextTextOffset`. Reading a child's final result marks it delivered. In your reply, name it as its `link` verbatim.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a Codenine thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadUpdateTool = Tool.make("codenine_thread_update", {
  description:
    "Rename a thread (`action:'rename'` with `title`) or regenerate its title. Omit `threadId` for this thread. Workspace and branch cannot change here.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update Codenine thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("codenine_thread_send", {
  description:
    "Send a message to any thread. The target cannot run with broader modes than yours. `mode:'auto'` starts an idle thread, steers a running turn, or queues. `queue`: new turn. `steer`: mid-turn update. `restart`: interrupt and restart. A send to a finished child thread starts a fresh task and returns its `taskId`. In your reply, name it as its `link` verbatim.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a Codenine thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("codenine_thread_wait", {
  description:
    "Wait for a thread's run to finish. No `runId`: latest. Idle: at once. On timeout, with `next` end your turn; without, call again.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a Codenine thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("codenine_thread_interrupt", {
  description:
    "Interrupt a top-level thread's running turn. No `runId`: newest running turn. No effect when idle. For a delegate, use `task_cancel`.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a Codenine thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  ProposeTeamTool,
  ProposeWorkflowTool,
  ReviewStepTool,
  SaveRunNoteTool,
  WorkflowStopTool,
  BackgroundWaitTool,
  RequestSecretTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
