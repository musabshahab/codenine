import { scopeThreadRef } from "@codenine/client-runtime/environment";
import { resolveThreadActivityTimestamp } from "@codenine/client-runtime/state/thread-sort";
import { useRouter } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useVisibleThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useThreadProjectGroup } from "../pages/threadPlace";

const RECENT_CHAT_LIMIT = 6;

/** Under a new chat in Chats: the open chats to go back to instead. */
export function DraftRecentChats() {
  const router = useRouter();
  const threads = useVisibleThreadShells();
  const groupOf = useThreadProjectGroup();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const chats = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.settledAt === null &&
        groupOf(thread)?.isScratch === true,
    )
    .map((thread) => ({ thread, activeAt: resolveThreadActivityTimestamp(thread) ?? "" }))
    .toSorted((a, b) => b.activeAt.localeCompare(a.activeAt))
    .slice(0, RECENT_CHAT_LIMIT);
  if (chats.length === 0) return null;
  return (
    <section aria-label="Recent chats" className="flex flex-col gap-1">
      <h2 className="px-2.5 pb-1 font-medium text-muted-foreground text-sm">Recent chats</h2>
      <ul className="flex flex-col">
        {chats.map(({ thread, activeAt }) => (
          <li key={`${thread.environmentId}:${thread.id}`}>
            <button
              type="button"
              onClick={() =>
                void router.navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                })
              }
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-start text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <MessageCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
              <span className="max-w-32 shrink-0 truncate text-muted-foreground text-xs">
                {thread.folder ?? "Chats"}
              </span>
              <span className="w-10 shrink-0 text-end text-muted-foreground text-xs tabular-nums">
                {activeAt === "" ? null : formatElapsedDurationLabel(activeAt, nowMs)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
