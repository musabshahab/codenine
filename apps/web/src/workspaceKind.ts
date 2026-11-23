import { WorkspaceKind } from "@codenine/contracts";
import type { EnvironmentProject } from "@codenine/client-runtime/state/shell";
import { workspacePreset, type WorkspacePreset } from "@codenine/shared/workspacePreset";
import * as Schema from "effect/Schema";

export const isWorkspaceKind = Schema.is(WorkspaceKind);

export const WORKSPACE_KIND_OPTIONS = [
  { kind: "code", label: "Code", description: "For developers building software" },
  { kind: "work", label: "Work", description: "For documents, research and everyday tasks" },
  { kind: "create", label: "Create", description: "For writers, designers and media makers" },
] as const satisfies ReadonlyArray<{
  readonly kind: WorkspaceKind;
  readonly label: string;
  readonly description: string;
}>;

export function workspaceKindOption(kind: WorkspaceKind) {
  return WORKSPACE_KIND_OPTIONS.find((option) => option.kind === kind) ?? WORKSPACE_KIND_OPTIONS[0];
}

/**
 * Personal has no type: with it, or with no workspace at all, a chat uses the Code preset. Pass
 * the chat's worktree where one may exist; see `workspacePreset`.
 */
export function projectPreset(
  project: Pick<EnvironmentProject, "kind" | "isScratch"> | null | undefined,
  worktreePath?: string | null,
): WorkspacePreset {
  return workspacePreset(project == null || project.isScratch ? null : project.kind, worktreePath);
}
