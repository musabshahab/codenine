import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleXIcon,
  HandIcon,
  MessageCircleIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import type { ThreadKind } from "./threadKind.logic";

const KIND_ICON = {
  chat: { Icon: MessageCircleIcon, tone: "text-muted-foreground", label: "Chat" },
  running: { Icon: CircleDotIcon, tone: "text-primary", label: "Running" },
  approval: { Icon: HandIcon, tone: "text-warning-foreground", label: "Waiting for approval" },
  question: { Icon: CircleHelpIcon, tone: "text-primary", label: "Waiting for an answer" },
  failed: { Icon: CircleXIcon, tone: "text-error-foreground", label: "Failed" },
  done: { Icon: CircleCheckIcon, tone: "text-success-foreground", label: "Done" },
  pr: { Icon: PullRequestGlyph.pullRequest, tone: "text-primary", label: "Pull request open" },
} as const satisfies Record<ThreadKind, unknown>;

/** A thread's status as one glyph. Static on purpose: no spinner repaints the list. */
export function ThreadKindIcon(props: { kind: ThreadKind; className?: string }) {
  const { Icon, tone, label } = KIND_ICON[props.kind];
  return (
    <Icon
      aria-label={label}
      role="img"
      className={cn("size-3.5 shrink-0", tone, props.className)}
    />
  );
}
