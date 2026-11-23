import { EnvironmentId, type ProjectRevertFileChangeInput, ThreadId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DiscardTransport,
  discardTurnFileChange,
  discardTurnFileChanges,
  onTurnFileChangeDiscarded,
  type TurnFileChange,
} from "./discardTurnChange";

const file = (relativePath: string): TurnFileChange => ({
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/work",
  relativePath,
  threadId: ThreadId.make("thread-1"),
  turnCount: 3,
});

function fakeServer(versions: Record<string, string | undefined | null>, conflicts: string[] = []) {
  const reverts: Array<ProjectRevertFileChangeInput> = [];
  const transport: DiscardTransport = {
    currentVersion: async (target) => versions[target.relativePath],
    revert: async (_target, input) => {
      reverts.push(input);
      return conflicts.includes(input.relativePath)
        ? { ok: false, conflict: true, message: null }
        : { ok: true, version: "restored" };
    },
  };
  return { reverts, transport };
}

describe("discarding a turn's change", () => {
  it("puts the whole file back against the version that is there now", async () => {
    const { reverts, transport } = fakeServer({ "budget.xlsx": "v7" });
    const heard: Array<string> = [];
    using _listening = {
      [Symbol.dispose]: onTurnFileChangeDiscarded((discarded) =>
        heard.push(discarded.relativePath),
      ),
    };
    expect(await discardTurnFileChange(file("budget.xlsx"), transport)).toEqual({ ok: true });
    // The request the review bar's Discard makes: no line range, so the whole file goes back.
    expect(reverts).toEqual([
      {
        cwd: "/work",
        relativePath: "budget.xlsx",
        threadId: "thread-1",
        turnCount: 3,
        expectedVersion: "v7",
      },
    ]);
    expect(heard).toEqual(["budget.xlsx"]);
  });

  it("restores a file the turn deleted, and writes nothing when the file cannot be read", async () => {
    const { reverts, transport } = fakeServer({ "gone.md": undefined, "broken.md": null });
    expect(await discardTurnFileChange(file("gone.md"), transport)).toEqual({ ok: true });
    expect(reverts[0]).not.toHaveProperty("expectedVersion");
    expect(await discardTurnFileChange(file("broken.md"), transport)).toMatchObject({ ok: false });
    expect(reverts).toHaveLength(1);
  });

  it("undoes every file of a reply and names the ones that changed meanwhile", async () => {
    const { reverts, transport } = fakeServer({ "a.md": "v1", "b.md": "v2" }, ["b.md"]);
    expect(await discardTurnFileChanges([file("a.md"), file("b.md")], transport)).toEqual([
      { relativePath: "b.md", conflict: true },
    ]);
    expect(reverts.map((revert) => revert.relativePath)).toEqual(["a.md", "b.md"]);
  });
});
