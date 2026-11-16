import { createFileRoute } from "@tanstack/react-router";

import { AgentsPage } from "../components/pages/AgentsPage";

export const Route = createFileRoute("/_chat/agents")({
  component: AgentsPage,
});
