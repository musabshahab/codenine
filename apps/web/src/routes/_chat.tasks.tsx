import { createFileRoute } from "@tanstack/react-router";

import { TasksPage } from "../components/pages/TasksPage";

export const Route = createFileRoute("/_chat/tasks")({
  component: TasksPage,
});
