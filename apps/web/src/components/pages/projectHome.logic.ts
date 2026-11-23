import type { EnvironmentThreadShell } from "@codenine/client-runtime/state/models";
import {
  needsYouReason,
  resolveSidebarThreadStatus,
} from "@codenine/client-runtime/state/thread-inbox";
import type { ProjectFileActivityEntry } from "@codenine/contracts";

/** Files the home page lists. Also how many the server is asked for, with room for repeats. */
const HOME_RECENT_FILE_LIMIT = 8;
export const HOME_FILE_ACTIVITY_LIMIT = 60;
/** Files of the folder asked for, to pick the listed ones from. */
export const HOME_FOLDER_FILE_LIMIT = 60;
/** Chats drawn at once; the filter reaches the rest. */
const HOME_CHAT_LIMIT = 12;
/** Chats past which the filter box shows. */
export const HOME_CHAT_FILTER_THRESHOLD = 8;

export interface HomeRecentFile {
  /** Relative to the workspace folder. */
  readonly path: string;
  readonly name: string;
  /** The folder inside the workspace, or "" at its top. */
  readonly folder: string;
  /** When it last changed, where that is known. */
  readonly at: string | null;
  /** What happened to it, or null for a file that is only there. */
  readonly detail: string | null;
}

/** The short type tag a file shows, such as XLSX, or null for a name without a usable ending. */
export function fileTypeTag(name: string): string | null {
  const cut = name.lastIndexOf(".");
  const ending = cut <= 0 ? "" : name.slice(cut + 1);
  return /^[a-z0-9]{1,5}$/i.test(ending) ? ending.toUpperCase() : null;
}

const splitPath = (path: string) => {
  const cut = path.lastIndexOf("/");
  return { name: path.slice(cut + 1), folder: cut < 0 ? "" : path.slice(0, cut) };
};

const ACTIVITY_DETAIL = {
  agent: "Changed by an agent",
  user: "Saved by you",
  restore: "Restored",
  external: "Changed outside Codenine",
} as const satisfies Record<ProjectFileActivityEntry["origin"], string>;

/**
 * The files most recently changed in a folder without Git, from its recorded changes (newest
 * first). Each file shows once, at its latest change, and a file whose latest change removed
 * it is left out.
 */
export function recentFilesFromActivity(
  entries: ReadonlyArray<
    Pick<ProjectFileActivityEntry, "relativePath" | "createdAt" | "change" | "origin">
  >,
  limit = HOME_RECENT_FILE_LIMIT,
): ReadonlyArray<HomeRecentFile> {
  const seen = new Set<string>();
  const files: Array<HomeRecentFile> = [];
  for (const entry of entries) {
    if (seen.has(entry.relativePath)) continue;
    seen.add(entry.relativePath);
    if (entry.change === "deleted") continue;
    files.push({
      path: entry.relativePath,
      ...splitPath(entry.relativePath),
      at: entry.createdAt,
      detail: entry.change === "created" ? "Created" : ACTIVITY_DETAIL[entry.origin],
    });
    if (files.length === limit) break;
  }
  return files;
}

const DOCUMENT_TAGS = new Set([
  "XLSX",
  "XLSM",
  "XLS",
  "CSV",
  "TSV",
  "PPTX",
  "PPT",
  "DOCX",
  "DOC",
  "PDF",
  "MD",
  "TXT",
  "RTF",
]);

/**
 * The files a folder's home page lists: the recently changed ones first, then the rest of the
 * folder with documents ahead of other files, each file once. Hidden files are left out.
 */
export function homeFolderFiles(
  recent: ReadonlyArray<HomeRecentFile>,
  entries: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>,
  limit = HOME_RECENT_FILE_LIMIT,
): ReadonlyArray<HomeRecentFile> {
  const listed = new Set(recent.map((file) => file.path));
  const documents: Array<HomeRecentFile> = [];
  const others: Array<HomeRecentFile> = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || listed.has(entry.path) || /(^|\/)\./.test(entry.path)) continue;
    listed.add(entry.path);
    const file = { path: entry.path, ...splitPath(entry.path), at: null, detail: null };
    (DOCUMENT_TAGS.has(fileTypeTag(file.name) ?? "") ? documents : others).push(file);
  }
  return [...recent, ...documents, ...others].slice(0, limit);
}

const comparablePath = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * In a Git checkout: the files with uncommitted changes that can be opened, most changed first.
 * Status paths are relative to the repository, which may sit above the workspace folder, so
 * they are rewritten against the workspace and files outside it or deleted are left out.
 */
export function recentFilesFromWorkingTree(
  workingTree: {
    readonly rootPath?: string | undefined;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly insertions: number;
      readonly deletions: number;
      readonly deleted?: boolean | undefined;
    }>;
  },
  workspaceRoot: string,
  limit = HOME_RECENT_FILE_LIMIT,
): ReadonlyArray<HomeRecentFile> {
  const root = workingTree.rootPath === undefined ? null : comparablePath(workingTree.rootPath);
  const workspace = comparablePath(workspaceRoot);
  // A root that does not hold the workspace is the same folder under another name.
  const prefix =
    root !== null && workspace.startsWith(`${root}/`) ? `${workspace.slice(root.length + 1)}/` : "";
  return workingTree.files
    .filter((file) => file.deleted !== true && file.path.startsWith(prefix))
    .toSorted(
      (left, right) =>
        right.insertions + right.deletions - (left.insertions + left.deletions) ||
        left.path.localeCompare(right.path),
    )
    .slice(0, limit)
    .map((file) => {
      const path = file.path.slice(prefix.length);
      return {
        path,
        ...splitPath(path),
        at: null,
        detail: `+${file.insertions} −${file.deletions}`,
      };
    });
}

export type HomeChatState = "needs-you" | "running" | "open" | "done";

export const HOME_CHAT_STATE_LABELS: Readonly<Record<HomeChatState, string | null>> = {
  "needs-you": "Needs you",
  running: "Running",
  open: null,
  done: "Done",
};

type HomeChatInput = Parameters<typeof needsYouReason>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0] &
  Pick<EnvironmentThreadShell, "settledOverride">;

/** A done chat is done even while its last run's state lingers; otherwise what waits on the user wins. */
export function homeChatState(thread: HomeChatInput): HomeChatState {
  if (thread.settledOverride === "settled") return "done";
  if (needsYouReason(thread) !== null) return "needs-you";
  const status = resolveSidebarThreadStatus(thread);
  if (status === "failed" || status === "limited") return "needs-you";
  if (status === "working" || status === "preparing") return "running";
  return thread.runtime?.status === "running" ? "running" : "open";
}

const STATE_ORDER: ReadonlyArray<HomeChatState> = ["needs-you", "running", "open", "done"];

/**
 * A workspace's chats for its home page: what waits on the user first, then what runs, then
 * open chats, then done ones, each newest first. The filter matches titles without case.
 */
export function selectHomeChats<T extends HomeChatInput & { readonly title: string }>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly activeAt: (thread: T) => string;
  readonly filter: string;
  readonly limit?: number;
}): {
  readonly chats: ReadonlyArray<{ readonly thread: T; readonly state: HomeChatState }>;
  readonly counts: Readonly<Record<HomeChatState, number>>;
  /** Matching chats past the limit. */
  readonly moreCount: number;
} {
  const filter = input.filter.trim().toLowerCase();
  const counts: Record<HomeChatState, number> = { "needs-you": 0, running: 0, open: 0, done: 0 };
  const all = input.threads.map((thread) => {
    const state = homeChatState(thread);
    counts[state] += 1;
    return { thread, state };
  });
  const matching = all
    .filter(({ thread }) => filter.length === 0 || thread.title.toLowerCase().includes(filter))
    .toSorted(
      (left, right) =>
        STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state) ||
        input.activeAt(right.thread).localeCompare(input.activeAt(left.thread)),
    );
  const limit = input.limit ?? HOME_CHAT_LIMIT;
  return {
    chats: matching.slice(0, limit),
    counts,
    moreCount: Math.max(0, matching.length - limit),
  };
}

/** A folder path with the home folder written as ~, as a chip shows it. */
export function folderChipLabel(workspaceRoot: string, homeDirectory: string | null | undefined) {
  if (!homeDirectory) return workspaceRoot;
  const home = homeDirectory.replace(/[\\/]+$/, "");
  if (workspaceRoot === home) return "~";
  return workspaceRoot.startsWith(`${home}/`) || workspaceRoot.startsWith(`${home}\\`)
    ? `~${workspaceRoot.slice(home.length)}`
    : workspaceRoot;
}
