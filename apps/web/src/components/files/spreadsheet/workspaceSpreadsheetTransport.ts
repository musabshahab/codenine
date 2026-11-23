import {
  type EnvironmentId,
  ProjectWriteFileConflictError,
  SpreadsheetOperationError,
  SpreadsheetTooLargeError,
  SpreadsheetUnsupportedError,
} from "@codenine/contracts";
import {
  type AtomCommandResult,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@codenine/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import type { SpreadsheetResult, SpreadsheetTransport } from "./spreadsheetSession";

const isConflict = Schema.is(ProjectWriteFileConflictError);
const isTooLarge = Schema.is(SpreadsheetTooLargeError);
const isUnsupported = Schema.is(SpreadsheetUnsupportedError);
const isOperationError = Schema.is(SpreadsheetOperationError);
const QUIET = { reportFailure: false, reportDefect: false } as const;

function settle<A>(result: AtomCommandResult<A, unknown>): SpreadsheetResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  const failure = squashAtomCommandFailure(result);
  if (isConflict(failure)) return { ok: false, failure: { kind: "conflict" } };
  if (isTooLarge(failure) || isUnsupported(failure) || isOperationError(failure)) {
    const { message, operationIndex } = failure;
    return {
      ok: false,
      failure: {
        kind: "refused",
        message,
        fallback: !isOperationError(failure),
        ...(operationIndex === undefined ? {} : { operationIndex }),
      },
    };
  }
  return {
    ok: false,
    failure: {
      kind: "failed",
      message: failure instanceof Error ? failure.message : "The server could not be reached.",
    },
  };
}

/** Reads and edits one workspace spreadsheet through the server that holds it. */
export function workspaceSpreadsheetTransport(file: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): SpreadsheetTransport {
  const { environmentId, cwd, relativePath } = file;
  return {
    open: async () =>
      settle(
        await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.openSpreadsheet({ environmentId, input: { cwd, relativePath } }),
          { ...QUIET, refresh: true },
        ),
      ),
    readRange: async (range) =>
      settle(
        await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.readSpreadsheetRange({
            environmentId,
            input: { cwd, relativePath, ...range },
          }),
          { ...QUIET, refresh: true },
        ),
      ),
    edit: async (operations, expectedVersion) =>
      settle(
        await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.editSpreadsheet,
          {
            environmentId,
            input: {
              cwd,
              relativePath,
              operations,
              ...(expectedVersion === undefined ? {} : { expectedVersion }),
            },
          },
          QUIET,
        ),
      ),
  };
}
