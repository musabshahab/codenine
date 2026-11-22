import { createFileRoute, redirect } from "@tanstack/react-router";

// Archived chats moved to the archive page; old links open its Archived tab.
export const Route = createFileRoute("/_chat/settings/archived")({
  beforeLoad: () => {
    throw redirect({ to: "/archive", search: { show: "archived" }, replace: true });
  },
});
