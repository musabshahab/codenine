import { describe, expect, it } from "vite-plus/test";

import { turnUndoFiles } from "./turnUndo.logic";

describe("turnUndoFiles", () => {
  const input = { workspaceRoot: "/repo/app", repositoryRoot: "/repo" };
  it.each([
    [
      "every listed file inside the workspace",
      [{ path: "app/a.md" }, { path: "app/docs/b.md" }],
      2,
      ["a.md", "docs/b.md"],
    ],
    ["nothing when some changed files are not listed", [{ path: "app/a.md" }], 3, []],
    [
      "nothing when a file is outside the workspace",
      [{ path: "app/a.md" }, { path: "other/b.md" }],
      2,
      [],
    ],
    ["nothing for an empty change", [], 0, []],
  ] as const)("offers %s", (_name, files, totalCount, expected) => {
    expect(turnUndoFiles({ ...input, files, totalCount })).toEqual(expected);
  });
});
