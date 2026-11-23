import { type ComponentType, type ReactNode, use } from "react";
import { ChevronLeftIcon, ChevronRightIcon, FileWarningIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { FileToolSlotContext } from "./explorerPlacement";

export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

export const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  /* Tint through --diffs-line-bg, not background-color. The editor paints row
     tints on a layer below its text selection; a background on the row itself
     covers the selection and makes selected text on this line invisible. */
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    --diffs-line-bg: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }
`;

/** Widths of the tool row, measured on the tools themselves, at which labels take over from icons. */
const COLLAPSED_TOOL = {
  narrow: { icon: "contents @[18.5rem]/tools:hidden", label: "hidden @[18.5rem]/tools:inline" },
  wide: { icon: "contents @[27.5rem]/tools:hidden", label: "hidden @[27.5rem]/tools:inline" },
} as const;

export function FileSurfaceAction(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const pressed = props.pressed;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          pressed === undefined ? (
            <Button
              type="button"
              className="shrink-0"
              disabled={props.disabled ?? false}
              onClick={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="icon-xs"
            >
              {props.children}
            </Button>
          ) : (
            <Toggle
              className="shrink-0"
              pressed={pressed}
              disabled={props.disabled ?? false}
              onPressedChange={props.onPress}
              aria-label={props.label}
              variant="ghost"
              size="xs"
            >
              {props.children}
            </Toggle>
          )
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A tool named in words, with an icon or without. `hint` says more in a tooltip; a `pressed`
 * tool is one that stays on, such as the tool a click on the page uses.
 */
export function FileToolButton(props: {
  readonly label: string;
  /** What the tool is called in full, where the label is a short form of it. */
  readonly name?: string;
  readonly hint?: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  /**
   * The tool shows its icon alone in a row too narrow for its label, and its label alone in a
   * wider one, so it needs an icon. Names how wide the row is before the label shows.
   */
  readonly collapse?: keyof typeof COLLAPSED_TOOL;
  /** An icon before the label. */
  readonly children?: ReactNode;
}) {
  const { pressed } = props;
  const collapsed = props.collapse === undefined ? null : COLLAPSED_TOOL[props.collapse];
  const content =
    collapsed === null ? (
      <>
        {props.children}
        {props.label}
      </>
    ) : (
      <>
        <span className={collapsed.icon}>{props.children}</span>
        <span className={collapsed.label}>{props.label}</span>
      </>
    );
  const fullName = props.name ?? props.label;
  const name = props.collapse || props.name !== undefined ? { "aria-label": fullName } : {};
  // A button, not a toggle, so a tool that stays on is the same size as the ones beside it.
  const button = (
    <Button
      type="button"
      className="shrink-0"
      disabled={props.disabled ?? false}
      onClick={props.onPress}
      variant="ghost"
      size="xs"
      {...name}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      {...(pressed === true ? { "data-pressed": "" } : {})}
    >
      {content}
    </Button>
  );
  const hint = props.hint ?? (props.collapse || props.name !== undefined ? fullName : undefined);
  if (hint === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

export function FileToolSeparator() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/** What the tool row says about the file at its end: whether it is saved, or cannot be changed. */
export function FileToolStatus(props: {
  readonly busy?: boolean;
  /** A narrow row drops the words: for a state the button beside it tells as well. */
  readonly brief?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center gap-1 px-1.5 text-2xs whitespace-nowrap text-muted-foreground"
    >
      {props.busy ? <Spinner size="xs" /> : null}
      {props.brief ? (
        <span className="sr-only @[26rem]/toolrow:not-sr-only">{props.children}</span>
      ) : (
        props.children
      )}
    </span>
  );
}

/**
 * Kept in view at the end of a tool row that scrolls sideways: the menu that holds every tool
 * the row has no room for, so none of them is out of reach or out of sight.
 */
export function FileToolRowPinned(props: { readonly children: ReactNode }) {
  return (
    <span className="sticky right-0 z-10 flex shrink-0 items-center bg-background pl-0.5">
      {props.children}
    </span>
  );
}

/**
 * An editor's tools. A row of its own beside the chat; on the stage of document view they join
 * the stage's one tool row. The tools are a size container named `tools`, so a tool can give
 * way by the room the tools themselves have, wherever the row is.
 */
export function FileToolRow(props: {
  readonly label: string;
  /** The tools wrap onto more lines instead of scrolling sideways. */
  readonly wrap?: boolean;
  /** Shown only on the stage: beside the chat the tools are not worth a row of their own. */
  readonly stageOnly?: boolean;
  /** Kept in view at the end of the row, such as the save state. */
  readonly end?: ReactNode;
  readonly children: ReactNode;
}) {
  const slot = use(FileToolSlotContext);
  if (slot === null ? props.stageOnly === true : slot.element === null) return null;
  const row = (
    <>
      <div
        role="toolbar"
        aria-label={props.label}
        className={cn(
          "@container/tools flex min-w-0 flex-1 items-center gap-0.5 text-xs",
          // One line of tools scrolls sideways where there is no room for all of them.
          props.wrap
            ? "flex-wrap"
            : "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {props.children}
      </div>
      {props.end}
    </>
  );
  if (slot !== null && slot.element !== null) return createPortal(row, slot.element);
  return (
    <div
      className={cn(
        "@container/toolrow flex shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs",
        props.wrap ? "min-h-9 py-1" : "h-9",
      )}
    >
      {row}
    </div>
  );
}

const BAR_TONES = {
  neutral: "border-border/60 bg-muted/40 text-muted-foreground",
  warning: "border-warning/20 bg-warning-surface text-warning-foreground",
} as const;

/** A line under the tools that states something about the file and offers what to do about it. */
export function FileSurfaceBar(props: {
  readonly tone?: "warning";
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-2xs leading-relaxed",
        BAR_TONES[props.tone ?? "neutral"],
      )}
    >
      <span className="min-w-48 flex-1">{props.children}</span>
      {props.actions ? (
        <span className="flex shrink-0 items-center gap-1.5">{props.actions}</span>
      ) : null}
    </div>
  );
}

/** A warning about how the file is shown, with nothing to do about it. */
export function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return <FileSurfaceBar tone="warning">{props.children}</FileSurfaceBar>;
}

/** One line under the document: a hint while idle, or what the selection adds up to. */
export function FileStatusBar(props: { readonly children: ReactNode }) {
  return (
    <div className="@container/status flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-border/60 bg-muted/40 px-3 text-2xs whitespace-nowrap text-muted-foreground">
      {props.children}
    </div>
  );
}

/** Steps through a paged document. It sits in the status bar under every one of them. */
export function FilePager(props: {
  readonly noun: "Page" | "Slide";
  readonly index: number;
  /** Null until the document has been read. */
  readonly count: number | null;
  readonly onShow: (index: number) => void;
}) {
  const { noun, index, count } = props;
  const name = noun.toLowerCase();
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <FileSurfaceAction
        label={`Previous ${name}`}
        disabled={count === null || index === 0}
        onPress={() => props.onShow(index - 1)}
      >
        <ChevronLeftIcon className="size-3.5" />
      </FileSurfaceAction>
      <span className="px-1 tabular-nums" aria-live="polite">
        {count === null ? noun : `${noun} ${index + 1} of ${count}`}
      </span>
      <FileSurfaceAction
        label={`Next ${name}`}
        disabled={count === null || index + 1 >= count}
        onPress={() => props.onShow(index + 1)}
      >
        <ChevronRightIcon className="size-3.5" />
      </FileSurfaceAction>
    </span>
  );
}

export function FileSurfaceLoading(props: { readonly className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground",
        props.className,
      )}
    >
      <Spinner size="lg" />
      <span>Opening…</span>
    </div>
  );
}

/**
 * What stands where a document would be when there is none to show: why, and what to do next.
 * `alert` announces it as a failure.
 */
export function FileSurfaceMessage(props: {
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly title: string;
  readonly alert?: boolean;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div
      role={props.alert ? "alert" : "status"}
      className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto px-6 py-8 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        {props.children ? (
          <div className="text-xs leading-relaxed text-muted-foreground">{props.children}</div>
        ) : null}
      </div>
      {props.actions ? <div className="flex items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}

export function FileSurfaceFailure(props: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <FileSurfaceMessage
      icon={FileWarningIcon}
      title="This file could not be opened"
      alert
      actions={
        props.onRetry ? (
          <Button type="button" variant="outline" size="xs" onClick={props.onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {props.message}
    </FileSurfaceMessage>
  );
}
