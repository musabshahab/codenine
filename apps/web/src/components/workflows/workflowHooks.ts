import type { EnvironmentId } from "@codenine/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useQuietThreadShells } from "../../state/entities";
import { resolveHour12 } from "../../timestampFormat";
import { type FormatOptions, type WorkflowRun, workflowRunsOf } from "./workflows.logic";

const NO_RUNS: ReadonlyArray<WorkflowRun> = [];

/** A machine's workflow runs, newest first, from thread shells without any lead's plan. */
export function useWorkflowRuns(environmentId: EnvironmentId | null): ReadonlyArray<WorkflowRun> {
  const shells = useQuietThreadShells();
  return environmentId === null ? NO_RUNS : workflowRunsOf(shells, environmentId);
}

/** This minute and the user's 12- or 24-hour clock, for the pages' times. */
export function useWorkflowClock(): FormatOptions {
  const nowMinute = useNowMinute();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  return { nowMs: Date.parse(`${nowMinute}Z`), hour12: resolveHour12(timestampFormat) };
}
