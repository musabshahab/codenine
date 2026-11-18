import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  WorkflowDefinition,
  WorkflowId,
  type WorkflowName,
  WorkflowSkippedRun,
  type WorkflowStep,
} from "@codenine/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { scheduleZone } from "./WorkflowSchedule.ts";

export const WORKFLOWS_FOLDER = "workflows";
export const WORKFLOW_FILE = "workflow.json";
export const NOTES_FILE = "notes.md";
export const STATE_FILE = "state.json";
// WorkflowSaveInput's limit on notes, which the contract keeps private.
const NOTES_MAX_CHARS = 8_000;
const MAX_STEPS = 12;

const { name: _name, ...definitionFields } = WorkflowDefinition.fields;
/** workflow.json: the definition, without the name its folder carries, and the id runs derive from. */
const StoredWorkflow = Schema.Struct({ id: WorkflowId, ...definitionFields });
const decodeStoredWorkflow = Schema.decodeUnknownOption(Schema.fromJsonString(StoredWorkflow));
const decodeStoredId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: WorkflowId })),
);
const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(StoredWorkflow.fields));

const QueuedWorkflowRun = Schema.Struct({
  trigger: Schema.Literals(["schedule", "missed"]),
  scheduledFor: IsoDateTime,
});
export type QueuedWorkflowRun = typeof QueuedWorkflowRun.Type;

/** state.json: what the server keeps about a workflow's runs. The editor never writes it. */
const WorkflowStateFile = Schema.Struct({
  /** The last run number given out. Lead threads derive from it, so a number is never reused. */
  runs: NonNegativeInt,
  /** The schedule in force and since when, so a changed schedule starts at its next time. */
  scheduleKey: Schema.NullOr(Schema.String),
  scheduleSince: Schema.NullOr(IsoDateTime),
  /** Scheduled times up to this one are queued, skipped or made up for. */
  handledThrough: Schema.NullOr(IsoDateTime),
  /** Scheduled runs waiting for the workflow's previous run to end, oldest first. */
  queue: Schema.Array(QueuedWorkflowRun),
  /** Newest first. */
  skipped: Schema.Array(WorkflowSkippedRun),
  /** Runs whose note is already in notes.md. */
  noted: Schema.Array(PositiveInt),
});
export type WorkflowState = typeof WorkflowStateFile.Type;
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowStateFile));

export const EMPTY_WORKFLOW_STATE: WorkflowState = {
  runs: 0,
  scheduleKey: null,
  scheduleSince: null,
  handledThrough: null,
  queue: [],
  skipped: [],
  noted: [],
};

export type ParsedWorkflowFile =
  | { readonly _tag: "found"; readonly id: WorkflowId; readonly workflow: WorkflowDefinition }
  /** What the server cannot read, or what would not save; `id` when the file still names one. */
  | { readonly _tag: "broken"; readonly id: WorkflowId | undefined; readonly issue: string };

export function parseWorkflowFile(name: WorkflowName, contents: string): ParsedWorkflowFile {
  const stored = decodeStoredWorkflow(contents);
  if (Option.isNone(stored)) {
    return {
      _tag: "broken",
      id: Option.getOrUndefined(decodeStoredId(contents))?.id,
      issue: "It is not a workflow this version of Codenine can read.",
    };
  }
  const { id, ...definition } = stored.value;
  const workflow: WorkflowDefinition = { ...definition, name };
  const issue = workflowDefinitionIssue(workflow);
  return issue === null ? { _tag: "found", id, workflow } : { _tag: "broken", id, issue };
}

/** Writes workflow.json, keeping any key of `existing` this version does not know. */
export function renderWorkflowFile(
  id: WorkflowId,
  workflow: WorkflowDefinition,
  existing?: string,
): string {
  const previous = existing === undefined ? undefined : decodeJsonObject(existing);
  const unknown =
    previous === undefined || Option.isNone(previous)
      ? {}
      : Object.fromEntries(Object.entries(previous.value).filter(([key]) => !KNOWN_KEYS.has(key)));
  const { name: _name, ...definition } = workflow;
  return `${JSON.stringify({ id, ...definition, ...unknown }, null, 2)}\n`;
}

/** A state file that cannot be read starts over; run numbers then skip lead threads that exist. */
export const parseWorkflowState = (contents: string): WorkflowState =>
  Option.getOrElse(decodeState(contents), () => EMPTY_WORKFLOW_STATE);

export const renderWorkflowState = (state: WorkflowState) => `${JSON.stringify(state, null, 2)}\n`;

/** The newest lines that fit in the notes' limit; the lead reads all of them on every run. */
export function trimNotes(notes: string): string {
  if (notes.length <= NOTES_MAX_CHARS) return notes;
  const lines = notes.split("\n");
  let length = notes.length;
  let start = 0;
  while (start < lines.length - 1 && length > NOTES_MAX_CHARS) {
    length -= lines[start]!.length + 1;
    start += 1;
  }
  const kept = lines.slice(start).join("\n");
  return kept.length <= NOTES_MAX_CHARS ? kept : kept.slice(-NOTES_MAX_CHARS);
}

export const appendNote = (notes: string, line: string) => {
  const current = notes.trimEnd();
  return trimNotes(current === "" ? line : `${current}\n${line}`);
};

function dependencyCycle(steps: ReadonlyArray<WorkflowStep>): ReadonlyArray<string> | undefined {
  const dependencies = new Map<string, ReadonlyArray<string>>(
    steps.map((step) => [step.id, step.dependsOn]),
  );
  const settled = new Set<string>();
  const path: Array<string> = [];
  const visit = (id: string): ReadonlyArray<string> | undefined => {
    if (settled.has(id)) return undefined;
    const start = path.indexOf(id);
    if (start !== -1) return [...path.slice(start), id];
    path.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    settled.add(id);
    return undefined;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** Why a definition cannot be saved, in words shown to the user; null when it can. */
export function workflowDefinitionIssue(workflow: WorkflowDefinition): string | null {
  const { steps } = workflow;
  if (steps.length > MAX_STEPS) {
    return `A workflow has at most ${MAX_STEPS} steps; this one has ${steps.length}.`;
  }
  const titles = new Map<string, string>();
  for (const step of steps) {
    if (titles.has(step.id)) return `Two steps have the id "${step.id}". Give each its own.`;
    titles.set(step.id, step.title);
  }
  for (const step of steps) {
    const missing = step.dependsOn.find((id) => !titles.has(id));
    if (missing !== undefined) {
      return `"${step.title}" waits for "${missing}", which is not a step of this workflow.`;
    }
  }
  const cycle = dependencyCycle(steps);
  if (cycle !== undefined) {
    return `Steps wait for each other in a loop: ${cycle.map((id) => titles.get(id) ?? id).join(" → ")}.`;
  }
  const schedule = workflow.trigger.schedule;
  if (schedule !== null && scheduleZone(schedule) === undefined) {
    return `Codenine does not know the time zone "${schedule.timeZone}".`;
  }
  return null;
}
