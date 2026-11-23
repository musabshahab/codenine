import {
  MEDIA_MAX_IMAGE_COUNT,
  MEDIA_PROMPT_MAX_LENGTH,
  MediaAspectRatio,
  OrchestratorMcpFailure,
} from "@codenine/contracts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Media from "../../../media/Media.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Media.Media,
    Path.Path,
  ],
};

// Relative to this chat's folder, or absolute inside it.
const WorkspacePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

const request = {
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MEDIA_PROMPT_MAX_LENGTH)),
  aspectRatio: Schema.optional(MediaAspectRatio),
  count: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEDIA_MAX_IMAGE_COUNT })),
  ),
  // Default: `media`.
  folder: Schema.optional(WorkspacePath),
};

const ImageResult = Schema.Struct({
  // The saved files, relative to this chat's folder.
  files: Schema.Array(Schema.String),
  model: Schema.String,
  costUsd: Schema.Number,
  spentThisMonthUsd: Schema.Number,
});

const ImageGenerateTool = Tool.make("codenine_image_generate", {
  ...shared,
  description:
    "Make images from a text prompt with the user's image provider and save them in this chat's folder (default folder: media). Each image costs the user money, within a limit they set: make one unless they ask for more. Describe the picture: subject, style, composition, any text to show. Returns the saved paths. If no provider is set up or the limit is reached, tell the user what the error says and stop.",
  parameters: Schema.Struct(request),
  success: ImageResult,
}).annotate(Tool.Destructive, false);

const ImageEditTool = Tool.make("codenine_image_edit", {
  ...shared,
  description:
    "Change a PNG, JPEG or WebP image in this chat's folder with the user's image provider: say what to change and what to keep. The result is saved as a new file; the original is kept. `mask` names a same-size image whose white area is the only part that may change. Each result costs the user money, within a limit they set.",
  parameters: Schema.Struct({
    path: WorkspacePath,
    ...request,
    mask: Schema.optional(WorkspacePath),
  }),
  success: ImageResult,
}).annotate(Tool.Destructive, false);

export const MediaToolkit = Toolkit.make(ImageGenerateTool, ImageEditTool);
