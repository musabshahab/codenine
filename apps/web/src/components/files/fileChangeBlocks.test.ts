import { describe, expect, it } from "vite-plus/test";

import {
  diffFileAgainstBaseline,
  fileChangeBlocks,
  fileChangeMarkerCssFor,
  fileChangeMarkers,
} from "./fileChangeBlocks";

const markersFor = (baseline: string, current: string) => {
  const diff = diffFileAgainstBaseline("notes.md", baseline, current)!;
  return [...fileChangeMarkers(fileChangeBlocks(diff), diff.additionLines.length)];
};

describe("fileChangeMarkers", () => {
  it.each([
    {
      name: "marks inserted lines as added",
      baseline: "a\nb\n",
      current: "a\nnew 1\nnew 2\nb\n",
      markers: [
        [2, "added"],
        [3, "added"],
      ],
    },
    {
      name: "marks every line that replaced other lines as changed",
      baseline: "a\nb\nc\n",
      current: "a\nB\nextra\nc\n",
      markers: [
        [2, "changed"],
        [3, "changed"],
      ],
    },
    {
      name: "marks the line after a removal",
      baseline: "a\nb\nc\n",
      current: "a\nc\n",
      markers: [[2, "removed"]],
    },
    {
      name: "marks the last line when the end of the file was removed",
      baseline: "a\nb\nc\n",
      current: "a\n",
      markers: [[1, "removed"]],
    },
    {
      name: "keeps a changed line's marker when the line before it was removed",
      baseline: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
      current: "a\nc\nd\ne\nf\ng\nh\ni\nJ\n",
      markers: [
        [9, "changed"],
        [2, "removed"],
      ],
    },
  ])("$name", ({ baseline, current, markers }) => {
    expect(markersFor(baseline, current)).toEqual(markers);
  });

  it("reports each change as line ranges in the baseline and the file", () => {
    const diff = diffFileAgainstBaseline(
      "notes.md",
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
      "one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\n",
    )!;
    expect(fileChangeBlocks(diff)).toEqual([
      { baseStart: 1, baseCount: 1, currentStart: 1, currentCount: 1 },
      { baseStart: 7, baseCount: 1, currentStart: 7, currentCount: 2 },
    ]);
    // An empty side has no line to point at, and the server takes no negative index.
    const blocksFor = (baseline: string, current: string) =>
      fileChangeBlocks(diffFileAgainstBaseline("notes.md", baseline, current)!);
    expect(blocksFor("", "hello\nworld\n")).toEqual([
      { baseStart: 0, baseCount: 0, currentStart: 0, currentCount: 2 },
    ]);
    expect(blocksFor("a\nb\n", "")).toEqual([
      { baseStart: 0, baseCount: 2, currentStart: 0, currentCount: 0 },
    ]);
  });

  it("styles nothing for an unchanged file and every line of a new one", () => {
    expect(fileChangeMarkerCssFor("notes.md", "a\n", "a\n")).toBe("");
    expect(fileChangeMarkerCssFor("notes.md", null, "a\n")).toContain("[data-column-number] {");
    expect(fileChangeMarkerCssFor("notes.md", "a\n", "a\nb\n")).toContain(
      '[data-column-number="2"] {',
    );
  });
});
