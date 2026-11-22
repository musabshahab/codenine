# Working with chats

Use a new chat for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a chat

The **New** button at the top of the sidebar starts a chat, a task with a team, a workflow, or a
workspace.
**New chat** opens the workspace picker when you have more than one open workspace. Archived
workspaces don't count. **Shift-click** to start in the current workspace, or use a workspace's own
**New chat** button. A new chat shows its workspace beside **Team** in the composer; pick another
there before you send. A new chat carries your model and mode selections, unless the destination
workspace has its own model default. Its branch and checkout come from your configured defaults. To
continue in the worktree you used last, choose **Previous worktree** in the **Checkout** menu.

When you change a new chat's workspace, Codenine stays in the current environment
if that workspace exists there. Otherwise it selects an environment that has it.

### Start in Personal

**Personal** holds the chats you start without picking a workspace. To start one, pick **Personal**
from **New chat in...** in the command palette, use the **New chat** button on Personal in the
sidebar, or press `mod+alt+n`. With no workspace at all, **New chat** starts in Personal. A chat
starts on your current environment; before sending, pick another environment from the environment menu in
**Details** to move it there. A Personal chat cannot ask for a team, since a team works in one
workspace's folder.

Each Personal chat works in its own folder under `~/.codenine/workspaces/personal`
(`~/.codenine/scratch` on older installs), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a chat keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into workspace** from the
chat's menu. The chat's folder becomes a workspace where it is, so nothing
moves and the agent keeps working in the same place. Other chats in that folder
move with it. Rename the workspace in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

Press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new chat and immediately open another draft. If
**Settings → Chat → Send shortcut** makes that chord send the prompt, add **Shift**. The
next draft keeps the checkout and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models, **Shift-click** models
in a new chat's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate chat
and worktree while you stay in the new chat composer. This requires a Git workspace.

## Workspaces

The sidebar lists your workspaces, each with its tasks and chats, under **Inbox**, **Tasks**, and
the **Build** pages. Personal comes first. Search, the magnifier at the top, finds chats in every
workspace.

**Inbox** lists everything waiting on you, across workspaces: approvals, a connector's included,
questions, teams waiting for your approval, and teams that failed. A workflow run that waits for
you or failed is there too, and opens on the run's page. An entry leaves once you act on it, mark
the chat done, or snooze it. **Tasks** lists every task a team works on, grouped by whether it
needs you, is running, or is done. Workflow runs are not in Tasks: a workflow's runs are listed
under its chat (**Show 3 runs**), open while one is running. The newest 10 show there, and
**All 12 runs** opens the rest on the workflow's page. A run's step chats are on the run's page.

Finished chats leave the grouped lists for **Completed & archived**, at the bottom of the
sidebar, where **Mark not done** brings back a done chat. Its **Archived** tab lists your
archived chats: **Unarchive** brings one back and **Delete** removes it for good. An agent's chat
is not listed there; open it from its task.

## Build

**Agents** holds the specialists you set up once, **Skills** the know-how agents follow, and
**Connectors** the services they can use; see [Agents](./agents.md), [Skills](./skills.md) and
[Connectors](./connectors.md). **Workflows** holds teams of your agents that run again, on a
schedule or when you start them; see [Workflows](./workflows.md).

## Group chats by workspace

The sidebar groups chats by workspace by default: your unsent drafts and **Pinned**
chats, then a folder for each workspace, pinned workspaces first, then **Snoozed**. Each row's icon
shows where the chat stands: running, waiting for you, failed, done, or with an open pull request.
Choose **Mark unread** from a chat's menu to show its latest result as new again until you open
the chat.

A workspace with no active chats keeps its folder unless it is archived. An archived workspace's
folder comes last and shows only while it has active chats. The filter beside **Workspaces**
narrows the list to the workspaces you pick. Click a workspace's arrow to open or close it; a closed
one shows how many chats it holds, and a dot when one of them needs you. Click its name to open
the workspace's page, with its folder, environments, and commands, its open tasks and chats, and buttons
to start either. Use a workspace's **New chat** button, or right-click it, to start a chat in that
workspace. You can drag a chat onto the composer to mention it, but not within the sidebar.

To show each chat in a workspace folder on two lines, with its branch, pull request, and agent
under the title, turn on **Settings → General → Sidebar → Two-line chat rows**.

For one list without workspace folders, turn off **Settings → General → Sidebar → Group chats by
workspace**. The single list keeps finished chats on its own **Done** shelf, you can drag chats
between sections and reorder them, and [working chats fold away](#fold-working-chats-beta).
Each device keeps its own choice.

## Pin and reorder chats

Choose **Pin chat** from a chat's menu to keep it above your active work.

Unpinning, marking done, snoozing, and archiving a chat each show
a notification with **Undo** for five seconds. Undo restores the chat's previous
state, including its pinned position, and reopens an archived chat you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

You can also drag files from your computer onto any chat row:
the chat opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

Pinning or unpinning a chat keeps the sidebar at your current
scroll position instead of following the chat to its new place in the list.

A pinned chat is not marked done automatically, except a team agent's chat when its team
finishes or is cancelled. Marking a chat done removes its pin.

In the single list, drag a chat between sections to change its state. Drag a chat up into
the pinned section to pin it at the spot you drop it; drag a pinned chat down into the active
list to unpin it. Dragging a chat onto the **Done** header marks it done, and dragging a done
chat into the active list marks it not done. A snoozed chat can be dragged out of the snoozed
shelf, which wakes it, but chats cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned chat out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the chat will land. When you cross into another section,
the dragged chat shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Done**, **Not done**, or **Wake**. Its status and hover actions hide during the drag. A pinned
chat keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a chat. Section labels stay readable for the whole drag, and the section the
chat is over takes the accent color. Section labels also
identify empty sections and a collapsed **Done** shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the chat will land. Drops into either section keep the position you choose. The server
saves the order, so it survives a refresh and appears on your other connected devices.

The list also animates section changes made with chat actions such as
**Pin**, **Mark done**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New chats appear above the active chats you have arranged. Marking a chat done clears its
active position, so **Mark not done** returns it to the top. Pinning and snoozing preserve its
active position until you move it again. Chat activity does not change the order. The **Done**
shelf is ordered by when each chat was marked done.

If dragging is unavailable for one environment, update the Codenine server running in that
environment. Pinned and active reordering require server support. Chats from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a chat's menu and choose
**Regenerate title**. It is unavailable while a title is being generated, and does not appear
until the environment is connected.

To change how titles are written, add **Chat title instructions** in **Settings → Chats →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a workspace to give it its own instructions.

Agents connected through Codenine can use the same server-owned metadata workflow to
rename a chat, regenerate its title, or link and unlink a pull request. These changes
appear on every connected client without requiring the originating browser to remain
open.

### Fold working chats (beta)

Chats that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests, and background commands or monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a chat
there. A chat returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the chat you last sent work to first. Pinned chats stay in
the pinned section.

This applies only to the single list; chats grouped by workspace have no Working section. It is on
by default. Turn it off with **Settings → General → Sidebar → Working section**. Each device
keeps its own choice.

While this is on, the active list is ordered by when each chat last came back to you, so you
cannot drag or move chats within it. Your saved order returns when you turn it off.

## Mark finished work done

Choose **Mark done** from a chat's menu to move finished work out of the active list
without deleting the conversation. Grouped by workspace, it goes to **Completed & archived**; the
single list keeps it on its **Done** shelf. **Mark done** is unavailable while the chat is
working, waiting on an approval or an answer, or has a message queued. **Mark not done** restores it to
active work and keeps it from being marked done automatically until new activity resumes the
usual rules. Marking an idle chat done by hand dismisses unanswered async questions without
sending an answer or restarting the agent. It also closes the chat's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open unless its action has **Stop this action
when the chat is marked done** enabled in Settings > Workspaces > Actions. You can also set
`"stopOnSettle": true` on a `codenine.json` action and import it there. Start the command through
that action so Codenine can stop its terminal and child processes. Commands started through an
agent's own shell tools are managed by the provider.

To reclaim disk space from finished work, turn on **Run in the chat's worktree when the
chat is marked done** for one of the workspace's actions, or set `"runOnSettle": true` on a
`codenine.json` script, for example `cargo clean`. It runs each time a chat in its own
worktree is marked done, by hand or automatically, even if a terminal there still runs a
command such as a dev server. Chats in the workspace's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

Press a chat's **Done** button and drag up or down to
mark every chat in that section done, between it and the one you release on.
The **Mark not done** and **Wake now** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments mark inactive chats done after seven days, and mark
chats done when their pull request merges. A closed pull request can also mark an idle
chat done. An empty chat's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on keep a chat from being marked done automatically. An open pull request does not
stop inactivity from marking it done unless you turn on **Keep chats with a PR** in
**Settings → Chats**, but an old closed or merged pull request does not mark work done that you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one chat from being marked done automatically, open its menu, choose **Mark done
automatically**, and pick **Never**. The current option is checked. Pick **As set in Settings** to
return to the rules in **Settings → Chats**. While those rules are off, a chat on **As set in
Settings** is not marked done automatically either. **Mark done**, snooze, and archive still work
while it is set to **Never**. On a team agent's chat the option reads **Never (until the team
ends)**: when a team finishes or is cancelled, its agents' chats are marked done anyway.

Change these rules in **Settings → Chats**.
They continue to run when your apps are closed. Choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
chats already marked done.

## Link a pull request

The server finds the PR for each saved branch of a chat that is not done, even when your
apps are closed. Done chats keep their saved links. Update the server if
automatic branch links do not appear.

Right-click a pull request link in a chat and choose
**Link to chat** to select a different PR. Use **Unlink from chat** on the
same link to return to the branch PR, if one exists.
The linked pull request counts when Codenine marks the chat done automatically.

## Find and reference work

Open the command palette with `Cmd/Ctrl+K` to search chats
across connected environments by title, branch, pull request, or workspace.
Chats you open often or recently rank higher, and for three weeks the chat
you last picked for a query ranks higher when you type that query again.
Chats whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a chat reference. A copied reference uses the chat's pull request
link when available, otherwise a link to the chat, which opens it from anywhere
you paste it and pastes into a composer as a chat chip (see
[sharing a chat](./prompt-links.md#share-a-chat)). To copy the chat's link even
when it has a PR, choose **Copy → Chat link** from its menu.
**Chat ID** copies the bare ID for scripts and the `codenine` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another account.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually. Do this when the provider reports no reset time, because nothing
continues the turn on its own.
Queued messages stay saved while the limit blocks the chat. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the chat. Enable **Resume after
usage limits** in **Settings → Chats** to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the chat, sending a new message,
archiving, or marking it done prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the chat until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the chat without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in chat behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

Use **Agents** to follow work delegated to subagents.
Stop on a chat also stops the subagents it delegated to.

Subagent chats started by the agent can't take messages; message the parent
chat instead. When such a subagent needs an approval or an answer, the parent
chat asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

The top of a workspace's chat holds its tools: the workspace's main command, such as **Dev**, with
its other commands in the menu beside it; **Details**; **Terminal**; **Changes**, with the lines
added and removed; **Files**; and **More**, the chat's menu, which clicking the chat's title
also opens. At its end, one button offers the
next step: **Open run** in a workflow run's chats, **Approve team**, **Retry** an agent that
failed, the team's progress while it runs, **View PR**, or **Create PR** once the work is ready. On your default branch, Create PR first offers
to move the changes to a new branch. On a narrow window some tools step aside; they stay in the
right panel.

The chat details card, with the environment, editor, workspace commands, branch, Git actions and
changes, stays closed until you open it with **Details** or `mod+shift+b`. Each chat remembers
whether you left its card open.

To choose what the chat details card shows, right-click the card or open
**Settings → Appearance → Chat details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and workspace commands. **Reset to default** brings
back the standard rows.

## Run a team

A team splits one job into small tasks, each on the model that fits it, so cheap, quick models do
the routine parts while a stronger one integrates and reviews. To ask for one, turn on
[**Team**](./composer.md#ask-for-a-team) in the composer before you send, or ask in your own words,
for example "propose a team for this: one agent writes the code, one tests it, one reviews". The
agent you asked, the lead, reads what it needs, plans the team and starts nothing. It writes each
task a detailed brief and a check that says when it is done, since the member has not seen your
chat. The plan opens in the **Task** tab of the right panel.

Where one of your [agents](./agents.md) fits a part of the job, the lead gives it that part, and the
member runs with the agent's instructions, skills and connectors. Otherwise the lead makes a member
just for this team, marked **Made for this team**, with its own instructions, which you can read
and edit under **Edit team**. Such a member uses the connectors of the lead's chat and is not added
to your agents; it is gone when the team is. Its menu offers **Use one of your agents, on this
model**, **Save as agent…** to keep it as one of your agents, and, after either, **Back to the
lead's definition**.

Nothing runs until you approve, from the Task tab or with **Approve team** at the top of the
lead's chat. The Task tab lists the team's steps in order, each with its brief, the agent that
runs it, and that agent's model. Choose a step's agent to give the step to another member, or to
another of your agents, and its model to change the model or effort for this team; the agent itself
keeps its model. **Use for all agents** puts the whole team on that model. **Edit team** adds a
member, either one of your agents or a new member made for this team, with its role and where it
works, or removes one that has no steps; choose a member's name there to run it as another of your
agents. It also sets how many tasks run at a time on each account, from one to six. You can also edit a step's brief or remove the
step. To add, reorder or split steps, ask the lead. Your edits apply once you choose **Save** or
**Approve and start**. If the team changes while you edit, for example because the lead proposed a
new one, the tab shows the new team and tells you your changes were not applied. **Cancel team**
drops the plan.

Each step runs in a chat of its own. A step starts once the steps whose results it needs are
done, with at most two running at a time on each account unless you set another number. The Task tab shows each step's status,
agent, model, and result, the steps it starts from, and a link to its chat. When a step fails,
retry it on its own agent, on another one, or with **Retry on another model…** on a stronger
model for that step alone; the steps that need it wait until it passes.
**View changes** opens the Changes tab. When the Task tab is out of sight, or the window is too narrow for the right panel, the
**Team** line above the composer shows where the team stands and opens the tab. The right panel's
**+** menu also has **Task**.

When the team finishes or gets stuck on a failed task, the lead reads the results and goes on.
After a finished team, its reply shows as the **Task result**, and **Save as workflow** in the Task
tab opens the workflow editor with that team, so the same agents can do the job again on a schedule
or when you start it.

An agent's chat opens with **Assignment from the lead**: its brief and the results it received
from earlier agents. Its header links back to the lead and shows the agent's place in the team, its
model, and its status. A message you send there goes to that agent only; to change the plan, ask
the lead. When an agent needs an approval or an answer, the lead's chat shows that too.

In the sidebar, the lead's row shows where the team stands: waiting for your approval, running,
done, or failed, and in the single list as **Review**, **Running 1/3**, **Done**, **Failed 1**, or
**Cancelled**. The agents' chats appear under it, and the team count on that row shows or hides
them. A team waiting for your approval, or one that failed, also appears in the
[**Inbox**](#workspaces), and every team is on the **Tasks** page. When the team finishes or is
cancelled, the agents' chats are marked done for you. After a failure they stay, so you can read
and retry them. The lead is never marked done for you.

- **Cancel team** stops the tasks that are running. Tasks that have not started never start.
- **Retry** runs a failed or cancelled task again in a new chat. To retry on a different model,
  such as a stronger one, choose another agent of the team under **Retry on**.
  A cancelled team cannot be retried; ask the lead for a new one.

## Side chats

A side chat lets you ask a question about a chat without adding to it. It starts
with what the chat knows, and the chat keeps working while you ask.

Start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in chat details.

A side chat works in the same folder as the chat and starts with the permissions,
model, and reasoning level shown in the chat's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Bring back**. The chat gets the side chat with
your next message there. Bring back is available while the chat is idle.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a chat also deletes its
side chats.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Chats → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment.

Choose **Snooze → Custom…** from a chat's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. You can also snooze
several selected chats together. Choose **Wake now** to bring a chat back early.

A snoozed chat keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early for an approval,
a new question, a failed run, or a message or answer you send. You can snooze an existing
question and answer when the chat wakes; the question stays unanswered.

## Get notified

Codenine can tell you when a chat finishes, fails, hits a usage limit, or needs your input or
approval. Turn on any of these in **Settings → General → Notifications**:

- **System notifications** appear only while Codenine is open but in the background, such as
  another window or a hidden tab. Click one to open its chat.
- **Sound** plays for every alert, even while Codenine is in front.
- **In-app toasts** appear while Codenine is in front, for chats other than the one on screen.

The first time you turn on system notifications, your browser asks for permission. If you
refused, the setting says **Blocked in browser settings**: allow notifications for this site in
your browser's site settings, then turn the switch on again. In a browser, system notifications
need HTTPS or localhost; the desktop app supports them.

These choices apply to this device only. Nothing alerts you once Codenine is closed.
