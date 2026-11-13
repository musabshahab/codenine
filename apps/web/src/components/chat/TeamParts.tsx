import type { TeamAgentRole, TeamWorkspace } from "@codenine/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  CodeIcon,
  CornerDownRightIcon,
  EyeIcon,
  FlaskConicalIcon,
  type LucideIcon,
  MapIcon,
  PenLineIcon,
  PuzzleIcon,
  SearchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export const TEAM_ROLE_LABELS: Record<TeamAgentRole, string> = {
  plan: "Plan",
  research: "Research",
  implement: "Implement",
  test: "Test",
  review: "Review",
  integrate: "Integrate",
  custom: "Custom",
};

export const TEAM_WORKSPACE_LABELS: Record<TeamWorkspace, string> = {
  shared: "Shared checkout",
  worktree: "Own worktree",
};

const ROLE_LOOK: Record<TeamAgentRole, { Icon: LucideIcon; surface: string; tone: string }> = {
  plan: {
    Icon: MapIcon,
    surface: "bg-indigo-500/14",
    tone: "text-indigo-600 dark:text-indigo-300",
  },
  research: { Icon: SearchIcon, surface: "bg-sky-500/14", tone: "text-sky-600 dark:text-sky-300" },
  implement: {
    Icon: CodeIcon,
    surface: "bg-emerald-500/14",
    tone: "text-emerald-600 dark:text-emerald-300",
  },
  test: {
    Icon: FlaskConicalIcon,
    surface: "bg-amber-500/14",
    tone: "text-amber-600 dark:text-amber-300",
  },
  review: {
    Icon: EyeIcon,
    surface: "bg-orange-500/14",
    tone: "text-orange-600 dark:text-orange-300",
  },
  integrate: {
    Icon: PuzzleIcon,
    surface: "bg-pink-500/14",
    tone: "text-pink-600 dark:text-pink-300",
  },
  custom: { Icon: PenLineIcon, surface: "bg-foreground/8", tone: "text-muted-foreground" },
};

// The icon carries its own size and color, so a button around the avatar cannot restyle it.
const AVATAR_SIZE = {
  xs: { box: "size-4 rounded-[4px]", icon: "size-2.5" },
  sm: { box: "size-5 rounded-[5px]", icon: "size-3" },
  md: { box: "size-5.5 rounded-md", icon: "size-3" },
  lg: { box: "size-6.5 rounded-md", icon: "size-3.5" },
} as const;

/** An agent's role as a tinted glyph, so one agent looks the same wherever the tab names it. */
export function TeamAgentAvatar(props: {
  role: TeamAgentRole;
  size: keyof typeof AVATAR_SIZE;
  className?: string;
}) {
  const { Icon, surface, tone } = ROLE_LOOK[props.role];
  const size = AVATAR_SIZE[props.size];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size.box,
        surface,
        props.className,
      )}
    >
      <Icon className={cn(size.icon, tone)} />
    </span>
  );
}

export function TeamSectionHeading(props: { children: string; detail?: string }) {
  return (
    <h3 className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
      {props.children}
      {props.detail === undefined ? null : (
        <span className="font-normal text-muted-foreground/70 tabular-nums">{props.detail}</span>
      )}
    </h3>
  );
}

/** Where a step stands; `proposed` shows its number instead of a status. */
export type TeamStepState =
  | "proposed"
  | "running"
  | "completed"
  | "failed"
  | "waiting"
  | "blocked"
  | "cancelled"
  | "not_started";

const STATE_ICON: Record<Exclude<TeamStepState, "proposed">, { Icon: LucideIcon; tone: string }> = {
  running: { Icon: CircleDotIcon, tone: "text-primary" },
  completed: { Icon: CircleCheckIcon, tone: "text-success-foreground" },
  failed: { Icon: CircleXIcon, tone: "text-error-foreground" },
  waiting: { Icon: CircleDashedIcon, tone: "text-muted-foreground/70" },
  blocked: { Icon: CirclePauseIcon, tone: "text-muted-foreground" },
  cancelled: { Icon: CircleSlashIcon, tone: "text-muted-foreground/70" },
  not_started: { Icon: CircleDashedIcon, tone: "text-muted-foreground/50" },
};

/**
 * One step on the timeline: its marker, the line down to the next step, then its content.
 * `framed` outlines the step whose thread is open, or the one that failed.
 */
export function TeamStepRow(props: {
  number: number;
  state: TeamStepState;
  last: boolean;
  framed: "this" | "failed" | null;
  children: ReactNode;
}) {
  const { state, framed } = props;
  return (
    <li
      aria-current={framed === "this" ? "step" : undefined}
      className="grid grid-cols-[1.375rem_minmax(0,1fr)] gap-x-3"
    >
      <div aria-hidden className={cn("flex flex-col items-center", framed !== null && "pt-1")}>
        {state === "proposed" ? (
          <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full border bg-card font-semibold text-2xs text-foreground/80 tabular-nums">
            {props.number}
          </span>
        ) : (
          <TeamStepIcon state={state} />
        )}
        {props.last ? null : (
          <span
            className={cn(
              "mt-1.5 mb-1 min-h-3.5 w-0.5 flex-1 rounded-full",
              state === "completed" ? "bg-success/35" : "bg-border",
            )}
          />
        )}
      </div>
      <div className={cn("min-w-0", !props.last && "pb-5")}>
        <div
          className={cn(
            framed !== null && "-ms-1 -mt-1.5 rounded-lg border px-3 py-2.5",
            framed === "this" && "border-primary/45 bg-primary/7",
            framed === "failed" && "border-error/32 bg-error/5",
          )}
        >
          {props.children}
        </div>
      </div>
    </li>
  );
}

function TeamStepIcon(props: { state: Exclude<TeamStepState, "proposed"> }) {
  const { Icon, tone } = STATE_ICON[props.state];
  return <Icon className={cn("size-5.5 shrink-0", tone)} strokeWidth={1.75} />;
}

/** "Starts with step 1's result", under a step's title. */
export function TeamStepFlow(props: { text: string }) {
  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-muted-foreground text-xs">
      <CornerDownRightIcon aria-hidden className="mt-px size-3 shrink-0" />
      {props.text}
    </p>
  );
}
