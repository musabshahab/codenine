import { describe, expect, it } from "vite-plus/test";

import {
  groupTeamThreads,
  type TeamThreadAttention,
  type TeamThreadRunState,
  type TeamThreadSection,
  teamTaskStatusLabel,
  withoutUnlinkedWorkflowRuns,
  withTeamTaskRows,
} from "./teamThreads.ts";

interface Row {
  readonly key: string;
  readonly lead: string | null;
  readonly createdAt: string;
  readonly attention: TeamThreadAttention | null;
  readonly run?: TeamThreadRunState;
}

const row = (
  key: string,
  lead: string | null = null,
  minute = 0,
  attention = null as Row["attention"],
) =>
  ({
    key,
    lead,
    createdAt: `2026-11-11T00:${String(minute).padStart(2, "0")}:00.000Z`,
    attention,
  }) satisfies Row;

function group(
  sections: Partial<Record<TeamThreadSection, ReadonlyArray<Row>>>,
  options: { openKey?: string; expandedByLead?: ReadonlyMap<string, boolean> } = {},
) {
  return groupTeamThreads({
    sections: {
      pinned: sections.pinned ?? [],
      active: sections.active ?? [],
      working: sections.working ?? [],
      snoozed: sections.snoozed ?? [],
      settled: sections.settled ?? [],
    },
    keyOf: (thread) => thread.key,
    leadKeyOf: (thread) => thread.lead,
    runOf: (thread) => thread.run ?? null,
    openKey: options.openKey ?? null,
    expandedByLead: options.expandedByLead ?? new Map(),
    attentionOf: (thread) => thread.attention,
  });
}

const keys = (rows: ReadonlyArray<Row>) => rows.map((thread) => thread.key);

const runRow = (key: string, chat: string, minute: number, run: TeamThreadRunState) => ({
  ...row(key, chat, minute),
  run,
});

describe("groupTeamThreads", () => {
  it("draws a lead's task threads under it, oldest first, and leaves the rest alone", () => {
    const grouping = group({
      active: [row("lead"), row("review", "lead", 3), row("other")],
      working: [row("build", "lead", 1)],
      settled: [row("tests", "lead", 2)],
    });
    expect(keys(grouping.sections.active)).toEqual(["lead", "other"]);
    expect(grouping.sections.working).toEqual([]);
    expect(grouping.sections.settled).toEqual([]);
    expect(keys(grouping.groups.get("lead")!.tasks)).toEqual(["build", "tests", "review"]);
    expect([...grouping.leadKeyByTaskKey]).toEqual([
      ["review", "lead"],
      ["build", "lead"],
      ["tests", "lead"],
    ]);
  });

  it.each([
    ["a pinned lead takes an active task", "pinned", "active", true],
    ["a settled lead takes a settled task", "settled", "settled", true],
    ["a snoozed lead takes a settled task", "snoozed", "settled", true],
    ["a settled lead leaves an active task out", "settled", "active", false],
    ["a snoozed lead leaves an active task out", "snoozed", "active", false],
    ["a working lead leaves a working task out", "working", "working", false],
    ["a task the user pinned stays pinned", "active", "pinned", false],
    ["a task the user snoozed stays snoozed", "active", "snoozed", false],
  ] as const)("%s", (_name, leadSection, taskSection, nested) => {
    const sections: Partial<Record<TeamThreadSection, Row[]>> = { [leadSection]: [row("lead")] };
    (sections[taskSection] ??= []).push(row("task", "lead"));
    const grouping = group(sections);
    expect(grouping.leadKeyByTaskKey.has("task")).toBe(nested);
    expect(keys(grouping.sections[taskSection]).includes("task")).toBe(!nested);
    expect(grouping.groups.size).toBe(nested ? 1 : 0);
  });

  it("keeps a task thread whose lead is not listed, or is itself a task, where it stands", () => {
    const grouping = group({
      active: [row("orphan", "archived-lead"), row("lead", "other-lead"), row("task", "lead")],
      settled: [row("self", "self")],
    });
    expect(keys(grouping.sections.active)).toEqual(["orphan", "lead", "task"]);
    expect(keys(grouping.sections.settled)).toEqual(["self"]);
    expect(grouping.groups.size).toBe(0);
  });

  it("opens a group while any task is unsettled, and lets the user's choice win", () => {
    const running = { active: [row("lead"), row("a", "lead")], settled: [row("b", "lead")] };
    const finished = { active: [row("lead")], settled: [row("a", "lead"), row("b", "lead")] };
    expect(group(running).groups.get("lead")?.expanded).toBe(true);
    expect(group(finished).groups.get("lead")?.expanded).toBe(false);
    expect(keys(group(finished).groups.get("lead")!.shown)).toEqual([]);
    const collapsed = group(running, { expandedByLead: new Map([["lead", false]]) });
    expect(collapsed.groups.get("lead")).toMatchObject({ expanded: false, shown: [] });
    const opened = group(finished, { expandedByLead: new Map([["lead", true]]) });
    expect(keys(opened.groups.get("lead")!.shown)).toEqual(["a", "b"]);
  });

  it("still shows the open task under a collapsed lead and names the lead's row", () => {
    const grouping = group(
      { active: [row("lead")], settled: [row("a", "lead"), row("b", "lead", 1)] },
      { openKey: "b" },
    );
    expect(keys(grouping.groups.get("lead")!.shown)).toEqual(["b"]);
    expect(grouping.openRowKey).toBe("lead");
    expect(group({ active: [row("lead")] }, { openKey: "lead" }).openRowKey).toBe("lead");
  });

  it("raises the most urgent state of the tasks a collapsed group hides", () => {
    const tasks = [
      row("working", "lead", 0, "working"),
      row("done", "lead", 1, "unread"),
      row("failed", "lead", 2, "failed"),
      row("asks", "lead", 3, "attention"),
    ];
    const collapse = { expandedByLead: new Map([["lead", false]]) };
    const attentionOf = (open: string | undefined, hidden: ReadonlyArray<Row>) =>
      group(
        { active: [row("lead"), ...hidden] },
        { ...collapse, ...(open === undefined ? {} : { openKey: open }) },
      ).groups.get("lead")?.attention;
    expect(attentionOf(undefined, tasks)).toBe("attention");
    expect(attentionOf("asks", tasks)).toBe("failed");
    expect(attentionOf(undefined, tasks.slice(0, 2))).toBe("unread");
    expect(attentionOf(undefined, [row("quiet", "lead")])).toBeNull();
    expect(group({ active: [row("lead"), ...tasks] }).groups.get("lead")?.attention).toBeNull();
  });

  it.each([
    ["active", "active"],
    ["settled", "active"],
    ["snoozed", "active"],
    ["active", "settled"],
    ["pinned", "settled"],
  ] as const)("nests an ended run under its %s chat from %s", (chatSection, runSection) => {
    const sections: Partial<Record<TeamThreadSection, Row[]>> = { [chatSection]: [row("chat")] };
    (sections[runSection] ??= []).push(runRow("run", "chat", 1, "ended"));
    const grouping = group(sections);
    expect(grouping.leadKeyByTaskKey.get("run")).toBe("chat");
    expect(keys(grouping.sections[runSection])).not.toContain("run");
  });

  it("leaves a running run under a settled chat on its own, and drops a run with no chat", () => {
    const grouping = group({
      active: [runRow("running", "chat", 1, "running"), runRow("orphan", "gone", 2, "ended")],
      settled: [row("chat"), runRow("lost", "gone", 3, "running")],
    });
    expect(grouping.groups.size).toBe(0);
    expect(keys(grouping.sections.active)).toEqual(["running"]);
    expect(keys(grouping.sections.settled)).toEqual(["chat"]);
  });

  it("opens a chat's runs only while one is running", () => {
    const ended = { active: [row("chat"), runRow("run-1", "chat", 1, "ended")] };
    expect(group(ended).groups.get("chat")).toMatchObject({ expanded: false, shown: [], runs: 1 });
    const running = { active: [...ended.active, runRow("run-2", "chat", 2, "running")] };
    expect(group(running).groups.get("chat")).toMatchObject({ expanded: true, runs: 2 });
  });

  it("draws team tasks oldest first, then the newest ten runs and the open one", () => {
    const runs = Array.from({ length: 12 }, (_, index) =>
      runRow(`run-${index + 1}`, "chat", index + 1, index === 11 ? "running" : "ended"),
    );
    const sections = {
      active: [row("chat"), row("task-b", "chat", 30), row("task-a", "chat", 20)],
    };
    const grouping = group({ ...sections, settled: runs }, { openKey: "run-1" });
    const chat = grouping.groups.get("chat")!;
    expect(chat.runs).toBe(12);
    expect(keys(chat.tasks).slice(0, 4)).toEqual(["task-a", "task-b", "run-12", "run-11"]);
    expect(keys(chat.shown)).toEqual([
      "task-a",
      "task-b",
      ...Array.from({ length: 10 }, (_, index) => `run-${12 - index}`),
      "run-1",
    ]);
  });
});

it("draws each lead's shown tasks right after it", () => {
  const grouping = group(
    { active: [row("lead"), row("a", "lead"), row("other")], settled: [row("b", "lead", 1)] },
    { openKey: "b", expandedByLead: new Map([["lead", false]]) },
  );
  expect(
    keys(withTeamTaskRows(grouping.sections.active, grouping, (thread) => thread.key)),
  ).toEqual(["lead", "b", "other"]);
});

it.each([
  ["proposed", 0, 0, "Review"],
  ["running", 0, 0, "Running 0/3"],
  ["running", 2, 0, "Running 2/3"],
  ["running", 1, 1, "Running 1/3"],
  ["completed", 3, 0, "Done"],
  ["failed", 1, 1, "Failed 1"],
  ["failed", 0, 2, "Failed 2"],
  ["failed", 1, 0, "Failed"],
  ["cancelled", 1, 0, "Cancelled"],
] as const)(
  "labels a %s team with %i of 3 done and %i failed as %s",
  (status, completed, failed, label) => {
    expect(teamTaskStatusLabel({ status, total: 3, completed, failed })).toBe(label);
  },
);

it("leaves out every step of a workflow run, and a run's lead that has no chat", () => {
  const shell = (
    environmentId: string,
    id: string,
    source: Parameters<typeof withoutUnlinkedWorkflowRuns>[0][number]["source"] = {},
  ) => ({ environmentId, id, source });
  const threads = [
    shell("env", "run-lead", { teamSummary: { run: {} } }),
    shell("env", "run-step", { teamTask: { rootThreadId: "run-lead" } }),
    shell("env", "linked-lead", { teamSummary: { run: { chatThreadId: "chat" } } }),
    shell("env", "linked-step", { teamTask: { rootThreadId: "linked-lead" } }),
    shell("env", "team-lead", { teamSummary: {} }),
    shell("env", "team-step", { teamTask: { rootThreadId: "team-lead" } }),
    shell("env", "chat"),
    // The same id on another machine is another thread.
    shell("other", "run-step", { teamTask: { rootThreadId: "run-lead" } }),
  ];
  expect(
    withoutUnlinkedWorkflowRuns(threads).map((thread) => `${thread.environmentId}:${thread.id}`),
  ).toEqual(["env:linked-lead", "env:team-lead", "env:team-step", "env:chat", "other:run-step"]);
  const noRuns = threads.slice(4);
  expect(withoutUnlinkedWorkflowRuns(noRuns)).toBe(noRuns);
});
