import { OrchestratorMcpFailure, SkillScope } from "@codenine/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Skills from "../../../skills/Skills.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Skills.Skills,
  ],
};

const SkillReadTool = Tool.make("codenine_skill_read", {
  ...shared,
  description:
    "Read a skill before you start a task it fits, then follow it. Returns its instructions, its folder and its other files; pass `file` to read one of those. Run a skill's scripts from its folder with your own shell.",
  parameters: Schema.Struct({
    name: Schema.String,
    file: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    name: Schema.String,
    folder: Schema.String,
    files: Schema.Array(Schema.String),
    text: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SkillListTool = Tool.make("codenine_skill_list", {
  ...shared,
  description:
    "List the skills `codenine_skill_read` can read: this workspace's and the user's Codenine skills, each with when to use it.",
  // No `parameters`: an explicit empty struct is not a valid MCP input schema.
  success: Schema.Struct({
    skills: Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.String, scope: SkillScope }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const SkillsToolkit = Toolkit.make(SkillReadTool, SkillListTool);
