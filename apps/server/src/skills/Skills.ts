import {
  type FoundSkill,
  type ProjectId,
  type SkillDetail,
  SkillError,
  type SkillName,
  type SkillRefInput,
  type SkillSaveInput,
  type SkillScope,
  type SkillSummary,
  type SkillsListInput,
  type SkillsListResult,
} from "@codenine/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import {
  SKILL_FILE,
  isSkillName,
  parseSkillFile,
  renderSkillFile,
  slugifySkillName,
} from "./SkillFile.ts";
import {
  type SkillRoot,
  availableSkills,
  codenineSkillRoot,
  findSkill,
  listSkills,
  readSkill,
  skillRoots,
  workspaceSkillRoot,
} from "./SkillFolders.ts";
import { SKILL_LIBRARY } from "./SkillLibrary.ts";

const AGENT_FILE_MAX_BYTES = 256 * 1024;
const IMPORT_MAX_FILES = 500;
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const FOUND_IN: Readonly<Record<string, string>> = { claudeAgent: "Claude Code", codex: "Codex" };

/** A skill, or one file in its folder, as an agent reads it. */
export interface AgentSkillRead {
  readonly name: string;
  readonly folder: string;
  readonly files: ReadonlyArray<string>;
  readonly text: string;
}

export class Skills extends Context.Service<
  Skills,
  {
    readonly list: (input: SkillsListInput) => Effect.Effect<SkillsListResult, SkillError>;
    readonly read: (input: SkillRefInput) => Effect.Effect<SkillDetail, SkillError>;
    /** Without `previousName` creates a skill and never replaces one; with it, edits, renames or moves that skill. */
    readonly save: (input: SkillSaveInput) => Effect.Effect<SkillSummary, SkillError>;
    readonly remove: (input: SkillRefInput) => Effect.Effect<void, SkillError>;
    readonly addFromLibrary: (input: {
      readonly name: SkillName;
    }) => Effect.Effect<SkillSummary, SkillError>;
    /** Copies a skill folder, one a provider found or any other, into the Codenine folder; the original stays put. */
    readonly importFound: (input: {
      readonly path: string;
    }) => Effect.Effect<SkillSummary, SkillError>;
    /** The skills an agent in a workspace can use, a workspace skill winning by name. */
    readonly available: (
      projectId: ProjectId | undefined,
    ) => Effect.Effect<ReadonlyArray<SkillSummary>>;
    readonly readForAgent: (input: {
      readonly name: string;
      readonly projectId: ProjectId | undefined;
      readonly file?: string | undefined;
    }) => Effect.Effect<AgentSkillRead, SkillError>;
  }
>()("codenine/skills/Skills") {}

const toSummary = ({ instructions: _instructions, ...summary }: SkillDetail): SkillSummary =>
  summary;

/** Logs what went wrong and tells the user only what failed. */
const failed = (detail: string) => (cause: unknown) =>
  Effect.logWarning(detail, { cause }).pipe(
    Effect.andThen(Effect.fail(new SkillError({ reason: "failed", detail }))),
  );

const codenineNameFor = (label: string) => (isSkillName(label) ? label : slugifySkillName(label));

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const codenine = codenineSkillRoot(baseDir, path);
  const withFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const skillFolderOf = (skillPath: string) =>
    path.basename(skillPath) === SKILL_FILE ? path.dirname(skillPath) : skillPath;
  const occupied = (target: string) =>
    fileSystem.lstat(target).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.catchTags({ PlatformError: failed("Could not check the skills folder.") }),
    );

  const workspaceOf = Effect.fn("Skills.workspaceOf")(function* (projectId: ProjectId) {
    const shell = yield* projects
      .getShell(projectId)
      .pipe(Effect.catchTags({ ProjectStoreV2Error: failed("Could not read the workspace.") }));
    if (Option.isNone(shell)) {
      return yield* new SkillError({
        reason: "not-found",
        detail: "That workspace was not found.",
      });
    }
    return { projectId, workspaceRoot: shell.value.workspaceRoot };
  });

  const rootFor = Effect.fn("Skills.rootFor")(function* (
    scope: SkillScope,
    projectId: ProjectId | undefined,
  ) {
    if (scope === "codenine") return codenine;
    if (projectId === undefined) {
      return yield* new SkillError({
        reason: "invalid",
        detail: "Choose the workspace this skill belongs to.",
      });
    }
    return workspaceSkillRoot(yield* workspaceOf(projectId), path);
  });

  const agentRoots = Effect.fn("Skills.agentRoots")(function* (projectId: ProjectId | undefined) {
    // An agent whose workspace is gone still gets the Codenine skills.
    const workspace =
      projectId === undefined
        ? undefined
        : yield* workspaceOf(projectId).pipe(Effect.orElseSucceed(() => undefined));
    return skillRoots({ baseDir, ...(workspace === undefined ? {} : { workspace }) }, path);
  });

  const readOrFail = Effect.fn("Skills.readOrFail")(function* (root: SkillRoot, name: string) {
    const skill = yield* withFileSystem(readSkill(root, name, { files: true }));
    if (Option.isNone(skill)) {
      return yield* new SkillError({
        reason: "not-found",
        detail: `There is no skill named ${name} here.`,
      });
    }
    return skill.value;
  });

  const foundSkills = Effect.fn("Skills.foundSkills")(function* (
    codenineNames: ReadonlySet<string>,
  ) {
    const codenineFolder = yield* fileSystem
      .realPath(codenine.folder)
      .pipe(Effect.orElseSucceed(() => codenine.folder));
    const seen = new Set<string>();
    const found: Array<FoundSkill> = [];
    for (const provider of yield* providers.getProviders) {
      for (const skill of provider.skills) {
        const folder = skillFolderOf(skill.path);
        if (seen.has(folder)) continue;
        seen.add(folder);
        const real = yield* fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => folder));
        // Older versions linked Codenine's own skills into account folders.
        if (isWithinRoot(path, real, codenineFolder)) continue;
        found.push({
          name: skill.name,
          description: skill.description ?? skill.shortDescription ?? "",
          providerInstanceId: provider.instanceId,
          providerName: FOUND_IN[provider.driver] ?? provider.displayName ?? provider.driver,
          path: skill.path,
          inCodenine: codenineNames.has(codenineNameFor(skill.name)),
        });
      }
    }
    return found.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.providerName.localeCompare(right.providerName),
    );
  });

  const list: Skills["Service"]["list"] = Effect.fn("Skills.list")(function* (input) {
    const workspace =
      input.projectId === undefined ? undefined : yield* workspaceOf(input.projectId);
    const own = yield* withFileSystem(listSkills(codenine, { files: true }));
    const shared =
      workspace === undefined
        ? []
        : yield* withFileSystem(listSkills(workspaceSkillRoot(workspace, path), { files: true }));
    const codenineNames = new Set(own.map((skill) => skill.name));
    return {
      skills: [...shared, ...own]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(toSummary),
      found: yield* foundSkills(codenineNames),
      library: SKILL_LIBRARY.map((skill) => ({
        name: skill.name,
        description: skill.description,
        added: own.some((candidate) =>
          [candidate.name, candidate.fromLibrary].includes(skill.name),
        ),
      })),
    };
  });

  const read: Skills["Service"]["read"] = Effect.fn("Skills.read")(function* (input) {
    return yield* readOrFail(yield* rootFor(input.scope, input.projectId), input.name);
  });

  const save: Skills["Service"]["save"] = Effect.fn("Skills.save")(function* (input) {
    const root = yield* rootFor(input.scope, input.projectId);
    const target = path.join(root.folder, input.name);
    const couldNotSave = failed("Could not save the skill.");
    const taken = new SkillError({
      reason: "exists",
      detail: `A skill named ${input.name} already exists here.`,
    });
    yield* fileSystem
      .makeDirectory(root.folder, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotSave }));
    const previousRoot =
      input.previousName === undefined || input.previousScope === undefined
        ? root
        : yield* rootFor(input.previousScope, input.previousProjectId);
    const source =
      input.previousName === undefined
        ? undefined
        : path.join(previousRoot.folder, input.previousName);
    const moved = source !== undefined && previousRoot.folder !== root.folder;
    if (input.previousName === undefined) {
      // Claiming the folder first means two creates of one name cannot both write it.
      yield* fileSystem.makeDirectory(target).pipe(
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.fail(taken)),
        Effect.catchTags({ PlatformError: couldNotSave }),
      );
    } else {
      yield* readOrFail(previousRoot, input.previousName);
    }
    if (source !== undefined && source !== target) {
      if (yield* occupied(target)) return yield* taken;
      // Another place can be another disk, so a move copies; a linked folder's files are copied.
      yield* (
        moved
          ? fileSystem
              .realPath(source)
              .pipe(Effect.flatMap((real) => fileSystem.copy(real, target, { overwrite: true })))
          : fileSystem.rename(source, target)
      ).pipe(Effect.catchTags({ PlatformError: couldNotSave }));
    }
    const skillFile = path.join(target, SKILL_FILE);
    yield* fileSystem.readFileString(skillFile).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
      Effect.flatMap((existing) =>
        fileSystem.writeFileString(
          skillFile,
          renderSkillFile({
            existing,
            name: input.name,
            description: input.description,
            instructions: input.instructions,
          }),
        ),
      ),
      Effect.catchTags({ PlatformError: couldNotSave }),
      // A folder this save made must not stay behind half written.
      Effect.tapError(() =>
        input.previousName === undefined || moved
          ? fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    if (moved && input.previousName !== undefined) {
      yield* removeFolder(previousRoot, input.previousName).pipe(
        Effect.catchTags({
          SkillError: () =>
            Effect.fail(
              new SkillError({
                reason: "failed",
                detail: "Saved, but the old copy is still there. Delete it from the Skills page.",
              }),
            ),
        }),
      );
    }
    return toSummary(yield* readOrFail(root, input.name));
  });

  const remove: Skills["Service"]["remove"] = Effect.fn("Skills.remove")(function* (input) {
    const root = yield* rootFor(input.scope, input.projectId);
    yield* readOrFail(root, input.name);
    yield* removeFolder(root, input.name);
  });

  const removeFolder = Effect.fn("Skills.removeFolder")(function* (root: SkillRoot, name: string) {
    const target = path.join(root.folder, name);
    const couldNotDelete = failed("Could not delete the skill.");
    const info = yield* fileSystem
      .lstat(target)
      .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    // A linked skill folder loses only its link; what it points at is someone else's.
    if (info.type === "SymbolicLink") {
      return yield* fileSystem
        .remove(target)
        .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    }
    const [realRoot, realTarget] = yield* Effect.all([
      fileSystem.realPath(root.folder),
      fileSystem.realPath(target),
    ]).pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
    if (realTarget === realRoot || !isWithinRoot(path, realTarget, realRoot)) {
      return yield* new SkillError({
        reason: "invalid",
        detail: "That folder is outside the skills folder.",
      });
    }
    yield* fileSystem
      .remove(target, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotDelete }));
  });

  // Claiming the folder first means two adds of one name cannot both write it.
  const claimFolder = Effect.fn("Skills.claimFolder")(function* (name: string) {
    const couldNotAdd = failed("Could not add the skill.");
    yield* fileSystem
      .makeDirectory(codenine.folder, { recursive: true })
      .pipe(Effect.catchTags({ PlatformError: couldNotAdd }));
    const target = path.join(codenine.folder, name);
    yield* fileSystem.makeDirectory(target).pipe(
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.fail(
          new SkillError({
            reason: "exists",
            detail: `A Codenine skill named ${name} already exists.`,
          }),
        ),
      ),
      Effect.catchTags({ PlatformError: couldNotAdd }),
    );
    return target;
  });

  const addFromLibrary: Skills["Service"]["addFromLibrary"] = Effect.fn("Skills.addFromLibrary")(
    function* (input) {
      const skill = SKILL_LIBRARY.find((candidate) => candidate.name === input.name);
      if (skill === undefined) {
        return yield* new SkillError({
          reason: "not-found",
          detail: `Codenine's library has no skill named ${input.name}.`,
        });
      }
      const target = yield* claimFolder(skill.name);
      yield* fileSystem
        .writeFileString(
          path.join(target, SKILL_FILE),
          renderSkillFile({
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
            fromLibrary: skill.name,
          }),
        )
        .pipe(
          Effect.catchTags({ PlatformError: failed("Could not add the skill.") }),
          Effect.tapError(() => fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore)),
        );
      return toSummary(yield* readOrFail(codenine, skill.name));
    },
  );

  /** Refuses folders too big to copy, such as a plugin whose root is its only skill. */
  const assertCopyable = Effect.fn("Skills.assertCopyable")(function* (folder: string) {
    const tooLarge = new SkillError({
      reason: "invalid",
      detail: `That skill's folder is too large to copy (over ${IMPORT_MAX_FILES} files or ${IMPORT_MAX_BYTES / 1024 / 1024} MB).`,
    });
    const pending = [folder];
    let files = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entries = yield* fileSystem
        .readDirectoryEntries(directory)
        .pipe(Effect.catchTags({ PlatformError: failed("Could not read the skill's folder.") }));
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        if (entry.type === "Directory") {
          pending.push(child);
          continue;
        }
        files += 1;
        if (entry.type === "File") {
          const info = yield* fileSystem.stat(child).pipe(Effect.option);
          bytes += Option.isSome(info) ? Number(info.value.size) : 0;
        }
        if (files > IMPORT_MAX_FILES || bytes > IMPORT_MAX_BYTES) return yield* tooLarge;
      }
    }
  });

  const importFound: Skills["Service"]["importFound"] = Effect.fn("Skills.importFound")(
    function* (input) {
      const requested = path.resolve(yield* withFileSystem(expandHomePath(input.path)));
      // A provider names its skills, such as a plugin's `plugin:review`; any other folder names itself.
      const found = (yield* providers.getProviders)
        .flatMap((provider) => provider.skills)
        .find(
          (candidate) =>
            path.resolve(candidate.path) === requested ||
            path.resolve(skillFolderOf(candidate.path)) === requested,
        );
      const gone = new SkillError({
        reason: "not-found",
        detail:
          found === undefined
            ? "That folder has no SKILL.md. Enter the folder that holds it, on the computer Codenine runs on."
            : "That skill is no longer there. Refresh the list and try again.",
      });
      // Copy what a link points at, so the copy never edits the original.
      const source = yield* fileSystem
        .realPath(skillFolderOf(found?.path ?? requested))
        .pipe(Effect.catchTags({ PlatformError: () => Effect.fail(gone) }));
      const contents = yield* fileSystem
        .readFileString(path.join(source, SKILL_FILE))
        .pipe(Effect.catchTags({ PlatformError: () => Effect.fail(gone) }));
      const ownFolder = yield* fileSystem
        .realPath(codenine.folder)
        .pipe(Effect.orElseSucceed(() => codenine.folder));
      if (isWithinRoot(path, source, ownFolder)) {
        return yield* new SkillError({
          reason: "exists",
          detail: "That skill is already in Codenine.",
        });
      }
      yield* assertCopyable(source);
      const parsed = parseSkillFile(contents);
      const skill = found ?? { name: parsed.name ?? path.basename(source), description: undefined };
      const name = codenineNameFor(skill.name);
      const target = yield* claimFolder(name);
      yield* fileSystem.copy(source, target, { overwrite: true }).pipe(
        Effect.andThen(
          // The open format names a skill after its folder, so a renamed copy is renamed inside too.
          parsed.name === name && parsed.description !== undefined
            ? Effect.void
            : fileSystem.writeFileString(
                path.join(target, SKILL_FILE),
                renderSkillFile({
                  existing: contents,
                  name,
                  description: parsed.description ?? skill.description,
                  instructions: parsed.instructions,
                }),
              ),
        ),
        Effect.catchTags({ PlatformError: failed("Could not copy the skill.") }),
        Effect.tapError(() => fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore)),
      );
      return toSummary(yield* readOrFail(codenine, name));
    },
  );

  const available: Skills["Service"]["available"] = Effect.fn("Skills.available")(
    function* (projectId) {
      const skills = yield* withFileSystem(
        availableSkills(yield* agentRoots(projectId), { files: false }),
      );
      return skills.map(toSummary);
    },
  );

  const readFileForAgent = Effect.fn("Skills.readFileForAgent")(function* (
    folder: string,
    file: string,
  ) {
    const relative = file.trim().replaceAll("\\", "/");
    const outside = new SkillError({
      reason: "invalid",
      detail: "Pass `file` as a path inside the skill's folder, such as references/guide.md.",
    });
    const target = path.resolve(folder, relative);
    if (relative === "" || path.isAbsolute(relative) || target === folder) return yield* outside;
    if (!isWithinRoot(path, target, folder)) return yield* outside;
    const missing = new SkillError({
      reason: "not-found",
      detail: `The skill has no file ${relative}.`,
    });
    const [realFolder, real] = yield* Effect.all([
      fileSystem.realPath(folder),
      fileSystem.realPath(target),
    ]).pipe(Effect.catchTags({ PlatformError: () => Effect.fail(missing) }));
    if (!isWithinRoot(path, real, realFolder)) return yield* outside;
    const info = yield* fileSystem
      .stat(real)
      .pipe(Effect.catchTags({ PlatformError: () => Effect.fail(missing) }));
    if (info.type !== "File") return yield* missing;
    if (Number(info.size) > AGENT_FILE_MAX_BYTES) {
      return yield* new SkillError({
        reason: "invalid",
        detail: `${relative} is too large to return here. Read it at ${target}.`,
      });
    }
    const bytes = yield* fileSystem
      .readFile(real)
      .pipe(Effect.catchTags({ PlatformError: failed(`Could not read ${relative}.`) }));
    if (bytes.includes(0)) {
      return yield* new SkillError({
        reason: "invalid",
        detail: `${relative} is not text. Use it at ${target}.`,
      });
    }
    return new TextDecoder().decode(bytes);
  });

  const readForAgent: Skills["Service"]["readForAgent"] = Effect.fn("Skills.readForAgent")(
    function* (input) {
      // Agents see skills named as `$name` in messages, and may pass the sigil along.
      const requested = input.name.trim().replace(/^\p{Sc}/u, "");
      const skill = yield* withFileSystem(
        findSkill(yield* agentRoots(input.projectId), requested, { files: true }),
      );
      if (Option.isNone(skill)) {
        return yield* new SkillError({
          reason: "not-found",
          detail: `There is no skill named ${requested}. codenine_skill_list lists them.`,
        });
      }
      const { name, path: folder, files, instructions } = skill.value;
      return {
        name,
        folder,
        files,
        text: input.file === undefined ? instructions : yield* readFileForAgent(folder, input.file),
      };
    },
  );

  return Skills.of({
    list,
    read,
    save,
    remove,
    addFromLibrary,
    importFound,
    available,
    readForAgent,
  });
});

export const layer = Layer.effect(Skills, make);
