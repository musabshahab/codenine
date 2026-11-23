// @effect-diagnostics nodeBuiltinImport:off - job ids are random UUIDs.
import * as NodeCrypto from "node:crypto";

import {
  type MediaAspectRatio,
  type MediaImageResult,
  MediaJobId,
  OrchestratorMcpFailure,
} from "@codenine/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Media from "../../../media/Media.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerFolder } from "../callerFolder.ts";
import { MediaToolkit } from "./tools.ts";

const REFUSAL = {
  tools: "Image tools",
  askFirst:
    "This chat asks the user before each file change, and Codenine cannot ask before paying for an image. Tell the user what you would make, and that they can switch the chat to a mode that accepts edits.",
};

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** Every media error says what the user can do, so the agent gets its message as it is. */
const mediaFailure = (cause: { readonly _tag: string; readonly message: string }) =>
  isMcpFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          cause._tag === "MediaLimitError" ||
          (cause._tag === "MediaProviderError" &&
            "reason" in cause &&
            cause.reason !== "unavailable")
            ? `${cause.message} Tell the user this. Do not look for another way to make the image.`
            : cause.message,
      });

const summary = (result: MediaImageResult) => ({
  files: result.files.map((file) => file.relativePath),
  model: result.model,
  costUsd: result.costUsd,
  spentThisMonthUsd: result.usage.spentUsd,
});

// The agent asks during its turn, so the user reviews the files as they do its other changes.
const DURING_TURN = { duringTurn: true } as const;

const request = (input: {
  readonly prompt: string;
  readonly aspectRatio?: MediaAspectRatio | undefined;
  readonly count?: number | undefined;
}) => ({
  jobId: MediaJobId.make(NodeCrypto.randomUUID()),
  prompt: input.prompt.trim() || "image",
  ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
  ...(input.count === undefined ? {} : { count: input.count }),
});

export const layer = McpToolAccess.toLayer(MediaToolkit, {
  codenine_image_generate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const folder = yield* callerFolder("edit", REFUSAL);
      const media = yield* Media.Media;
      const result = yield* media.generate(
        {
          ...request(input),
          cwd: folder.cwd,
          ...(input.folder === undefined ? {} : { folder: folder.relative(input.folder) }),
        },
        DURING_TURN,
      );
      return summary(result);
    }).pipe(Effect.mapError(mediaFailure)),
  ),
  codenine_image_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const folder = yield* callerFolder("edit", REFUSAL);
      const media = yield* Media.Media;
      const result = yield* media.edit(
        {
          ...request(input),
          cwd: folder.cwd,
          sourcePath: folder.relative(input.path),
          ...(input.mask === undefined ? {} : { maskPath: folder.relative(input.mask) }),
          ...(input.folder === undefined ? {} : { folder: folder.relative(input.folder) }),
        },
        DURING_TURN,
      );
      return summary(result);
    }).pipe(Effect.mapError(mediaFailure)),
  ),
});
