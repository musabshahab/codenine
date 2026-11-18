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
  the skipped times and the runs whose note is in. The editor never writes it, so saving a
  definition cannot undo the scheduler's bookkeeping.

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

The run waits for the user (`team.hold`) when it reaches its spending or time limit, or when a
step's result has waited over a minute while its lead has no turn coming. A hold's command id
names the plan, the reason and the limit, so each limit holds once, and raising it can hold again.

The lead saves its note in its final turn, after the plan has ended. Once an ended plan has a
note, the server appends it to `notes.md` and then records the run in `state.json`. An ended run is
read again only when its lead thread has changed, at most once a minute.
