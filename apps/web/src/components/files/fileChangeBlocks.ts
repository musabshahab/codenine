import type { ProjectFileLineChange } from "@codenine/contracts";
import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";

export type FileChangeMarker = "added" | "changed" | "removed";

/** Above this size the line diff costs more than a marker or an in-file review is worth. */
const FILE_CHANGE_DIFF_MAX_CHARS = 500_000;

const MAX_MARKED_LINES = 4_000;

/** The diff of a file against its baseline; null when the baseline is absent or too large. */
export function diffFileAgainstBaseline(
  name: string,
  baseline: string,
  current: string,
): FileDiffMetadata | null {
  if (baseline.length > FILE_CHANGE_DIFF_MAX_CHARS || current.length > FILE_CHANGE_DIFF_MAX_CHARS) {
    return null;
  }
  return parseDiffFromFile({ name, contents: baseline }, { name, contents: current });
}

/** Each run of changed lines, as zero-based line ranges in the baseline and in the file. */
export function fileChangeBlocks(diff: Pick<FileDiffMetadata, "hunks">): ProjectFileLineChange[] {
  return diff.hunks.flatMap((hunk) =>
    hunk.hunkContent.flatMap((content) =>
      content.type === "change"
        ? [
            {
              baseStart: content.deletionLineIndex,
              baseCount: content.deletions,
              currentStart: content.additionLineIndex,
              currentCount: content.additions,
            },
          ]
        : [],
    ),
  );
}

/**
 * Gutter markers by one-based line number. A removal marks the line that now follows it, or the
 * last line when it was the end of the file, and never replaces that line's own marker.
 */
export function fileChangeMarkers(
  blocks: ReadonlyArray<ProjectFileLineChange>,
  lineCount: number,
): Map<number, FileChangeMarker> {
  const markers = new Map<number, FileChangeMarker>();
  for (const block of blocks) {
    const marker = block.baseCount === 0 ? "added" : "changed";
    for (let offset = 0; offset < block.currentCount; offset += 1) {
      markers.set(block.currentStart + offset + 1, marker);
    }
  }
  for (const block of blocks) {
    if (block.currentCount > 0) continue;
    const line = Math.max(1, Math.min(block.currentStart + 1, lineCount));
    if (!markers.has(line)) markers.set(line, "removed");
  }
  return markers;
}

const MARKER_STYLE: Record<FileChangeMarker, string> = {
  added:
    "background-image: linear-gradient(var(--diff-addition), var(--diff-addition)); background-size: 3px 100%;",
  changed:
    "background-image: linear-gradient(var(--info), var(--info)); background-size: 3px 100%;",
  removed:
    "background-image: linear-gradient(var(--diff-deletion), var(--diff-deletion)); background-size: 9px 3px;",
};

/**
 * Styles the gutter cells by line number, so markers hold while rows are virtualised and while
 * the editor redraws them. Files with more marked lines than the cap get no markers.
 */
function fileChangeMarkerCss(markers: ReadonlyMap<number, FileChangeMarker>): string {
  if (markers.size === 0 || markers.size > MAX_MARKED_LINES) return "";
  const selectors: Record<FileChangeMarker, string[]> = { added: [], changed: [], removed: [] };
  for (const [line, marker] of markers) {
    selectors[marker].push(`[data-column-number="${line}"]`);
  }
  return (["added", "changed", "removed"] as const)
    .filter((marker) => selectors[marker].length > 0)
    .map(
      (marker) =>
        `${selectors[marker].join(",")} { ${MARKER_STYLE[marker]} background-repeat: no-repeat; background-position: left top; }`,
    )
    .join("\n");
}

const ALL_LINES_ADDED_CSS = `[data-column-number] { ${MARKER_STYLE.added} background-repeat: no-repeat; background-position: left top; }`;

/** Marker CSS for a file against its last committed text; null text means the file is new. */
export function fileChangeMarkerCssFor(
  name: string,
  baseline: string | null,
  current: string,
): string {
  if (baseline === null) return ALL_LINES_ADDED_CSS;
  if (baseline === current) return "";
  const diff = diffFileAgainstBaseline(name, baseline, current);
  if (diff === null) return "";
  return fileChangeMarkerCss(fileChangeMarkers(fileChangeBlocks(diff), diff.additionLines.length));
}
