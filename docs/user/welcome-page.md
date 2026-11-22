# Welcome page

Codenine shows a Welcome page when you open a new installation. An installation
that already has your workspaces or chats skips it. Setup is one step: connect an
agent on the computer you are using, then start chatting in **Personal**, the
workspace every installation starts with.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

Moving from another computer? **Restore from a backup** at the top of the page brings back your
chats, workspaces, accounts and settings instead. See
[Move to a new computer](./backup.md#move-to-a-new-computer).

If Codenine cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Codenine cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

The page shows a card for Claude Code and a card for Codex. Each card checks
whether the agent is **Installed** (with its version), **Signed in** (with its
account), and **Ready**, and offers the one next step:

- **Turn on** enables an agent that is off on this computer, including one only
  some workspaces use. Codenine then checks it.
- **Install** or **Sign in** opens a terminal in the card, in your home folder,
  with the command typed in. Review it and press Enter. When it finishes,
  Codenine checks the agent again and types the next command, such as signing in
  after an install. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- **Update** opens the agent in **Settings → Accounts** when Codenine knows the
  installed version does not work with it. **Details** opens an agent that could
  not load or does not work.

When your browser is on another device than the computer you are setting up,
Codex signs in with a device code: open the link in the terminal and enter the
code it shows. Claude Code also shows a link and asks you to paste a code back.

For Codex, **Use ChatGPT sign-in instead** signs in with your ChatGPT account and
lets Codenine install and manage Codex. **Use the Codex CLI instead** goes back.

Below the cards, **Have an OpenRouter API key? Use it instead of signing in** adds
OpenRouter, which runs models from many providers through Claude Code with your
OpenRouter key. It then shows as its own agent. See
[Use OpenRouter](./providers-claude.md#use-openrouter).

Other agents are under **Add more agents**. The same card opens later from
**Set up** on a chat's notice that Claude or Codex isn't ready, and from
**Set up** in **Settings → Accounts** for one that is missing or signed out.

On the desktop app, when the folder of the `codenine` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the environment configured for the account.
Sensitive values remain redacted in Settings and terminal metadata while the
terminal process can use them.

## Start chatting

Once an agent is ready, **Start chatting in Personal** saves setup as done and
opens a new chat in [Personal](./thread-sidebar.md#start-in-personal). One agent is
enough to start. Teams that mix Claude and Codex need both; you can add the second
later in **Settings → Accounts**. With no agent ready, **Continue without an agent**
opens the same chat, where **Set up agents** offers the same cards.

Personal is unavailable when the Codenine data directory sits inside a Git
checkout, and until the computer is connected. The page then says why, and its
button opens the app instead.

To keep a project's files, chats, and tasks together, create a workspace from the
sidebar. See [Start, clone, or publish a workspace](./source-control.md#start-clone-or-publish-a-workspace).
