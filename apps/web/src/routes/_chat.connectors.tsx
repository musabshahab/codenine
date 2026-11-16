import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsPage } from "../components/pages/ConnectorsPage";

export const Route = createFileRoute("/_chat/connectors")({
  component: ConnectorsPage,
});
