import { Columns3Icon, MessageSquareIcon, PanelRightIcon } from "lucide-react";
import { Maximize2, Minimize2 } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { memo, type ReactNode } from "react";

import type { FileView } from "~/documentView.logic";
import { cn } from "~/lib/utils";

import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PanelLayoutControlsProps {
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  onToggleRightPanel: () => void;
}

/** The right panel toggle; the thread header holds the other panel toggles. */
export const PanelLayoutControls = memo(function PanelLayoutControls({
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={rightPanelOpen}
            onPressedChange={onToggleRightPanel}
            aria-label="Toggle right panel"
            data-right-panel-toggle
            variant="ghost-muted"
            size="sm"
            disabled={!rightPanelAvailable}
          >
            <PanelRightIcon className="size-4" />
          </Toggle>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {rightPanelAvailable
            ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
            : rightPanelUnavailableLabel}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const label = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost-muted"
            size="sm"
          >
            <MorphIcon className="size-4" icon={maximized ? Minimize2 : Maximize2} />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/** Switches an open file between the main stage with the chat beside it and the panel beside the chat. */
export const FileViewSwitch = memo(function FileViewSwitch(props: {
  readonly view: FileView;
  readonly shortcutLabel: string | null;
  readonly onToggle: () => void;
}) {
  const document = props.view === "document";
  const label = document ? "Switch to chat view" : "Switch to document view";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={document}
            onPressedChange={props.onToggle}
            aria-label="Document view"
            data-file-view-switch={props.view}
            variant="ghost-muted"
            size="sm"
          >
            <Columns3Icon className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {label}
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
        <span className="block text-muted-foreground">
          {document
            ? "The chat is the main column and files open beside it."
            : "The file is the main column and the chat sits beside it."}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});

/** Opens the chat over the file on a narrow screen. Its dot shows that the chat has moved on. */
export const ChatSlideOverToggle = memo(function ChatSlideOverToggle(props: {
  readonly open: boolean;
  readonly unread: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.open ? "Hide chat" : props.unread ? "Show chat, new activity" : "Show chat";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="relative shrink-0 [-webkit-app-region:no-drag]"
            pressed={props.open}
            onPressedChange={props.onToggle}
            aria-label={label}
            data-chat-slide-over-toggle
            variant="ghost-muted"
            size="sm"
          >
            <MessageSquareIcon className="size-4" />
            {props.unread ? (
              <span
                aria-hidden
                data-chat-unread
                className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/** The window's top-right panel controls, with the maximize toggle while the panel is open. */
export function WorkspaceTitlebarControls(props: {
  readonly showMaximizeControl: boolean;
  readonly rightPanelOpen: boolean;
  readonly animationsActive: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="pointer-events-none fixed top-[calc(var(--workspace-controls-top)+var(--workspace-frame,0px))] right-[calc(var(--workspace-controls-right)+var(--workspace-frame,0px))] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      {props.showMaximizeControl ? (
        <span
          aria-hidden={!props.rightPanelOpen}
          // Fading out on close would show it beside the thread details toggle that replaces it.
          className={cn(
            "flex shrink-0",
            props.rightPanelOpen &&
              props.animationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            props.rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!props.rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={props.maximized}
            onToggle={props.onToggleMaximized}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{props.children}</div>
    </div>
  );
}
