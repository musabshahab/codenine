import { SkillName } from "@codenine/contracts";
import * as Schema from "effect/Schema";

const isSkillName = Schema.is(SkillName);
const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** The folder name a skill is saved under: "Our email tone" becomes "our-email-tone". */
export function skillNameFromTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

interface SkillDraft {
  readonly title: string;
  readonly description: string;
}

export interface SkillDraftErrors {
  readonly title?: string;
  readonly description?: string;
}

/** The name to save under, or why the form cannot be saved yet. */
export function checkSkillDraft(
  draft: SkillDraft,
):
  | { readonly name: SkillName; readonly errors?: undefined }
  | { readonly errors: SkillDraftErrors } {
  const name = skillNameFromTitle(draft.title);
  const description = draft.description.trim();
  const errors: { title?: string; description?: string } = {};
  if (draft.title.trim() === "") errors.title = "Give the skill a name.";
  else if (name === "") errors.title = "Use letters or numbers in the name.";
  else if (name.length > SKILL_NAME_MAX_LENGTH) errors.title = "Use a shorter name.";
  if (description === "") errors.description = "Say when agents should use it.";
  else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    errors.description = `Keep this under ${SKILL_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters.`;
  }
  if (errors.title !== undefined || errors.description !== undefined || !isSkillName(name)) {
    return { errors };
  }
  return { name };
}
