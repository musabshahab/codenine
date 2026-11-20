import type { ProjectId, SkillDetail, SkillScope } from "@codenine/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { SKILL_FILE, isSkillName, parseSkillFile } from "./SkillFile.ts";

const CODENINE_SKILLS_FOLDER = "skills";
const WORKSPACE_SKILLS_FOLDER = [".agents", "skills"] as const;
const SKILL_FILE_MAX_BYTES = 1024 * 1024;
const LISTED_FILES_MAX = 200;
const LISTED_FILES_MAX_DEPTH = 6;

export interface SkillRoot {
  readonly folder: string;
  readonly scope: SkillScope;
  readonly projectId: ProjectId | null;
}

export const codenineSkillRoot = (baseDir: string, path: Path.Path): SkillRoot => ({
  folder: path.join(baseDir, CODENINE_SKILLS_FOLDER),
  scope: "codenine",
  projectId: null,
});

export const workspaceSkillRoot = (
  workspace: { readonly projectId: ProjectId; readonly workspaceRoot: string },
  path: Path.Path,
): SkillRoot => ({
  folder: path.join(workspace.workspaceRoot, ...WORKSPACE_SKILLS_FOLDER),
  scope: "workspace",
  projectId: workspace.projectId,
});

/** Workspace first: a workspace skill wins over a Codenine skill of the same name. */
export const skillRoots = (
  input: {
    readonly baseDir: string;
    readonly workspace?: { readonly projectId: ProjectId; readonly workspaceRoot: string };
  },
  path: Path.Path,
): ReadonlyArray<SkillRoot> => [
  ...(input.workspace === undefined ? [] : [workspaceSkillRoot(input.workspace, path)]),
  codenineSkillRoot(input.baseDir, path),
];

// Untraced: these two run once per skill, inside the traced listings and reads that call them.

/** Files beside SKILL.md, relative to the folder; hidden entries and linked folders are not walked. */
export const listSkillFiles = Effect.fnUntraced(function* (folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const pending: Array<{ readonly relative: string; readonly depth: number }> = [
    { relative: "", depth: 0 },
  ];
  while (pending.length > 0 && files.length < LISTED_FILES_MAX) {
    const { relative, depth } = pending.shift()!;
    const entries = yield* fileSystem
      .readDirectoryEntries(path.join(folder, relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.type === "Directory") {
        if (depth + 1 < LISTED_FILES_MAX_DEPTH) pending.push({ relative: child, depth: depth + 1 });
      } else if (child !== SKILL_FILE && files.length < LISTED_FILES_MAX) {
        files.push(child);
      }
    }
  }
  return files.sort();
});

/** One skill folder, read as far as it can be: an unreadable or broken SKILL.md never fails a list. */
export const readSkill = Effect.fnUntraced(function* (
  root: SkillRoot,
  name: string,
  options: { readonly files: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(root.folder, name);
  const skillFile = path.join(folder, SKILL_FILE);
  const info = yield* fileSystem.stat(skillFile).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return Option.none<SkillDetail>();
  const contents =
    Number(info.value.size) > SKILL_FILE_MAX_BYTES
      ? ""
      : yield* fileSystem.readFileString(skillFile).pipe(Effect.orElseSucceed(() => ""));
  const parsed = parseSkillFile(contents);
  return Option.some<SkillDetail>({
    name,
    description: parsed.description ?? "",
    scope: root.scope,
    projectId: root.projectId,
    path: folder,
    fromLibrary:
      parsed.fromLibrary !== undefined && isSkillName(parsed.fromLibrary)
        ? parsed.fromLibrary
        : null,
    files: options.files ? yield* listSkillFiles(folder) : [],
    updatedAt: DateTime.formatIso(
      Option.match(info.value.mtime, {
        onNone: () => DateTime.makeUnsafe(0),
        onSome: DateTime.fromDateUnsafe,
      }),
    ),
    instructions: parsed.instructions,
  });
});

/** Every skill in a root, by name. A folder whose name is not a valid skill name is skipped. */
export const listSkills = Effect.fn("SkillFolders.listSkills")(function* (
  root: SkillRoot,
  options: { readonly files: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectoryEntries(root.folder)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<FileSystem.DirectoryEntry> => []));
  const names = entries
    .filter((entry) => entry.type !== "File" && isSkillName(entry.name))
    .map((entry) => entry.name)
    .sort();
  const skills = yield* Effect.forEach(names, (name) => readSkill(root, name, options), {
    concurrency: 8,
  });
  return skills.flatMap((skill) => (Option.isSome(skill) ? [skill.value] : []));
});

/** The skills an agent can use from these roots, earlier roots winning by name. */
export const availableSkills = Effect.fn("SkillFolders.availableSkills")(function* (
  roots: ReadonlyArray<SkillRoot>,
  options: { readonly files: boolean },
) {
  const byName = new Map<string, SkillDetail>();
  for (const root of roots) {
    for (const skill of yield* listSkills(root, options)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

export const findSkill = Effect.fn("SkillFolders.findSkill")(function* (
  roots: ReadonlyArray<SkillRoot>,
  name: string,
  options: { readonly files: boolean },
) {
  if (!isSkillName(name)) return Option.none<SkillDetail>();
  for (const root of roots) {
    const skill = yield* readSkill(root, name, options);
    if (Option.isSome(skill)) return skill;
  }
  return Option.none<SkillDetail>();
});
