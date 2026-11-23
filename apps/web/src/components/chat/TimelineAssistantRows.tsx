import { shouldPreserveAssistantLineBreaks } from "@codenine/shared/markdownPipeline";
import { type RunId } from "@codenine/contracts";
import { canForkProjectedAssistantItem } from "@codenine/client-runtime/state/thread-workflows";
import { memo, use, useState } from "react";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { CheckIcon, FileDownIcon, GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { checkpointFileTotals } from "@codenine/client-runtime/state/thread-checkpoints";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import {
  useAssistantMessageText,
  useProject,
  useThreadCheckpointSummaries,
  useThreadShell,
} from "../../state/entities";
import { resolveDiffPathForWorkspace } from "../../diffFileActions";
import { openFileForReview, reviewableTurnCount } from "../../fileReviewStore";
import { useCanSaveReply } from "../work/SaveReplyDialog";
import { useSaveReplyStore } from "../work/saveReplyStore";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  // The timeline holds a streaming message's row while only its text grows.
  const liveText = useAssistantMessageText(
    row.message.streaming ? ctx.threadRef : null,
    row.projectedItem?.item.id,
  );
  const text = liveText ?? row.message.text;
  const messageText = text || (row.message.streaming ? "" : "(empty response)");

  const content = (
    <>
      <div data-thread-find-text="true">
        <AssistantCitationSource
          messageId={row.message.id}
          {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
          itemKey={row.id}
          request={ctx.citationRequest}
          listRef={ctx.listRef}
        >
          <ChatMarkdown
            text={messageText}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={Boolean(row.message.streaming)}
            lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
            skills={ctx.skills}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            onUseArtifactTemplate={ctx.onUseArtifactTemplate}
            onRunShellCommand={ctx.onRunShellCommand}
            onImageExpand={ctx.onImageExpand}
          />
        </AssistantCitationSource>
      </div>
      {ctx.onOpenTurnDiff ? (
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
      ) : null}
      {row.showAssistantMeta ? (
        <AssistantMessageMeta
          className="mt-1.5"
          projectedItem={row.projectedItem}
          message={row.message}
          showCopyButton={row.showAssistantCopyButton}
          copyStreaming={row.assistantCopyStreaming}
        />
      ) : null}
    </>
  );
  if (row.taskResult) {
    return (
      <article
        aria-label="Task result"
        className="relative min-w-0 rounded-xl border border-success/32 px-4 py-3"
      >
        <div className="mb-2 flex items-center gap-2">
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
          <h3 className="font-semibold">Task result</h3>
          <span className="ms-auto text-muted-foreground text-xs">from the lead</span>
        </div>
        {content}
      </article>
    );
  }
  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>Codenine</MessageAuthorHeading>
      {content}
    </div>
  );
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  if (!canFork || onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId }).finally(
                () => setBusy(false),
              );
            }}
            aria-label="Fork from this response"
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {projectedItem.item.status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {showCopyButton && !copyStreaming && message.text ? (
        <AssistantSaveButton text={message.text} />
      ) : null}
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantForkButton projectedItem={projectedItem} />
      ) : null}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

/** Saves the reply into the workspace as a file. Hidden where the chat has no folder to save to. */
function AssistantSaveButton({ text }: { text: string }) {
  const ctx = use(TimelineRowCtx);
  const canSave = useCanSaveReply(ctx.threadRef?.environmentId ?? null, ctx.workspaceRoot);
  const threadRef = ctx.threadRef;
  if (!canSave || threadRef === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label="Save reply as file"
            onClick={() => useSaveReplyStore.getState().open(threadRef, text)}
          />
        }
      >
        <FileDownIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>Save reply as file</TooltipPopup>
    </Tooltip>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.runId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);
  // Turn summaries name files from the repository root, which can sit above the workspace.
  const repositoryRoot =
    thread?.worktreePath == null ? activeProject?.repositoryIdentity?.rootPath : undefined;
  // Only the latest turn's change can be reviewed in the file.
  const latestTurn = useThreadCheckpointSummaries(ctx.threadRef).at(-1);
  const reviewTurnCount =
    latestTurn?.runId === turnSummary.runId ? reviewableTurnCount(latestTurn, () => true) : null;
  const threadRef = ctx.threadRef;
  // A folder without Git has no checkpoint for the Diff tab to read, in any workspace type.
  const diffOffered = ctx.turnDiffTabOffered && turnSummary.status !== "missing";
  // Without a Diff tab, a file opens itself, on its review when this is the latest turn.
  const openInFile = (_runId: RunId, filePath?: string) => {
    const relativePath =
      filePath === undefined
        ? null
        : resolveDiffPathForWorkspace({
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot,
          });
    if (threadRef && relativePath !== null) {
      openFileForReview(threadRef, relativePath, reviewTurnCount);
    }
  };

  return (
    <ChangedFilesCard
      runId={turnSummary.runId}
      files={checkpointFiles}
      totals={checkpointFileTotals(turnSummary)}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.runId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={diffOffered ? onOpenTurnDiff : openInFile}
      fullDiffOffered={diffOffered}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            review:
              threadRef && reviewTurnCount !== null
                ? { threadRef, turnCount: reviewTurnCount }
                : null,
            repositoryRoot,
          },
          event,
        )
      }
    />
  );
}
