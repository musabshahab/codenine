import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/pages/InboxPage";

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxPage,
});
