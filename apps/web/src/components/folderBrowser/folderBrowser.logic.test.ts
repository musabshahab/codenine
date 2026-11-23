import { describe, expect, it } from "vite-plus/test";

import {
  folderCrumbs,
  folderName,
  folderPathForInput,
  folderPlaces,
  initialBrowsePath,
  listFolderRows,
  moveFolderHighlight,
  newFolderNameProblem,
  parentFolderPath,
} from "./folderBrowser.logic";

const entry = (name: string, parent = "/home/me", isGitRepository?: boolean) => ({
  name,
  fullPath: `${parent}/${name}`,
  ...(isGitRepository === undefined ? {} : { isGitRepository }),
});

describe("folder paths", () => {
  it.each([
    ["/home/me/work/", ["/", "/home/", "/home/me/", "/home/me/work/"], ["/", "home", "me", "work"]],
    ["/", ["/"], ["/"]],
    ["~/notes", ["~/", "~/notes/"], ["Home", "notes"]],
    ["C:\\Users\\me", ["C:\\", "C:\\Users\\", "C:\\Users\\me\\"], ["C:", "Users", "me"]],
    ["c:/Users/me/", ["c:\\", "c:\\Users\\", "c:\\Users\\me\\"], ["C:", "Users", "me"]],
    [
      "\\\\wsl$\\Ubuntu\\home\\me",
      ["\\\\wsl$\\Ubuntu\\", "\\\\wsl$\\Ubuntu\\home\\", "\\\\wsl$\\Ubuntu\\home\\me\\"],
      ["\\\\wsl$\\Ubuntu", "home", "me"],
    ],
    // A WSL machine's own paths are plain Linux paths.
    ["/mnt/c/Users", ["/", "/mnt/", "/mnt/c/", "/mnt/c/Users/"], ["/", "mnt", "c", "Users"]],
    ["notes/today", [], []],
  ])("breaks %s into crumbs that each open a folder", (path, paths, labels) => {
    const crumbs = folderCrumbs(path);
    expect(crumbs.map((crumb) => crumb.path)).toEqual(paths);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(labels);
  });

  it.each([
    ["/home/me/", "/home/", "me"],
    ["/", null, "/"],
    ["C:\\Users\\me\\", "C:\\Users\\", "me"],
    ["C:\\", null, "C:"],
    ["\\\\wsl$\\Ubuntu\\home", "\\\\wsl$\\Ubuntu\\", "home"],
    ["~/", null, "Home"],
  ])("climbs and names %s", (path, parent, name) => {
    expect(parentFolderPath(path)).toBe(parent);
    expect(folderName(path)).toBe(name);
  });

  it("keeps the path box and the browser on the same folder", () => {
    // The box's path opens in the browser, and the folder chosen there goes back unchanged.
    for (const typed of ["/home/me/work", "C:\\Users\\me", "\\\\wsl$\\Ubuntu\\home", "~/notes"]) {
      const opened = initialBrowsePath({ typedPath: typed, fallback: "~/", windows: true });
      expect(folderPathForInput(opened)).toBe(typed);
    }
    expect(initialBrowsePath({ typedPath: "  /srv/data/ ", fallback: "~/", windows: false })).toBe(
      "/srv/data/",
    );
    // Nothing usable in the box: start where the machine starts.
    for (const typedPath of ["", "my-app", "./here", "C:\\Users\\me"]) {
      expect(initialBrowsePath({ typedPath, fallback: "/home/me", windows: false })).toBe(
        "/home/me/",
      );
    }
  });
});

describe("listFolderRows", () => {
  const entries = [
    entry(".config"),
    entry("archive"),
    entry("Reports", "/home/me", true),
    entry("old-reports"),
    entry("repo", "/home/me", true),
  ];

  it("hides dot folders until asked, and marks repositories and workspaces", () => {
    const listing = listFolderRows({
      entries,
      filter: "",
      showHidden: false,
      workspaceRoots: ["/home/me/repo/", "/elsewhere"],
    });
    expect(listing.rows.map((row) => row.name)).toEqual([
      "archive",
      "Reports",
      "old-reports",
      "repo",
    ]);
    expect(listing.hiddenCount).toBe(1);
    expect(listing.rows.filter((row) => row.isGitRepository).map((row) => row.name)).toEqual([
      "Reports",
      "repo",
    ]);
    expect(listing.rows.filter((row) => row.isWorkspace).map((row) => row.name)).toEqual(["repo"]);
    expect(
      listFolderRows({ entries, filter: "", showHidden: true, workspaceRoots: [] }).rows[0]?.name,
    ).toBe(".config");
  });

  it("filters without case, names that start with the text first", () => {
    const rows = (filter: string) =>
      listFolderRows({ entries, filter, showHidden: false, workspaceRoots: [] }).rows.map(
        (row) => row.name,
      );
    expect(rows("rep")).toEqual(["Reports", "repo", "old-reports"]);
    expect(rows(" REPO ")).toEqual(["Reports", "repo", "old-reports"]);
    // A filter that starts with a dot is asking for hidden folders.
    expect(rows(".c")).toEqual([".config"]);
    expect(rows("zzz")).toEqual([]);
  });

  it("caps the rows and counts what was left out", () => {
    const many = Array.from({ length: 12 }, (_, index) => entry(`folder-${index}`));
    const listing = listFolderRows({
      entries: many,
      filter: "",
      showHidden: false,
      workspaceRoots: [],
      limit: 5,
    });
    expect(listing.rows).toHaveLength(5);
    expect(listing.overflowCount).toBe(7);
  });
});

it.each([
  [0, "ArrowDown", 3, 1],
  [2, "ArrowDown", 3, 2],
  [0, "ArrowUp", 3, 0],
  [2, "ArrowUp", 3, 1],
  [1, "End", 20, 19],
  [7, "Home", 20, 0],
  [1, "PageDown", 20, 9],
  [15, "PageDown", 20, 19],
  [3, "PageUp", 20, 0],
  [0, "Enter", 3, null],
  [0, "ArrowDown", 0, null],
])("moves the highlight from %i on %s among %i rows to %s", (index, key, count, expected) => {
  expect(moveFolderHighlight(index, key, count)).toBe(expected);
});

describe("folderPlaces", () => {
  it("lists home, Codenine's folder, the start folder and recent parents once each", () => {
    const places = folderPlaces({
      homeDirectory: "/home/me",
      newProjectsRoot: "/home/me/.codenine/projects",
      addProjectBaseDirectory: "~/",
      workspaceRoots: [
        "/home/me/.codenine/projects/notes",
        "/srv/clients/acme",
        "/srv/clients/globex",
        "/home/me/code/app",
        "/a/1",
        "/b/2",
        "/c/3",
        "/",
      ],
    });
    expect(places.map((place) => [place.kind, place.label, place.path])).toEqual([
      ["home", "Home", "/home/me/"],
      ["workspaces", "Codenine folder", "/home/me/.codenine/projects/"],
      ["recent", "clients", "/srv/clients/"],
      ["recent", "code", "/home/me/code/"],
      ["recent", "a", "/a/"],
      ["recent", "b", "/b/"],
    ]);
  });

  it("falls back to ~/ on a server that does not say where home is", () => {
    expect(
      folderPlaces({
        homeDirectory: null,
        newProjectsRoot: null,
        addProjectBaseDirectory: "D:\\Work",
        workspaceRoots: ["D:\\Work\\site"],
      }).map((place) => [place.kind, place.path]),
    ).toEqual([
      ["home", "~/"],
      ["start", "D:\\Work\\"],
    ]);
  });
});

it.each([
  ["", "Give the folder a name."],
  ["a/b", "A folder name cannot be . or .., or hold a slash."],
  ["..", "A folder name cannot be . or .., or hold a slash."],
  ["archive", "archive already exists in this folder."],
  // Another folder on a server that tells case apart; one that does not refuses it itself.
  ["reports", null],
  ["Drafts", null],
])("checks the new folder name %j", (name, problem) => {
  expect(newFolderNameProblem(name, ["Reports", "archive"])).toBe(problem);
});
