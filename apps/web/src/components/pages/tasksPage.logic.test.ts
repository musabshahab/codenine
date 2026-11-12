import type { TeamPlanStatus, TeamPlanSummary } from "@codenine/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupTeamTasks, teamTaskProgress } from "./tasksPage.logic";

const summary = (
  status: TeamPlanStatus,
  counts: Partial<Pick<TeamPlanSummary, "total" | "completed" | "failed">> = {},
) =>
  ({ status, total: 3, completed: 0, failed: 0, running: 0, cancelled: 0, ...counts }) as
    | TeamPlanSummary
    | undefined;

describe("tasks page", () => {
  it("groups tasks by what they need and drops empty groups", () => {
    const tasks = [
      { id: "proposed", status: "proposed" },
      { id: "running", status: "running" },
      { id: "failed", status: "failed" },
      { id: "plain", status: null },
      { id: "completed", status: "completed" },
    ] as const;
    expect(
      groupTeamTasks(tasks, (task) => task.status).map((group) => [
        group.label,
        group.tasks.map((task) => task.id),
      ]),
    ).toEqual([
      ["Needs you", ["proposed", "failed"]],
      ["Running", ["running"]],
      ["Done", ["completed"]],
    ]);
    expect(groupTeamTasks([{ status: "running" as const }], (task) => task.status)).toHaveLength(1);
  });

  it.each([
    ["proposed", summary("proposed", { total: 2 }), "Proposed · 2 agents"],
    ["running", summary("running", { completed: 1 }), "1 of 3 done"],
    ["failed", summary("failed", { completed: 1, failed: 1 }), "1 of 3 done · 1 failed"],
    ["completed", summary("completed", { completed: 3 }), "3 of 3 done"],
    ["cancelled", summary("cancelled"), "Cancelled"],
    ["no plan", undefined, ""],
  ] as const)("describes a %s task", (_name, plan, text) => {
    expect(teamTaskProgress(plan)).toBe(text);
  });
});
