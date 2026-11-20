import type { EnvironmentId, ThreadId, WorkflowStepId } from "@codenine/contracts";
import { create } from "zustand";

import type { WorkflowEdit } from "./workflows.logic";

/** What the editor's side panel shows. */
export type WorkflowSelection =
  | { readonly kind: "step"; readonly id: WorkflowStepId }
  | { readonly kind: "lead" }
  | { readonly kind: "trigger" };

/**
 * Which workflow an edit belongs to on a machine: a saved workflow's name, or where a new one
 * starts. Names are slugs and never `new`, so the two cannot collide. It travels in the address
 * when the editor sends the user to make an agent, so the agent page can hand the agent back.
 */
export type WorkflowEditTarget =
  | { readonly kind: "saved"; readonly name: string }
  | { readonly kind: "new"; readonly from: WorkflowStart };

export type WorkflowStart =
  | { readonly kind: "blank" }
  | { readonly kind: "draft"; readonly threadId: ThreadId }
  | { readonly kind: "team"; readonly threadId: ThreadId };

export function workflowEditKey(target: WorkflowEditTarget): string {
  if (target.kind === "saved") return target.name;
  switch (target.from.kind) {
    case "blank":
      return "new";
    case "draft":
      return `new:thread:${target.from.threadId}`;
    case "team":
      return `new:team:${target.from.threadId}`;
  }
}

export function parseWorkflowEditKey(key: string): WorkflowEditTarget | null {
  if (key === "new") return { kind: "new", from: { kind: "blank" } };
  const match = /^new:(thread|team):(.+)$/u.exec(key);
  if (match !== null) {
    const threadId = match[2] as ThreadId;
    return {
      kind: "new",
      from: match[1] === "thread" ? { kind: "draft", threadId } : { kind: "team", threadId },
    };
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key) ? { kind: "saved", name: key } : null;
}

interface WorkflowEditState {
  readonly edits: Readonly<Record<string, WorkflowEdit>>;
  readonly selections: Readonly<Record<string, WorkflowSelection | null>>;
}

// Outlives the editor, so leaving to make an agent and coming back keeps the unsaved edits.
const useWorkflowEditStore = create<WorkflowEditState>(() => ({ edits: {}, selections: {} }));

function storeKey(environmentId: EnvironmentId, key: string): string {
  return `${environmentId}\u0000${key}`;
}

export function useWorkflowEdit(environmentId: EnvironmentId, key: string): WorkflowEdit | null {
  return useWorkflowEditStore((state) => state.edits[storeKey(environmentId, key)] ?? null);
}

export function useWorkflowSelection(
  environmentId: EnvironmentId,
  key: string,
): WorkflowSelection | null {
  return useWorkflowEditStore((state) => state.selections[storeKey(environmentId, key)] ?? null);
}

export function readWorkflowEdit(environmentId: EnvironmentId, key: string): WorkflowEdit | null {
  return useWorkflowEditStore.getState().edits[storeKey(environmentId, key)] ?? null;
}

/** Replaces the edits; null drops them, as saving or discarding does. */
export function setWorkflowEdit(
  environmentId: EnvironmentId,
  key: string,
  edit: WorkflowEdit | null,
): void {
  const id = storeKey(environmentId, key);
  useWorkflowEditStore.setState((state) => {
    const { [id]: _dropped, ...rest } = state.edits;
    return { edits: edit === null ? rest : { ...rest, [id]: edit } };
  });
}

export function setWorkflowSelection(
  environmentId: EnvironmentId,
  key: string,
  selection: WorkflowSelection | null,
): void {
  const id = storeKey(environmentId, key);
  useWorkflowEditStore.setState((state) => ({
    selections: { ...state.selections, [id]: selection },
  }));
}
