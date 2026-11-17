import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** A skill's folder and `name`: lower case letters, digits and single hyphens, as SKILL.md requires. */
export const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
export type SkillName = typeof SkillName.Type;

/** "write-clear-emails" reads as "Write clear emails". */
export function skillTitle(name: string): string {
  const words = name
    .split("-")
    .filter((word) => word.length > 0)
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * - `codenine`: in the Codenine folder's `skills/`, for every workspace.
 * - `workspace`: in a workspace's `.agents/skills/`, shared with whoever shares its files.
 */
export const SkillScope = Schema.Literals(["codenine", "workspace"]);
export type SkillScope = typeof SkillScope.Type;

const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export const SkillDescription = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SKILL_DESCRIPTION_MAX_LENGTH),
);

export const SkillSummary = Schema.Struct({
  name: SkillName,
  /** "Use it when…": what agents read to decide whether the skill fits. */
  description: Schema.String,
  scope: SkillScope,
  /** The workspace for a `workspace` skill. */
  projectId: Schema.NullOr(ProjectId),
  /** The skill's folder on the server's computer. */
  path: Schema.String,
  /** The library skill this one was added from, if any. */
  fromLibrary: Schema.NullOr(SkillName),
  /** Files besides SKILL.md, relative to the folder. */
  files: Schema.Array(Schema.String),
  updatedAt: IsoDateTime,
});
export type SkillSummary = typeof SkillSummary.Type;

/** A skill only one provider can use, found in that provider's own folders. */
export const FoundSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  providerInstanceId: ProviderInstanceId,
  /** Such as "Claude Code" or "Codex". */
  providerName: Schema.String,
  path: Schema.String,
  /** A Codenine skill with this name exists already. */
  inCodenine: Schema.Boolean,
});
export type FoundSkill = typeof FoundSkill.Type;

/** A skill that comes with Codenine, ready to add. */
export const LibrarySkill = Schema.Struct({
  name: SkillName,
  description: Schema.String,
  added: Schema.Boolean,
});
export type LibrarySkill = typeof LibrarySkill.Type;

export const SkillsListInput = Schema.Struct({
  /** Include this workspace's own skills. */
  projectId: Schema.optionalKey(ProjectId),
});
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillSummary),
  found: Schema.Array(FoundSkill),
  library: Schema.Array(LibrarySkill),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export const SkillRefInput = Schema.Struct({
  name: SkillName,
  scope: SkillScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type SkillRefInput = typeof SkillRefInput.Type;

export const SkillDetail = Schema.Struct({
  ...SkillSummary.fields,
  /** SKILL.md without its frontmatter. */
  instructions: Schema.String,
});
export type SkillDetail = typeof SkillDetail.Type;

export const SkillSaveInput = Schema.Struct({
  name: SkillName,
  description: SkillDescription,
  instructions: Schema.String,
  scope: SkillScope,
  projectId: Schema.optionalKey(ProjectId),
  /** Editing: the skill's current name in the same scope. Leave out to create; taken names fail. */
  previousName: Schema.optionalKey(SkillName),
});
export type SkillSaveInput = typeof SkillSaveInput.Type;

export const SkillAddFromLibraryInput = Schema.Struct({ name: SkillName });

/** Copies a found skill into the Codenine folder; the original stays where it is. */
export const SkillImportInput = Schema.Struct({ path: TrimmedNonEmptyString });

export const SkillsEmptyResult = Schema.Struct({});

export class SkillError extends Schema.TaggedError<SkillError>()("SkillError", {
  reason: Schema.Literals(["not-found", "invalid", "exists", "failed"]),
  /** Shown to the user as is. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
