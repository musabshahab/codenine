import { EnvironmentId, ThreadId } from "@codenine/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ revertFileChange: vi.fn() }));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.revertFileChange) as never,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  reloadProjectFileQueryData: vi.fn(),
}));

import { FileReviewSurface } from "./FileReviewSurface";

const environmentId = EnvironmentId.make("file-review-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };

function setup() {
  state.revertFileChange
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ relativePath: "notes.md", deleted: false, version: "after" }),
    );
  const onKeep = vi.fn();
  const onClose = vi.fn();
  const surface = (
    <FileReviewSurface
      environmentId={environmentId}
      cwd="/workspace"
      relativePath="notes.md"
      threadRef={threadRef}
      turnCount={3}
      baseline={"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n"}
      contents={"one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\n"}
      version="seen"
      canDiscard
      resolvedTheme="dark"
      wordWrap={false}
      onKeep={onKeep}
      onClose={onClose}
    />
  );
  return { surface, onKeep, onClose };
}

it("discards one change, then the file, at the version the review showed", async () => {
  const { surface, onClose } = setup();
  await using screen = await render(surface);
  const revert = { cwd: "/workspace", relativePath: "notes.md", threadId: "thread", turnCount: 3 };

  await screen.getByRole("button", { name: "Discard change" }).nth(1).click();
  expect(state.revertFileChange).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...revert,
      expectedVersion: "seen",
      change: { baseStart: 7, baseCount: 1, currentStart: 7, currentCount: 2 },
    },
  });
  // The file has not read back yet, so a second discard would name a stale version.
  await expect.element(screen.getByRole("button", { name: "Discard", exact: true })).toBeDisabled();

  await screen.rerender(<div key="reset" />);
  const next = setup();
  await screen.rerender(next.surface);
  await screen.getByRole("button", { name: "Discard", exact: true }).click();
  expect(state.revertFileChange).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...revert, expectedVersion: "seen" },
  });
  await vi.waitFor(() => expect(next.onClose).toHaveBeenCalled());
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps the file once its last change is kept", async () => {
  const { surface, onKeep } = setup();
  await using screen = await render(surface);

  await screen.getByRole("button", { name: "Keep change" }).first().click();
  expect(onKeep).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Keep change" })).toBeInTheDocument();
  await screen.getByRole("button", { name: "Keep change" }).click();
  expect(onKeep).toHaveBeenCalledOnce();
  expect(state.revertFileChange).not.toHaveBeenCalled();
});
