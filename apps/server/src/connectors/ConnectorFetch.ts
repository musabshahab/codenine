// @effect-diagnostics globalFetch:off - the MCP SDK takes a fetch function, and this is where it comes from.
import type { FetchLike } from "@modelcontextprotocol/client";
import * as Context from "effect/Context";

/** Every request Codenine makes to a connected service; tests swap in a fake service. */
export const ConnectorFetch = Context.Reference<FetchLike>("codenine/connectors/ConnectorFetch", {
  defaultValue: () => (url, init) => fetch(url, init),
});
