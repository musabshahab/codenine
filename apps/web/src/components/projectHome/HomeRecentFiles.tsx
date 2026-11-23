import type { EnvironmentId, VcsStatusResult } from "@codenine/contracts";
import { PositiveInt } from "@codenine/contracts";

import { useTheme } from "~/hooks/useTheme";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  fileTypeTag,
  HOME_FILE_ACTIVITY_LIMIT,
  HOME_FOLDER_FILE_LIMIT,
  homeFolderFiles,
  recentFilesFromActivity,
  recentFilesFromWorkingTree,
} from "../pages/projectHome.logic";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { HomeEmpty, HomeSection } from "./HomeSection";

const ACTIVITY_LIMIT = PositiveInt.make(HOME_FILE_ACTIVITY_LIMIT);
const FOLDER_LIMIT = PositiveInt.make(HOME_FOLDER_FILE_LIMIT);
// Two rows of tiles: what loading, an empty folder and up to four files all take up.
const RESERVED = "min-h-[6.5rem] max-sm:min-h-0";
const SKELETON_WIDTHS = ["w-32", "w-24", "w-40", "w-28"];

/**
 * The workspace's files. A workspace that shows its checkout lists the files with uncommitted
 * changes, from the status the page already follows. Any other lists what is in its folder,
 * recently changed files first, so a folder of existing documents opens from here.
 */
export function HomeRecentFiles(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Nothing is asked of a machine that is not connected, and nothing pretends to load. */
  readonly connected: boolean;
  /** Whether this kind of workspace shows its checkout. */
  readonly checkout: boolean;
  /** Null while the folder's Git state is not known. */
  readonly git: Pick<VcsStatusResult, "isRepo" | "workingTree"> | null;
  /** Why the Git state could not be read, when it could not. */
  readonly gitError: string | null;
  /** Older servers do not list recorded changes. */
  readonly fileActivity: boolean;
  readonly nowMs: number;
  readonly onOpen: (path: string) => void;
  /** Opens the whole folder beside a chat. */
  readonly onBrowse: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const { connected, environmentId } = props;
  const changes = props.checkout && props.git?.isRepo === true;
  const awaitingGit = props.checkout && props.git === null && props.gitError === null;
  const folder = connected && !changes && !awaitingGit;
  const access = useFilesystemReadAccess(folder ? environmentId : null);
  const recorded = useEnvironmentQuery(
    folder && props.fileActivity
      ? projectEnvironment.listFileActivity({
          environmentId,
          input: { cwd: props.workspaceRoot, limit: ACTIVITY_LIMIT },
        })
      : null,
  );
  const listed = useEnvironmentQuery(
    folder && access.canReadFiles
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd: props.workspaceRoot, query: "", limit: FOLDER_LIMIT, kind: "file" },
        })
      : null,
  );
  const files =
    changes && props.git !== null
      ? recentFilesFromWorkingTree(props.git.workingTree, props.workspaceRoot)
      : homeFolderFiles(
          recentFilesFromActivity(recorded.data?.entries ?? []),
          listed.data?.entries ?? [],
        );
  const unsettled = (query: { data: unknown; error: string | null }) =>
    query.data === null && query.error === null;
  const loading =
    awaitingGit ||
    (folder &&
      ((props.fileActivity && unsettled(recorded)) ||
        access.isPending ||
        (access.canReadFiles && unsettled(listed))));
  const failure = folder && files.length === 0 ? (listed.error ?? recorded.error) : null;

  return (
    <HomeSection
      title={changes ? "Changed files" : "Files"}
      note={files.length > 0 && changes ? "Not committed yet" : null}
      actions={
        connected && !changes && !awaitingGit ? (
          <InlineButton onClick={props.onBrowse}>Browse all</InlineButton>
        ) : null
      }
    >
      {!connected ? (
        <HomeEmpty className={RESERVED}>Reconnect this machine to see its files.</HomeEmpty>
      ) : failure !== null ? (
        <HomeEmpty className={RESERVED}>
          The files could not be listed. {failure}{" "}
          <InlineButton
            onClick={() => {
              recorded.refresh();
              listed.refresh();
            }}
          >
            Try again
          </InlineButton>
        </HomeEmpty>
      ) : loading && files.length === 0 ? (
        <div aria-hidden className={`grid content-start gap-2 sm:grid-cols-2 ${RESERVED}`}>
          {SKELETON_WIDTHS.map((width) => (
            <div
              key={width}
              className="flex h-12 items-center gap-3 rounded-xl border border-border px-3"
            >
              <Skeleton className="size-5" />
              <div className={width}>
                <Skeleton className="h-3.5 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : files.length === 0 ? (
        <HomeEmpty className={RESERVED}>
          {changes
            ? "No uncommitted changes. Files you or an agent edit show here until they are committed."
            : "This folder has no files yet. Files you or an agent save in it show here."}
        </HomeEmpty>
      ) : (
        <ul className={`grid content-start gap-2 sm:grid-cols-2 ${RESERVED}`}>
          {files.map((file) => {
            const tag = changes ? null : fileTypeTag(file.name);
            const where = [file.folder, file.detail].filter(Boolean).join(" · ");
            return (
              <li key={file.path} className="min-w-0">
                <button
                  type="button"
                  onClick={() => props.onOpen(file.path)}
                  className="flex h-12 w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <PierreEntryIcon
                    pathValue={file.path}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground text-sm">{file.name}</span>
                    {where === "" ? null : (
                      <span className="truncate text-muted-foreground text-xs">{where}</span>
                    )}
                  </span>
                  {file.at === null ? null : (
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {formatElapsedDurationLabel(file.at, props.nowMs)}
                    </span>
                  )}
                  {tag === null ? null : (
                    <Badge variant="outline" size="sm">
                      {tag}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </HomeSection>
  );
}
