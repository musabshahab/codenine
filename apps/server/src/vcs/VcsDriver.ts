import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@codenine/contracts";
import { CheckpointRef } from "@codenine/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface VcsListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsReadFileAtRevisionInput {
  readonly cwd: string;
  readonly revision: CheckpointRef | "HEAD";
  /** Relative to `cwd`, with `/` separators. */
  readonly relativePath: string;
  /** A commit the caller already read this file from; a match skips the read. */
  readonly knownCommit?: string | undefined;
}

/** `unavailable` covers a missing revision and files that are binary or over the size limit. */
export type VcsFileAtRevision =
  | { readonly kind: "text"; readonly commit: string; readonly contents: string }
  | { readonly kind: "absent"; readonly commit: string }
  | { readonly kind: "unchanged"; readonly commit: string }
  | { readonly kind: "unavailable" };

export const FILE_AT_REVISION_MAX_BYTES = 1024 * 1024;

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<boolean, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listAuthoredPaths: (
    input: VcsListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
  readonly readFileAtRevision: (
    input: VcsReadFileAtRevisionInput,
  ) => Effect.Effect<VcsFileAtRevision, VcsError>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints: VcsCheckpointOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("codenine/vcs/VcsDriver") {}
