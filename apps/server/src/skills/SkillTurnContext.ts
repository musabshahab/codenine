import {
  attachedSkillContext,
  keptOnSkillsContext,
} from "@codenine/provider-core/server/skillInstructions";
import { SKILL_MENTION_PATTERN } from "@codenine/shared/composerInlineTokens";
import type { ProjectId } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { type SkillRoot, availableSkills, listSkillFiles, skillRoots } from "./SkillFolders.ts";

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

/**
 * The skill fields of the message a provider gets, for a new turn and for a message that joins a
 * running one. Empty `text` and `keptOn` still list the skills and take none along.
 */
export const makeMessageSkills = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  return Effect.fn("SkillTurnContext.messageSkills")(function* (input: {
    readonly projectId: ProjectId;
    readonly text: string;
    readonly keptOn: ReadonlyArray<string>;
  }) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const workspace =
      project === undefined
        ? {}
        : { workspace: { projectId: input.projectId, workspaceRoot: project.workspaceRoot } };
    const turn = yield* skillTurnContext({
      roots: skillRoots({ baseDir, ...workspace }, path),
      text: input.text,
      keptOn: input.keptOn,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    return {
      skills: turn.skills,
      ...(turn.context.length === 0 ? {} : { context: turn.context }),
    };
  });
});
