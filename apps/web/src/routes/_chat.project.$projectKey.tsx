import { createFileRoute } from "@tanstack/react-router";

import { ProjectPage } from "../components/pages/ProjectPage";

function ProjectRouteView() {
  const { projectKey } = Route.useParams();
  return <ProjectPage projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/project/$projectKey")({
  component: ProjectRouteView,
});
