import { createFileRoute, redirect } from "@tanstack/react-router";

import { ControlSignInSurface } from "../components/business/ControlSignInSurface";
import { isBusinessEdition } from "../env";

export const Route = createFileRoute("/admin/sign-in")({
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminSignInRouteView,
});

function AdminSignInRouteView() {
  // A full load, so the app starts over with the new session cookie.
  return <ControlSignInSurface onSignedIn={() => window.location.assign("/")} />;
}
