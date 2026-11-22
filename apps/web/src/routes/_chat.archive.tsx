import { createFileRoute } from "@tanstack/react-router";

import { ArchivePage, validateArchiveSearch } from "../components/pages/ArchivePage";

function ArchiveRouteView() {
  const search = Route.useSearch();
  return <ArchivePage show={search.show ?? "completed"} />;
}

export const Route = createFileRoute("/_chat/archive")({
  validateSearch: validateArchiveSearch,
  component: ArchiveRouteView,
});
