import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
  normalizeProjectPathForComparison,
} from "@codenine/client-runtime/state/projects";
import type { FilesystemBrowseEntry } from "@codenine/contracts";
import { isUncPath, isWindowsAbsolutePath, isWindowsDrivePath } from "@codenine/shared/path";

/** Rows drawn at once. A longer folder says so and is narrowed by typing. */
const FOLDER_LIST_LIMIT = 300;
const RECENT_PLACE_LIMIT = 4;

export interface FolderCrumb {
  readonly label: string;
  /** The folder to open, with its trailing separator. */
  readonly path: string;
}

interface SplitFolderPath {
  readonly root: string;
  readonly rootLabel: string;
  readonly separator: "/" | "\\";
  readonly segments: ReadonlyArray<string>;
}

function splitFolderPath(value: string): SplitFolderPath | null {
  const path = value.trim();
  if (isWindowsDrivePath(path)) {
    return {
      root: `${path.slice(0, 2)}\\`,
      rootLabel: path.slice(0, 2).toUpperCase(),
      separator: "\\",
      segments: path
        .slice(2)
        .split(/[\\/]+/)
        .filter(Boolean),
    };
  }
  if (isUncPath(path)) {
    const [server, share, ...segments] = path.split(/[\\/]+/).filter(Boolean);
    if (server === undefined || share === undefined) return null;
    return {
      root: `\\\\${server}\\${share}\\`,
      rootLabel: `\\\\${server}\\${share}`,
      separator: "\\",
      segments,
    };
  }
  if (path === "~" || path.startsWith("~/")) {
    return {
      root: "~/",
      rootLabel: "Home",
      separator: "/",
      segments: path.slice(1).split(/\/+/).filter(Boolean),
    };
  }
  if (path.startsWith("/")) {
    return {
      root: "/",
      rootLabel: "/",
      separator: "/",
      segments: path.split(/\/+/).filter(Boolean),
    };
  }
  return null;
}

/** The folders from the root down to `path`, each one openable. Empty for a path that is not absolute. */
export function folderCrumbs(path: string): ReadonlyArray<FolderCrumb> {
  const split = splitFolderPath(path);
  if (split === null) return [];
  const crumbs: Array<FolderCrumb> = [{ label: split.rootLabel, path: split.root }];
  let current = split.root;
  for (const segment of split.segments) {
    current = `${current}${segment}${split.separator}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** A folder as the path box holds it: no trailing separator, except on a root. */
export function folderPathForInput(path: string): string {
  const split = splitFolderPath(path);
  if (split === null) return path.trim();
  return split.segments.length === 0
    ? split.root
    : `${split.root}${split.segments.join(split.separator)}`;
}

/** The folder above, with its trailing separator, or null at a root. */
export function parentFolderPath(path: string): string | null {
  const split = splitFolderPath(path);
  if (split === null || split.segments.length === 0) return null;
  return getBrowseParentPath(folderPathForInput(path));
}

/** The name of the folder at `path`: its last segment, or its root's label. */
export function folderName(path: string): string {
  const split = splitFolderPath(path);
  if (split === null) return path.trim();
  return split.segments.at(-1) ?? split.rootLabel;
}

/**
 * Where the browser opens: the folder in the path box when it holds an absolute path this
 * machine can have, else `fallback`. Windows paths only open on a Windows machine.
 */
export function initialBrowsePath(input: {
  readonly typedPath: string;
  readonly fallback: string;
  readonly windows: boolean;
}): string {
  const typed = input.typedPath.trim();
  const usable =
    splitFolderPath(typed) !== null && (input.windows || !isWindowsAbsolutePath(typed));
  return ensureBrowseDirectoryPath(usable ? typed : input.fallback);
}

export interface FolderRow {
  readonly name: string;
  readonly path: string;
  readonly isGitRepository: boolean;
  readonly isWorkspace: boolean;
}

export interface FolderListing {
  readonly rows: ReadonlyArray<FolderRow>;
  /** Folders left out only because hidden folders are off. */
  readonly hiddenCount: number;
  /** Matching folders past the limit. */
  readonly overflowCount: number;
}

/**
 * The rows to draw: names that start with the filter first, then names that hold it, each in
 * the order given. Hidden folders show when asked for, or when the filter starts with a dot.
 */
export function listFolderRows(input: {
  readonly entries: ReadonlyArray<FilesystemBrowseEntry>;
  readonly filter: string;
  readonly showHidden: boolean;
  /** Folders that are workspaces already. */
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly limit?: number;
}): FolderListing {
  const filter = input.filter.trim().toLowerCase();
  const showHidden = input.showHidden || filter.startsWith(".");
  const workspaces = new Set(input.workspaceRoots.map(normalizeProjectPathForComparison));
  const starts: Array<FilesystemBrowseEntry> = [];
  const holds: Array<FilesystemBrowseEntry> = [];
  let hiddenCount = 0;
  for (const entry of input.entries) {
    const name = entry.name.toLowerCase();
    if (!name.includes(filter)) continue;
    if (!showHidden && entry.name.startsWith(".")) {
      hiddenCount += 1;
      continue;
    }
    (name.startsWith(filter) ? starts : holds).push(entry);
  }
  const matches = [...starts, ...holds];
  const limit = input.limit ?? FOLDER_LIST_LIMIT;
  return {
    rows: matches.slice(0, limit).map((entry) => ({
      name: entry.name,
      path: entry.fullPath,
      isGitRepository: entry.isGitRepository === true,
      isWorkspace: workspaces.has(normalizeProjectPathForComparison(entry.fullPath)),
    })),
    hiddenCount,
    overflowCount: Math.max(0, matches.length - limit),
  };
}

const PAGE_STEP = 8;

/** The highlighted row after a list key. Returns null for a key that does not move it. */
export function moveFolderHighlight(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  const clamp = (next: number) => Math.min(count - 1, Math.max(0, next));
  switch (key) {
    case "ArrowDown":
      return clamp(index + 1);
    case "ArrowUp":
      return clamp(index - 1);
    case "PageDown":
      return clamp(index + PAGE_STEP);
    case "PageUp":
      return clamp(index - PAGE_STEP);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface FolderPlace {
  readonly id: string;
  readonly label: string;
  readonly kind: "home" | "workspaces" | "start" | "recent";
  readonly path: string;
}

/**
 * Starting places for a machine: home, Codenine's own folder, the configured start folder, and
 * the folders that hold its most recent workspaces. Each folder is listed once.
 */
export function folderPlaces(input: {
  readonly homeDirectory: string | null;
  readonly newProjectsRoot: string | null;
  readonly addProjectBaseDirectory: string;
  /** Workspace folders on this machine, most recently used first. */
  readonly workspaceRoots: ReadonlyArray<string>;
}): ReadonlyArray<FolderPlace> {
  const places: Array<FolderPlace> = [];
  const seen = new Set<string>();
  const add = (place: FolderPlace) => {
    const key = normalizeProjectPathForComparison(folderPathForInput(place.path));
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    places.push({ ...place, path: ensureBrowseDirectoryPath(place.path) });
    return true;
  };
  add({ id: "home", label: "Home", kind: "home", path: input.homeDirectory ?? "~/" });
  if (input.homeDirectory !== null) seen.add("~");
  if (input.newProjectsRoot !== null) {
    add({
      id: "workspaces",
      label: "Codenine folder",
      kind: "workspaces",
      path: input.newProjectsRoot,
    });
  }
  const start = input.addProjectBaseDirectory.trim();
  if (start.length > 0) add({ id: "start", label: "Start folder", kind: "start", path: start });
  let recent = 0;
  for (const root of input.workspaceRoots) {
    if (recent === RECENT_PLACE_LIMIT) break;
    const parent = parentFolderPath(root);
    if (parent === null) continue;
    if (add({ id: `recent:${parent}`, label: folderName(parent), kind: "recent", path: parent })) {
      recent += 1;
    }
  }
  return places;
}

/** Why a new folder name cannot be used, or null when it can. The server checks again. */
export function newFolderNameProblem(name: string, existing: ReadonlyArray<string>): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the folder a name.";
  if (trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
    return "A folder name cannot be . or .., or hold a slash.";
  }
  // Exact, since names that differ only by case are two folders on most servers. Where they
  // are one, the server says so.
  return existing.includes(trimmed) ? `${trimmed} already exists in this folder.` : null;
}
