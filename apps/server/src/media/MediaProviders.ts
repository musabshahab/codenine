import * as Context from "effect/Context";

import { falMediaAdapter } from "./FalMedia.ts";
import type { MediaAdapter } from "./MediaAdapter.ts";
import { openRouterMediaAdapter } from "./OpenRouterMedia.ts";

/** Every image provider the server offers. A provider without a key is listed, and not called. */
export const MediaAdapters = Context.Reference<ReadonlyArray<MediaAdapter>>(
  "codenine/media/MediaAdapters",
  { defaultValue: () => [falMediaAdapter, openRouterMediaAdapter] },
);
