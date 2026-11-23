import {
  type EnvironmentId,
  type ProjectFileVersion,
  ProjectWriteFileConflictError,
} from "@codenine/contracts";
import { squashAtomCommandFailure } from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { usePrimarySettings } from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatDayAwareTimestamp } from "~/timestampFormat";

import { reloadProjectFileQueryData } from "./projectFilesQueryState";

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);

function VersionAuthor(props: {
  readonly environmentId: EnvironmentId;
  readonly version: ProjectFileVersion;
}) {
  const { version } = props;
  const thread = useThreadShell(
    version.threadId === undefined
      ? null
      : { environmentId: props.environmentId, threadId: version.threadId },
  );
  switch (version.origin) {
    case "user":
      return "Saved in the editor";
    case "restore":
      return "Restored";
    case "external":
      return "Changed outside the editor";
    case "agent": {
      const turn = version.turnCount === undefined ? "" : `, turn ${version.turnCount}`;
      return `${thread?.title ?? "An agent"}${turn}`;
    }
  }
}

function versionSize(version: ProjectFileVersion): string {
  if (version.state === "deleted") return "File deleted";
  const size = formatBytes(version.byteLength);
  return version.state === "skipped" ? `${size}, too large to keep` : size;
}

/**
 * The versions of one file in a workspace without Git: when each was made, by whom, what it held,
 * and a way back to it. Restoring keeps the replaced contents as a version too.
 */
export function FileVersionsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /** The version on disk as the tab last read it. Missing for unsaved edits and unread files. */
  readonly currentVersion: string | undefined;
  /** True for a file the editor holds, which is only replaced when `currentVersion` still stands. */
  readonly editorHoldsFile: boolean;
  readonly canRestore: boolean;
}) {
  const { environmentId, cwd, relativePath, currentVersion } = props;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const list = useEnvironmentQuery(
    props.open
      ? projectEnvironment.listFileVersions({ environmentId, input: { cwd, relativePath } })
      : null,
  );
  const versions = list.data?.versions ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    versions.find((version) => version.id === selectedId) ??
    versions.find((version) => version.state === "stored" && version.version !== currentVersion) ??
    versions[0];
  const preview = useEnvironmentQuery(
    props.open && selected?.state === "stored"
      ? projectEnvironment.readFileVersion({
          environmentId,
          input: { cwd, relativePath, versionId: selected.id },
        })
      : null,
  );
  const restoreFileVersion = useAtomCommand(projectEnvironment.restoreFileVersion, {
    reportFailure: false,
  });
  const [restoring, setRestoring] = useState(false);
  const isCurrent = selected?.version !== undefined && selected.version === currentVersion;
  const unsavedEdits = props.editorHoldsFile && currentVersion === undefined;

  const restore = async () => {
    if (selected === undefined) return;
    setRestoring(true);
    const result = await restoreFileVersion({
      environmentId,
      input: {
        cwd,
        relativePath,
        versionId: selected.id,
        ...(currentVersion === undefined ? {} : { expectedVersion: currentVersion }),
      },
    });
    setRestoring(false);
    reloadProjectFileQueryData(environmentId, cwd, relativePath);
    list.refresh();
    if (result._tag === "Success") {
      props.onOpenChange(false);
      toastManager.add({
        type: "success",
        title: "Version restored",
        description: "The contents it replaced are kept as a version too.",
      });
      return;
    }
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not restore the version",
      description: isWriteConflict(failure)
        ? "The file changed on disk. It has been reloaded, so check it and try again."
        : failure instanceof Error
          ? failure.message
          : "Try again.",
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>
            Earlier contents of {relativePath}, kept when you save and when an agent changes the
            file.
          </DialogDescription>
        </DialogHeader>
        {list.data === null ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {list.error ?? <Spinner className="size-4" />}
          </div>
        ) : versions.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {list.data.tracked
              ? "No versions yet. One is kept the next time you save this file or an agent changes it."
              : "This workspace uses Git, so its history is in Git and in each turn's checkpoint."}
          </p>
        ) : (
          <div
            className="flex min-h-0 flex-[1_1_20rem] overflow-hidden border-t max-sm:flex-col"
            data-file-versions
          >
            <div className="min-h-0 max-sm:h-40 sm:w-64 sm:shrink-0 sm:border-r">
              <ScrollArea>
                <ul className="p-2">
                  {versions.map((version) => (
                    <li key={version.id}>
                      <button
                        type="button"
                        aria-pressed={version.id === selected?.id}
                        onClick={() => setSelectedId(version.id)}
                        className={cn(
                          "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          version.id === selected?.id && "bg-accent",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2 text-foreground">
                          {formatDayAwareTimestamp(version.createdAt, timestampFormat)}
                          {version.version !== undefined && version.version === currentVersion ? (
                            <span className="text-2xs text-muted-foreground">Current</span>
                          ) : null}
                        </span>
                        <span className="truncate text-muted-foreground">
                          <VersionAuthor environmentId={environmentId} version={version} />
                        </span>
                        <span className="text-2xs text-muted-foreground">
                          {versionSize(version)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {selected?.state !== "stored" ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {selected?.state === "deleted"
                    ? "The file was deleted here. Restore an earlier version to bring it back."
                    : "This change was recorded, but the file was too large to keep a copy of."}
                </p>
              ) : preview.data === null ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  {preview.error ?? <Spinner className="size-4" />}
                </div>
              ) : preview.data.contents === null ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No preview for this version. It can still be restored.
                </p>
              ) : (
                <ScrollArea className="min-h-0 flex-1">
                  <pre className="p-3 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                    {preview.data.contents}
                  </pre>
                </ScrollArea>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {unsavedEdits ? (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              Save your edits before restoring a version.
            </span>
          ) : null}
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={
              !props.canRestore ||
              restoring ||
              unsavedEdits ||
              isCurrent ||
              selected?.state !== "stored"
            }
            onClick={() => void restore()}
          >
            Restore this version
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
