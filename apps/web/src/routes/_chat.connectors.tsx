import { EnvironmentId } from "@codenine/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsPage } from "../components/pages/ConnectorsPage";

function ConnectorsRouteView() {
  const search = Route.useSearch();
  return (
    <ConnectorsPage machine={search.machine ?? null} signInError={search.signInError ?? null} />
  );
}

export const Route = createFileRoute("/_chat/connectors")({
  // A failed sign-in comes back here with `signInError`.
  validateSearch: (
    raw: Record<string, unknown>,
  ): { machine?: EnvironmentId | undefined; signInError?: string | undefined } => ({
    ...(typeof raw.machine === "string" && raw.machine.trim()
      ? { machine: EnvironmentId.make(raw.machine) }
      : {}),
    ...(typeof raw.signInError === "string" && raw.signInError.trim()
      ? { signInError: raw.signInError }
      : {}),
  }),
  component: ConnectorsRouteView,
});
