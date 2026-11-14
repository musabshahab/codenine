import { createFileRoute, redirect } from "@tanstack/react-router";

import { ControlAdminSurface } from "../components/business/ControlAdminSurface";
import { isBusinessEdition } from "../env";

export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminRouteView,
});

function AdminRouteView() {
  return <ControlAdminSurface onSignedOut={() => window.location.assign("/admin/sign-in")} />;
}
