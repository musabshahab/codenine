import { describe, expect, it } from "vite-plus/test";

import { workflowScheduleText } from "./workflowDraft.logic";

describe("workflowScheduleText", () => {
  const timeZone = "Europe/London";
  it.each([
    [null, "When you start it"],
    [{ days: ["mon"], time: "09:00", timeZone }, "Every Monday at 9:00 · Europe/London"],
    [
      { days: ["fri", "mon", "wed"], time: "09:00", timeZone },
      "Every Monday, Wednesday and Friday at 9:00 · Europe/London",
    ],
    [
      { days: ["mon", "tue", "wed", "thu", "fri"], time: "17:30", timeZone },
      "Every weekday at 17:30 · Europe/London",
    ],
    [
      { days: ["sat", "sun"], time: "10:05", timeZone },
      "Every Saturday and Sunday at 10:05 · Europe/London",
    ],
    [
      { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "00:15", timeZone },
      "Every day at 0:15 · Europe/London",
    ],
    [{ days: ["mon"], time: "08:00", timeZone: "Etc/GMT" }, "Every Monday at 8:00 · GMT"],
  ] as const)("says %j as %s", (schedule, text) => {
    expect(workflowScheduleText(schedule)).toBe(text);
  });
});
