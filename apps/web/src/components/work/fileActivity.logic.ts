import type { ThreadCheckpointSummary } from "@codenine/client-runtime/state/thread-checkpoints";
import type { ProjectFileActivityEntry } from "@codenine/contracts";

export type FileActivityChange = "edited" | "created" | "deleted" | "restored" | "signed";

export interface FileActivityEntry {
  readonly key: string;
  /** When the change was made: a turn's is when the turn ended. */
  readonly at: string;
  /** The turn that made the change, counted from 1. Null for a change the user made. */
  readonly turnCount: number | null;
  readonly path: string;
  readonly change: FileActivityChange;
}

const turnChange = (kind: string): FileActivityChange => {
  const normalized = kind.toLowerCase();
  if (normalized.startsWith("add") || normalized.startsWith("creat")) return "created";
  return normalized.startsWith("delet") || normalized.startsWith("remov") ? "deleted" : "edited";
};

const recordedChange = (entry: ProjectFileActivityEntry): FileActivityChange => {
  if (entry.action === "signed") return "signed";
  if (entry.change === "deleted") return "deleted";
  if (entry.origin === "restore") return "restored";
  return entry.change === "created" ? "created" : "edited";
};

/**
 * The changes to the workspace's files made in one chat, newest first. A turn's changes come
 * from its checkpoint, and from the version store where no checkpoint lists them. The user's
 * saves, restores and signatures come from the version store, from the chat's start on. Changes
 * made outside Codenine or by other chats are left out.
 */
export function deriveFileActivity(input: {
  readonly threadId: string;
  /** When the chat began. Recorded changes before it belong to no turn of this chat. */
  readonly since: string | null;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  readonly recorded: ReadonlyArray<ProjectFileActivityEntry>;
}): ReadonlyArray<FileActivityEntry> {
  const entries: Array<FileActivityEntry> = [];
  const fromCheckpoint = new Set<string>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status !== "ready" && checkpoint.status !== "missing") continue;
    if (checkpoint.checkpointTurnCount <= 0) continue;
    for (const file of checkpoint.files) {
      const key = `turn:${checkpoint.checkpointTurnCount}:${file.path}`;
      if (fromCheckpoint.has(key)) continue;
      fromCheckpoint.add(key);
      entries.push({
        key,
        at: checkpoint.completedAt,
        turnCount: checkpoint.checkpointTurnCount,
        path: file.path,
        change: turnChange(file.kind),
      });
    }
  }
  for (const entry of input.recorded) {
    if (input.since !== null && entry.createdAt < input.since) continue;
    if (entry.origin === "external") continue;
    if (entry.origin === "agent") {
      if (entry.threadId !== input.threadId || entry.turnCount === undefined) continue;
      const key = `turn:${entry.turnCount}:${entry.relativePath}`;
      if (fromCheckpoint.has(key)) continue;
      fromCheckpoint.add(key);
      entries.push({
        key,
        at: entry.createdAt,
        turnCount: entry.turnCount,
        path: entry.relativePath,
        change: recordedChange(entry),
      });
      continue;
    }
    entries.push({
      key: `version:${entry.id}`,
      at: entry.createdAt,
      turnCount: null,
      path: entry.relativePath,
      change: recordedChange(entry),
    });
  }
  // Times are ISO text, which sorts as time does. Equal times keep the order found.
  return entries
    .map((entry, index) => ({ entry, index }))
    .toSorted((a, b) =>
      a.entry.at === b.entry.at ? a.index - b.index : a.entry.at < b.entry.at ? 1 : -1,
    )
    .map(({ entry }) => entry);
}

export const FILE_ACTIVITY_CHANGE_LABELS: Readonly<Record<FileActivityChange, string>> = {
  edited: "Edited",
  created: "Created",
  deleted: "Deleted",
  restored: "Restored",
  signed: "Signed",
};
