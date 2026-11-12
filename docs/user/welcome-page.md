# Welcome page

Codenine shows a Welcome page when you open a new installation. Existing
workspaces skip it. It sets up the computer you are using in three steps: its
**Agents**, a **Project** to work in, and your **First task**, which you write on
the project's start screen.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

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
  some projects use. Codenine then checks it.
- **Install** or **Sign in** opens a terminal in the card, in your home folder,
  with the command typed in. Review it and press Enter. When it finishes,
  Codenine checks the agent again and types the next command, such as signing in
  after an install. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- **Update** opens the agent in **Settings → Providers** when Codenine knows the
  installed version does not work with it. **Details** opens an agent that could
  not load or does not work.

When your browser is on another device than the computer you are setting up,
Codex signs in with a device code: open the link in the terminal and enter the
code it shows. Claude Code also shows a link and asks you to paste a code back.

For Codex, **Use ChatGPT sign-in instead** signs in with your ChatGPT account and
lets Codenine install and manage Codex. **Use the Codex CLI instead** goes back.

Other agents are under **Add more agents**. The same card opens later from
**Set up** on a chat's notice that Claude or Codex isn't ready, and from
**Set up** in **Settings → Providers** for one that is missing or signed out.

On the desktop app, when the folder of the `codenine` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the environment configured for the provider instance.
Sensitive values remain redacted in Settings and terminal metadata while the
terminal process can use them.

**Continue** waits for one ready agent. When only one of Claude Code and Codex is
ready, it reads **Continue without** the other: teams that mix Claude and Codex
need both, and you can set up the other later in **Settings → Providers**.
Select **Continue without an agent** to go on without one.

## Project

A project is a folder on that computer that agents work in. Choose how to get one:

- **New project** creates an empty Git repository.
- **Open a folder** uses code already on that computer.
- **Clone a repository** downloads a GitHub or Git URL into a new folder.

See [Start, clone, or publish a project](./source-control.md#start-clone-or-publish-a-project)
for details. Your most recent projects on that computer are listed below these choices; pick one
to continue with it. **Skip for now and chat without a project** opens a chat
[without a project](./thread-sidebar.md#start-without-a-project). Setup is saved as done as soon as
you choose any of these.
