import { useState } from "react";

import {
  chooseDepartment,
  controlErrorMessage,
  currentControlStartup,
} from "../../business/control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

/** For people in several departments: each has its own workspace, and this opens another. */
export function DepartmentSwitcher() {
  const mine = currentControlStartup()?.departments;
  const [switching, setSwitching] = useState(false);
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
