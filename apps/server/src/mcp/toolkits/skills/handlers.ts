import { OrchestratorMcpFailure, type SkillError } from "@codenine/contracts";
import * as Effect from "effect/Effect";

import * as Skills from "../../../skills/Skills.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { SkillsToolkit } from "./tools.ts";

const skillFailure = (error: SkillError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "failed" ? "orchestration_error" : "invalid_request",
    message: error.detail,
  });

// A thread caller resolves its own workspace's skills first; an outside client gets Codenine's.
export const layer = McpToolAccess.toLayer(SkillsToolkit, {
  codenine_skill_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const skills = yield* Skills.Skills;
      return yield* skills
        .readForAgent({ name: input.name, projectId: caller?.projectId, file: input.file })
        .pipe(Effect.mapError(skillFailure));
    }),
  ),
  codenine_skill_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const skills = yield* Skills.Skills;
      const available = yield* skills.available(caller?.projectId);
      return {
        skills: available.map(({ name, description, scope }) => ({ name, description, scope })),
      };
    }),
  ),
});
