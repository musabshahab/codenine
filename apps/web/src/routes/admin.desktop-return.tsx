import { createFileRoute, redirect } from "@tanstack/react-router";

import { DesktopReturnPage } from "../components/business/DesktopSignInPages";
import { isBusinessEdition } from "../env";

export const Route = createFileRoute("/admin/desktop-return")({
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminDesktopReturnRouteView,
});

// A full load, so the app starts over with the new session cookie.
const signedIn = () => window.location.replace("/");

function AdminDesktopReturnRouteView() {
  return <DesktopReturnPage onSignedIn={signedIn} />;
}
