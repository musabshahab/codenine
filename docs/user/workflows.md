# Workflows

A workflow is a team of your [agents](./agents.md) that runs again, on a schedule or whenever you
start it. Each step is done by one of your agents in its own chat. A lead checks every step's
result against the outcome you want and the step's **Done when** line, and sends work back with
notes until it fits. Workflows live in your Codenine folder, so backups include them.

## Make a workflow

Open **Workflows** under **Build** in the sidebar and choose **New workflow**:

- **Draw it yourself** opens an empty canvas.
- **Describe it in a chat** starts a chat with **Workflow** on; the lead drafts the workflow from
  what you write, and **Review and save** opens the draft here. See
  [Draft a workflow](./composer.md#draft-a-workflow).
- **From a finished team**: in the Task tab of a team that did the job well, choose **Save as
  workflow**.

Nothing is saved until you choose **Save**. Unsaved changes stay while you visit other pages, such
as making an agent, and **Discard changes** drops them.

## The canvas

The canvas shows when the workflow runs, the lead as a frame, and the steps inside it. Select a box
to change it in the panel beside the canvas.

- **Steps**: **+ Add step**, then choose the agent that does it, what it does each run, and what
  **Done when** means. A step the lead suggested an agent for offers **Create agent**, which makes
  the agent and gives it to the step. A step runs on its agent's model unless you choose another.
- **Order**: drag from a step's right edge to another step. The second step starts once the first
  is done, and gets its result. Select an arrow and press Delete to remove it. Steps can't wait for
  each other in a loop.
- **Lead**: its model, **The outcome you want**, the workspace the steps work in, what happens when
  an agent wants to change something (**Ask me**, **Auto**, or **Never ask**), its notes from past
  runs, which you can edit, and limits on what each run may spend and how long it may take.
- **When it runs**: **On a schedule** (days, time and time zone) or **When you start it**, what to
  do with scheduled runs missed while Codenine was off, and the values each run starts with.

A workflow can't run until every step has an agent and the lead has a model, a workspace and an
outcome; its page says what is missing. A scheduled workflow runs only while it is **On**, and only
while Codenine is running on that computer.

## Runs

**Run now** starts a run at once and opens it; a workflow with inputs first asks for this run's
values. A run's page shows each step as waiting, working, being checked by the lead, sent back,
done or failed. Select a step to open its chat. The lead's notes say what it decided and when.

A run waits for you when:

- **It reaches a limit.** A step already working finishes first. Choose **Go on** to allow the
  original amount again on top of what the run has used, or **Stop run**.
- **A step's agent asks before going on.** **Open to answer** opens that step's chat. These also
  wait in your Inbox.
- **The lead leaves a step for you.** Choose **Accept**, or **Send back** with what should change.
  You can also accept or send back any step while the lead is checking it.

If Codenine stops during a run, the run carries on from the step it was on when Codenine starts
again.

**Runs**, beside **Canvas**, lists every run with how it started, its result, time and cost, and the
scheduled runs that were skipped.
