import { scopeThreadRef } from "@codenine/client-runtime/environment";
import type { NeedsYouReason } from "@codenine/client-runtime/state/thread-inbox";
import { InboxIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import { useNeedsYouEntries } from "../../hooks/useWorkLists";
import { useNowMinute } from "../../hooks/useNowMinute";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { ThreadKindIcon } from "../ThreadKindIcon";
import type { ThreadKind } from "../threadKind.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { useThreadPlaceLabel } from "./threadPlace";
import { WorkspacePage } from "./WorkspacePage";

const REASON = {
  approval: { kind: "approval", title: (title: string) => `Approve a request: ${title}` },
  review: { kind: "approval", title: (title: string) => `Approve team: ${title}` },
  question: { kind: "question", title: (title: string) => `Answer a question: ${title}` },
  failed: { kind: "failed", title: (title: string) => `Team failed: ${title}` },
} as const satisfies Record<NeedsYouReason, { kind: ThreadKind; title: (title: string) => string }>;

/** Everything that waits on the user, across projects and chats. */
export function InboxPage() {
  const router = useRouter();
  const entries = useNeedsYouEntries();
  const placeOf = useThreadPlaceLabel();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}Z`);
  return (
    <WorkspacePage
      area="inbox"
      title="Inbox"
      subtitle={entries.length === 0 ? null : `${entries.length} need you`}
    >
      {entries.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing needs you</EmptyTitle>
            <EmptyDescription>
              Approvals, questions, and teams that fail show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-px p-2">
          {entries.map(({ thread, reason }) => (
            <li key={`${thread.environmentId}:${thread.id}`}>
              <button
                type="button"
                onClick={() =>
                  void router.navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                  })
                }
                className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <ThreadKindIcon kind={REASON[reason].kind} className="mt-0.5 size-4" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">
                    {REASON[reason].title(thread.title)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{placeOf(thread)}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatElapsedDurationLabel(thread.updatedAt, nowMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}
