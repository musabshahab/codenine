import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FILESYSTEM_METADATA_BATCH_LIMIT = 64;

export const FilesystemGetMetadataInput = Schema.Struct({
  // Absolute host paths, including ~/; clients must anchor relative paths.
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(FILESYSTEM_METADATA_BATCH_LIMIT)),
});
export type FilesystemGetMetadataInput = typeof FilesystemGetMetadataInput.Type;

export const FilesystemEntryMetadata = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "other"]),
  byteLength: Schema.optionalKey(NonNegativeInt),
  mimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesystemEntryMetadata = typeof FilesystemEntryMetadata.Type;

// Entries follow request order; null means missing, unreadable, or unsupported.
export const FilesystemGetMetadataResult = Schema.Struct({
  entries: Schema.Array(Schema.NullOr(FilesystemEntryMetadata)),
});
export type FilesystemGetMetadataResult = typeof FilesystemGetMetadataResult.Type;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
  // Marks each listed folder that is a Git repository. One stat per folder, so only asked for
  // by a folder browser. Older servers ignore it.
  detectRepositories: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
  isGitRepository: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
  // Set when the server may not read the folder; its entries are then empty.
  permissionDenied: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    /** Set when the directory does not exist; older clients ignore it. */
    pathMissing: Schema.optional(Schema.Boolean),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly pathMissing?: boolean;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

const FILESYSTEM_DIRECTORY_NAME_MAX_LENGTH = 255;

export const FilesystemCreateDirectoryInput = Schema.Struct({
  // An absolute host path, or one under ~/.
  parentPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  // One path segment: no separators, and not "." or "..".
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_DIRECTORY_NAME_MAX_LENGTH)),
});
export type FilesystemCreateDirectoryInput = typeof FilesystemCreateDirectoryInput.Type;

export const FilesystemCreateDirectoryResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type FilesystemCreateDirectoryResult = typeof FilesystemCreateDirectoryResult.Type;

export const FilesystemCreateDirectoryFailure = Schema.Literals([
  "invalid_name",
  "already_exists",
  "parent_missing",
  "permission_denied",
  "create_failed",
]);
export type FilesystemCreateDirectoryFailure = typeof FilesystemCreateDirectoryFailure.Type;

/** `message` is written for the user and shown as is. */
export class FilesystemCreateDirectoryError extends Schema.TaggedError<FilesystemCreateDirectoryError>()(
  "FilesystemCreateDirectoryError",
  {
    failure: FilesystemCreateDirectoryFailure,
    message: TrimmedNonEmptyString,
  },
) {}
