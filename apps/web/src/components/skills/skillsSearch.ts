import { EnvironmentId, ProjectId } from "@codenine/contracts";

/** The machine and workspace a Skills page shows, carried in its address. */
export interface SkillsSearch {
  readonly machine?: EnvironmentId | undefined;
  readonly workspace?: ProjectId | undefined;
}

export function validateSkillsSearch(raw: Record<string, unknown>): SkillsSearch {
  return {
    ...(typeof raw.machine === "string" && raw.machine.trim()
      ? { machine: EnvironmentId.make(raw.machine) }
      : {}),
    ...(typeof raw.workspace === "string" && raw.workspace.trim()
      ? { workspace: ProjectId.make(raw.workspace) }
      : {}),
  };
}
