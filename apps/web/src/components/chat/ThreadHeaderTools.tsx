import { formatDiffCount } from "@codenine/client-runtime/diff-count";
import type { EnvironmentId } from "@codenine/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";
import { DiffIcon, FolderIcon, ListIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { vcsEnvironment } from "../../state/vcs";
import { resolveChangesTotals } from "../GitActionsControl.logic";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Its own slice of the status stream the chat view already holds, so a changed line count
// re-renders only the Changes button.
const changesTotalsAtom = Atom.family((status: ReturnType<typeof vcsEnvironment.status>) =>
  Atom.map(status, (result) => {
    const data = AsyncResult.getOrElse(result, () => null);
    if (data === null || !data.isRepo) return null;
    const totals = resolveChangesTotals(data);
    return { insertions: totals?.insertions ?? 0, deletions: totals?.deletions ?? 0 };
  }).pipe(Atom.withEquality(Equal.equals)),
);
const NO_CHANGES_TOTALS_ATOM: ReturnType<typeof changesTotalsAtom> = Atom.make(null);

function shortcutSuffix(label: string | null) {
  return label ? ` (${label})` : "";
}

function HeaderToolToggle(props: {
  label: string;
  tooltip: string;
  pressed: boolean;
  disabled?: boolean;
  onToggle?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={props.label}
            pressed={props.pressed}
            onPressedChange={props.onToggle}
            disabled={props.disabled}
            variant="ghost"
            size="sm"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface ThreadDetailsTool {
  open: boolean;
  presentation: ThreadPanelPresentation;
  popoverHandle: ReturnType<typeof PopoverCreateHandle>;
  shortcutLabel: string | null;
  onToggle: () => void;
}

/** Opens the thread's details card: workspace, branch, git actions, usage and context. */
function ThreadDetailsToolToggle(props: ThreadDetailsTool) {
  const tooltip = `Details${shortcutSuffix(props.shortcutLabel)}`;
  if (props.presentation !== "popover") {
    return (
      <HeaderToolToggle
        label="Details"
        tooltip={tooltip}
        pressed={props.open}
        onToggle={props.onToggle}
      >
        <ListIcon />
      </HeaderToolToggle>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <PopoverTrigger
          handle={props.popoverHandle}
          render={<Toggle aria-label="Details" pressed={props.open} variant="ghost" size="sm" />}
        >
          <ListIcon />
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The tools beside a project thread's title: its project command, then the panels it opens.
 * Labels give way to icons as the header narrows.
 */
export function ThreadHeaderTools(props: {
  environmentId: EnvironmentId;
  /** The project's command button, such as Dev; null when the project has none. */
  scripts: ReactNode;
  details: ThreadDetailsTool;
  terminal: { open: boolean; shortcutLabel: string | null; onToggle: () => void } | null;
  /** Null when the thread has no diff to show, such as a draft. */
  changes: {
    gitCwd: string | null;
    open: boolean;
    shortcutLabel: string | null;
    onToggle: () => void;
  } | null;
  files: { open: boolean; onToggle: () => void } | null;
}) {
  const { changes } = props;
  const totals = useAtomValue(
    changes === null || changes.gitCwd === null
      ? NO_CHANGES_TOTALS_ATOM
      : changesTotalsAtom(
          vcsEnvironment.status({
            environmentId: props.environmentId,
            input: { cwd: changes.gitCwd },
          }),
        ),
  );
  const hasChanges = totals !== null && (totals.insertions > 0 || totals.deletions > 0);
  return (
    <>
      {props.scripts === null ? null : (
        <span className="hidden items-center @md/header-actions:flex">
          {props.scripts}
          <span aria-hidden className="mx-1.5 h-4.5 w-px bg-border" />
        </span>
      )}
      <ThreadDetailsToolToggle {...props.details} />
      {props.terminal === null ? null : (
        <HeaderToolToggle
          label="Terminal"
          tooltip={`Terminal${shortcutSuffix(props.terminal.shortcutLabel)}`}
          pressed={props.terminal.open}
          onToggle={props.terminal.onToggle}
        >
          <TerminalIcon />
        </HeaderToolToggle>
      )}
      {changes === null ? null : (
        <HeaderToolToggle
          label={
            hasChanges
              ? `Changes: ${totals.insertions} added, ${totals.deletions} removed`
              : "Changes"
          }
          tooltip={`Changes${shortcutSuffix(changes.shortcutLabel)}`}
          pressed={changes.open}
          onToggle={changes.onToggle}
        >
          <DiffIcon />
          {hasChanges ? (
            <span className="hidden gap-1.5 font-mono text-xs tabular-nums @xl/header-actions:flex">
              <span className="text-diff-addition-foreground">
                +{formatDiffCount(totals.insertions)}
              </span>
              <span className="text-diff-deletion-foreground">
                −{formatDiffCount(totals.deletions)}
              </span>
            </span>
          ) : null}
        </HeaderToolToggle>
      )}
      {props.files === null ? null : (
        <HeaderToolToggle
          label="Files"
          tooltip="Files"
          pressed={props.files.open}
          onToggle={props.files.onToggle}
        >
          <FolderIcon />
        </HeaderToolToggle>
      )}
    </>
  );
}
