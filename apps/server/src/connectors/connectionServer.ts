import type { ConnectorAuthKind } from "@codenine/contracts";

import { type CatalogConnector, catalogConnector } from "./catalog.ts";
import type { ConnectionSecrets, StoredConnection } from "./ConnectorStore.ts";

/** Where and how Codenine reaches one connection's MCP server. */
export type ResolvedServer =
  | { readonly type: "http"; readonly url: string }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    };

export const connectionCatalog = (connection: StoredConnection): CatalogConnector | undefined =>
  connection.catalogId === null ? undefined : catalogConnector(connection.catalogId);

export const connectionAuthKind = (connection: StoredConnection): ConnectorAuthKind =>
  connectionCatalog(connection)?.entry.auth ?? connection.custom?.auth ?? "none";

export const resolveServer = (
  connection: StoredConnection,
  secrets: ConnectionSecrets,
): ResolvedServer | undefined => {
  const value = (key: string) => connection.inputs[key] ?? secrets.inputs[key];
  const catalog = connectionCatalog(connection);
  if (catalog === undefined) {
    const transport = connection.custom?.transport;
    if (transport === undefined) return undefined;
    return transport.type === "http"
      ? { type: "http", url: transport.url }
      : { type: "stdio", command: transport.command, args: transport.args, env: {} };
  }
  const server = catalog.server;
  if (server.type === "http") {
    const params = Object.entries(server.queryInputs ?? {}).flatMap(([key, param]) => {
      const answer = value(key);
      return answer === undefined || answer.length === 0 ? [] : [[param, answer] as const];
    });
    if (params.length === 0) return { type: "http", url: server.url };
    const url = new URL(server.url);
    for (const [param, answer] of params) url.searchParams.set(param, answer);
    return { type: "http", url: url.href };
  }
  const flags = Object.entries(server.flagInputs ?? {}).flatMap(([key, flag]) => {
    const answer = value(key);
    return answer === undefined || answer.length === 0 ? [] : [flag, answer];
  });
  const env = Object.fromEntries(
    Object.entries(server.envInputs ?? {}).flatMap(([key, variable]) => {
      const answer = value(key);
      return answer === undefined || answer.length === 0 ? [] : [[variable, answer] as const];
    }),
  );
  return { type: "stdio", command: server.command, args: [...server.args, ...flags], env };
};

/** A short, plain name for where the server is, safe to show and log. */
export const serverLocation = (server: ResolvedServer): string =>
  server.type === "http"
    ? URL.canParse(server.url)
      ? new URL(server.url).host
      : server.url
    : server.command;
