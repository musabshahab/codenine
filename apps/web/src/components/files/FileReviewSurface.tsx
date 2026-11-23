import {
  type EnvironmentId,
  type ProjectFileLineChange,
  ProjectWriteFileConflictError,
  type ScopedThreadRef,
} from "@codenine/contracts";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { diffFileAgainstBaseline, fileChangeBlocks } from "./fileChangeBlocks";
import { FileSurfaceBar } from "./fileSurfaceChrome";
import { reloadProjectFileQueryData } from "./projectFilesQueryState";

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);

interface ReviewChange {
  readonly key: string;
  readonly change: ProjectFileLineChange;
}

/** Baseline line numbers hold for the whole review, so they identify a change across discards. */
const changeKey = (change: ProjectFileLineChange, added: ReadonlyArray<string>) =>
  `${change.baseStart}:${change.baseCount}:${added.join("")}`;

/**
 * The latest turn's change to one file, as a diff against the turn's start, with Keep and
 * Discard for the file and for each change. Discard restores the earlier text on the server,
 * which refuses when the file is no longer the version shown here.
 */
export function FileReviewSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly turnCount: number;
  /** Null when the turn created the file. */
  readonly baseline: string | null;
  readonly contents: string;
  /** Missing while the file has unsaved edits or the server reports no version. */
  readonly version: string | undefined;
  readonly canDiscard: boolean;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
  readonly onKeep: () => void;
  readonly onClose: () => void;
}) {
  const { environmentId, cwd, relativePath, version } = props;
  const revertFileChange = useAtomCommand(projectEnvironment.revertFileChange, {
    reportFailure: false,
  });
  const [keptChangeKeys, setKeptChangeKeys] = useState<ReadonlySet<string>>(() => new Set());
  // The version a discard was sent for; its buttons stay off until the file reads back changed.
  const [revertedVersion, setRevertedVersion] = useState<string | null>(null);
  const diff = diffFileAgainstBaseline(relativePath, props.baseline ?? "", props.contents);
  const changes: ReadonlyArray<ReviewChange> =
    diff === null
      ? []
      : fileChangeBlocks(diff).map((change) => ({
          change,
          key: changeKey(
            change,
            diff.additionLines.slice(
              change.currentStart,
              change.currentStart + change.currentCount,
            ),
          ),
        }));
  const openChanges = changes.filter((entry) => !keptChangeKeys.has(entry.key));
  const discardDisabled = !props.canDiscard || version === undefined || version === revertedVersion;

  const discard = async (change: ProjectFileLineChange | undefined) => {
    if (version === undefined) return;
    setRevertedVersion(version);
    const result = await revertFileChange({
      environmentId,
      input: {
        cwd,
        relativePath,
        threadId: props.threadRef.threadId,
        turnCount: props.turnCount,
        expectedVersion: version,
        ...(change === undefined ? {} : { change }),
      },
    });
    reloadProjectFileQueryData(environmentId, cwd, relativePath);
    if (result._tag === "Success") {
      if (change === undefined) props.onClose();
      return;
    }
    setRevertedVersion(null);
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not discard the change",
      description: isWriteConflict(failure)
        ? "The file changed on disk. It has been reloaded, so check the change and try again."
        : failure instanceof Error
          ? failure.message
          : "Try again.",
    });
  };

  const keepChange = (key: string) => {
    if (openChanges.length === 1 && openChanges[0]?.key === key) {
      props.onKeep();
      return;
    }
    setKeptChangeKeys((current) => new Set(current).add(key));
  };

  const lineAnnotations: DiffLineAnnotation<ReviewChange>[] = openChanges.map((entry) =>
    entry.change.currentCount > 0
      ? {
          side: "additions",
          lineNumber: entry.change.currentStart + entry.change.currentCount,
          metadata: entry,
        }
      : {
          side: "deletions",
          lineNumber: entry.change.baseStart + entry.change.baseCount,
          metadata: entry,
        },
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-review>
      <FileSurfaceBar
        actions={
          <>
            <Button type="button" size="micro" variant="outline" onClick={props.onKeep}>
              Keep
            </Button>
            <Button
              type="button"
              size="micro"
              variant="destructive-outline"
              disabled={discardDisabled}
              onClick={() => void discard(undefined)}
            >
              {props.baseline === null ? "Discard file" : "Discard"}
            </Button>
            <Button type="button" size="micro" variant="ghost-muted" onClick={props.onClose}>
              Back to editing
            </Button>
          </>
        }
      >
        {props.baseline === null
          ? "The agent created this file in its last turn."
          : "Changes the agent made to this file in its last turn."}
        {version === undefined && props.canDiscard ? " Save your edits to discard changes." : ""}
      </FileSurfaceBar>
      {diff === null ? (
        <div className="p-4 text-xs text-muted-foreground">
          This file is too large to show its changes here.
        </div>
      ) : (
        <DiffWorkerPoolProvider>
          <Virtualizer
            className="min-h-0 flex-1 overflow-auto"
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            <FileDiff<ReviewChange>
              fileDiff={diff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                disableFileHeader: true,
                overflow: props.wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(props.resolvedTheme),
                themeType: props.resolvedTheme,
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
              }}
              lineAnnotations={lineAnnotations}
              renderAnnotation={(annotation) => (
                <div className="flex items-center gap-1.5 px-2 py-1 font-sans">
                  <Button
                    type="button"
                    size="micro"
                    variant="outline"
                    onClick={() => keepChange(annotation.metadata.key)}
                  >
                    Keep change
                  </Button>
                  <Button
                    type="button"
                    size="micro"
                    variant="destructive-outline"
                    disabled={discardDisabled}
                    // A file the turn created is one change, and discarding it removes the file.
                    onClick={() =>
                      void discard(props.baseline === null ? undefined : annotation.metadata.change)
                    }
                  >
                    Discard change
                  </Button>
                </div>
              )}
              className="min-h-full"
            />
          </Virtualizer>
        </DiffWorkerPoolProvider>
      )}
    </div>
  );
}
