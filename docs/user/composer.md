# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. Use
`Cmd+Shift+V` on macOS or `Ctrl+Shift+V` elsewhere to keep a large paste editable in the composer instead.

## Formatting

The composer writes Markdown and shows it styled as you type. When your cursor
is on styled text, its Markdown shows instead, such as `**bold**`, and the
markers edit like any other text: delete them to remove the style, or change
`**` to `*` for italic. The style updates when your cursor leaves. To write
plain Markdown with no styling, turn off **Settings → Chat → Rich text
composer**. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---`
become lists, task lists, quotes, headings and rules; ` ``` ` followed by Enter
opens a code block. What you typed is what the agent receives, markers and
numbering included, and `#1234` without a space still looks up a pull request.

Some styled text containing or touching literal Markdown characters, such as a
bold `path\` or `2*3`, keeps its styling without showing markers. Use formatting
shortcuts or turn off rich text to edit the formatting of those ranges.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line moves out one level, then leaves it; **Tab** nests a list item
under the one above and **Shift+Tab** moves it back out. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Attach files

Choose **+** next to the message box, then **Add files or photos**. Attach up to 100 files per
message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. Reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the composer. HEIC and HEIF photos are
converted to JPEG; photos over the image limit are also resized to fit.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

Choose **Settings → Chat → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited or removed before they send.
When Enter sends, `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses
the opposite action: it steers when your default is Queue and queues when your
default is Steer.
If your **Send shortcut** requires `Cmd+Enter` or `Ctrl+Enter`, that shortcut uses
your default follow-up behavior; add **Shift** to use the opposite action. This
applies only to multiline messages when you choose the multiline send option.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. If that shortcut sends the opposite
action for your draft, move focus outside the composer to steer the queued message. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

## Custom models

Use Settings → Accounts → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that account:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Model defaults

Codenine remembers your provider, model, and model options for new chats. A
workspace's configured model takes precedence; resetting that workspace setting
returns to the remembered selection.

Once you have [agents](./agents.md), the model picker lists them under **Agents**, above the
models. Choosing one makes the chat talk to that agent on its model; **No agent** keeps the model.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

Select text within one assistant response and choose
**Cite**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this chat. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the chat. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Suggested next prompt

Turn on **Suggest next prompt** in Settings > Labs. After a Claude or Codex turn completes, the
empty composer shows a predicted next message. Press `Tab` to fill it in, then edit or send it, or
press `Escape` to dismiss it. Each suggestion is one extra request that reuses the turn's prompt
cache, so it uses a little of your plan's usage. Claude skips suggestions on the first turn of a
chat and near usage limits. Codex needs version 0.165 or later; if Codenine manages
Codex, update it in Settings > Accounts. Codex follows a change to the setting at once; open Claude
chats follow it after they restart.

## Edit an earlier prompt

Choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to put the workspace back
to its checkpoint from before that message. That also undoes edits you made yourself.
File restore is only offered for chats running in a worktree, and it is
refused when another chat or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A chat that works in the workspace directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active chat
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

Press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Queued messages

The composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a send button that shows your
[Follow-up behavior](#send-while-the-agent-is-working): a queue icon for Queue or a steer arrow for
Steer. Click it or press your send shortcut to use that action. Hold `Cmd` on macOS or `Ctrl` on
Windows and Linux to switch the button to the opposite action, then click, or use the opposite-action
shortcut described above.

Queued messages appear at the end of the chat as dashed messages that have
not been sent yet. Each shows its text and any attached
images. **Send now** sends a message right away, into the running turn if there is one. You can
also edit or remove it.

If you stop the agent or the server restarts, queued messages keep their order and are held.
Press **Resume** in an empty composer to continue. **Resume** also continues a stopped
run or one that hit a usage limit, even with nothing queued. Sending a new message also resumes the queue, unless it steers a turn that is already
running. You can edit or remove held messages without starting them.

The pencil on a queued message opens it in the composer for editing. The original message
stays in the queue until you save, and it is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** next to it leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill. Your Codenine skills come first; a provider skill
with the same name is left out. See [Skills](./skills.md).

The **+** menu next to the message box keeps a skill on for the whole chat (**Add a skill…**) and
turns the chat's [connectors](./connectors.md) on or off. What the chat uses shows above the message
box, where you can remove it. In a chat with an [agent](./agents.md), the agent decides both.

The slash menu also lists skills. Only skills enabled for the provider are listed.

After you add or change skills, plugins, or MCP servers, use **Restart agent
session** in the command palette. The conversation continues,
and your next message starts the agent again with the new setup.

Provider commands must start the message to run. Codenine commands such as
`/model` and skill mentions work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it.

Send `/clear` on its own, or pick it from the slash menu, to start a fresh session
in the same chat. Your next message goes to a new provider session that doesn't see the
earlier messages, and the chat marks where it began with **New session**.
Earlier messages and diffs stay in the chat. Dismiss the notice above the
composer to keep the current session instead.

Turn on **Context window** in **Settings → Appearance →
Chat details** to see context usage in the chat details card. It appears
once the provider reports usage.

Claude accounts can also compact idle chats for you. See
[compact long conversations](./providers-claude.md#compact-long-conversations).

## Goals

With Codex and Claude, send `/goal` followed by what "done" means, for example
`/goal all tests in packages/api pass`. The agent keeps working across turns
until it judges the goal met. The chat shows **Goal** while it works, and a
line at the end of the chat shows the goal and
its progress.

- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex also supports `/goal pause` and `/goal resume`. Stopping a Codex goal
  pauses it, and so does Codex ending its work without meeting the goal.
- Stopping Claude ends the current turn, but the goal stays set. Claude checks it
  again at the end of your next message.
- Sending a new goal, or `/goal resume`, while the agent works stops the current
  turn and starts the goal, unless you queue it. `/goal clear` and `/goal pause`
  stop the turn only when it is working on the goal. Other goal commands wait for
  the turn to end.

## Ask for a team

Turn on **Team**, next to the attach button, to have the agent plan a
[team](./thread-sidebar.md#run-a-team) for your message instead of starting the work. The sent
message shows **Team requested**. Team turns off once the message is sent or you reload, and it
does not apply to a message that starts with a `/` command. It is not offered in a chat that
already leads a team or works for one, in subagent chats and side chats, or in a Personal chat, since a team works in
one workspace's folder. To toggle it from
the keyboard, bind **Composer: Toggle Team** in **Settings → Keybindings**.

A new chat in a workspace suggests a few example prompts under the composer. Choosing one fills in
the composer without sending; the team example also turns on Team.

## Draft a workflow

Turn on **Workflow**, next to **Team**, to have the agent draft a workflow from your message
instead of doing the work: say what should happen each time, and when. The draft opens in the
right panel's **Workflow** tab, a step for each of your agents' parts; a step none of your agents
fits shows the agent the lead suggests. Ask in the chat to change it. Nothing is saved until you
open the draft in the workflow editor and save it there. A saved workflow starts off; turn it on
from the chat's **Workflow** tab or in the editor to run it on its schedule. After you save, the
**Workflow** tab shows the saved workflow, whether it is on, and anything that keeps it from
running, and you can turn it on or off and run it from there. If you ask for changes later, they
show as changes to that workflow: review and save them to update it instead of making a new one, or
discard them to keep it as it is. You can still turn it on or off and run it while changes wait. The sent
message shows **Workflow requested**. Like Team, Workflow turns off once the message is sent, and
it does not apply to a `/` command; turning one on turns the other off. It is offered in Personal
chats too: choose its workspace in the editor before you save. **New workflow** in the sidebar's
**New** menu starts a chat with Workflow on.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. Type `#` to browse the newest
pull requests in the current workspace's repository. Pull requests linked to the chat are included
from any repository and listed first, after any exact number match. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another chat can be context too. Type `@` followed by part of its title to pick one from
the same server. You can also drag a chat out of the sidebar and
drop it on the composer; a multi-selection drops together. **Copy chat link** copies a
link to the chat that pastes into a composer as its chip. The chip shows the chat's
current title and opens it when selected. Your prompt only carries a reference: the agent reads the chat's
history on demand, so attaching a long chat costs nothing until the agent looks. Attaching a
chat does not change it, and the agent cannot send messages to it unless you ask.

A pasted link to a chat on another environment stays a link. Dropping a chat
from another environment attaches a saved transcript file. The source
environment must be connected and up to date. The transcript includes the visible history and
saved text context at the time of the drop; later messages and the contents of attached files
are not copied. The agent can read the saved transcript after the source disconnects. Normal
file attachment limits apply.

Type `@` and part of a model or provider name, such as `@opus`, to name that model for the
agent, for example when delegating. It does not change the chat's model. Join words with
`:`, `/` or `-`, as in `@opus:claude`.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same chat or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete Codenine tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

Files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. A ZIP up to
50 MB opens as a folder list.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser; save an unsupported video to open it in another app.

Right-click media to save it or copy its path or URL.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## Edit workspace files

Open a workspace file from the Files tab or a file link to edit it beside the conversation. Each
file opens in its own tab, and edits save as you type. A dot on a tab means that file has edits
that are not saved yet.

If the file changes on disk while you have unsaved edits, for example because an agent wrote to
it, Codenine does not save over it. Choose **Reload from disk** to drop your edits and see the
file as it is now, or **Overwrite** to save yours anyway. Closing the tab in that state asks
before it discards your edits.

In a Git workspace, the line numbers carry a marker for each line that differs from the last
commit: green for added, blue for changed, and a red tick where lines were removed.

When the agent's latest turn changed a file you have open, the file offers **Review changes**. The
review shows that turn's changes inside the file, against the file as it was when the turn
started. **Keep** accepts them and **Discard** puts the earlier text back, for the whole file or
for one change at a time. Discarding a file the turn created deletes it, and a file the turn
deleted offers **Restore file** when you open it. You can also right-click
a file in the latest turn's changed files or in the Diff tab and choose **Review in file**, which
also brings back a review you closed with **Keep**. In Work and Create workspaces, selecting a file
in the latest turn's changed files opens this review; files from earlier turns open in the editor.
In a Git workspace the review covers files Git tracks or would track, not ignored files or links,
and relies on the checkpoints Codenine saves each turn. In a folder without Git it relies on
[file versions](#file-versions) instead.

### File versions

A folder that is not a Git checkout has no commits to go back to, so Codenine keeps earlier
versions of its files itself. A version is kept when you save in the editor, and around each
agent turn for the files that turn changed, created or deleted. Changes made in another app are
picked up at the start of the next turn.

Open a file and choose **Versions** in the file's toolbar to see them: when each was made, how
large it is, and whether it came from the editor, an agent's turn, a restore, or outside Codenine.
Select one to read it, then **Restore this version** to put it back. Restoring keeps the contents
it replaces as a version too, so you can go back again. When those contents cannot be kept, as
for a file over the size limit, the restore is refused and the file is left as it is; the same
holds for **Discard** in a review. Versions work for any kind of file; only text has a preview.

Versions live in Codenine's own data folder, never in your folder, and are limited for each
workspace: 30 versions of a file and 1 GB in total, with the oldest removed first and the newest
version of every file always kept. A file over 32 MB is listed when it changes but no copy is
kept, and a folder is watched up to its first 10,000 files, leaving out `node_modules` and
`.git`. Saves a few minutes apart count as one version. Deleting the workspace deletes its
versions, and [backups](backup.md) leave them out.

A Git workspace keeps no versions: its history is in Git and in the checkpoints behind the Diff
tab. A folder that becomes a Git checkout later keeps the versions it already has, and
**Versions** stays on the files that have some. When several agents work in one folder at once,
a change is listed under the turn that ended first after it.

### Spreadsheets

An `.xlsx` workbook opens as a grid you can edit, and so does a `.csv` or `.tsv` file in its
table view. The grid shows cell values, bold and fill colours only. **Show as laid out** in the
file header switches a workbook to the read-only view with its column widths, merged cells,
images and charts, and **Edit cells** switches back. A read-only connection gets that view. Select a cell and type to replace its contents, or press F2 or double-click to change
them; Enter and Tab save the cell and move on. Start with `=` for a formula. Copy and paste work
with other spreadsheet apps, Ctrl/Cmd+Z undoes your own cell edits, and edits save as you type,
with the same **Reload from disk** and **Overwrite** choice as a text file when the file changed
underneath you. Here **Overwrite** puts only your edited cells into the file as it is now.

The tools above the grid set bold, currency, per cent and a fill colour, insert or delete rows
and columns, and **Sort** orders the table around the selected cell by that cell's column. A sort
moves whole rows with their formats, keeps a first row of headings in place, and stops at the
first empty row. It is refused when it would change what a formula reads, such as a formula
that points at one row of the table from elsewhere, or when the rows hold merged cells. The
sheet tabs add, rename and delete sheets. These save at once and are not undone with Ctrl/Cmd+Z,
so use [file versions](#file-versions) or Git to go back.

Type a cell or a range such as `B16` or `A1:C4` into the box beside the formula bar to go there.
**Find in sheet** (Ctrl/Cmd+F in the grid) searches the whole sheet, values and formulas; Enter
goes to the next match and Shift+Enter to the one before. Selecting several cells shows their
sum, average and count under the grid. Drag a column's edge to resize it, or double-click the
edge to fit its text; a width you drag is saved in a workbook. While an agent's change to the
file waits for **Keep** or **Discard**, the cells it changed are marked, as far as the grid had
them on screen before the change. Formatting a whole column or row reaches as
far as the sheet's last used cell. Edits that could not be saved yet stay with the file while you
look at another one, and are saved or offered again when you come back to it. A CSV or TSV file holds text only: no
formulas, formats or extra sheets.

Saving keeps what Codenine does not show, such as charts, images, styles and other sheets.
Codenine recalculates everyday formulas (arithmetic, `SUM`, `AVERAGE`, `IF`, `ROUND` and the
like). A formula it cannot work out shows as its text until a spreadsheet app opens the file and
calculates it. A change that would damage the workbook is refused with the reason, for example
inserting rows in a sheet that holds a chart, a table, a filter or comments, or a formula with an
unclosed bracket; make that change in a spreadsheet app. Your other unsaved edits are still saved. Workbooks over 16 MB or about 600,000 cells, files protected with a password,
and CSV files that are not UTF-8 open for viewing only.

### Documents the agent changes

Ask the agent to change a spreadsheet, a PDF or a slide deck and it edits the file in place: it
sets cells and formulas, fills in a PDF's form fields, highlights passages of a PDF with a note,
and in a `.pptx` deck replaces text, adds a slide from one of the deck's own layouts, deletes or
reorders slides and writes speaker notes. Everything it does not touch is kept, such as charts,
pictures, themes and animations. Both Claude and Codex agents can do this. An agent that may not
edit files cannot, and neither can an agent in a chat set to ask before each change: it tells you
what it would change, and you make the change yourself or switch the chat to a mode that accepts
edits.

Decks are view-only for you: the agent edits them, and you read the result. An open spreadsheet,
PDF or deck shows the agent's change when its turn ends. If you had unsaved edits of your own in
that file, they are kept and you choose between your edits and the file as it is now.

When the agent's latest turn changed one of these files, the file's tab offers **Keep** or
**Discard changes**. These files cannot be compared line by line, so Discard puts the whole file
back as it was before that turn, without anything saved to it since. In a folder without Git
the agent's change is also listed in the file's [versions](#file-versions), where any earlier
version can be restored. The agent cannot sign a PDF; see below.

### Sources

The **Sources** tab in the right panel lists what the chat has read or cited: workspace files
the agent read, files you attached, web pages it opened or found in a search, and connectors it
used. Choose a file to open it beside the chat, or a page to open it in your browser. A Work
workspace lists the tab first; in other workspaces add it with the panel's **+** button.

### Activity

The **Activity** tab lists the changes made to the workspace's files during the chat, newest
first: which file, whether it was edited, created, deleted, restored or signed, and whether the
agent did it (and in which turn) or you did. Choose an entry to review the latest turn's change
in the file, or to see the file's versions for an earlier one. Your own saves, restores and
signatures are listed in a folder without Git, where Codenine keeps
[versions](#file-versions); in a Git checkout the list holds the agent's turns only.

### Save a reply as a file

Hover a reply and choose **Save reply as file**, or run **Save last reply as file** from the
command palette. Pick the format, the file name and a folder inside the workspace:

- **Markdown** saves the reply as it was written.
- **PDF** saves it as pages of text with its headings, lists, code and tables. Characters
  outside Western European text print as a question mark.
- **Spreadsheet** is offered when the reply holds a table, and saves the first one as an
  `.xlsx` sheet with a bold header row. Plain numbers become numbers you can sum. Codes that
  start with a zero and numbers longer than 15 digits stay as text, so they are kept as written.

The file opens beside the chat. If a file with that name is already there, nothing is written
until you choose **Replace file** or change the name.

### Review and sign PDFs

A PDF in a workspace opens with a toolbar for marking it up. Nothing changes in the file until
you press **Save** (Ctrl/Cmd+S); until then the toolbar's undo button, or Ctrl/Cmd+Z, takes back
your latest change.

- **Highlight text**: choose the tool, then select text on the page.
- **Add a note**: choose the tool, click where the note belongs, and write it. Click a highlight
  or a note later to read it, comment on it or remove it.
- **Fill in the form**: when the PDF has form fields they become inputs on the page. Use the
  toolbar toggle to hide them and read the page as it is.
- **Sign**: draw your signature, type your name to have it written in a handwriting style, or
  upload a PNG or JPEG of it (up to 512 KB). Click the page to place it, drag it to move it and
  drag its corner to resize it. Your name and the date, as your device writes dates, are printed
  under it.
- **Notes and highlights** lists everything on the document; choose an entry to jump to it.

Highlights, notes and form values are saved in the PDF itself as standard annotations and
fields, so other PDF readers show them and can change them. A signature is different: saving
draws it into the page, so it cannot be moved or removed afterwards. In a folder without Git you
can take one back by restoring an earlier version of the file ([file versions](#file-versions)),
where the save is listed as signed by you. In a Git checkout no earlier version is kept, so
commit the unsigned file or keep a copy of it before you sign. It is a picture of your signature,
not a certificate-based digital signature. Only you can sign: agents have no way to place a
signature. An agent can fill in the rest of a form and will then ask you to sign it here.

Tick **Keep this signature on this device** to reuse a signature. It is stored in this browser
only, and **Delete from this device** in the same dialog removes it.

Some PDFs open for reading only, with the reason shown: ones protected with a password or
permissions, ones that carry a certificate signature (any change would invalidate it), and ones
over 32 MB. Highlights and notes made in another app are listed but can only be removed there.
If the file changed on disk while you were working, the save is held back and you choose
whether to load the new file and keep your changes, or discard them. Closing the tab, or leaving
the page in a browser, asks first when a PDF has unsaved changes. The desktop app does not ask
when it quits, so save before you close it.

The toolbar's **Download** button saves the PDF, as last saved, to your device. In a browser,
**Open in a new tab to print** shows it in the browser's own viewer, which prints it and lists
its outline. A PDF over 50 MB or 2,000 pages, or one that takes too long to load, opens in the
browser's own viewer for reading only.

## HTML and PDF files in the file viewer

HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your Codenine session.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.
