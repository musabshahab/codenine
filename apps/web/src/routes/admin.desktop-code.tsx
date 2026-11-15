import { createFileRoute, redirect } from "@tanstack/react-router";

import { isDesktopScheme } from "../business/desktopSignIn";
import { DesktopCodePage } from "../components/business/DesktopSignInPages";
import { isBusinessEdition } from "../env";

const STATE = /^[\w-]{16,128}$/u;

export const Route = createFileRoute("/admin/desktop-code")({
  validateSearch: (search: Record<string, unknown>) => ({
    state:
      typeof search["state"] === "string" && STATE.test(search["state"]) ? search["state"] : "",
    scheme: isDesktopScheme(search["scheme"]) ? search["scheme"] : "codenine",
  }),
  beforeLoad: ({ search }) => {
    if (!isBusinessEdition || search.state === "") throw redirect({ to: "/", replace: true });
  },
  component: AdminDesktopCodeRouteView,
});

function AdminDesktopCodeRouteView() {
  const { state, scheme } = Route.useSearch();
  return <DesktopCodePage scheme={scheme} state={state} />;
}
