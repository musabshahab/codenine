# Architecture

Codenine keeps execution in the environment that owns the workspace. Web and desktop
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic out of the UI keeps reconnect and multi-environment behavior in one place.
See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Every protocol-2 environment advertises `threadPullRequests`. Once an environment's server config
has loaded, clients use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread
lookup. Before that, they hide linking actions.

Environments keep advertising `threadPullRequestLinking`, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field, because older clients still read them. That
hostless field includes only links in the thread project's own repository. Retain the legacy wire
fields, projection column, and replay support.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

Orchestration state is decided as events, and projections are the source of truth once they apply
them. The [v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

The event log only keeps what live readers need: about a day of history for reconnect replay and
command-id retries.
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
older events the projections cover, so projections cannot be rebuilt from the log. It keeps each
stream's newest event (high-water marks, stream versions, snapshot sequences), `thread.created`
(the legacy importer's marker), every `running` run update (Codex usage history reads the first
of each attempt), and prompt anchors that retained subagent rows reference. A client whose cursor
is below both its thread's newest event and the recorded pruned-through sequence missed pruned
events, so it resumes from a snapshot; an idle thread's cursor resumes without one. Resumes
recheck that sequence after reading the replay, since a pass can prune during the read. V2 command
receipts stay for idempotency: a retry older than the retained history is still deduplicated,
but its replay comes back without the pruned events. Receipts of imported legacy commands are
removed once their threads are imported.

Retained events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

A folder without Git has no refs, so its checkpoints stay `missing` and it cannot be reverted to
one. The [file version store](../../apps/server/src/fileVersions/FileVersions.ts) covers it instead:
checkpoint capture walks the folder before and after a turn, and a `missing` checkpoint then still
lists the files the turn changed. Clients read "the turn changed files" from that list and
"the workspace can roll back" from `ready`; keep the two apart. The store never records in a Git
checkout. Its walk attributes every difference since the last walk to the turn that ends, so with
several agents in one folder a change can land on another agent's turn. The walk before a turn
is skipped while another thread's turn runs in the folder, or it would take that turn's changes
from it. A file is called created by a turn only when the walk before, in the same server
process, would have seen it: one that walk could not read counts as an outside change.
Otherwise a review's Discard could delete a file the agent did not make.

Office documents are read and changed on the server by the
[Documents service](../../apps/server/src/documents/Documents.ts), so a client sends operations
and reads pages, never a whole file. Its writes go through the version store's save, which is
what makes them undoable in a folder without Git; never write a document around it. A workbook
is edited as its parts: only the parts an operation touches are rewritten, and the rest of the
archive is carried over untouched. No permissively licensed library does that. The ones that
exist rebuild the workbook from their own model and drop what the model lacks, such as charts
and pivot tables. The price is that an operation must itself move every reference it
invalidates, so one that would leave a part pointing at the wrong cells is refused with a typed
error instead of applied. A formula result the built-in evaluator cannot produce is cleared,
never left stale, and the workbook is marked for a full recalculation on its next open in a
spreadsheet app; results an edit does not reach are kept, since other readers have only them. Parsing runs on the server's own thread, which is why the size limits are low.

A PDF is the opposite case: it is loaded and written whole with a PDF library, because its
objects reference each other by number and there is no smaller unit to rewrite. That rewrite
changes every byte offset, which is why a file with a certificate signature is refused rather
than edited. Highlights, notes and form values stay standard annotations and fields. A signature
is drawn into the page's content instead, so no reader can move it, and the save is recorded in
the version store as signed. Only a person signs: the signing edit is a separate service method
whose single caller is the client RPC, and
[a test](../../apps/server/src/mcp/agentSigningGuard.test.ts) fails when anything else reaches
it. Give an agent the plain `editPdf`, never the signing one. The library unpacks object
streams whole and has no limit of its own, so the PDF code counts what its decoders grow to
against a budget for each parse and refuses a file that goes over it. Saving replaces the file, and an
asset URL is minted for one file as it was, so the client mints a new one after each save.

Agents reach the same service through the
[document tools](../../apps/server/src/mcp/toolkits/documents/tools.ts), never a second write
path. A tool call made during a turn passes `duringTurn`, and the version store then records
nothing for the write itself: the walk that ends the turn finds the file changed and records it
as that turn's change, exactly as for a file the agent changed from its shell. Recording the
write as a save would hide it from the turn, and with it the review and Discard. A deck is
edited like a workbook, part by part in its Open XML package, and no client edits one. Both
adapters turn the edit tools off for an agent without `editFiles`, because neither provider's
own sandbox covers a tool that runs in the server. For the same reason the tools refuse an edit
in an `approval-required` chat: the providers pre-approve Codenine's tools, so no approval card
would cover the write. A document that is not text has no line
review: its turn baseline answers `wholeFileOnly`, from the version store or, in a Git
checkout, from the turn's first checkpoint, and Discard puts those bytes back.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside Codenine, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. The GitHub
definition names its CLI's commands in `changeRequestCloseCommand`. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable sorting and detaches idle provider
sessions. Clients render the persisted result; they do not derive settlement from their own clocks
or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path: `@crowecawcaw/xa11y`
runs only in a worker thread (`WindowsForegroundFocusWorker`), and `ffi-rs` loads lazily inside
`WindowsForeground.ts` for a handful of Win32 calls. A crash or stall in either must not take the
app down, so new native capability goes in a child with a deadline, not an `import` in main.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
