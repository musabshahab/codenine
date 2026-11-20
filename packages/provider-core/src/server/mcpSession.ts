import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@codenine/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Connections this thread uses. Each is its own MCP server, named by the connection id and
   * served at `<endpoint>/connectors/<id>` with the same authorization header.
   */
  readonly connectors?: ReadonlyArray<string>;
}

export const connectorEndpoint = (config: McpProviderSessionConfig, connectionId: string) =>
  `${config.endpoint}/connectors/${encodeURIComponent(connectionId)}`;
