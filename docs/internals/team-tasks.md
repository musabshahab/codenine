# Team tasks

A lead thread holds a team plan in `thread.team`: agents, tasks, and each task's state. The
decisions below span the orchestrator, the effect worker, thread launch, and the MCP tools. The
transitions themselves are in
[`TeamPlan.ts`](../../apps/server/src/orchestration-v2/TeamPlan.ts) and
[`@codenine/shared/team`](../../packages/shared/src/team.ts).

## A team task is a launched thread, not a delegated task

`delegated_task.request` needs a live parent run, and its result returns into that run. A lead ends
its turn after it proposes a team, and the user may approve hours later. So
[`TeamTaskService`](../../apps/server/src/orchestration-v2/TeamTaskService.ts) starts each task as
an ordinary top-level thread through `ThreadLaunchService`, marked with `thread.teamTask`. The lead
is not its parent in `lineage`, and none of the delegated-task machinery (completion delivery,
`task_status`, `task_cancel`) applies to it.

A retry launches a new thread for the next attempt. Never send a retry into the earlier thread:
moving it to another model would switch a provider session mid-conversation, which is the cost the
team exists to avoid.

Task threads are working threads, not where the user reads the outcome; the lead's final message
is. So when a plan completes or is cancelled, the server settles (the UI says "marks done") the
thread of every attempt of every task (attempt ids are derived from the plan, task and attempt). A
failed plan keeps its threads active, because the user reads and retries them there. The lead is never settled, and a
thread the user explicitly unsettled keeps that choice.

## Members are made for the team or are the user's agents

A member the lead defines in `propose_team` has no `agent`: its task runs as a plain thread, with
the member's `instructions` placed in the brief rather than in a runtime carrier, so both providers
get them the same way and nothing that keys on `thread.agent` applies. It lives only in the plan,
like a Claude Code subagent made for one job, and nothing is written to the Agents folder. It gets
the lead's `runtimeMode` and the lead's `connectors` as its ceiling; without the connectors a member
of a lead that turned connectors off would reach every default-on connector. A member with `agent`
names one of the user's agents, and its thread is created with that agent as `thread.agent`, so it
runs with the agent's instructions, abilities, connectors and skills. A `target` on such a member is
laid over the agent's own model, not the lead's. The user can swap either kind for the other in the
Task tab. A swapped lead-defined member keeps its label and model, and any member can drop its
saved agent again; the plan records no "lead-defined" marker, so the client tells the two apart
only from the draft the edit began with, and only for the wording and the label it keeps.

Members with `suggestion` come from plans and workflows made before inline members. The decider
still refuses `team.approve` while one has no agent (`teamMembersWithoutAgent`), and `team.start`
still requires `agent` on every member, because a workflow step always names a saved agent. The
decider cannot read agent files, so an agent deleted after approval fails its task's turn instead.

Every task thread, with or without an agent, refuses Codenine's MCP tools that start, read or steer
other chats ([`McpHttpServer`](../../apps/server/src/mcp/McpHttpServer.ts)): a task that reached
other chats could start work the user never approved. This also holds for plans that were running
before the change. So a task's brief never points at another thread: results of `dependsOn` tasks
are read from their threads' own final messages at launch, each cut to fit the provider's input
limit, while the plan keeps a shorter copy whose cap shrinks as the plan grows
(`teamResultCap`), so the whole plan stays inside the payload bound below. The lead's wake spends
its budget on the results of tasks nothing depends on first, because those report on the goal.

A retry may name a model for that task alone (`TeamTask.modelSelection`), so a part that failed on
a cheap model can run again on a stronger one without changing the member. A retry onto another
member without a model drops the override and runs on that member's model.

The plan's text (goal, briefs, done-when lines and instructions) is bounded as a whole by
`validateTeamDraft`, and a proposed plan over that bound cannot be edited, even to swap an agent.
A client older than its server checks drafts against its own, smaller limits and drops
`instructions` when it saves an edit, since `team.edit` replaces the members wholesale.

## Workflow runs

A workflow run is a lead thread whose plan has `run`. `team.start` makes the plan approved and
running in one command, so a run never reads as proposed, which the Inbox shows as needing the user.

- **Review gate.** A step's completed settle stores its result and sets `review.awaiting`, but the
  task stays `running`, so the steps that need it `completed` wait. The lead answers with
  `team.task.review`: accept completes the task; revise bumps `review.round` and queues
  `team-task.continue`, which sends the notes into the step's own thread as its next turn, on the
  same model and session. The notes ride in the outbox row, not in the plan.
- **Settle per run.** A step's thread settles once per run, so `team.task.settle` carries `runId`
  and the reactor's command id is `server:team-task-settle:<thread>:<run>`. A per-thread id would
  make the settle after a send-back a silent no-op, because even an unchanged settle stores its
  receipt. The plan records `resultRunId` and ignores that run's settle afterwards.
- **Wakes.** The lead is woken once per step and round with a system notification whose outcome is
  `updated`, because a `completed` one turns its reply into a Task result. The run's completion wake
  stays `completed` and asks the lead to call `save_run_note`.
- **Holds.** `hold` (spend, time or review) stops launches and step wakes; running turns finish and
  a send-back already decided still goes out. Under a spend or time hold a review waits for
  `team.resume`, which wakes the lead again for every step awaiting review. Under a review hold the
  user decides, and the hold lifts once no step awaits review. Holds and review are optional fields,
  never new status literals: an older client decodes `teamSummary` strictly.
- **Restart.** Restart recovery cancels a run that never started, which loses a wake or a
  send-back. After activation the reactor wakes the lead again for each awaiting step whose wake it
  never read, and resends each send-back whose turn never started, at most once per round.

`propose_workflow` leaves a draft on its chat in `thread.workflowDraft`. Saving from the editor with
`fromDraft` makes `Workflows.save` dispatch `workflow.draft.saved`, which sets
`thread.savedWorkflow` to the workflow's id and the draft's `proposedAt`. A save never fails
because the link could not be written. A create from a chat already linked to an existing workflow
is refused. Clients find the workflow by id in their list, and a missing id means it was deleted.
The link also runs the other way: each run names the chat it reports to in
`TeamPlanRun.chatThreadId`, and a chat the server makes for a workflow is linked with the same
`workflow.draft.saved` (see [Workflows](workflows.md#where-results-go)). Forks copy none of these
fields, nor the chat's workflow results.

## The plan lives in the thread payload

Plan changes are `thread.metadata-updated` events, so the thread stream delivers them with no new
event type or table. Two things follow:

- Every thread event on the lead carries the whole plan, including `thread.visited`. The limits in
  [`team.ts`](../../packages/contracts/src/team.ts) bound that payload. Keep per-task output in the
  task's own thread, not in the plan.
- A plan this build cannot decode reads as `null` instead of failing the thread, so a client older
  than its server keeps the thread and loses only the plan.

Thread lists read shells, and every client receives every shell change, so a lead's shell carries
`teamSummary` (the plan's status and task counts), never the plan. Lists, the Inbox and Tasks pages,
and the Team strip read only `teamSummary`. An agent thread's header and the Task tab read the plan
from the lead's thread detail, so viewing an agent thread keeps the lead's thread stream open too;
the header's Approve and Retry read it only while the summary says the team needs one. They share
the Task tab's unsaved edits, so approving from the header starts the team the tab shows. Anything
shown for many threads at once stays on the summary.

Only the server may set `teamTask`: a thread with it reports its result into the lead's plan, so a
client's `thread.create` has the field removed, and `team.task.settle` is an internal command.
Forks and delegated children reset both fields.

## The client finds two messages by structure

The web client marks two messages by where they sit in the thread, not by their text, so the server
must keep that shape:

- The **Task result** card is the lead's final message in a run that a completed system
  notification started. The team wake for a completed plan is the only such notification (a restart
  continuation is `updated`), so a new sender of completed system notifications would turn its
  reply into a Task result too. See `isTeamFinishedNotification` in
  [`client-runtime/team.ts`](../../packages/client-runtime/src/team.ts).
- An agent's **Assignment from the lead** is the first user message of a `teamTask` thread when
  its `createdBy` is `"system"`. The composed brief must stay that thread's first user message.

## The composer's Team and Workflow toggles

A message sent with Team or Workflow on carries a `team-request` or `workflow-request` context
record that no text links.
`projectComposerContextForProvider` in
[`composerContextReferences.ts`](../../packages/shared/src/composerContextReferences.ts) appends one
instruction for it, so Codex and Claude get the same text on turn start and on steer, and no adapter
adds its own. A server older than the record cannot decode it (an unknown record needs a
`payload`), drops it, and sends the message without the instruction.

## Effects run on the lead's lane

`team-task.launch`, `team-task.stop`, `team-task.continue`, `team.lead-wake`, and
`team.task-threads.settle` are queued under the lead thread's id, whichever task they act on. The outbox runs one thread's effects in
order, which is what keeps a cancel's stop behind the launch of the same task, and its settle
behind the stops. Each effect rereads the plan and does nothing when the task or plan has moved
on, so replaying one after a restart is safe.

[`TeamTaskReactor`](../../apps/server/src/orchestration-v2/TeamTaskReactor.ts) settles a task when
its thread's work has ended, by the same rule that decides a delegated task has a result
(`delegatedTaskProgress`). Like the other reactors it listens only after server activation, while
restart recovery and the effect worker end runs before that. So once it listens, it sweeps the
plans still `running` and settles each task whose work has ended. Reactor and sweep settle a run
with the same command id, so whichever comes second is a no-op. A task waiting on a restart
continuation is settled once that continuation is decided, since a declined one writes no event.

`runtimeLayer.layer` leaves `TeamTaskService` unprovided, because it does not include thread launch.
`layerProduction` provides it, also to the reactor for restart recovery; a test built on `layer`
supplies its own.
