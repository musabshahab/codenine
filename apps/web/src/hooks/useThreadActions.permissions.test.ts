import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "@codenine/client-runtime/environment";
import { useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  serverConfig: { shellThreadFamilies: false },
  familyLookupFails: false,
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    lineage: { parentThreadId: ThreadId | null; sideChat?: boolean };
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  familyThreads: [] as {
    id: ThreadId;
    lineage: { parentThreadId: ThreadId | null; sideChat?: boolean };
  }[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: { threadId?: string; cwd?: string; force?: boolean };
  }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
  routeThreadRef: null as ScopedThreadRef | null,
  worktreeThreadIds: [] as ThreadId[],
  worktreeRefusesRemoval: false,
  worktreeFiles: [] as string[] | null,
  fallbackThreadId: null as ThreadId | null,
  fallbackCandidates: [] as ThreadId[][],
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    state: { location: { href: "/" }, matches: [] },
    navigate: (options: unknown) => state.navigate(options),
  }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: {
      environmentId: string;
      input: { threadId?: string; cwd?: string; force?: boolean };
    }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      if (action === "removeWorktree" && !request.input.force && state.worktreeRefusesRemoval) {
        return AsyncResult.failure(Cause.fail(new Error("git worktree remove failed")));
      }
      if (action !== "refreshStatus") return AsyncResult.success(undefined);
      return state.worktreeFiles === null
        ? AsyncResult.failure(Cause.fail(new Error("git status failed")))
        : AsyncResult.success({
            isRepo: true,
            workingTree: { files: state.worktreeFiles.map((path) => ({ path })) },
          });
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (family: unknown) => async (environmentId: string) =>
    family === "worktreeThreadIds"
      ? AsyncResult.success({ threadIds: state.worktreeThreadIds })
      : family === "threadFamily"
        ? state.familyLookupFails
          ? AsyncResult.failure(Cause.fail(new Error("Family lookup failed")))
          : AsyncResult.success({ threads: state.familyThreads })
        : state.sessionLookupFails
          ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
          : AsyncResult.success({
              authenticated: true,
              scopes: [...(state.scopes.get(environmentId) ?? [])],
              auth: { serverUpdateScope: "environment:maintain" },
            }),
}));
vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: {
    threadFamily: "threadFamily",
    worktreeThreadIds: "worktreeThreadIds",
  },
}));
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentServerConfigsAtom: Atom.make(new Map([["secondary", state.serverConfig]])),
  };
});
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: (input: { threads: ReadonlyArray<{ id: ThreadId }> }) => {
    state.fallbackCandidates.push(input.threads.map((thread) => thread.id));
    return state.fallbackThreadId;
  },
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: (ref: ScopedThreadRef) =>
        state.localEffects.push(`clear-draft:${ref.threadId}`),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: (ref: ScopedThreadRef) =>
    state.localEffects.push(`release-uploads:${ref.threadId}`),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => state.routeThreadRef,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "./useThreadActions";

function seedThreadPanelState(ref: ScopedThreadRef) {
  useRightPanelStore.getState().show(ref);
  useDiffPanelStore.getState().selectGitScope(ref, "branch");
}

function threadPanelStatePresence(ref: ScopedThreadRef) {
  const key = scopedThreadKey(ref);
  return {
    rightPanel: key in useRightPanelStore.getState().byThreadKey,
    diffPanel: key in useDiffPanelStore.getState().byThreadKey,
  };
}
const panelStateKept = { rightPanel: true, diffPanel: true };
const panelStateCleared = { rightPanel: false, diffPanel: false };

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.serverConfig.shellThreadFamilies = false;
  state.familyLookupFails = false;
  state.familyThreads = [];
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      lineage: { parentThreadId: null },
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  state.routeThreadRef = null;
  state.worktreeThreadIds = [];
  state.worktreeRefusesRemoval = false;
  state.worktreeFiles = [];
  state.fallbackThreadId = null;
  state.fallbackCandidates = [];
  state.navigate.mockReset().mockResolvedValue(undefined);
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
});

describe("thread action permissions", () => {
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("names an archived thread in its delete confirmation and preserves it on cancel", async () => {
    state.threads = [];
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.confirm.mockResolvedValue(false);
    await useThreadActions().confirmAndDeleteThread(target, "Archived release notes");
    expect(state.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete chat "Archived release notes"?'),
      { variant: "destructive" },
    );
    expect(state.requests).toEqual([]);
  });

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.serverConfig.shellThreadFamilies = true;
    state.familyThreads = [
      {
        id: ThreadId.make("side-chat"),
        lineage: { parentThreadId: target.threadId, sideChat: true },
      },
      { id: ThreadId.make("fork"), lineage: { parentThreadId: target.threadId } },
      {
        id: ThreadId.make("other-side-chat"),
        lineage: { parentThreadId: ThreadId.make("other-parent"), sideChat: true },
      },
    ];
    state.threads = [];
    seedThreadPanelState(target);
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
    expect(state.localEffects).toEqual([
      "release-uploads:thread",
      "clear-draft:thread",
      "release-uploads:side-chat",
      "clear-draft:side-chat",
      "refresh-archive",
      "clear-terminal-ui",
    ]);
    expect(state.localEffects).not.toContain("clear-draft:fork");
    expect(state.localEffects).not.toContain("clear-draft:other-side-chat");

    // The family read only finds drafts to clear; it never blocks the delete.
    state.familyLookupFails = true;
    state.requests = [];
    state.localEffects = [];
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
    expect(state.localEffects).toContain("clear-draft:thread");
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
  });

  it.each([false, true])(
    "deletes a chat the shell list leaves out like a listed one, from the chat as shown (families: %s)",
    async (shellThreadFamilies) => {
      state.serverConfig.shellThreadFamilies = shellThreadFamilies;
      state.worktreeThreadIds = [target.threadId];
      state.scopes
        .get(secondary)!
        .add(AuthOrchestrationOperateScope)
        .add(AuthSourceControlWriteScope);
      const shown = { ...state.threads[0]!, worktreePath: "/worktrees/thread" };
      const next = { ...state.threads[0]!, id: ThreadId.make("next") };
      state.threads = [next];
      state.routeThreadRef = target;
      state.fallbackThreadId = next.id;
      expect((await useThreadActions().deleteThread(target, { thread: shown as never }))._tag).toBe(
        "Success",
      );
      expect(state.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("This chat is the only one linked to this worktree:"),
        { variant: "destructive" },
      );
      expect(state.requests.map((request) => request.action)).toEqual([
        "stopSession",
        "delete",
        "removeWorktree",
        "refreshStatus",
      ]);
      // The next chat is picked from a list that includes the deleted one.
      expect(state.fallbackCandidates).toEqual([[next.id, target.threadId]]);
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: secondary, threadId: next.id },
        replace: true,
      });
    },
  );

  const forceRequired =
    "Git could not remove the worktree thread without force. It may contain submodules with unpushed commits or changes.";
  it.each([
    {
      case: "keeps uncommitted files",
      files: ["a.ts", "b.ts", "c.ts"],
      discard: false,
      asked: "The worktree thread has uncommitted changes.",
      removals: [false],
    },
    {
      case: "discards them when confirmed",
      files: ["a.ts", "b.ts", "c.ts"],
      discard: true,
      asked: "The worktree thread has uncommitted changes.",
      removals: [false, true],
    },
    {
      case: "keeps one whose status cannot be read",
      files: null,
      discard: false,
      asked: forceRequired,
      removals: [false],
    },
    {
      // Submodule repositories and their unpushed commits live in the worktree's admin directory.
      case: "keeps a clean one unless confirmed",
      files: [],
      discard: false,
      asked: forceRequired,
      removals: [false],
    },
  ])(
    "when Git keeps a deleted chat's worktree, $case",
    async ({ files, discard, asked, removals }) => {
      state.scopes
        .get(secondary)!
        .add(AuthOrchestrationOperateScope)
        .add(AuthSourceControlWriteScope);
      state.threads[0]!.worktreePath = "/worktrees/thread";
      state.worktreeRefusesRemoval = true;
      state.worktreeFiles = files;
      state.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(discard);

      expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
      expect(
        state.requests
          .filter((request) => request.action === "removeWorktree")
          .map((request) => request.input.force),
      ).toEqual(removals);
      expect(state.confirm.mock.calls.map(([message]) => message.split("\n")[0])).toEqual([
        "This chat is the only one linked to this worktree:",
        asked,
      ]);
      expect(state.toasts).toEqual([]);
    },
  );

  it("clears the drafts of the side chats deleted with it", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const parent = state.threads[0]!;
    state.threads.push(
      {
        ...parent,
        id: ThreadId.make("side-chat"),
        lineage: { parentThreadId: parent.id, sideChat: true },
      },
      { ...parent, id: ThreadId.make("fork"), lineage: { parentThreadId: parent.id } },
    );
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.localEffects).toEqual(
      expect.arrayContaining(["release-uploads:side-chat", "clear-draft:side-chat"]),
    );
    expect(state.localEffects).not.toContain("clear-draft:fork");
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});
