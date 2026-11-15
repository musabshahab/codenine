import { createFileRoute, redirect } from "@tanstack/react-router";

import { ControlSignInSurface } from "../components/business/ControlSignInSurface";
import { isBusinessEdition } from "../env";

/** Only the desktop code page sends people here to come back, so nothing else can be a target. */
const returnTarget = (next: unknown) =>
  typeof next === "string" && next.startsWith("/admin/desktop-code?") ? next : "/";

export const Route = createFileRoute("/admin/sign-in")({
  validateSearch: (search: Record<string, unknown>): { next?: string; sso?: string } => ({
    ...(typeof search["next"] === "string" ? { next: search["next"] } : {}),
    ...(typeof search["sso"] === "string" ? { sso: search["sso"] } : {}),
  }),
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminSignInRouteView,
});

function AdminSignInRouteView() {
  const { next, sso } = Route.useSearch();
  // A full load, so the app starts over with the new session cookie.
  return (
    <ControlSignInSurface
      next={returnTarget(next)}
      onSignedIn={() => window.location.assign(returnTarget(next))}
      ssoError={sso}
    />
  );
}
