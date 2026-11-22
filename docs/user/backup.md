# Backup and restore

A backup is one encrypted file that holds your chats, workspaces, accounts and settings. Use it to
recover from a problem, or to move Codenine to a new computer.

## Turn on backups

Open **Settings → Backup** and select **Turn on backups**. Setup asks three things:

1. **Where to keep backups.** Codenine suggests the synced cloud folders it finds, such as iCloud
   Drive or Dropbox, and preselects the one it recommends. **Another folder…** takes any path, such
   as an external drive. Pick somewhere that survives losing this computer.
2. **A backup password.** Every backup is encrypted with it.
3. **How often.** Every day or every week at 3:00 AM, or only when you ask.

**Turn on and back up now** saves your choices and makes the first backup.

When the server runs on another machine, choose that machine at the top of **Settings → Backup**.
Each machine keeps its own backups.

## Your backup password

You need the password to restore, and Codenine cannot recover it. Keep it in a password manager.
**Change password** under **Protection** sets the password for new backups; keep the old one for
backups made before the change.

## Back up and keep backups

**Back up now** makes a backup at any time. Automatic backups run at the time you chose, in the time
zone of the device you chose it on; pick the time again to move it to your current zone. If the
computer is asleep or off then, Codenine backs up as soon as it is back.

**Keep** sets how many automatic backups stay; older ones are deleted. Backups you make yourself
stay until you delete them from **Recent backups**, where you can also download or restore any
backup.

When the last backup failed, or automatic backups have not finished for 3 days, the chat shows a
notice and **Backup** is marked in Settings. **Try again** backs up right away.

## What a backup holds

- Chats, with their history and attachments
- Workspaces in your Codenine folder, without the files Git ignores, like `node_modules`
- Accounts you added in Codenine, and your saved keys
- Settings, skills, agents and workflows

Workspaces kept elsewhere on the computer are not included; they stay where they are. Neither
are Codenine's caches and downloads. Unfinished task copies (worktrees) are left out unless you
turn on **Also keep unfinished task copies**. Without them, an unfinished task restarts from its
branch and loses changes that were not committed.

On a Mac, Claude Code keeps its sign-in in the macOS Keychain, not in a file, so a backup cannot
hold it. Restoring on the same Mac keeps the sign-in; on another Mac, sign in to Claude again
after the restore.

## Restore a backup

Select **Restore…** in **Settings → Backup**, or **Restore** on a backup in **Recent backups**.

1. **Choose backup.** Codenine lists the backups in your backup folder and in the synced folders
   it finds. **Use another file…** takes a path.
2. **Unlock.** Enter the password the backup was made with.
3. **Review.** Check what comes back, then select **Restore and restart**.

Codenine saves what is on the computer first, then restores and restarts, which takes a minute
or two. If Codenine cannot restart itself, quit it and open it again to finish.

After the restart, **Restore complete** lists anything that needs you: accounts to sign in to,
workspaces whose folders were not in the backup, and devices to pair again. **Undo restore**
brings back what was on the computer before, for 7 days.

## Move to a new computer

1. On the old computer, select **Back up now**, then quit Codenine there. A ChatGPT sign-in only
   works on one computer at a time.
2. On the new computer, install Codenine and open it.
3. On the Welcome page, select **Restore from a backup**. Codenine looks in the synced folders it
   finds, so a backup in iCloud Drive or Dropbox shows up once that folder has synced.

A backup from another computer signs out the browsers and computers that connected to this one.
Pair them again from **Settings → Sharing & access**. If you restored from a browser, it is signed
out too and shows the pairing screen after the restart: run `codenine pair` on the computer and
open the link it prints.
