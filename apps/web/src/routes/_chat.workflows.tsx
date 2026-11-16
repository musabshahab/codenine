import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPage } from "../components/pages/WorkflowsPage";

export const Route = createFileRoute("/_chat/workflows")({
  component: WorkflowsPage,
});
