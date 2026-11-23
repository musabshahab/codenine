import type { EnvironmentId, ScopedThreadRef } from "@codenine/contracts";
import { IsoDateTime } from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";
import { HistoryIcon } from "lucide-react";

import { openFileForReview, openFileVersions } from "~/fileReviewStore";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useQuietThreadShell, useThreadCheckpointSummaries } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatDayAwareTimestamp } from "~/timestampFormat";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { revisionedQuery } from "~/state/revisionedQuery";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import {
  deriveFileActivity,
  FILE_ACTIVITY_CHANGE_LABELS,
  type FileActivityEntry,
} from "./fileActivity.logic";

/** Changes to the workspace's files made in this chat, newest first. */
export default function ActivityPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  /** Changes after each turn and save, so the list is read again. */
  readonly workspaceMutationId: string | null;
  /** True where the folder has no Git, so the server keeps versions of its files. */
  readonly versionsOffered: boolean;
}) {
  const { threadRef, environmentId, workspaceRoot } = props;
  const { resolvedTheme } = useTheme();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useQuietThreadShell(threadRef);
  const checkpoints = useThreadCheckpointSummaries(threadRef);
  const since = shell?.createdAt ?? null;
  // Older servers do not list recorded changes, so there only the turns' changes show.
  const recorded = useEnvironmentQuery(
    serverConfig?.environment.capabilities.fileActivity === true &&
      workspaceRoot !== undefined &&
      since !== null
      ? revisionedQuery(
          projectEnvironment.listFileActivity({
            environmentId,
            input: { cwd: workspaceRoot, since: IsoDateTime.make(since) },
          }),
          props.workspaceMutationId,
        )
      : null,
  );
  const activity = deriveFileActivity({
    threadId: threadRef.threadId,
    since,
    checkpoints,
    recorded: recorded.data?.entries ?? [],
  });
  const latestTurnCount = checkpoints.at(-1)?.checkpointTurnCount ?? null;

  if (activity.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>No changes yet</EmptyTitle>
          <EmptyDescription>
            {props.versionsOffered
              ? "Files the agent edits, creates or deletes in this chat are listed here, with your own saves, restores and signatures, newest first."
              : "Files the agent edits, creates or deletes in this chat are listed here, newest first."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const open = (entry: FileActivityEntry) => {
    // Only the latest turn's change is reviewed in the file. Earlier ones are in its versions.
    if (entry.turnCount !== null && entry.turnCount === latestTurnCount) {
      openFileForReview(threadRef, entry.path, entry.turnCount);
    } else if (props.versionsOffered) openFileVersions(threadRef, entry.path);
    else openFileForReview(threadRef, entry.path, null);
  };
  const opens = (entry: FileActivityEntry) =>
    entry.turnCount !== null && entry.turnCount === latestTurnCount
      ? "Review this change"
      : props.versionsOffered
        ? "Show this file's versions"
        : "Open this file";

  return (
    <section aria-label="Activity" className="flex min-h-0 flex-1 flex-col text-sm">
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <ul className="p-2">
          {activity.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                aria-label={`${entry.path}. ${opens(entry)}`}
                onClick={() => open(entry)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <PierreEntryIcon
                  pathValue={entry.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{entry.path}</span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {FILE_ACTIVITY_CHANGE_LABELS[entry.change]} by{" "}
                    {entry.turnCount === null ? "you" : `the agent in turn ${entry.turnCount}`}
                  </span>
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {formatDayAwareTimestamp(entry.at, timestampFormat)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </section>
  );
}
