import type { ThreadCheckpointSummary } from "@codenine/client-runtime/state/thread-checkpoints";
import { CheckpointRef, RunId } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewableTurnCount } from "./fileReviewStore";

const turn = (
  status: ThreadCheckpointSummary["status"],
  paths: ReadonlyArray<string>,
): ThreadCheckpointSummary => ({
  runId: RunId.make("run"),
  checkpointTurnCount: 2,
  checkpointRef: CheckpointRef.make("refs/codenine/test"),
  status,
  files: paths.map((path) => ({ path, kind: "modified", additions: 0, deletions: 0 })),
  assistantMessageId: null,
  completedAt: "2026-11-20T10:00:00.000Z",
});

describe("reviewableTurnCount", () => {
  it.each([
    ["a ready checkpoint that lists the file", turn("ready", ["notes.md"]), 2],
    ["a ready checkpoint that does not list it", turn("ready", ["other.md"]), null],
    // Without Git no checkpoint exists, and the version store names the turn's files.
    ["a missing checkpoint that lists the file", turn("missing", ["notes.md"]), 2],
    ["a missing checkpoint with no files", turn("missing", []), null],
    ["a failed checkpoint", turn("error", ["notes.md"]), null],
    ["no turn", undefined, null],
  ])("%s", (_name, latestTurn, expected) => {
    expect(reviewableTurnCount(latestTurn, (path) => path === "notes.md")).toBe(expected);
  });
});
