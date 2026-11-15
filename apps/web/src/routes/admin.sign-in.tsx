import { createFileRoute, redirect } from "@tanstack/react-router";

import { ControlSignInSurface } from "../components/business/ControlSignInSurface";
import { isBusinessEdition } from "../env";

/** Only the desktop code page sends people here to come back, so nothing else can be a target. */
const returnTarget = (next: unknown) =>
  typeof next === "string" && next.startsWith("/admin/desktop-code?") ? next : "/";

export const Route = createFileRoute("/admin/sign-in")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search["next"] === "string" ? { next: search["next"] } : {},
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminSignInRouteView,
});

function AdminSignInRouteView() {
  const { next } = Route.useSearch();
  // A full load, so the app starts over with the new session cookie.
  return <ControlSignInSurface onSignedIn={() => window.location.assign(returnTarget(next))} />;
}
