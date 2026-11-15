import type { ControlWorkspaceAccess } from "@codenine/contracts/control";
import { Link } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";

import { currentControlStartup } from "../../business/control";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

const REASONS: Record<NonNullable<ControlWorkspaceAccess["reason"]>, string> = {
  "no-licence": "No licence is installed",
  "licence-unusable": "The licence cannot be used",
  "licence-not-started": "The licence has not started yet",
  "licence-ended": "The licence has ended",
};

/** Says why agents cannot change anything while the business licence does not allow work. */
export function ReadOnlyNotice() {
  const access = currentControlStartup()?.access;
  if (access === null || access === undefined || access.canWork || access.reason === null) {
    return null;
  }
  return (
    <Alert variant="warning">
      <LockIcon />
      <AlertTitle>Read-only</AlertTitle>
      <AlertDescription>
        {REASONS[access.reason]}, so you can look at your work but agents cannot change anything.{" "}
        <Link className="underline underline-offset-2" to="/admin">
          Open account
        </Link>
      </AlertDescription>
    </Alert>
  );
}
