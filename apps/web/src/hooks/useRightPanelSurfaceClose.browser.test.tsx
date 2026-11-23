import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@codenine/contracts";
import { scopedThreadKey } from "@codenine/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const fixture = vi.hoisted(() => ({
  confirm: (_labels: readonly string[]): Promise<boolean> => Promise.resolve(false),
  allowed: new Set<string>(),
  sessions: new Map<string, string>(),
  failClose: false,
  conflictedFiles: new Set<string>(),
  discardedFiles: [] as string[],
  confirmDiscard: (_message: string): Promise<boolean> => Promise.resolve(false),
}));
// The real modules read the app's query cache, which would connect a client.
vi.mock("../components/files/projectFilesQueryState", () => ({
  hasProjectFileConflict: (_environmentId: string, _cwd: string, relativePath: string) =>
    fixture.conflictedFiles.has(relativePath),
}));
vi.mock("../components/files/fileSaveSessions", () => ({
  discardFileDraft: (target: { relativePath: string }) =>
    fixture.discardedFiles.push(target.relativePath),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    dialogs: { confirm: (message: string) => fixture.confirmDiscard(message) },
  }),
}));
vi.mock("../lib/terminalCloseConfirm", () => ({
  confirmTerminalClose: (labels: readonly string[]) => fixture.confirm(labels),
}));
vi.mock("../components/ChatView.logic", () => ({
  agentControlledBrowserCloseConfirmation: () => null,
}));
vi.mock("../previewStateStore", () => ({
  useThreadPreviewState: () => ({ sessions: {}, desktopByTabId: {} }),
  setActivePreviewTab: () => {},
  beginPreviewSessionClose: () => {},
  cancelPreviewSessionClose: () => {},
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: (id: string) => fixture.allowed.has(id),
  readEnvironmentScope: (id: string) => fixture.allowed.has(id),
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => null,
  useProject: () => null,
  readThreadShell: () => null,
}));
vi.mock("../state/terminalSessions", () => ({ useKnownTerminalSessions: () => null }));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    useComposerDraftStore: () => null,
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (_command: unknown, label: string) =>
    async (request: {
      environmentId: string;
      input: { threadId: string; terminalId: string; data?: string };
    }) => {
      const key = `${request.environmentId}/${request.input.threadId}/${request.input.terminalId}`;
      if (label === "terminal close" && fixture.failClose) return { _tag: "Failure" };
      if (label === "terminal close" || label === "terminal write") fixture.sessions.delete(key);
      return { _tag: "Success" };
    },
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/terminal", () => ({ terminalEnvironment: { open: {}, close: {}, write: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { delete: {} } }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("@codenine/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
}));

function setup() {
  fixture.allowed = new Set(["environment-a", "environment-b"]);
  fixture.sessions = new Map();
  fixture.failClose = false;
  fixture.conflictedFiles = new Set();
  fixture.discardedFiles = [];
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  for (const ref of [original, other]) {
    fixture.sessions.set(`${ref.environmentId}/${ref.threadId}/term-1`, "history to preserve");
    useRightPanelStore.getState().openTerminal(ref, "term-1");
  }
  const surface = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, original)
    .surfaces[0]!;
  let resolve!: (confirmed: boolean) => void;
  const confirmation = new Promise<boolean>((done) => {
    resolve = done;
  });
  fixture.confirm = () => confirmation;
  function Harness({ threadRef }: { threadRef: ScopedThreadRef }) {
    const { closeSurface } = useRightPanelSurfaceClose({
      threadRef,
      terminalLabelsById: new Map(),
      fileWorkspaceRoot: undefined,
    });
    return <button onClick={() => closeSurface(surface)}>Close original terminal</button>;
  }
  return { original, other, Harness, resolve };
}

it.each([false, true])(
  "keeps a pending close on its original environment and thread, fallback=%s",
  async (failClose) => {
    const { original, other, Harness, resolve } = setup();
    fixture.failClose = failClose;
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
    await screen.rerender(<Harness threadRef={other} />);
    await act(async () => {
      resolve(true);
    });
    expect([...fixture.sessions]).toEqual([
      ["environment-b/thread-b/term-1", "history to preserve"],
    ]);
    const panels = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(panels, original).surfaces).toEqual([]);
    expect(selectThreadRightPanelState(panels, other).surfaces).toHaveLength(1);
  },
);

it.each(["cancel", "revoked"])(
  "leaves both sessions intact when confirmation is %s",
  async (outcome) => {
    const { original, other, Harness, resolve } = setup();
    await using screen = await render(<Harness threadRef={original} />);
    await screen.getByRole("button").click();
    await screen.rerender(<Harness threadRef={other} />);
    if (outcome === "revoked") fixture.allowed.delete(original.environmentId);
    await act(async () => {
      resolve(outcome !== "cancel");
    });
    expect(fixture.sessions.size).toBe(2);
    expect(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(other)]?.surfaces,
    ).toHaveLength(1);
  },
);

it.each([
  { confirmed: true, discarded: ["notes.md"], openFiles: 0 },
  { confirmed: false, discarded: [], openFiles: 1 },
])(
  "asks before closing a file whose edits a save conflict left unsaved, confirmed=$confirmed",
  async ({ confirmed, discarded, openFiles }) => {
    const { original } = setup();
    fixture.conflictedFiles = new Set(["notes.md"]);
    const asked: string[] = [];
    fixture.confirmDiscard = (message) => {
      asked.push(message);
      return Promise.resolve(confirmed);
    };
    useRightPanelStore.getState().openFile(original, "notes.md");
    useRightPanelStore.getState().openFile(original, "saved.md");
    const fileSurfaces = () =>
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        original,
      ).surfaces.filter((surface) => surface.kind === "file");
    const [unsaved, saved] = fileSurfaces();
    function Harness() {
      const { closeSurface } = useRightPanelSurfaceClose({
        threadRef: original,
        terminalLabelsById: new Map(),
        fileWorkspaceRoot: "/workspace",
      });
      return (
        <>
          <button onClick={() => closeSurface(saved!)}>Close saved file</button>
          <button onClick={() => closeSurface(unsaved!)}>Close unsaved file</button>
        </>
      );
    }
    await using screen = await render(<Harness />);

    await screen.getByRole("button", { name: "Close saved file" }).click();
    expect(fileSurfaces()).toHaveLength(1);
    expect(asked).toEqual([]);
    await screen.getByRole("button", { name: "Close unsaved file" }).click();
    expect(asked).toHaveLength(1);
    // Lets the answered confirmation run its close.
    await act(async () => {});
    expect(fileSurfaces()).toHaveLength(openFiles);
    expect(fixture.discardedFiles).toEqual(discarded);
  },
);
