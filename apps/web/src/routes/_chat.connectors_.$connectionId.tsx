import { ConnectionId, EnvironmentId } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";

import { ConnectorDetailPage } from "../components/pages/ConnectorDetailPage";

function ConnectorRouteView() {
  const { connectionId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <ConnectorDetailPage
      // Keyed so a sign-in notice or a pending change never carries over to another connector.
      key={connectionId}
      connectionId={Option.getOrNull(ConnectionId.makeOption(connectionId))}
      machine={search.machine ?? null}
      signedIn={search.signedIn === true}
    />
  );
}

export const Route = createFileRoute("/_chat/connectors_/$connectionId")({
  // A finished sign-in comes back here with `signedIn=1`.
  validateSearch: (
    raw: Record<string, unknown>,
  ): { machine?: EnvironmentId | undefined; signedIn?: true | undefined } => ({
    ...(typeof raw.machine === "string" && raw.machine.trim()
      ? { machine: EnvironmentId.make(raw.machine) }
      : {}),
    ...(raw.signedIn === 1 || raw.signedIn === "1" || raw.signedIn === true
      ? { signedIn: true }
      : {}),
  }),
  component: ConnectorRouteView,
});
