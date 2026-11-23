import {
  type EnvironmentId,
  ProjectId,
  type ProjectReadFileResult,
  type ScopedProjectRef,
  WS_METHODS,
} from "@codenine/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  request,
  requestGuarded,
} from "../rpc/client.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import { createProject, deleteProject, updateProject } from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createFileMetadataAtoms } from "./fileMetadata.ts";
import { resolveWorkspaceFilePath } from "@codenine/shared/path";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  /** `version` is the disk version these contents were edited from, which a save must still find. */
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
  /** Set when a save was refused because the file changed on disk; saving waits for a decision. */
  readonly conflict?: { readonly currentVersion: string | undefined };
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

function writtenFilePaths(
  input: Pick<EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>, "cwd" | "relativePath">,
  result: Pick<EnvironmentRpcSuccess<typeof WS_METHODS.projectsWriteFile>, "relativePath">,
) {
  return new Set(
    [result.relativePath, input.relativePath].map((path) =>
      resolveWorkspaceFilePath(path, input.cwd),
    ),
  );
}

export class ScratchProjectNotLoadedError extends Schema.TaggedError<ScratchProjectNotLoadedError>()(
  "ScratchProjectNotLoadedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The folder for threads without a project has not reached this device yet. Try again.";
  }
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  options: {
    readonly projectAtom: (ref: ScopedProjectRef) => Atom.Atom<EnvironmentProject | null>;
  },
) {
  const fileMetadata = createFileMetadataAtoms(runtime);
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    fileMetadata: fileMetadata.metadata,
    fileMetadataThread: fileMetadata.retainThread,
    invalidateFileMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:filesystem:invalidate-metadata",
      execute: (input: { paths: ReadonlyArray<string> }, registry, environmentId) =>
        Effect.forEach([...new Set(input.paths)], (path) =>
          fileMetadata
            .invalidate(path)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => fileMetadata.refreshPath(environmentId, path, registry)),
              ),
            ),
        ),
    }),
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsSearchEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsListEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    listIgnoredFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-ignored-files",
      tag: WS_METHODS.projectsListIgnoredFiles,
      staleTimeMs: 15_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsReadFile, input),
          (result, isCurrent) =>
            result.exists === false
              ? Effect.void
              : fileMetadata.rememberFile(input.cwd, result, isCurrent),
        ),
    }),
    readFileBaseline: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file-baseline",
      tag: WS_METHODS.projectsReadFileBaseline,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    listFileVersions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-file-versions",
      tag: WS_METHODS.projectsListFileVersions,
      staleTimeMs: 5_000,
      idleTtlMs: 60_000,
    }),
    readFileVersion: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file-version",
      tag: WS_METHODS.projectsReadFileVersion,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    openSpreadsheet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:documents:open-spreadsheet",
      tag: WS_METHODS.documentsOpenSpreadsheet,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    readSpreadsheetRange: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:documents:read-spreadsheet-range",
      tag: WS_METHODS.documentsReadSpreadsheetRange,
      staleTimeMs: 0,
      // The grid keeps the pages it shows, so a settled read is not held a second time.
      idleTtlMs: 1_000,
    }),
    editSpreadsheet: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:documents:edit-spreadsheet",
      tag: WS_METHODS.documentsEditSpreadsheet,
      scheduler: fileScheduler,
      // The key `writeFile` uses, so an edit and a restore of one file never interleave.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.documentsEditSpreadsheet, input).pipe(
          Effect.tap(() => Effect.forEach(writtenFilePaths(input, input), fileMetadata.invalidate)),
        ),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, input))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
    openPdf: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:documents:open-pdf",
      tag: WS_METHODS.documentsOpenPdf,
      staleTimeMs: 0,
      idleTtlMs: 1_000,
    }),
    editPdf: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:documents:edit-pdf",
      tag: WS_METHODS.documentsEditPdf,
      scheduler: fileScheduler,
      // The key `writeFile` uses, so an edit and a restore of one file never interleave.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.documentsEditPdf, input).pipe(
          Effect.tap(() => Effect.forEach(writtenFilePaths(input, input), fileMetadata.invalidate)),
        ),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, input))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: createProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: updateProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: deleteProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // Finds or creates the environment's Scratch project and resolves once the
    // project is in the client store, since drafts key off its stored path.
    openScratch: createEnvironmentCommand(runtime, {
      label: "environment-data:projects:open-scratch",
      execute: (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsEnsureScratch>,
        registry,
        environmentId,
      ) =>
        request(WS_METHODS.projectsEnsureScratch, input).pipe(
          Effect.flatMap(({ projectId }) =>
            AtomRegistry.toStream(registry, options.projectAtom({ environmentId, projectId })).pipe(
              Stream.filter(Predicate.isNotNull),
              Stream.runHead,
              Effect.timeoutOption("10 seconds"),
              Effect.map(Option.flatten),
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => Effect.fail(new ScratchProjectNotLoadedError({ projectId })),
                }),
              ),
            ),
          ),
        ),
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createNew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-new",
      tag: WS_METHODS.projectsCreateNew,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createFromThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-from-thread",
      tag: WS_METHODS.projectsCreateFromThread,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.projectsWriteFile, input).pipe(
          Effect.tap((result) =>
            Effect.forEach(writtenFilePaths(input, result), fileMetadata.invalidate),
          ),
        ),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, result))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
    revertFileChange: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:revert-file-change",
      tag: WS_METHODS.projectsRevertFileChange,
      scheduler: fileScheduler,
      // The key `writeFile` uses, so a revert and a save of one file never interleave.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.projectsRevertFileChange, input).pipe(
          Effect.tap((result) =>
            Effect.forEach(writtenFilePaths(input, result), fileMetadata.invalidate),
          ),
        ),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, result))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
    restoreFileVersion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:restore-file-version",
      tag: WS_METHODS.projectsRestoreFileVersion,
      scheduler: fileScheduler,
      // The key `writeFile` uses, so a restore and a save of one file never interleave.
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.projectsRestoreFileVersion, input).pipe(
          Effect.tap((result) =>
            Effect.forEach(writtenFilePaths(input, result), fileMetadata.invalidate),
          ),
        ),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, result))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
  };
}
