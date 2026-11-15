import type { ControlRole } from "@codenine/contracts/control";
import type * as Effect from "effect/Effect";
import type React from "react";

import type { ControlClient } from "../../business/control";

/** One change on the control server; the page reloads after it. */
export type ControlCall = (client: ControlClient) => Effect.Effect<unknown, unknown>;

export const ROLE_LABELS: Record<ControlRole, string> = {
  owner: "Owner",
  admin: "Admin",
  "department-admin": "Department admin",
  member: "Member",
  restricted: "Restricted",
  auditor: "Auditor",
};

export function SectionTitle({ children }: { readonly children: React.ReactNode }) {
  return <h2 className="mt-8 text-base font-semibold">{children}</h2>;
}
