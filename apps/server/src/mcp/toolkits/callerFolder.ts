import { OrchestratorMcpFailure } from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../../project/ProjectService.ts";
import { loadCaller, unavailable } from "../threadAccess.ts";

/**
 * The calling chat's folder, for a tool that reads or changes files in it. A change is refused
 * in plan mode and in a chat that asks before each change, with `askFirst` as the reason.
 */
export const callerFolder = Effect.fn("mcp.callerFolder")(function* (
  access: "read" | "edit",
  refusal: { readonly tools: string; readonly askFirst: string },
) {
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: `${refusal.tools} work on the calling chat's folder.`,
    });
  }
  if (access === "edit" && caller.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This chat is in plan mode, which does not change files.",
    });
  }
  // These tools are pre-approved for the provider, so no approval card would cover the write.
  if (access === "edit" && caller.runtimeMode === "approval-required") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: refusal.askFirst,
    });
  }
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This chat's workspace was not found.",
    });
  }
  const path = yield* Path.Path;
  const cwd = caller.worktreePath ?? project.value.workspaceRoot;
  return {
    cwd,
    /** A path the agent gave, absolute or not, as one relative to the folder. */
    relative: (requested: string) =>
      (path.isAbsolute(requested) ? path.relative(cwd, requested) : requested).replaceAll(
        "\\",
        "/",
      ),
  };
});
