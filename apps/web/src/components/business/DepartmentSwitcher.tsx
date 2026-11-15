import { useState } from "react";

import type { ControlMyDepartments } from "@codenine/contracts/control";

import {
  chooseDepartment,
  controlErrorMessage,
  currentControlStartup,
  leaveWorkspace,
} from "../../business/control";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

/** Says whose workspace an owner is looking at, and takes them back to their own. */
function ViewingNotice({
  viewing,
}: {
  readonly viewing: NonNullable<ControlMyDepartments["viewing"]>;
}) {
  const [leaving, setLeaving] = useState(false);
  const until = new Date(viewing.until).toLocaleTimeString(undefined, { timeStyle: "short" });
  return (
    <Alert variant="warning">
      <AlertDescription>
        <p>
          You are looking at {viewing.displayName}'s workspace
          {viewing.departmentName === null ? "" : ` in ${viewing.departmentName}`}, without changing
          anything, until {until}.
        </p>
        <Button
          className="mt-2"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            leaveWorkspace().catch((error: unknown) => {
              setLeaving(false);
              toastManager.add({ type: "error", title: controlErrorMessage(error) });
            });
          }}
          size="xs"
          variant="outline"
        >
          Back to my workspace
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** For people in several departments: each has its own workspace, and this opens another. */
export function DepartmentSwitcher() {
  const mine = currentControlStartup()?.departments;
  const [switching, setSwitching] = useState(false);
  if (mine !== null && mine !== undefined && mine.viewing !== null) {
    return <ViewingNotice viewing={mine.viewing} />;
  }
  if (mine === null || mine === undefined || mine.departments.length < 2) {
    return null;
  }
  return (
    <Select
      disabled={switching}
      items={Object.fromEntries(mine.departments.map(({ id, name }) => [id, name]))}
      onValueChange={(value) => {
        const chosen = mine.departments.find(({ id }) => id === value);
        if (chosen === undefined || chosen.id === mine.current) return;
        setSwitching(true);
        chooseDepartment(chosen.id).catch((error: unknown) => {
          setSwitching(false);
          toastManager.add({ type: "error", title: controlErrorMessage(error) });
        });
      }}
      value={mine.current}
    >
      <SelectTrigger aria-label="Department" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {mine.departments.map((department) => (
          <SelectItem key={department.id} value={department.id}>
            {department.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
