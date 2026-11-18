# Backup and restore

A backup is one encrypted file of a Codenine home, written by the
[backup service](../../apps/server/src/backup/BackupService.ts), the scheduler, or
`codenine backup`. A restore replaces the home's data with one and applies when the server next
starts. This page holds the constraints that span those pieces.

## File format

[`BackupFile.ts`](../../apps/server/src/backup/BackupFile.ts) owns the layout: an 8-byte magic, a
length, a JSON header anyone can read, then the payload. The header carries what a list shows
(when, which computer, which Codenine and schema version, what kind) and how to open the payload:
the scrypt cost and salt, the cipher, and a key check derived alongside the key, so a wrong
password fails before any payload is read and is never reported as damage.

The payload is a gzipped tar archive whose first entry is `manifest.json`, cut into 1 MiB chunks,
each sealed with AES-256-GCM.

- A chunk's nonce is its index plus a last-chunk flag, and every chunk authenticates the header
  bytes. Reordered chunks, a cut file and an edited header all fail to open.
- Every chunk but the last holds exactly the chunk size; the last holds less, possibly nothing.
  That is how a reader tells a file cut at a chunk boundary from a complete one. Keep it if the
  chunking changes.
- The counter nonce is safe only because every file gets a fresh salt and so a fresh key. Never
  write two files with one key.
- A reader follows the cost the header states, within bounds, so the cost can rise without a new
  format version. A newer `format`, in the header or the manifest, is refused as `newer-version`.

The tar writer and reader are [ours](../../apps/server/src/backup/tar.ts): the archive maps several
folders to one tree and adds the manifest and the database snapshot, and the reader must refuse
paths outside the tree. Paths that do not fit ustar go in pax headers, so `tar` can read a
decrypted payload.

## What a backup holds

The state folder minus logs, caches, runtime files and the backup's own state; `accounts/`,
`skills/`, `agents/`, `workflows/`, the workspace folders, and `worktrees/` when asked. In a Git
repository only what Git tracks or would track is copied, plus all of `.git`, so ignored build
output stays behind but every commit, stash and branch comes back. A symlink into the archive is
stored relative, so links like a Codex shadow home's links into its shared home work in a new
home; a symlink out of it is left out.

The database is never copied as a file. SQLite's online backup copies a consistent snapshot in one
step on a worker thread: a WAL read transaction sees one commit while the server keeps writing. A
stepped copy restarts whenever another connection writes between steps and may never finish
under a busy agent. Files are copied after the snapshot, so a backup can hold an attachment the
snapshot does not reference, which is harmless.

## Applying a restore at startup

A restore never touches live data while the server runs: services hold the database open and
cache what they read. It saves a safety backup of the current data into `restore-undo` (kept for
seven days, and skipped in a home with no database yet and when undoing a restore, which restores
that safety backup and is final), unpacks the backup into
`restore-staging`, verifying every chunk, and writes `restore-pending.json` last.
[`applyPendingRestore`](../../apps/server/src/backup/BackupRestore.ts) runs after the server takes
the ownership lock and before anything opens the database; `codenine restore` takes the same lock
and applies at once.

It renames each state-folder entry and each top-level folder aside into `restore-previous` and
renames the staged one in, after writing a journal of those moves. Only entries a backup holds
move. The ownership lock in the state folder must stay put: its watcher treats a moved lock file
as lost ownership. The database's `-wal` and `-shm` files move aside with no replacement, because
SQLite would replay an old WAL into the restored database. If any later step fails, the moves are
undone; if the process dies, the next start finds the journal and undoes them first.

A backup made by a newer schema is refused when inspected and again at startup, since a binary
can be downgraded between the two.

## A backup from another computer

A backup is from this computer when its environment id matches, or it is this home's own safety
backup. Otherwise the restore makes the home a new environment: a new environment id and signing
keys, no sessions, pairing links, peer links or Codenine Connect link, and no ChatGPT sessions,
since ChatGPT rotates refresh tokens and two computers sharing one would sign each other out. A
restore from this computer keeps the sessions and pairing links of the moment, so it neither signs
out devices paired since the backup nor revives ones revoked since.

Absolute paths that start with the old Codenine home, state folder or user home are rewritten,
longest prefix first, in every text column of the database, in `settings.json` and in Git
worktree links. Only whole values or whole JSON strings are rewritten, so a path quoted in a
message stays as written. Production never rebuilds projections from events, which are pruned
after a day, but the retained events get the same rewrite because reconnecting clients replay
them. Paths inside provider homes, such as Claude's per-project history folders, are not
rewritten, and a move between Windows and another system leaves mixed separators.

Every run in flight when the backup was made is dropped: provider session runtime, the effect
outbox and thread launch workflows are cleared, so nothing resumes against a stale session. The
password used to restore becomes the backup password, so it opens the safety backup and later
backups use it.

## Schedule

Automatic backups run in the server's local time. The next one is the first scheduled time after
the last automatic run, so times missed while the computer was off are owed once, and a failed
run retries within the hour. Pruning keeps `keep` automatic backups per computer, identified by a
hash of the environment id in the header, so a cloud folder shared by two computers keeps both
computers' backups.
