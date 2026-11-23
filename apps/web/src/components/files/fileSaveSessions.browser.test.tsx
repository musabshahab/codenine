import { render, fakeTimers } from "../../../test/render";
import {
  type AuthSessionState,
  EnvironmentId,
  ProjectWriteFileConflictError,
} from "@codenine/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const { runAtomCommand, getUnsavedFile } = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  getUnsavedFile: vi.fn(),
}));
vi.mock(import("@codenine/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: runAtomCommand as never,
}));
// The real session atom boots the connection runtime, whose endless discovery poll
// would keep vi.runAllTimersAsync from ever draining once its timers are faked.
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const reactivity = await import("effect/reactivity");
  const signedOut = reactivity.Atom.make(reactivity.AsyncResult.initial<AuthSessionState>());
  return {
    ...actual,
    environmentSession: { ...actual.environmentSession, sessionStateAtom: () => signedOut },
    readEnvironmentScope: () => true,
  };
});
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  confirmProjectFileQueryData: () => true,
  getUnsavedProjectFileQueryData: getUnsavedFile,
}));

import { changeFileSaveSession, useFileSaveSession } from "./fileSaveSessions";
import { hasProjectFileConflict, setProjectFileQueryData } from "./projectFilesQueryState";

const target = {
  environmentId: EnvironmentId.make("file-save-sessions-browser"),
  cwd: "/workspace",
  relativePath: "README.md",
};
const onPendingChange = vi.fn();

// The editor and rendered-markdown surfaces are different component types, so
// switching between them unmounts one session holder and mounts another.
function EditorSurface() {
  useFileSaveSession({ ...target }, onPendingChange);
  return <div>editor</div>;
}
function MarkdownSurface() {
  useFileSaveSession({ ...target }, onPendingChange);
  return <div>markdown</div>;
}
const refusedTarget = { ...target, relativePath: "refused.md" };
function RefusedFileSurface() {
  useFileSaveSession({ ...refusedTarget }, onPendingChange);
  return <div>editor</div>;
}

describe("file save sessions in React", () => {
  it("writes a pending draft once when the file switches surfaces under StrictMode", async () => {
    let finishWrite = () => {};
    runAtomCommand.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(AsyncResult.success({ relativePath: "README.md" }));
        }),
    );
    getUnsavedFile.mockReset().mockReturnValue(null);
    await using screen = await render(
      <StrictMode>
        <EditorSurface />
      </StrictMode>,
      { router: false }, // no routes involved; the surfaces are bare effect hosts
    );
    using _timers = fakeTimers();
    // An edit lands in the query cache, unconfirmed until its write settles.
    getUnsavedFile.mockReturnValue({ contents: "draft" });
    changeFileSaveSession(target, "draft");

    await screen.rerender(
      <StrictMode>
        <MarkdownSurface />
      </StrictMode>,
    );
    finishWrite();
    getUnsavedFile.mockReturnValue(null);
    await vi.runAllTimersAsync();

    expect(runAtomCommand.mock.calls.map(([, , request]) => request)).toEqual([
      {
        environmentId: target.environmentId,
        input: { cwd: "/workspace", relativePath: "README.md", contents: "draft" },
      },
    ]);
    expect(onPendingChange).toHaveBeenLastCalledWith("README.md", false);
  });

  it("saves over the version the draft began from, and holds a refused draft as a conflict", async () => {
    const { environmentId, cwd, relativePath } = refusedTarget;
    runAtomCommand
      .mockReset()
      .mockResolvedValue(
        AsyncResult.failure(
          Cause.fail(
            new ProjectWriteFileConflictError({ cwd, relativePath, currentVersion: "disk" }),
          ),
        ),
      );
    getUnsavedFile.mockReset().mockReturnValue(null);
    await using _screen = await render(
      <RefusedFileSurface />,
      { router: false }, // no routes involved; the surface is a bare effect host
    );
    using _timers = fakeTimers();
    setProjectFileQueryData(environmentId, cwd, relativePath, "draft", "read");
    getUnsavedFile.mockReturnValue({ contents: "draft", version: "read" });
    changeFileSaveSession(refusedTarget, "draft");
    await vi.runAllTimersAsync();

    expect(runAtomCommand.mock.calls.map(([, , request]) => request)).toEqual([
      { environmentId, input: { cwd, relativePath, contents: "draft", expectedVersion: "read" } },
    ]);
    expect(hasProjectFileConflict(environmentId, cwd, relativePath)).toBe(true);
  });
});
