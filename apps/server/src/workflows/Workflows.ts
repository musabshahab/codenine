import {
  type AgentModel,
  CommandId,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerProvider,
  type TeamPlan,
  type TeamPlanHoldReason,
  type TeamPlanRun,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowDraftRef,
  WorkflowError,
  WorkflowId,
  type WorkflowInput,
  WorkflowName,
  type WorkflowProblem,
  type WorkflowRunInput,
  type WorkflowRunStarted,
  type WorkflowRunTrigger,
  type WorkflowSaveInput,
  type WorkflowSetEnabledInput,
  type WorkflowsListResult,
  type WorkflowSummary,
} from "@codenine/contracts";
import { randomUuidV4 } from "@codenine/provider-core/server/randomUuid";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A plain sync hash names a report; nothing here needs Effect's Digest service.
import * as NodeCrypto from "node:crypto";
import { writeFileStringAtomically } from "@codenine/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Agents from "../agents/Agents.ts";
import * as ServerConfig from "../config.ts";
import { workflowRunItemId } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { teamTaskThreadId } from "../orchestration-v2/TeamPlan.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as UsageService from "../usage/UsageService.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import {
  appendNote,
  NOTES_FILE,
  parseWorkflowFile,
  parseWorkflowState,
  renderWorkflowFile,
  renderWorkflowState,
  STATE_FILE,
  trimNotes,
  WORKFLOW_FILE,
  workflowDefinitionIssue,
  WORKFLOWS_FOLDER,
  type WorkflowState,
  EMPTY_WORKFLOW_STATE,
} from "./WorkflowFile.ts";
import {
  capRunResult,
  noteLine,
  reachedLimit,
  runResult,
  staleReview,
  turnUsage,
  type WorkflowAgent,
  workflowModelSelection,
  workflowProblems,
  workflowRunBrief,
  workflowRunThreadId,
  workflowTeam,
} from "./WorkflowPlan.ts";
import { advanceSchedule, nextOccurrence, scheduleZone, withSkipped } from "./WorkflowSchedule.ts";

const WORKFLOW_FILE_MAX_BYTES = 1024 * 1024;
const STATE_FILE_MAX_BYTES = 256 * 1024;
const NOTES_FILE_MAX_BYTES = 256 * 1024;
/** The newest runs of a workflow the server still watches: for one running, or a note to keep. */
const WATCHED_RUNS = 10;
// Prices change slowly against a limit set in dollars; a run is priced at most this often.
const COST_CHECK_MS = 30_000;
// An ended run gets a note only from its lead's last turn, so it is looked at less often.
const ENDED_RUN_CHECK_MS = 60_000;
const LIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;

const chatIsBusy = (chat: OrchestrationV2ThreadShell) =>
  chat.activeRunId !== null || (LIVE_RUN_STATUSES as ReadonlyArray<string>).includes(chat.status);

const isWorkflowName = Schema.is(WorkflowName);

type WorkflowRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "broken"; readonly folder: string; readonly id: WorkflowId | undefined }
  | {
      readonly _tag: "found";
      readonly folder: string;
      readonly id: WorkflowId;
      readonly workflow: WorkflowDefinition;
      readonly updatedAt: string;
    };
type FoundWorkflow = Extract<WorkflowRead, { readonly _tag: "found" }>;

interface ProblemContext {
  readonly agents: ReadonlyMap<string, WorkflowAgent>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projects: ReadonlySet<ProjectId>;
}

interface RunStart {
  readonly trigger: WorkflowRunTrigger;
  readonly scheduledFor: string | null;
  readonly inputs: ReadonlyArray<WorkflowInput>;
}

export class Workflows extends Context.Service<
  Workflows,
  {
    /** By title. A workflow whose workflow.json cannot be read is logged and left out. */
    readonly list: Effect.Effect<typeof WorkflowsListResult.Type, WorkflowError>;
    readonly read: (input: {
      readonly name: WorkflowName;
    }) => Effect.Effect<WorkflowDetail, WorkflowError>;
    /** Without `previousName` creates a workflow; with it, edits or renames that one, keeping its id. */
    readonly save: (input: WorkflowSaveInput) => Effect.Effect<WorkflowDetail, WorkflowError>;
    readonly remove: (input: { readonly name: WorkflowName }) => Effect.Effect<void, WorkflowError>;
    /** Starts a run now, whether or not the workflow is on; refused while it has problems. */
    readonly run: (input: WorkflowRunInput) => Effect.Effect<WorkflowRunStarted, WorkflowError>;
    /** Turns scheduled runs on or off, leaving the rest of the file as it is. */
    readonly setEnabled: (
      input: WorkflowSetEnabledInput,
    ) => Effect.Effect<WorkflowDetail, WorkflowError>;
    /** Queues the scheduled runs now due and starts the next queued one; the scheduler calls it. */
    readonly runDue: Effect.Effect<void>;
    /** Prices runs in progress, holds those at a limit, and keeps each ended run's note. */
    readonly superviseRuns: Effect.Effect<void>;
  }
>()("codenine/workflows/Workflows") {}

/** Logs what went wrong and tells the user only what failed. */
const failed = (detail: string) => (cause: unknown) =>
  Effect.logWarning(detail, { cause }).pipe(
    Effect.andThen(Effect.fail(new WorkflowError({ reason: "failed", detail }))),
  );

const notFound = (name: string) =>
  new WorkflowError({ reason: "not-found", detail: `There is no workflow named ${name}.` });

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const stampOf = (info: FileSystem.File.Info) =>
  `${Option.getOrElse(info.ino, () => 0n)}:${Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (mtime) => mtime.getTime(),
  })}:${info.size}`;

const cannotRunDetail = (problems: ReadonlyArray<WorkflowProblem>) =>
  problems.length === 0
    ? "This workflow cannot run yet."
    : `This workflow cannot run yet. ${problems.map((problem) => problem.message).join(" ")}`;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const agents = yield* Agents.Agents;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const usage = yield* UsageService.UsageService;
  const scheduler = yield* Scheduler.Scheduler;
  const root = path.join(baseDir, WORKFLOWS_FOLDER);
  const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const writeFile = (filePath: string, contents: string) =>
    withFileSystem(writeFileStringAtomically({ filePath, contents }));

  // The scheduler reads every workflow's files every few seconds; unchanged ones come from here.
  const workflowCache = new Map<string, { readonly stamp: string; readonly read: WorkflowRead }>();
  const stateCache = new Map<string, { readonly stamp: string; readonly state: WorkflowState }>();
  // Untraced: the scheduler reads it for every workflow on every tick.
  const readState = Effect.fnUntraced(function* (folder: string) {
    const file = path.join(folder, STATE_FILE);
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      stateCache.delete(file);
      return EMPTY_WORKFLOW_STATE;
    }
    const stamp = stampOf(info.value);
    const cached = stateCache.get(file);
    if (cached?.stamp === stamp) return cached.state;
    const contents =
      Number(info.value.size) > STATE_FILE_MAX_BYTES
        ? Option.none<string>()
        : yield* fileSystem.readFileString(file).pipe(Effect.option);
    const state = Option.match(contents, {
      onNone: () => EMPTY_WORKFLOW_STATE,
      onSome: parseWorkflowState,
    });
    stateCache.set(file, { stamp, state });
    return state;
  });

  // Untraced: both scheduler sources call it for every workflow on every tick.
  const readWorkflow = Effect.fnUntraced(function* (
    name: WorkflowName,
  ): Effect.fn.Return<WorkflowRead> {
    const folder = path.join(root, name);
    const file = path.join(folder, WORKFLOW_FILE);
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") {
      workflowCache.delete(file);
      // A folder that lost only its workflow.json still has the runs state.json names.
      const id = (yield* readState(folder)).workflowId;
      return id === undefined ? { _tag: "missing" } : { _tag: "broken", folder, id };
    }
    const stamp = stampOf(info.value);
    const cached = workflowCache.get(file);
    if (cached?.stamp === stamp) return cached.read;
    const contents =
      Number(info.value.size) > WORKFLOW_FILE_MAX_BYTES
        ? Option.none<string>()
        : yield* fileSystem.readFileString(file).pipe(Effect.option);
    const parsed = Option.isNone(contents) ? undefined : parseWorkflowFile(name, contents.value);
    let read: WorkflowRead;
    if (parsed?._tag === "found") {
      read = {
        _tag: "found",
        folder,
        id: parsed.id,
        workflow: parsed.workflow,
        updatedAt: DateTime.formatIso(
          Option.match(info.value.mtime, {
            onNone: () => DateTime.makeUnsafe(0),
            onSome: DateTime.fromDateUnsafe,
          }),
        ),
      };
    } else {
      yield* Effect.logWarning("Codenine could not read a workflow's workflow.json.", {
        folder,
        issue: parsed?.issue ?? "The file is too large or unreadable.",
      });
      read = {
        _tag: "broken",
        folder,
        id: parsed?.id ?? (yield* readState(folder)).workflowId,
      };
    }
    workflowCache.set(file, { stamp, read });
    return read;
  });

  const writeState = (folder: string, state: WorkflowState) => {
    const file = path.join(folder, STATE_FILE);
    return writeFile(file, renderWorkflowState(state)).pipe(
      Effect.ensuring(Effect.sync(() => stateCache.delete(file))),
    );
  };

  const readNotes = Effect.fn("Workflows.readNotes")(function* (folder: string) {
    const file = path.join(folder, NOTES_FILE);
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || Number(info.value.size) > NOTES_FILE_MAX_BYTES) return "";
    return trimNotes(yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => "")));
  });

  const listRead = Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectoryEntries(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
    const names = entries
      .filter((entry) => entry.type !== "File")
      .map((entry) => entry.name)
      .filter(isWorkflowName);
    return yield* Effect.forEach(
      names,
      (name) => readWorkflow(name).pipe(Effect.map((read) => ({ name, read }))),
      { concurrency: 8 },
    );
  });

  const listFound = listRead.pipe(
    Effect.map((entries) => entries.flatMap(({ read }) => (read._tag === "found" ? [read] : []))),
  );

  const keyedLock = <K>() => {
    const locks = new Map<K, Semaphore.Semaphore>();
    return <A, E, R>(key: K, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock.withPermit(effect);
      });
  };
  const withLock = keyedLock<WorkflowId>();
  // A create from a chat checks the chat's link and then writes it; two at once would both pass.
  const withDraftLock = keyedLock<ThreadId>();

  /**
   * Runs `f` holding the workflow's lock, on the workflow as it is then. None when it was
   * renamed or deleted meanwhile; a write to its old folder would bring the folder back.
   */
  const whileLocked = <A, E, R>(
    name: WorkflowName,
    id: WorkflowId,
    f: (found: FoundWorkflow) => Effect.Effect<A, E, R>,
  ) =>
    withLock(
      id,
      readWorkflow(name).pipe(
        Effect.flatMap((read) =>
          read._tag === "found" && read.id === id
            ? f(read).pipe(Effect.asSome)
            : Effect.succeedNone,
        ),
      ),
    );

  const readOrFail = Effect.fn("Workflows.readOrFail")(function* (name: WorkflowName) {
    const read = yield* readWorkflow(name);
    switch (read._tag) {
      case "missing":
        return yield* notFound(name);
      case "broken":
        return yield* new WorkflowError({
          reason: "invalid",
          detail: `Codenine cannot read ${path.join(read.folder, WORKFLOW_FILE)}. Fix it, or delete the workflow.`,
        });
      case "found":
        return read;
    }
  });

  const problemContext = Effect.fn("Workflows.problemContext")(function* (
    workflows: ReadonlyArray<WorkflowDefinition>,
  ) {
    const projectIds = [...new Set(workflows.flatMap((workflow) => workflow.lead.projectId ?? []))];
    const listed = yield* agents.list.pipe(
      Effect.catchTags({ AgentError: failed("Could not read your agents.") }),
    );
    const rows: ReadonlyArray<ProjectStore.ProjectRow> =
      projectIds.length === 0
        ? []
        : yield* projects
            .list({ projectIds })
            .pipe(Effect.catch(failed("Could not read your workspaces.")));
    return {
      agents: new Map(listed.agents.map((agent) => [agent.name, agent])),
      providers: yield* providers.getProviders,
      projects: new Set(rows.map((row) => row.projectId)),
    } satisfies ProblemContext;
  });

  const problemsOf = (workflow: WorkflowDefinition, context: ProblemContext) =>
    workflowProblems({
      workflow,
      agents: context.agents,
      providers: context.providers,
      projectExists:
        workflow.lead.projectId !== null && context.projects.has(workflow.lead.projectId),
    });

  const fileFields = (
    found: FoundWorkflow,
    state: WorkflowState,
    context: ProblemContext,
    nowMs: number,
  ) => {
    const { enabled, trigger } = found.workflow;
    const next =
      enabled && trigger.schedule !== null ? nextOccurrence(trigger.schedule, nowMs) : null;
    return {
      id: found.id,
      path: found.folder,
      updatedAt: found.updatedAt,
      problems: problemsOf(found.workflow, context),
      nextRunAt: next === null ? null : iso(next),
      skipped: state.skipped,
    };
  };

  const toSummary = (
    found: FoundWorkflow,
    state: WorkflowState,
    context: ProblemContext,
    nowMs: number,
  ): WorkflowSummary => {
    const { workflow } = found;
    return {
      name: workflow.name,
      title: workflow.title,
      description: workflow.description,
      enabled: workflow.enabled,
      trigger: workflow.trigger,
      leadModel: workflow.lead.model,
      leadModelStatus: Agents.agentModelStatus(workflow.lead.model, context.providers),
      projectId: workflow.lead.projectId,
      steps: workflow.steps.map(
        ({ instructions: _instructions, doneWhen: _doneWhen, suggestion: _suggestion, ...step }) =>
          step,
      ),
      ...fileFields(found, state, context, nowMs),
    };
  };

  const list: Workflows["Service"]["list"] = Effect.gen(function* () {
    const found = yield* listFound;
    const context = yield* problemContext(found.map((entry) => entry.workflow));
    const nowMs = yield* Clock.currentTimeMillis;
    const workflows = yield* Effect.forEach(found, (entry) =>
      readState(entry.folder).pipe(Effect.map((state) => toSummary(entry, state, context, nowMs))),
    );
    return {
      workflows: workflows.sort(
        (left, right) =>
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
          left.name.localeCompare(right.name),
      ),
    };
  }).pipe(Effect.withSpan("Workflows.list"));

  const read: Workflows["Service"]["read"] = Effect.fn("Workflows.read")(function* (input) {
    const found = yield* readOrFail(input.name);
    const [context, state, notes] = yield* Effect.all([
      problemContext([found.workflow]),
      readState(found.folder),
      readNotes(found.folder),
    ]);
    return {
      ...found.workflow,
      ...fileFields(found, state, context, yield* Clock.currentTimeMillis),
      notes,
    };
  });

  const occupied = (target: string) =>
    fileSystem.lstat(target).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.catchTags({ PlatformError: failed("Could not check the workflows folder.") }),
    );

  const refuseSecondCopy = Effect.fn("Workflows.refuseSecondCopy")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThread(threadId).pipe(Effect.orElseSucceed(() => null));
    const link = thread?.savedWorkflow ?? null;
    if (link === null) return;
    const existing = (yield* listFound).find((entry) => entry.id === link.id);
    if (existing === undefined) return;
    return yield* new WorkflowError({
      reason: "exists",
      detail: `This chat's draft is already saved as ${existing.workflow.title}. Open it from the chat's Workflow tab.`,
    });
  });

  // Fresh ids: a receipt replays by command id alone, and a refused command stays refused.
  const linkDraft = Effect.fn("Workflows.linkDraft")(function* (
    fromDraft: WorkflowDraftRef,
    workflowId: WorkflowId,
  ) {
    yield* threads
      .dispatch({
        type: "workflow.draft.saved",
        commandId: CommandId.make(`server:workflow-saved:${yield* randomUuidV4}`),
        threadId: fromDraft.threadId,
        workflowId,
        proposedAt: fromDraft.proposedAt,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Codenine could not link a saved workflow to its chat.", {
            threadId: fromDraft.threadId,
            cause,
          }),
        ),
      );
  });

  const save: Workflows["Service"]["save"] = Effect.fn("Workflows.save")(function* (input) {
    const { workflow, previousName, fromDraft } = input;
    const issue = workflowDefinitionIssue(workflow);
    if (issue !== null) return yield* new WorkflowError({ reason: "invalid", detail: issue });
    const target = path.join(root, workflow.name);
    const couldNotSave = failed("Could not save the workflow.");
    const taken = new WorkflowError({
      reason: "exists",
      detail: `A workflow named ${workflow.name} already exists.`,
    });
    const writeNotes = (folder: string) =>
      input.notes === undefined
        ? Effect.void
        : writeFile(path.join(folder, NOTES_FILE), input.notes);
    yield* fileSystem
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotSave }));
    if (previousName === undefined) {
      const create = Effect.gen(function* () {
        if (fromDraft !== undefined) yield* refuseSecondCopy(fromDraft.threadId);
        const id = WorkflowId.make(yield* randomUuidV4);
        // Claiming the folder first means two creates of one name cannot both write it.
        yield* fileSystem.makeDirectory(target).pipe(
          Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.fail(taken)),
          Effect.catchTags({ PlatformError: couldNotSave }),
        );
        yield* writeFile(path.join(target, WORKFLOW_FILE), renderWorkflowFile(id, workflow)).pipe(
          Effect.andThen(writeNotes(target)),
          Effect.catchTags({ PlatformError: couldNotSave }),
          Effect.tapError(() => fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore)),
        );
        // Linked before the read, so a failed read cannot leave the saved draft offered again.
        if (fromDraft !== undefined) yield* linkDraft(fromDraft, id);
        return yield* read({ name: workflow.name });
      });
      return yield* fromDraft === undefined ? create : withDraftLock(fromDraft.threadId, create);
    }
    const previous = yield* readWorkflow(previousName);
    if (previous._tag === "missing") return yield* notFound(previousName);
    // A file this version cannot read keeps the id it names, so its runs stay its own.
    const id = previous.id ?? WorkflowId.make(yield* randomUuidV4);
    yield* withLock(
      id,
      Effect.gen(function* () {
        if (previousName !== workflow.name) {
          if (yield* occupied(target)) return yield* taken;
          yield* fileSystem
            .rename(path.join(root, previousName), target)
            .pipe(Effect.catchTags({ PlatformError: couldNotSave }));
        }
        const file = path.join(target, WORKFLOW_FILE);
        const existing = yield* fileSystem.readFileString(file).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
          Effect.catchTags({ PlatformError: couldNotSave }),
        );
        yield* writeFile(file, renderWorkflowFile(id, workflow, existing)).pipe(
          Effect.andThen(writeNotes(target)),
          Effect.catchTags({ PlatformError: couldNotSave }),
        );
      }),
    );
    if (fromDraft !== undefined) yield* linkDraft(fromDraft, id);
    return yield* read({ name: workflow.name });
  });

  const setEnabled: Workflows["Service"]["setEnabled"] = Effect.fn("Workflows.setEnabled")(
    function* ({ name, enabled }) {
      const current = yield* readWorkflow(name);
      if (current._tag === "missing") return yield* notFound(name);
      if (current._tag === "broken") {
        return yield* new WorkflowError({
          reason: "invalid",
          detail: "This workflow's file can't be read, so it can't be turned on or off.",
        });
      }
      const written = yield* whileLocked(name, current.id, (found) =>
        Effect.gen(function* () {
          if (found.workflow.enabled === enabled) return;
          const file = path.join(found.folder, WORKFLOW_FILE);
          const existing = yield* fileSystem.readFileString(file);
          yield* writeFile(
            file,
            renderWorkflowFile(found.id, { ...found.workflow, enabled }, existing),
          );
        }).pipe(Effect.catchTags({ PlatformError: failed("Could not save the workflow.") })),
      );
      if (Option.isNone(written)) return yield* notFound(name);
      return yield* read({ name });
    },
  );

  // Runs are found through the workflow's folder, so one left running would go on unwatched.
  const cancelLiveRuns = Effect.fn("Workflows.cancelLiveRuns")(function* (
    id: WorkflowId,
    folder: string,
  ) {
    const couldNotStop = failed("Could not stop the workflow's runs, so it was not deleted.");
    const { runs } = yield* readState(folder);
    for (let run = runs; run > Math.max(0, runs - WATCHED_RUNS); run -= 1) {
      const threadId = workflowRunThreadId(id, run);
      const shell = yield* projections.getThreadShell(threadId).pipe(Effect.catch(couldNotStop));
      if (shell?.deletedAt !== null || shell.teamSummary?.status !== "running") continue;
      yield* threads
        .dispatch({
          type: "team.cancel",
          commandId: CommandId.make(`server:workflow-removed:${id}:${run}`),
          threadId,
        })
        .pipe(
          // Refused before means the run had already ended.
          Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
          Effect.catch(couldNotStop),
        );
    }
  });

  const leadIsIdle = Effect.fn("Workflows.leadIsIdle")(function* (threadId: ThreadId) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
      runStatuses: LIVE_RUN_STATUSES,
    });
    return runs.every((run) => run.status === "queued" && run.queueHeld === true);
  });

  /**
   * Posts an ended run's result to its workflow's chat and marks its lead read, since the chat is
   * where the result is seen. Ids follow what is reported, so a repeat after a restart is a no-op.
   * False, having done nothing, while the chat has a turn going: a card would land inside it.
   */
  const reportRun = Effect.fn("Workflows.reportRun")(function* (
    lead: OrchestrationV2AppThread,
    shell: OrchestrationV2ThreadShell,
    options: {
      /** Whether the lead's last turn has ended, so its last message is final and it can be read. */
      readonly leadIdle: boolean;
      readonly waitForIdleChat: boolean;
    },
  ) {
    const plan = lead.team;
    const chatThreadId = plan?.run?.chatThreadId;
    if (plan == null || plan.run === undefined || chatThreadId === undefined) return true;
    const { status } = plan;
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return true;
    const { workflowId, run, title, headline } = plan.run;
    const chat = yield* projections.getThreadShell(chatThreadId);
    if (chat === null || chat.deletedAt !== null) {
      yield* Effect.logInfo("A workflow run's chat is gone, so its result was not posted.", {
        chatThreadId,
      });
    } else {
      if (options.waitForIdleChat && chatIsBusy(chat)) return false;
      let result = runResult(plan);
      if (result === null) {
        const card = yield* projections.getTurnItem({
          threadId: chatThreadId,
          itemId: workflowRunItemId(workflowId, run),
        });
        // The lead's latest message moves on when the user talks to it; the posted one stays.
        if (card?.type === "workflow_run" && card.status === status) result = card.result;
        else if (options.leadIdle && shell.latestRunId !== null) {
          const { messages } = yield* projections.getThreadRecords(lead.id, ["messages"], {
            messageRoles: ["assistant"],
            messageRunIds: [shell.latestRunId],
          });
          result = messages.findLast((message) => message.text.trim() !== "")?.text ?? null;
        }
      }
      result = result === null ? null : capRunResult(result);
      const hash = NodeCrypto.createHash("sha256")
        .update(`${status}\0${headline ?? ""}\0${result ?? ""}`)
        .digest("hex")
        .slice(0, 16);
      const commandId = `server:workflow-report:${workflowId}:${run}:${chatThreadId}:${hash}`;
      const report = (id: string) =>
        threads.dispatch({
          type: "workflow.run.report",
          commandId: CommandId.make(id),
          threadId: chatThreadId,
          workflowId,
          run,
          title,
          leadThreadId: lead.id,
          status,
          headline,
          result,
        });
      yield* report(commandId).pipe(
        // The chat is live, so that refusal was a failure on the way; an identical card is a no-op.
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () =>
            Effect.flatMap(randomUuidV4, (uuid) => report(`${commandId}:retry:${uuid}`)),
        }),
      );
    }
    if (!options.leadIdle) return true;
    yield* threads
      .dispatch({
        type: "thread.visit",
        commandId: CommandId.make(
          `server:workflow-run-read:${lead.id}:${DateTime.formatIso(shell.updatedAt)}`,
        ),
        threadId: lead.id,
        visitedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.ignore);
    return true;
  });

  // Once the folder is gone its runs are no longer supervised, so their results are posted now,
  // even into a chat mid-turn, and a lead mid-turn is left unread.
  const reportUnwatchedRuns = Effect.fn("Workflows.reportUnwatchedRuns")(function* (
    id: WorkflowId,
    folder: string,
  ) {
    const { runs, noted } = yield* readState(folder);
    for (let run = runs; run > Math.max(0, runs - WATCHED_RUNS); run -= 1) {
      if (noted.includes(run)) continue;
      const threadId = workflowRunThreadId(id, run);
      yield* Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return;
        yield* reportRun(yield* projections.getThread(threadId), shell, {
          leadIdle: yield* leadIsIdle(threadId),
          waitForIdleChat: false,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not post a deleted workflow's run result.", {
            threadId,
            cause,
          }),
        ),
      );
    }
  });

  const remove: Workflows["Service"]["remove"] = Effect.fn("Workflows.remove")(function* (input) {
    const target = path.join(root, input.name);
    const couldNotDelete = failed("Could not delete the workflow.");
    const info = yield* fileSystem.lstat(target).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(notFound(input.name))),
      Effect.catchTags({ PlatformError: couldNotDelete }),
    );
    const removeFolder = Effect.gen(function* () {
      // A linked workflow folder loses only its link; what it points at is someone else's.
      if (info.type === "SymbolicLink") {
        return yield* fileSystem
          .remove(target)
          .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
      }
      const [realRoot, realTarget] = yield* Effect.all([
        fileSystem.realPath(root),
        fileSystem.realPath(target),
      ]).pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
      if (realTarget === realRoot || !isWithinRoot(path, realTarget, realRoot)) {
        return yield* new WorkflowError({
          reason: "invalid",
          detail: "That folder is outside the workflows folder.",
        });
      }
      yield* fileSystem
        .remove(target, { recursive: true })
        .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    });
    const current = yield* readWorkflow(input.name);
    const id = current._tag === "missing" ? undefined : current.id;
    // A state write in progress finishes first, so it cannot bring the folder back.
    yield* id === undefined
      ? removeFolder
      : withLock(
          id,
          cancelLiveRuns(id, target).pipe(
            Effect.andThen(reportUnwatchedRuns(id, target)),
            Effect.andThen(removeFolder),
          ),
        );
  });

  /**
   * The chat run `run` of `found` reports to: the one state.json names while it is not deleted,
   * else the chat it was saved from, else the previous run's, else a new one. Null when none can
   * be had; the run still starts.
   */
  const resolveChat = Effect.fn("Workflows.resolveChat")(
    function* (
      found: FoundWorkflow,
      lead: { readonly model: AgentModel; readonly projectId: ProjectId },
      providerList: ReadonlyArray<ServerProvider>,
      run: number,
    ) {
      const { id, workflow } = found;
      const liveChat = (threadId: ThreadId | null | undefined) =>
        threadId == null
          ? Effect.succeed(null)
          : projections
              .getThreadShell(threadId)
              .pipe(Effect.map((shell) => (shell?.deletedAt === null ? threadId : null)));
      const stored = (yield* readState(found.folder)).chatThreadId ?? null;
      // The previous run still names a chat whose link or state write failed after it was made.
      const previousRunChat = projections
        .getThreadShell(workflowRunThreadId(id, run - 1))
        .pipe(Effect.flatMap((shell) => liveChat(shell?.teamSummary?.run?.chatThreadId)));
      let chatThreadId =
        (yield* liveChat(stored)) ??
        (yield* projections.findThreadBySavedWorkflow(id)) ??
        (yield* previousRunChat);
      if (chatThreadId === null) {
        const launched = yield* launches.launch({
          commandId: CommandId.make(`server:workflow-chat:${id}:${yield* randomUuidV4}`),
          projectId: lead.projectId,
          title: workflow.title,
          modelSelection: workflowModelSelection(lead.model, providerList),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "default",
          createdBy: "system",
          creationSource: "server",
          workspaceStrategy: { type: "root" },
        });
        chatThreadId = launched.threadId;
        yield* threads
          .dispatch({
            type: "workflow.draft.saved",
            commandId: CommandId.make(`server:workflow-chat-link:${id}:${yield* randomUuidV4}`),
            threadId: chatThreadId,
            workflowId: id,
            proposedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("A workflow's new chat could not be linked to it.", {
                workflowId: id,
                chatThreadId,
                cause,
              }),
            ),
          );
      }
      if (chatThreadId !== stored) {
        const chosen = chatThreadId;
        yield* readState(found.folder).pipe(
          Effect.flatMap((fresh) => writeState(found.folder, { ...fresh, chatThreadId: chosen })),
          Effect.catch((cause) =>
            Effect.logWarning("Could not save which chat a workflow reports to.", {
              workflowId: id,
              chatThreadId: chosen,
              cause,
            }),
          ),
        );
      }
      return chatThreadId;
    },
    (effect, found) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("A workflow run starts without a chat to report to.", {
            workflowId: found.id,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
  );

  /** Starts a run of `found`, whose lock the caller holds. */
  const startRun = Effect.fn("Workflows.startRun")(function* (
    found: FoundWorkflow,
    start: RunStart,
  ) {
    const { workflow, id } = found;
    const context = yield* problemContext([workflow]);
    const problems = problemsOf(workflow, context);
    const team = workflowTeam({
      workflow,
      agents: context.agents,
      providers: context.providers,
    });
    const { model, projectId } = workflow.lead;
    if (problems.length > 0 || team === null || model === null || projectId === null) {
      return yield* new WorkflowError({ reason: "cannot-run", detail: cannotRunDetail(problems) });
    }
    const state = yield* readState(found.folder);
    let run = state.runs + 1;
    // A lost or older state.json must not hand out a number whose lead thread exists.
    while (
      (yield* projections
        .getThreadShell(workflowRunThreadId(id, run))
        .pipe(Effect.catch(failed("Could not start the run.")))) !== null
    ) {
      run += 1;
    }
    yield* writeState(found.folder, { ...state, runs: run, workflowId: id }).pipe(
      Effect.catchTags({ PlatformError: failed("Could not save the workflow's run count.") }),
    );
    const chatThreadId = yield* resolveChat(found, { model, projectId }, context.providers, run);
    const threadId = workflowRunThreadId(id, run);
    const couldNotStart = (cause: unknown) =>
      Effect.logWarning("A workflow run could not start.", { workflowId: id, run, cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new WorkflowError({
              reason: "failed",
              detail: `Run ${run} could not start: ${userFacingDispatchErrorMessage(cause) ?? "its lead could not be launched."}`,
            }),
          ),
        ),
      );
    const brief = workflowRunBrief({
      workflow,
      run,
      inputs: start.inputs,
      notes: yield* readNotes(found.folder),
      agents: context.agents,
    });
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const lead = {
      threadId,
      projectId,
      title: `${workflow.title} · run ${run}`,
      modelSelection: workflowModelSelection(model, context.providers),
      // Steps take the lead's mode as their ceiling, so this is what they may do unasked.
      runtimeMode: workflow.lead.approvals === "review" ? "auto" : DEFAULT_RUNTIME_MODE,
      interactionMode: "default",
      createdBy: "system",
      creationSource: "server",
    } as const;
    // Only the steps' agents reach the user's apps. The lead's empty connectors and skills are
    // set before its first message, so no turn of it starts with a chat's defaults.
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:workflow-lead:${id}:${run}`),
        ...lead,
        branch: null,
        worktreePath: null,
      })
      .pipe(
        Effect.andThen(
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:workflow-lead:${id}:${run}:reach`),
            threadId,
            connectors: [],
            skills: [],
          }),
        ),
        Effect.andThen(
          launches.launch({
            ...lead,
            commandId: CommandId.make(`server:workflow-launch:${id}:${run}`),
            reuseExistingThread: true,
            workspaceStrategy: { type: "root" },
            initialMessage: { text: brief, attachments: [] },
          }),
        ),
        Effect.catch(couldNotStart),
      );
    yield* threads
      .dispatch({
        type: "team.start",
        commandId: CommandId.make(`server:workflow-start:${id}:${run}`),
        threadId,
        goal: workflow.lead.goal.trim(),
        agents: team.agents,
        tasks: team.tasks,
        run: {
          workflowId: id,
          workflowName: workflow.name,
          title: workflow.title,
          run,
          trigger: start.trigger,
          scheduledFor: start.scheduledFor,
          inputs: start.inputs,
          approvals: workflow.lead.approvals,
          limits: workflow.lead.limits,
          startedAt,
          costUsd: null,
          headline: null,
          note: null,
          ...(chatThreadId === null ? {} : { chatThreadId }),
        },
      })
      .pipe(Effect.catch(couldNotStart));
    return { threadId, run };
  });

  const run: Workflows["Service"]["run"] = Effect.fn("Workflows.run")(function* (input) {
    const found = yield* readOrFail(input.name);
    const started = yield* whileLocked(input.name, found.id, (current) =>
      startRun(current, {
        trigger: "manual",
        scheduledFor: null,
        inputs: input.inputs ?? current.workflow.inputs,
      }),
    );
    if (Option.isNone(started)) return yield* notFound(input.name);
    return started.value;
  });

  // Untraced, like the scheduling below it: it runs for each workflow on every tick.
  const hasLiveRun = Effect.fnUntraced(function* (id: WorkflowId, runs: number) {
    for (let run = runs; run > Math.max(0, runs - WATCHED_RUNS); run -= 1) {
      const shell = yield* projections.getThreadShell(workflowRunThreadId(id, run));
      if (shell?.deletedAt === null && shell.teamSummary?.status === "running") return true;
    }
    return false;
  });

  /** Brings one workflow's schedule up to now and starts its next queued run when none runs. */
  const advance = Effect.fnUntraced(function* (found: FoundWorkflow) {
    const nowMs = yield* Clock.currentTimeMillis;
    const before = yield* readState(found.folder);
    const state = advanceSchedule(before, {
      enabled: found.workflow.enabled,
      trigger: found.workflow.trigger,
      nowMs,
    });
    const [head, ...rest] = state.queue;
    if (head === undefined || (yield* hasLiveRun(found.id, state.runs))) {
      if (state !== before) yield* writeState(found.folder, state);
      return;
    }
    // Taken off the queue before it starts: a crash loses this run rather than starting it twice.
    yield* writeState(found.folder, { ...state, queue: rest });
    const started = yield* startRun(found, {
      trigger: head.trigger,
      scheduledFor: head.scheduledFor,
      inputs: found.workflow.inputs,
    }).pipe(Effect.result);
    if (started._tag === "Success") return;
    yield* Effect.logWarning("A scheduled workflow run was skipped.", {
      workflowId: found.id,
      scheduledFor: head.scheduledFor,
      reason: started.failure.reason,
    });
    const current = yield* readState(found.folder);
    yield* writeState(found.folder, {
      ...current,
      skipped: withSkipped(current.skipped, [head.scheduledFor]),
    });
  });

  // Runs every few seconds, so it is not traced; each workflow's own failure is only logged.
  const runDue: Workflows["Service"]["runDue"] = Effect.gen(function* () {
    for (const found of yield* listFound) {
      yield* whileLocked(found.workflow.name, found.id, advance).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not run a workflow's schedule.", {
            folder: found.folder,
            cause,
          }),
        ),
      );
    }
  });

  const dispatchQuietly = (command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(
      Effect.asVoid,
      // Its first try was refused, as when the plan moved on; a repeat changes nothing.
      Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
    );

  const estimateCost = Effect.fn("Workflows.estimateCost")(function* (
    lead: OrchestrationV2AppThread,
    plan: TeamPlan & { readonly run: TeamPlanRun },
  ) {
    const threadIds = [
      lead.id,
      ...plan.tasks.flatMap((task) =>
        Array.from({ length: task.attempt }, (_, index) =>
          teamTaskThreadId(plan.id, task.id, index + 1),
        ),
      ),
    ];
    const turns = yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerTurns"]).pipe(
          Effect.map(({ thread, providerTurns }) =>
            providerTurns.flatMap((turn) => turnUsage(turn, thread.modelSelection.model) ?? []),
          ),
          // A task that has not started yet has no thread.
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed([]) }),
        ),
      { concurrency: 4 },
    );
    // Downloading prices is worth it only where a spending limit depends on them.
    return yield* usage.priceTokenUsage({
      usage: turns.flat(),
      download: plan.run.limits.spendUsd !== null,
    });
  });

  const hold = (
    plan: TeamPlan & { readonly run: TeamPlanRun },
    threadId: ThreadId,
    reason: TeamPlanHoldReason,
    key: string,
  ) =>
    dispatchQuietly({
      type: "team.hold",
      // One per plan, reason and limit: a repeat is a no-op, a raised limit can hold again.
      commandId: CommandId.make(`server:workflow-hold:${plan.id}:${reason}:${key}`),
      threadId,
      planId: plan.id,
      reason,
    });

  const costCheckedAt = new Map<ThreadId, number>();

  const superviseLiveRun = Effect.fn("Workflows.superviseLiveRun")(function* (
    threadId: ThreadId,
    nowMs: number,
  ) {
    const lead = yield* projections.getThread(threadId);
    const plan = lead.team;
    if (plan == null || plan.status !== "running" || plan.run === undefined) return;
    const runPlan = { ...plan, run: plan.run };
    let costUsd: number | "unpriced" | null = plan.run.costUsd;
    const lastPriced = costCheckedAt.get(threadId);
    if (lastPriced === undefined || nowMs - lastPriced >= COST_CHECK_MS) {
      costCheckedAt.set(threadId, nowMs);
      const estimate = yield* estimateCost(lead, runPlan);
      // The saved cost predates the turn that has no price, so it is not checked against the limit.
      if (estimate === null) costUsd = "unpriced";
      else if (costUsd === null || Math.abs(estimate - costUsd) >= 0.01) {
        yield* dispatchQuietly({
          type: "team.run.update",
          commandId: CommandId.make(
            `server:workflow-cost:${plan.id}:${Math.round(estimate * 100)}`,
          ),
          threadId,
          planId: plan.id,
          costUsd: estimate,
        });
        costUsd = estimate;
      }
    }
    if (plan.hold !== undefined) return;
    const limit = reachedLimit(plan.run, costUsd, nowMs);
    if (limit !== null) {
      const { spendUsd, minutes } = plan.run.limits;
      return yield* hold(runPlan, threadId, limit, String(limit === "time" ? minutes : spendUsd));
    }
    const waiting = staleReview(plan, nowMs);
    if (waiting !== undefined && (yield* leadIsIdle(threadId))) {
      yield* hold(
        runPlan,
        threadId,
        "review",
        `${waiting.id}:${waiting.attempt}:${waiting.review?.round ?? 0}`,
      );
    }
  });

  const keepNote = Effect.fn("Workflows.keepNote")(function* (
    found: FoundWorkflow,
    run: TeamPlanRun & { readonly note: string },
  ) {
    const state = yield* readState(found.folder);
    if (state.noted.includes(run.run)) return;
    const schedule = found.workflow.trigger.schedule;
    const zone =
      (schedule === null ? undefined : scheduleZone(schedule)) ?? DateTime.zoneMakeLocal();
    const notes = yield* readNotes(found.folder);
    yield* writeFile(
      path.join(found.folder, NOTES_FILE),
      appendNote(notes, noteLine(run, run.note, zone)),
    );
    yield* writeState(found.folder, {
      ...state,
      noted: [...state.noted, run.run].filter((noted) => noted > state.runs - WATCHED_RUNS),
    });
  });

  const endedRuns = new Map<ThreadId, { readonly checkedAt: number; readonly updatedAt: string }>();

  const superviseRun = Effect.fnUntraced(function* (
    workflow: { readonly name: WorkflowName; readonly id: WorkflowId },
    run: number,
    nowMs: number,
  ) {
    const threadId = workflowRunThreadId(workflow.id, run);
    const ended = endedRuns.get(threadId);
    if (ended !== undefined && nowMs - ended.checkedAt < ENDED_RUN_CHECK_MS) return;
    const shell = yield* projections.getThreadShell(threadId);
    // A run whose lead or plan is not there yet is still starting; it is looked at again next tick.
    const summary = shell?.deletedAt === null ? shell.teamSummary : undefined;
    if (shell === null || summary === undefined) return;
    if (summary.status === "running") {
      endedRuns.delete(threadId);
      return yield* superviseLiveRun(threadId, nowMs);
    }
    costCheckedAt.delete(threadId);
    const updatedAt = DateTime.formatIso(shell.updatedAt);
    if (ended?.updatedAt !== updatedAt) {
      // The lead's last turn comes after its plan ends; wait for it so the cost and note are final.
      if (!(yield* leadIsIdle(threadId))) return;
      const lead = yield* projections.getThread(threadId);
      const planRun = lead.team?.run;
      if (lead.team != null && planRun !== undefined) {
        const estimate = yield* estimateCost(lead, { ...lead.team, run: planRun });
        if (
          estimate !== null &&
          (planRun.costUsd === null || Math.abs(estimate - planRun.costUsd) >= 0.001)
        ) {
          yield* dispatchQuietly({
            type: "team.run.update",
            commandId: CommandId.make(
              `server:workflow-cost:${lead.team.id}:final:${Math.round(estimate * 10_000)}`,
            ),
            threadId,
            planId: lead.team.id,
            costUsd: estimate,
          });
        }
      }
      // Reported before the note: a noted run is not looked at again.
      const reported = yield* reportRun(lead, shell, {
        leadIdle: true,
        waitForIdleChat: true,
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Could not post a workflow run's result to its chat.", {
            threadId,
            cause,
          }),
        ),
        Effect.result,
      );
      if (reported._tag === "Success" && !reported.success) {
        yield* Effect.logDebug("A workflow run's result waits for its chat's turn to end.", {
          threadId,
        });
      }
      if (reported._tag === "Failure" || !reported.success) {
        endedRuns.set(threadId, { checkedAt: nowMs, updatedAt: "" });
        return;
      }
      if (planRun?.note != null) {
        const note = planRun.note;
        const kept = yield* whileLocked(workflow.name, workflow.id, (current) =>
          keepNote(current, { ...planRun, note }),
        );
        if (Option.isSome(kept)) endedRuns.delete(threadId);
        // Its workflow.json cannot be read now, so the note is tried again at the next check.
        else endedRuns.set(threadId, { checkedAt: nowMs, updatedAt: "" });
        return;
      }
    }
    endedRuns.set(threadId, { checkedAt: nowMs, updatedAt });
  });

  // Runs every few seconds, so it is not traced; each run's own failure is only logged.
  const superviseRuns: Workflows["Service"]["superviseRuns"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const { name, read } of yield* listRead) {
      // A workflow.json that cannot be read starts no runs, but those it started keep their limits.
      if (read._tag === "missing" || read.id === undefined) continue;
      const state = yield* readState(read.folder);
      for (let run = Math.max(1, state.runs - WATCHED_RUNS + 1); run <= state.runs; run += 1) {
        if (state.noted.includes(run)) continue;
        yield* superviseRun({ name, id: read.id }, run, nowMs).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check a workflow run.", {
              folder: read.folder,
              run,
              cause,
            }),
          ),
        );
      }
    }
  });

  yield* scheduler.register("workflows", runDue);
  yield* scheduler.register("workflow-runs", superviseRuns);

  return Workflows.of({ list, read, save, remove, run, setEnabled, runDue, superviseRuns });
});

export const layer = Layer.effect(Workflows, make);
