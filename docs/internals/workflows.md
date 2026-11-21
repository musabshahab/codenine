# Workflows

A workflow is a saved team that runs on a schedule or when the user starts it. Its lead model
hands each step to one of the user's agents and checks every result against the workflow's goal
and the step's "Done when". The server side is in
[`apps/server/src/workflows/`](../../apps/server/src/workflows/).

## Three files per workflow

Each workflow is a folder `workflows/<name>/` in the Codenine folder, so backups carry it and
every workspace sees it, as with agents.

- `workflow.json` is what the editor saves: the definition and an `id` the server makes when the
  workflow is created. The folder is the name, but runs belong to the id, so a rename keeps them.
  A file that does not decode or would not save, such as steps waiting on each other in a loop,
  is left out of the list and cannot run until it is fixed.
- `notes.md` holds what leads noted for later runs. The server appends to it and the user may
  edit it. Every run's brief carries all of it, so it stays under 8,000 characters by dropping
  its oldest lines.
- `state.json` is the server's alone: the run counter, the schedule it last saw, the runs owed,
  the skipped times, the runs whose note is in and the chat its runs report to. The editor never
  writes it, so saving a definition cannot undo the scheduler's bookkeeping.

A run's lead thread is `thread:workflow:<id>:<run>`, and the web app derives the same id, so run
numbers never repeat. The counter is written before the run starts, and a counter that went
missing skips numbers whose lead thread exists.

## A run is a team plan

A run is a lead thread holding a [team plan](team-tasks.md) with `run` set. The server launches
the lead the way a team task's thread starts, with the run brief as its first message, then sends
the internal `team.start`, which makes and approves the plan at once so it never reads as
proposed. Only the steps' agents reach the user's apps, so the lead's thread is created first with
no connectors or skills, and the launch then sends the brief into it; a chat's defaults never
reach even its first turn. There is one member per pair of agent and model across the steps, which keeps a run
within `TEAM_MAX_AGENTS`, and every member works in the workspace's checkout. The lead runs in
`auto` when approvals are `review` and in the default mode otherwise; step threads take the lead's
mode as their ceiling.

## Where results go

Each workflow has one chat its runs report to. `startRun` resolves it under the workflow's lock:
the chat `state.json` names while it is not deleted (an archived chat stays linked), else the
newest live chat whose `savedWorkflow` is this workflow, else the live chat the previous run
reported to, else a new chat named after the workflow in its workspace, launched like any server
chat and linked with the same `workflow.draft.saved` a save from a chat sends. A launched chat is
the run's chat even when linking it or writing `state.json` fails; the previous-run step finds it
again, so such a failure does not leave a second chat. The lookup scans thread payloads, which the
no-scan rule below forbids on the scheduler's tick; it is allowed here because it runs once per run
start, and an `instr` prefilter keeps `json_extract` to the few threads that mention the id. Each
run carries the chat as `TeamPlanRun.chatThreadId`. When none can be had, the run starts without
one and reports nowhere.

A run's result is a runless `workflow_run` turn item in that chat, one per run, posted with the
internal `workflow.run.report` only when the run has ended. Runless items normally sort before
every run, so the position store gives this one the band of the chat's newest run: it lands at
the bottom and keeps that place. That band takes the newest run's later items too, so a report
waits while the chat has a turn running or queued, or the card would split that turn. The result
is the terminal steps' results, else the lead's last reply, cut to `WORKFLOW_RUN_RESULT_MAX_CHARS`.
Once a card holds a lead reply for a status, later reports reuse it: the user may talk to the lead
afterwards, and its newer replies are not the run's outcome.

Only a new ending is news. A report that changes the card's status sets `workflowResultAt`, seeds
a null `lastVisitedAt` so the result reads as unread everywhere, unsettles a chat marked Done
(a snooze stays, as for other automatic wakes) and adds the item to `pendingWorkflowResults`. A
changed headline or result only updates the card, and an identical report emits nothing. Report
command ids hash what is reported, because the server's memory of ended runs does not survive a
restart. A deleted chat counts as reported. Any other failure leaves the run for the next check;
a refusal recorded under the same id while the chat is live was a failure on the way, since the
decider refuses only a deleted chat, so the report goes out once more under a fresh id. The chat
record holds pointers only: every thread event carries the whole thread, so the
text stays on the card.

The next prompt that reaches the chat's provider carries the pending results inline, and they are
cleared only once the provider accepts it. The clear compares each card's status and `updatedAt`
with what the prompt carried, because a run reported again keeps its item id; a result reported
meanwhile stays pending. A message starting with `/` leaves them waiting, since a provider reads a
command only at the start of the prompt. Results given
before a provider switch are not in the new provider's history, though `codenine_thread_read` on
the chat still shows the cards. Once its result is in the chat, the run's lead is marked read, so
finished runs nested under the chat do not light unread dots. Deleting a workflow reports the runs
it stops before their folder, and with it their supervision, goes away. That cannot wait, so it
posts even into a chat mid-turn, and a lead still mid-turn gets no reply as its result and is not
marked read: it may stay unread until the user opens it.

## Schedule and missed runs

Times are wall-clock times in the schedule's own time zone. A time a clock change skips runs at
the first minute after the gap, and a time it repeats runs once. A time the scheduler finds within
two minutes of passing is on time; an older one passed while Codenine was off and follows the
workflow's `missedRuns`. A new schedule, or one just turned on, starts at its next time and drops
what the old one queued, so saving never starts a run.

Runs started by the user begin at once. Scheduled ones go one at a time: a due run waits in
`state.json` until no run of the workflow is running or held. At most 20 wait; older ones, and
ones that cannot start because of a problem, are listed as skipped. A run leaves the queue before
it starts, so a crash loses that run rather than starting it twice.

## Limits, holds and notes

A second scheduler source watches each workflow's newest ten runs by their lead thread ids. It
does not look for running plans in the projection, because that query reads every thread's
payload. For a running run it estimates the cost of the lead and every attempt of every step from
their provider turns, priced as the Usage page prices them. Only a run with a spending limit may
download the public price lists; any other run uses prices already saved, or none.

Because runs are found only through their workflow's folder, deleting a workflow cancels its runs
in progress first, and a workflow whose `workflow.json` cannot be read is still watched under the
id the file names (or last named while this server ran).

The run waits for the user (`team.hold`) when it reaches its spending or time limit, when it has
a spending limit and a turn that cannot be priced (`unpriced`: the limit fails closed, and going
on drops it), or when a step's result has waited over a minute while its lead has no turn coming.
A hold's command id names the plan, the reason and the limit, so each limit holds once, and
raising it can hold again.

The lead saves its note in its final turn, after the plan has ended, so an ended run is settled
only once its lead has no turn left: the server prices it one last time, reports its result to the
workflow's chat, appends its note to `notes.md`, and then records the run in `state.json`. The
report comes first because a noted run is never looked at again; a failed or waiting report leaves
both for the next check. An ended run is read again only when its lead thread has changed, at most
once a minute.
