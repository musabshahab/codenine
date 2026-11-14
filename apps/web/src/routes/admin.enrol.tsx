import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ControlEnrolSurface } from "../components/business/ControlEnrolSurface";
import { isBusinessEdition } from "../env";

export const Route = createFileRoute("/admin/enrol")({
  beforeLoad: () => {
    if (!isBusinessEdition) throw redirect({ to: "/", replace: true });
  },
  component: AdminEnrolRouteView,
});

function AdminEnrolRouteView() {
  // The control server puts the bare token after `#`, which never reaches a server.
  const [token] = useState(() => window.location.hash.replace(/^#/u, ""));
  // oxlint-disable-next-line codenine/no-unreasoned-state-sync -- removes the one-time token from the address bar and history once it is read
  useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
  }, []);
  return <ControlEnrolSurface onFinished={() => window.location.assign("/")} token={token} />;
}
