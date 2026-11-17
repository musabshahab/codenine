import {
  attachedSkillContext,
  keptOnSkillsContext,
} from "@codenine/provider-core/server/skillInstructions";
import { SKILL_MENTION_PATTERN } from "@codenine/shared/composerInlineTokens";
import * as Effect from "effect/Effect";

import { type SkillRoot, availableSkills, listSkillFiles } from "./SkillFolders.ts";

/** Names a message mentions as `$name`, by the composer's token rules, in order and once each. */
export const mentionedSkillNames = (text: string): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
};

/**
 * What a turn carries about Codenine's skills, the same for every provider: the skills the
 * session lists, the full text of each skill the message names, and a note naming the skills
 * kept on for the chat, which the agent reads with the skill tool once per conversation.
 */
export const skillTurnContext = Effect.fn("SkillTurnContext.build")(function* (input: {
  readonly roots: ReadonlyArray<SkillRoot>;
  readonly text: string;
  readonly keptOn: ReadonlyArray<string>;
}) {
  const available = yield* availableSkills(input.roots, { files: false });
  const byName = new Map(available.map((skill) => [skill.name, skill]));
  const attached = mentionedSkillNames(input.text).filter((name) => byName.has(name));
  const attachedContext = yield* Effect.forEach(attached, (name) => {
    const skill = byName.get(name)!;
    return listSkillFiles(skill.path).pipe(
      Effect.map((files) =>
        attachedSkillContext({
          name,
          folder: skill.path,
          files,
          instructions: skill.instructions,
        }),
      ),
    );
  });
  const keptOn = input.keptOn.filter((name) => byName.has(name) && !attached.includes(name));
  return {
    context:
      keptOn.length === 0 ? attachedContext : [...attachedContext, keptOnSkillsContext(keptOn)],
    skills: {
      available: available.map(({ name, description }) => ({ name, description })),
      attached,
    },
  };
});
