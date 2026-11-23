import type { ThreadCheckpointSummary } from "@codenine/client-runtime/state/thread-checkpoints";
import {
  CheckpointRef,
  IsoDateTime,
  type ProjectFileActivityEntry,
  RunId,
  ThreadId,
} from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveFileActivity } from "./fileActivity.logic";

const checkpoint = (
  turnCount: number,
  completedAt: string,
  files: ReadonlyArray<readonly [path: string, kind: string]>,
  status: ThreadCheckpointSummary["status"] = "missing",
): ThreadCheckpointSummary => ({
  runId: RunId.make(`run-${turnCount}`),
  checkpointTurnCount: turnCount,
  checkpointRef: CheckpointRef.make(`refs/codenine/test/${turnCount}`),
  status,
  files: files.map(([path, kind]) => ({ path, kind, additions: 0, deletions: 0 })),
  assistantMessageId: null,
  completedAt,
});

let nextId = 1;
const recorded = (
  relativePath: string,
  createdAt: string,
  fields: Partial<ProjectFileActivityEntry> = {},
): ProjectFileActivityEntry => ({
  id: String(nextId++),
  createdAt: IsoDateTime.make(createdAt),
  byteLength: 10,
  state: "stored",
  origin: "user",
  relativePath,
  change: "modified",
  ...fields,
});

const THREAD = ThreadId.make("thread-a");

describe("deriveFileActivity", () => {
  it("orders a chat's turn changes and the user's saves, restores and signatures by time", () => {
    const activity = deriveFileActivity({
      threadId: THREAD,
      since: "2026-11-20T09:00:00.000Z",
      checkpoints: [
        checkpoint(1, "2026-11-20T10:00:00.000Z", [
          ["budget.xlsx", "modified"],
          ["notes.md", "added"],
        ]),
        checkpoint(2, "2026-11-20T12:00:00.000Z", [["old.md", "deleted"]]),
        // A checkpoint that failed says nothing about what changed.
        checkpoint(3, "2026-11-20T13:00:00.000Z", [["lost.md", "modified"]], "error"),
      ],
      recorded: [
        recorded("contract.pdf", "2026-11-20T12:30:00.000Z", { action: "signed" }),
        recorded("budget.xlsx", "2026-11-20T11:00:00.000Z", { origin: "restore" }),
        recorded("budget.xlsx", "2026-11-20T10:30:00.000Z"),
        // The store's record of what the checkpoint already lists.
        recorded("budget.xlsx", "2026-11-20T10:00:01.000Z", {
          origin: "agent",
          threadId: THREAD,
          turnCount: 1,
        }),
        // A turn's change that only the store saw.
        recorded("deck.pptx", "2026-11-20T12:00:01.000Z", {
          origin: "agent",
          threadId: THREAD,
          turnCount: 2,
          change: "created",
        }),
        recorded("other.md", "2026-11-20T11:30:00.000Z", {
          origin: "agent",
          threadId: ThreadId.make("thread-b"),
          turnCount: 1,
        }),
        recorded("outside.md", "2026-11-20T11:40:00.000Z", { origin: "external" }),
        recorded("draft.md", "2026-11-20T11:45:00.000Z", { origin: "restore", change: "deleted" }),
        recorded("before.md", "2026-11-19T08:00:00.000Z"),
      ],
    });
    expect(
      activity.map(({ at, turnCount, path, change }) => [
        at.slice(11, 16),
        turnCount,
        path,
        change,
      ]),
    ).toEqual([
      ["12:30", null, "contract.pdf", "signed"],
      ["12:00", 2, "deck.pptx", "created"],
      ["12:00", 2, "old.md", "deleted"],
      ["11:45", null, "draft.md", "deleted"],
      ["11:00", null, "budget.xlsx", "restored"],
      ["10:30", null, "budget.xlsx", "edited"],
      ["10:00", 1, "budget.xlsx", "edited"],
      ["10:00", 1, "notes.md", "created"],
    ]);
    expect(new Set(activity.map((entry) => entry.key)).size).toBe(activity.length);
  });

  it("is empty for a chat that changed nothing", () => {
    expect(
      deriveFileActivity({ threadId: THREAD, since: null, checkpoints: [], recorded: [] }),
    ).toEqual([]);
  });
});
