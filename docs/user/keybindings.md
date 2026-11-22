# Keybindings

Customize shortcuts in **Settings → Keybindings**. That page lists every command
in your version, including those with no default shortcut, and shows a command's ID
when you hover its name. To see what a shortcut does, search for it as you would type
or read it, such as `ctrl+k`, `cmd k`, or `⌘K`. While you record a shortcut, Tab and
Shift+Tab still move between fields, so a Tab shortcut needs `mod`, `ctrl`, or `alt`.

## Composer controls

In **Settings → Chat → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message. `mod+Alt+Enter` sends, keeps that
chat running in the background, and opens a new chat. In a new chat, `mod+Enter`
does the same. When the send shortcut requires `mod+Enter` for the current prompt,
both `mod+Enter` shortcuts move to `mod+Shift+Enter`, so `mod+Enter` sends
normally. Change these shortcuts in **Settings → Keybindings** under
**Composer: Opposite Queue or Steer Action**, **Composer: Start in Background**,
or **Composer: Send and Start New Chat**. These bindings take priority over the
send shortcut. Click the send button to use the configured follow-up behavior.

When a chat has queued messages, `mod+Shift+Enter` sends the first one as a steer
while a turn is running, or as a new turn when the chat is stopped. Change it under
**Queue: Send First Queued Message** in Keybindings.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
To step a new chat to the next environment instead of opening the menu, bind
**Composer: Cycle Host** in Keybindings. It has no default shortcut. Neither does
**Composer: Toggle Team**, which turns [Team](./composer.md#ask-for-a-team) on or off.
Use `mod+shift+e` for effort, `mod+shift+a` for permissions, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. The workspace menu includes the
current checkout, a new worktree, and the previous worktree when available.
Use `mod+shift+l` to reuse the previous worktree directly.

To change effort one step without opening the picker, bind
**Composer: Increase Effort** and **Composer: Decrease Effort** in Keybindings.
Both are unbound by default. Increase wraps from the highest level to the
lowest, and decrease wraps from the lowest level to the highest.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. Right at the end of the search moves to the highlighted model's effort
levels, and Left comes back. Choosing a model keeps the picker open on its effort. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Copy a chat or its pull request

In a chat with a linked pull request, `mod+shift+c` copies the pull request's
URL. Without one, it copies the chat itself, which pastes into a composer as a
chat chip. It leaves terminal input alone. Change it in Settings by searching
for “Copy Link or Chat”.

## Find in a diff

Click into a diff in the Diff panel, then press
`mod+f` to search every file in it, including folded files and unchanged lines
hidden between changes. Enter and `Shift+Enter` move between matches, and a
match in a folded file opens it. Escape closes the search. This shortcut is not
configurable. A very large uncommitted diff loads its files as you scroll, and
find only searches the files loaded so far.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.codenine/userdata/keybindings.json` by default. You can edit this file directly.
The app takes its shortcuts from the primary environment, so **Settings → Keybindings**
changes only that environment's file. To give a workspace action on another environment a
shortcut, edit its action in **Settings → Workspaces**.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

Codenine creates the file with its defaults and adds new defaults on later startups.
When a default changes, Codenine updates the rule in your file only if you have not
edited it. New defaults do not replace commands you customized. If a new default
overlaps one of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, Codenine uses defaults.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Workspace actions use `script.{id}.run`, such as `script.test.run`. Settings lists
them under **Workspace actions** as **Run Action: Test** and so on.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `rightPanelOpen`,
`modelPickerOpen`, `usagePageOpen`, `composerFocus`, `draftThreadRoute`, `turnRunning`, `editableFocus`, `isWeb`, `isDesktop`, and `isMac`.
`rightPanelOpen` applies only to `rightPanel.new` and is true while the right panel is
open; the default `mod+t` uses it to open the panel's new-tab menu.
`draftThreadRoute` is true on a draft chat, including a restored draft, until it is first sent.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `isWeb` is true in a browser tab. `isDesktop` is true in the
desktop app. `isMac` is true when the client runs on macOS, even if the server
does not. Unknown keys evaluate to `false`.

`mod+1` through `mod+9` jump to the first nine chats, and to models while the
model picker is open. The chat jumps do not run while the model picker is open.
Those defaults use `isDesktop` so they do not steal the
browser's tab-switch shortcuts. Remove that condition in Settings if you want
the same jumps in a browser.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Find in the current chat

`chat.find` searches conversation messages and proposed plans in the active chat. Entering a
query searches the entire chat, including older messages. Chat search requires server support;
update an older server to enable it. Select **Retry** if a search fails. It defaults to
`mod+f` outside terminals. Press **Enter** or **Shift+Enter** to move between matches,
and **Escape** to close find.

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused chat. It has no default
shortcut; assign one in **Settings → Keybindings**.

`thread.settle` (`mod+shift+s` by default) is **Chat: Mark Done** in Settings. It marks
the current chat done, or not done when it already is.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, mark done, snooze, archive, or discarding a
draft. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. Right after an action, the shortcut works even
in a text field such as the composer. Once you type or press another key, the
field gets its own undo back. Terminals always keep their native shortcut.

`navigation.back` (`mod+[` by default) and `navigation.forward` (`mod+]`) move
through the pages you have visited, like a browser's back and forward buttons.

`chat.new` may ask you to choose a workspace when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-chat defaults](./thread-sidebar.md#start-a-chat). `chat.newWithoutProject`
(`mod+alt+n`) starts a chat [in Personal](./thread-sidebar.md#start-in-personal).

## Reserved shortcuts

In the desktop app, `mod+w` closes the active right-panel tab, and on macOS also the
focused terminal. When nothing remains to close, it does nothing; it never closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

A focused terminal on Windows or Linux keeps `Ctrl+W`, `Ctrl+D`, and `Ctrl+N` for
the shell. There, `Ctrl+Shift+5` splits the terminal and `Ctrl+Shift+D` splits it
vertically. In the desktop app, `Ctrl+Shift+W` closes it and `Ctrl+Shift+N` opens
a new one. A Windows or Linux browser keeps those two chords for closing its
window and opening a private one, so **Terminal: Close** and **Terminal: New**
have no default shortcut in a browser tab there; bind them to other keys if you
want them. On macOS these are `Cmd+W`, `Cmd+N`, `Cmd+D`, and `Cmd+Shift+D`.

`mod+shift+t` reopens the last closed tab across the app, including files and
diffs, in the order you closed them. This shortcut does not undo deleted work.
Browsers also use it to reopen browser tabs; choose another binding in Settings
if the browser takes it first.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
