import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  CommandId,
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  type UnknownUnionMember,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  runOnSettle: Schema.optional(Schema.Boolean),
  stopOnSettle: Schema.optional(Schema.Boolean),
  async: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|icns|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const ProjectIconOverride = Schema.Union([
  ProjectLucideIcon,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

const ProjectLucideIconWithLegacyMonogram = Schema.Struct({
  ...ProjectLucideIcon.fields,
  monogramText: Schema.optional(ProjectMonogramText),
  monogram: Schema.optional(ProjectMonogramText),
});
const projectIconMembers = [
  ProjectLucideIconWithLegacyMonogram,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
] as const;
type ProjectIconMember = (typeof projectIconMembers)[number]["Type"];

const fromLegacyMonogram = (icon: ProjectIconMember): ProjectIconOverride => {
  if (icon.kind !== "lucide") return icon;
  const text = icon.monogramText ?? icon.monogram;
  return text === undefined
    ? { kind: "lucide", name: icon.name, color: icon.color }
    : { kind: "monogram", text, color: icon.color };
};

export const StoredProjectIcon = Schema.Union(projectIconMembers).pipe(
  Schema.decodeTo(
    Schema.toType(ProjectIconOverride),
    SchemaTransformation.transform<ProjectIconOverride, ProjectIconMember>({
      decode: fromLegacyMonogram,
      encode: (icon) => icon,
    }),
  ),
);

export const ReceivedProjectIcon = ForwardCompatibleUnion(projectIconMembers, "kind").pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.toType(ProjectIconOverride)),
    SchemaTransformation.transform<
      ProjectIconOverride | null,
      ProjectIconMember | UnknownUnionMember<"kind">
    >({
      decode: (icon) => (isUnknownUnionMember(icon) ? null : fromLegacyMonogram(icon)),
      encode: (icon) => icon as ProjectIconMember,
    }),
  ),
);

export const WorkspaceKind = Schema.Literals(["code", "work", "create"]).annotate({
  description: "Workspace type.",
});
export type WorkspaceKind = typeof WorkspaceKind.Type;

/** Projects from before workspace kinds, and from older servers, are code workspaces. */
export const WorkspaceKindWithDefault = WorkspaceKind.pipe(
  Schema.withDecodingDefault(Effect.succeed("code" as const)),
);

export const Project = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  kind: WorkspaceKindWithDefault,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ReceivedProjectIcon)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  scripts: Schema.Array(ProjectScript),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Project = typeof Project.Type;

export const ProjectSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
  updatedAt: IsoDateTime,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectCreatePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  kind: Schema.optional(WorkspaceKind),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.Type;

export const ProjectUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(WorkspaceKind),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autoPull: Schema.optional(Schema.Boolean),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(
    Schema.Boolean.annotate({
      description: "Threads and files are kept.",
    }),
  ),
});
export type ProjectUpdatePayload = typeof ProjectUpdatePayload.Type;

export const ProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.create"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectCreatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.update"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.delete"),
    commandId: CommandId,
    projectId: ProjectId,
    force: Schema.optional(Schema.Boolean),
    /** Also deletes the workspace root on the server's disk, and the project's worktrees. */
    deleteFolder: Schema.optional(Schema.Boolean),
  }),
]);
export type ProjectMutation = typeof ProjectMutation.Type;

export class ProjectMutationError extends Schema.TaggedError<ProjectMutationError>()(
  "ProjectMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  ignored: Schema.optional(Schema.Boolean),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Preserve whitespace because it is significant in content queries.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  directoryPath: Schema.optional(TrimmedString),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

// Untracked files git ignores. Wholly ignored folders such as `node_modules`
// are left out, so the list stays small enough to pick from.
export const ProjectListIgnoredFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListIgnoredFilesInput = typeof ProjectListIgnoredFilesInput.Type;

export const ProjectIgnoredFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type ProjectIgnoredFile = typeof ProjectIgnoredFile.Type;

export const ProjectListIgnoredFilesResult = Schema.Struct({
  files: Schema.Array(ProjectIgnoredFile),
  truncated: Schema.Boolean,
});
export type ProjectListIgnoredFilesResult = typeof ProjectListIgnoredFilesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
  "directory_list_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedError<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Workspace-relative or absolute host path; only workspace-relative paths are writable.
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  // Optional files can be absent without failing the read.
  allowMissing: Schema.optional(Schema.Boolean),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  // Omitted by older servers; false only for an absent optional file.
  exists: Schema.optional(Schema.Boolean),
  // Hash of the bytes on disk. Omitted by older servers and for truncated or absent files.
  version: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
  // The read `version` the writer last saw. A file that differs is not written. Omit to overwrite.
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  // The `version` a read of the written file returns. Omitted by older servers.
  version: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

/** The file changed on disk after the writer read it, so nothing was written. */
export class ProjectWriteFileConflictError extends Schema.TaggedError<ProjectWriteFileConflictError>()(
  "ProjectWriteFileConflictError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    // Absent when the file no longer exists.
    currentVersion: Schema.optional(TrimmedNonEmptyString),
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' changed on disk since it was read.`;
  }
}

export const ProjectFileBaselineSource = Schema.Union([
  /** The workspace's last commit. */
  Schema.Struct({ kind: Schema.Literal("head") }),
  /** The checkpoint a thread's turn started from. */
  Schema.Struct({
    kind: Schema.Literal("turn"),
    threadId: ThreadId,
    turnCount: PositiveInt,
  }),
]);
export type ProjectFileBaselineSource = typeof ProjectFileBaselineSource.Type;

export const ProjectReadFileBaselineInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  source: ProjectFileBaselineSource,
  // The `revision` of a baseline the caller holds; a match is answered without the contents.
  knownRevision: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectReadFileBaselineInput = typeof ProjectReadFileBaselineInput.Type;

export const ProjectReadFileBaselineResult = Schema.Struct({
  // False without Git, without the commit or checkpoint, and for binary or oversized files.
  available: Schema.Boolean,
  // Null when the file did not exist in the baseline, and when `unchanged`.
  contents: Schema.NullOr(Schema.String),
  // The commit the baseline was read from.
  revision: Schema.optional(TrimmedNonEmptyString),
  // True when `revision` is the caller's `knownRevision`, so the contents were left out.
  unchanged: Schema.optional(Schema.Boolean),
  // True when the earlier contents are kept but are not text, as for a workbook. The file can be
  // put back whole with projects.revertFileChange, but not compared here.
  wholeFileOnly: Schema.optional(Schema.Boolean),
  // With `wholeFileOnly`: the read `version` of the file as it is now, which
  // projects.revertFileChange takes as `expectedVersion`. Absent when the file is gone.
  currentVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectReadFileBaselineResult = typeof ProjectReadFileBaselineResult.Type;

export class ProjectReadFileBaselineError extends Schema.TaggedError<ProjectReadFileBaselineError>()(
  "ProjectReadFileBaselineError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Zero-based line ranges of one change: the baseline's lines and the lines that replaced them. */
export const ProjectFileLineChange = Schema.Struct({
  baseStart: NonNegativeInt,
  baseCount: NonNegativeInt,
  currentStart: NonNegativeInt,
  currentCount: NonNegativeInt,
});
export type ProjectFileLineChange = typeof ProjectFileLineChange.Type;

export const ProjectRevertFileChangeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  threadId: ThreadId,
  turnCount: PositiveInt,
  // The read `version` the caller saw. Omit for a file that is gone, to put back one the turn
  // deleted.
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
  // Omit to restore the whole file, which deletes a file the turn created.
  change: Schema.optional(ProjectFileLineChange),
});
export type ProjectRevertFileChangeInput = typeof ProjectRevertFileChangeInput.Type;

export const ProjectRevertFileChangeResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  deleted: Schema.Boolean,
  version: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectRevertFileChangeResult = typeof ProjectRevertFileChangeResult.Type;

export class ProjectRevertFileChangeError extends Schema.TaggedError<ProjectRevertFileChangeError>()(
  "ProjectRevertFileChangeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectFileVersion = Schema.Struct({
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  byteLength: NonNegativeInt,
  // Only a "stored" version can be read and restored. "deleted" marks the file's removal, and
  // "skipped" a change whose contents were too large to keep.
  state: Schema.Literals(["stored", "deleted", "skipped"]),
  // Who wrote these contents: an editor save, an agent's turn, a restore, or something outside
  // Codenine. The first time a file is seen counts as outside.
  origin: Schema.Literals(["user", "agent", "restore", "external"]),
  // Set on the save in which the user placed their signature on the document.
  action: Schema.optional(Schema.Literal("signed")),
  // The `version` a read of the file returns while it holds these contents.
  version: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  turnCount: Schema.optional(PositiveInt),
});
export type ProjectFileVersion = typeof ProjectFileVersion.Type;

export const ProjectListFileVersionsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
});
export type ProjectListFileVersionsInput = typeof ProjectListFileVersionsInput.Type;

export const ProjectListFileVersionsResult = Schema.Struct({
  // False in a Git checkout, where checkpoints and Git hold the history instead.
  tracked: Schema.Boolean,
  // Newest first.
  versions: Schema.Array(ProjectFileVersion),
});
export type ProjectListFileVersionsResult = typeof ProjectListFileVersionsResult.Type;

export const ProjectListFileActivityInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Only changes recorded at or after this time.
  since: Schema.optional(IsoDateTime),
  // The chat asking. Changes it never lists (another chat's turns, and changes made outside
  // Codenine) are then left out before the newest few hundred are taken.
  threadId: Schema.optional(ThreadId),
  // Fewer than the newest few hundred, for a short list. Older servers ignore it.
  limit: Schema.optional(PositiveInt),
});
export type ProjectListFileActivityInput = typeof ProjectListFileActivityInput.Type;

export const ProjectFileActivityEntry = Schema.Struct({
  ...ProjectFileVersion.fields,
  relativePath: TrimmedNonEmptyString,
  change: Schema.Literals(["created", "modified", "deleted"]),
});
export type ProjectFileActivityEntry = typeof ProjectFileActivityEntry.Type;

export const ProjectListFileActivityResult = Schema.Struct({
  // False in a Git checkout, where the version store records nothing.
  tracked: Schema.Boolean,
  // Newest first, and at most the newest few hundred.
  entries: Schema.Array(ProjectFileActivityEntry),
});
export type ProjectListFileActivityResult = typeof ProjectListFileActivityResult.Type;

export const ProjectReadFileVersionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  versionId: TrimmedNonEmptyString,
});
export type ProjectReadFileVersionInput = typeof ProjectReadFileVersionInput.Type;

export const ProjectReadFileVersionResult = Schema.Struct({
  // Null for a version that is not text or is over the preview limit. It can still be restored.
  contents: Schema.NullOr(Schema.String),
  byteLength: NonNegativeInt,
});
export type ProjectReadFileVersionResult = typeof ProjectReadFileVersionResult.Type;

export const ProjectRestoreFileVersionInput = Schema.Struct({
  ...ProjectReadFileVersionInput.fields,
  // As for a save: the read `version` the caller saw. Omit to replace whatever is on disk.
  expectedVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectRestoreFileVersionInput = typeof ProjectRestoreFileVersionInput.Type;

export const ProjectRestoreFileVersionResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
});
export type ProjectRestoreFileVersionResult = typeof ProjectRestoreFileVersionResult.Type;

export class ProjectFileVersionError extends Schema.TaggedError<ProjectFileVersionError>()(
  "ProjectFileVersionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectEnsureScratchResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectEnsureScratchResult = typeof ProjectEnsureScratchResult.Type;

export const ProjectCreateNewInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: Schema.optional(WorkspaceKind),
});
export type ProjectCreateNewInput = typeof ProjectCreateNewInput.Type;

export const ProjectCreateNewResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** The project and its files exist either way. */
  commitError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectCreateNewResult = typeof ProjectCreateNewResult.Type;

export const ProjectCreateFromThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectCreateFromThreadInput = typeof ProjectCreateFromThreadInput.Type;

export const ProjectCreateFromThreadResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCreateFromThreadResult = typeof ProjectCreateFromThreadResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
