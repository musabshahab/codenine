# Settings and workspace overrides

The "Applying settings for …" sentence at the top of Settings pages picks
the workspace and environment a change applies to. Pages that hold only preferences saved in this
browser or app, such as Appearance, say **Saved on this device** instead. With one environment, its
name shows in place of a menu.

Only pages with settings a workspace can override, such as Chats and Source control, offer a
workspace. Other pages pick only the environment, and opening one clears the workspace you picked.
The environment stays selected as you move between pages or search for a setting.

Preferences saved on this device, such as appearance and confirmations, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a workspace to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a workspace override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a workspace are shown read-only
while a workspace is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a workspace's own override. When workspaces override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a workspace to jump to it, or **Reset all** to make those workspaces follow the environment
again.

Accounts and Diagnostics show one environment at a time, the primary one until you pick another.
Keybindings edit only the primary environment, whose shortcuts this app uses. Every other setting
fans out to the selection.

With a workspace selected, a provider's switch in **Settings → Accounts** turns it on or off for
that workspace only, in either direction: a provider off on the machine can be used in one workspace,
and one on everywhere can be kept out of another. That workspace's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the workspace to the
machine's setting. Every other provider setting stays per machine.

## Pin, archive, and remove workspaces

Pinned workspaces come first in the workspace pickers: the workspace picker on a new chat, the
**New chat in...** list, the command palette, and the sidebar workspace filter. When chats are
grouped by workspace, pinned workspaces get the top folders, even with no active threads. Pin or unpin
a workspace from its row in any of those lists, or press the thread pin shortcut (`mod+shift+p` by default) on the highlighted row. **Pin
workspace** in the command palette and **Settings → Workspaces** work too. A list keeps its order
while it is open, so a new pin moves up the next time you open it.

Archive a workspace you are done with in **Settings → Workspaces**. It leaves the workspace pickers.
Its threads, settings, and files stay as they are, and archived workspaces still show in the
Settings workspace list, marked **Archived**. Choose one there and select **Unarchive** to bring it
back.

A workspace on several machines must have every machine connected to pin or archive it.

Remove a workspace from its folder's right-click menu in the sidebar or from **Settings → Workspaces**.
Removing it deletes its threads from Codenine and leaves its folder on disk; **Delete workspace and
folder** also permanently deletes the folder, including uncommitted work, and the workspace's
Codenine worktrees on the machine that holds it.

## Worktree branch names

In **Settings → Worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `codenine/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a workspace
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Defaults and inheritance

Chats contains the model and workspace for new chats. Source control contains automatic pull
and text generation. The same rows edit environment defaults or workspace overrides depending on
the selected workspace.

The Workspaces category, under Code, holds the workspace's name, icon, actions,
checkouts and removal. Actions belong to a workspace: editing them creates the workspace's own list
on each selected environment, and reset returns to the environment's shared list. A workspace's
`codenine.json` actions can be imported there.

Settings a repository can also declare in `codenine.json`, such as the workspace for new threads,
resolve in one order: a workspace override, then the environment setting, then `codenine.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Worktrees** under Advanced (with the workspace
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `codenine.json` of the branch being checked out
applies when the workspace and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the Codenine home directory. To put them somewhere else,
such as another drive, set **Settings → Worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Fast worktree checkout on macOS

Fast worktree checkout is a beta. Turn it on for each Mac in **Settings → Labs → Fast worktree
checkout**. Codenine then keeps a few recent checkouts of each repository in the `caches` folder of
the Codenine home directory. A new worktree is cloned from one of them with APFS copy-on-write, which is
about twice as fast as writing every file and makes the first `git status` in it fast as well.
Turning it off deletes the cache.

The first worktree of a repository uses Git's normal checkout and fills the cache. It needs Git 2.42
or newer. Git's normal checkout is also used for worktrees on a different drive from the Codenine home
directory, sparse checkouts, repositories whose attributes use filters such as Git LFS, and
repositories whose checkout settings changed.

## Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a workspace to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that workspace's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected workspace or checkout. Log retention
remains machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread is marked done,
after merging, or when they have no commits beyond the default branch. Set **Delete worktrees of
done threads** to 0 days to remove a worktree at the next cleanup after its thread is marked done. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the workspace workspace;
if that checkout has a detached HEAD, the worktree is kept. Only Codenine-managed worktrees are eligible.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

Rotated logs have their own retention period. Current logs and message attachments are kept.

## Workspace icons

Select the workspace and open Workspace to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the workspace group and appears on connected clients. Choose **Automatic** to let
Codenine detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, Codenine shows a two-character monogram with a color
from the icon palette, derived from the saved workspace name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a workspace to override it.

Codenine only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
