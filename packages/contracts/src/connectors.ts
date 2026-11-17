import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";

/** Sign-ins come back to `<the origin the browser uses><this path>`. */
export const CONNECTOR_OAUTH_CALLBACK_PATH = "/oauth/connectors/callback";

const ConnectorSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/));

/** A connector in the library that ships with Codenine, such as `gmail`. */
export const ConnectorCatalogId = ConnectorSlug.pipe(Schema.brand("ConnectorCatalogId"));
export type ConnectorCatalogId = typeof ConnectorCatalogId.Type;

/** A connector the user connected; a library connector's first connection uses its catalogue id. */
export const ConnectionId = ConnectorSlug.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const ConnectorCategory = Schema.Literals([
  "email-calendar",
  "files-docs",
  "messages",
  "code",
  "projects",
  "payments",
  "data",
  "automation",
  "web-browser",
  "other",
]);
export type ConnectorCategory = typeof ConnectorCategory.Type;

/**
 * - `none`: no account.
 * - `sign-in`: standard sign-in; Codenine registers itself with the service.
 * - `own-app`: the service only accepts apps the user creates (Google, Slack).
 * - `token`: an access token, API key or connection key the user pastes.
 */
export const ConnectorAuthKind = Schema.Literals(["none", "sign-in", "own-app", "token"]);
export type ConnectorAuthKind = typeof ConnectorAuthKind.Type;

/** Apps the user creates once and Codenine reuses for every connector from that company. */
export const ConnectorOwnApp = Schema.Literals(["google", "slack"]);
export type ConnectorOwnApp = typeof ConnectorOwnApp.Type;

/** A value the user enters when connecting, such as a project id or database address. */
export const ConnectorInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  placeholder: Schema.optional(Schema.String),
  help: Schema.optional(Schema.String),
  /** Kept in the secret store and never sent back to clients. */
  secret: Schema.Boolean,
  required: Schema.Boolean,
});
export type ConnectorInput = typeof ConnectorInput.Type;

export const ConnectorCatalogEntry = Schema.Struct({
  id: ConnectorCatalogId,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  category: ConnectorCategory,
  auth: ConnectorAuthKind,
  ownApp: Schema.optional(ConnectorOwnApp),
  /** What the user pastes for `token` auth, such as "Access token". */
  tokenLabel: Schema.optional(Schema.String),
  tokenHelpUrl: Schema.optional(Schema.String),
  inputs: Schema.Array(ConnectorInput),
  /** Runs as a program on the server's computer rather than as a web service. */
  runsLocally: Schema.Boolean,
  docsUrl: Schema.optional(Schema.String),
});
export type ConnectorCatalogEntry = typeof ConnectorCatalogEntry.Type;

/** How far an action reaches: reading, changing, or something that can't be taken back. */
export const ConnectorRisk = Schema.Literals(["read", "change", "irreversible"]);
export type ConnectorRisk = typeof ConnectorRisk.Type;

export const ConnectorApprovalMode = Schema.Literals(["auto", "ask"]);
export type ConnectorApprovalMode = typeof ConnectorApprovalMode.Type;

export const ConnectorApprovals = Schema.Struct({
  read: ConnectorApprovalMode,
  change: ConnectorApprovalMode,
  irreversible: ConnectorApprovalMode,
});
export type ConnectorApprovals = typeof ConnectorApprovals.Type;

export const ConnectionStatus = Schema.Literals([
  "connected",
  "connecting",
  "needs-sign-in",
  "error",
]);
export type ConnectionStatus = typeof ConnectionStatus.Type;

export const ConnectionSnapshot = Schema.Struct({
  id: ConnectionId,
  /** Null for a custom connector. */
  catalogId: Schema.NullOr(ConnectorCatalogId),
  name: TrimmedNonEmptyString,
  description: Schema.String,
  category: ConnectorCategory,
  auth: ConnectorAuthKind,
  runsLocally: Schema.Boolean,
  /** A custom connector's web address or command; null for library connectors. */
  address: Schema.NullOr(Schema.String),
  status: ConnectionStatus,
  /** Shown to the user as is: why it needs attention, or what it is doing. */
  statusDetail: Schema.NullOr(Schema.String),
  /** The account signed in, when the service says, such as an email address. */
  account: Schema.NullOr(Schema.String),
  /** Used by chats that have not picked their own connectors. */
  onByDefault: Schema.Boolean,
  approvals: ConnectorApprovals,
  toolCount: Schema.NullOr(NonNegativeInt),
  /** Non-secret answers to the catalogue's inputs. */
  inputs: Schema.Record(Schema.String, Schema.String),
  /** Keys of secret inputs that hold a value; the values never leave the server. */
  secretInputsSet: Schema.Array(Schema.String),
  connectedAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type ConnectionSnapshot = typeof ConnectionSnapshot.Type;

export const ConnectorsState = Schema.Struct({
  catalog: Schema.Array(ConnectorCatalogEntry),
  connections: Schema.Array(ConnectionSnapshot),
  /** Own apps already saved, so connecting another of their connectors skips the setup. */
  ownApps: Schema.Array(ConnectorOwnApp),
});
export type ConnectorsState = typeof ConnectorsState.Type;

export const ConnectorsEmptyInput = Schema.Struct({});
export const ConnectorsEmptyResult = Schema.Struct({});

export const ConnectorTransport = Schema.Union([
  Schema.Struct({ type: Schema.Literal("http"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
  }),
]);
export type ConnectorTransport = typeof ConnectorTransport.Type;

export const ConnectorConnectInput = Schema.Struct({
  /** A library connector; leave out and pass `custom` for any other MCP server. */
  catalogId: Schema.optionalKey(ConnectorCatalogId),
  custom: Schema.optionalKey(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      transport: ConnectorTransport,
      auth: Schema.Literals(["none", "sign-in", "token"]),
    }),
  ),
  /** Answers to the catalogue's inputs, secret ones included, plus `token` for token auth. */
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The user's own app, for `own-app` connectors; saved once per company. */
  ownApp: Schema.optionalKey(
    Schema.Struct({
      clientId: TrimmedNonEmptyString,
      clientSecret: TrimmedNonEmptyString,
    }),
  ),
  /** `window.location.origin`: where the service sends the browser back after signing in. */
  redirectOrigin: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ConnectorConnectInput = typeof ConnectorConnectInput.Type;

export const ConnectorConnectResult = Schema.Struct({
  connectionId: ConnectionId,
  /** Open this in the browser to finish signing in; null when the connector is ready. */
  authorizeUrl: Schema.NullOr(Schema.String),
});
export type ConnectorConnectResult = typeof ConnectorConnectResult.Type;

export const ConnectorIdInput = Schema.Struct({ connectionId: ConnectionId });

export const ConnectorSignInInput = Schema.Struct({
  connectionId: ConnectionId,
  redirectOrigin: TrimmedNonEmptyString,
});
export const ConnectorSignInResult = Schema.Struct({ authorizeUrl: Schema.String });

export const ConnectorUpdateInput = Schema.Struct({
  connectionId: ConnectionId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  onByDefault: Schema.optionalKey(Schema.Boolean),
  approvals: Schema.optionalKey(
    Schema.Struct({
      read: Schema.optionalKey(ConnectorApprovalMode),
      change: Schema.optionalKey(ConnectorApprovalMode),
      irreversible: Schema.optionalKey(ConnectorApprovalMode),
    }),
  ),
  /** One action's choice; null goes back to its group's choice. */
  toolApprovals: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(ConnectorApprovalMode)),
  ),
  /** New answers to the catalogue's inputs; secret ones replace the saved value. */
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ConnectorUpdateInput = typeof ConnectorUpdateInput.Type;

export const ConnectorTestResult = Schema.Struct({
  ok: Schema.Boolean,
  toolCount: Schema.NullOr(NonNegativeInt),
  detail: Schema.NullOr(Schema.String),
});
export type ConnectorTestResult = typeof ConnectorTestResult.Type;

export const ConnectorTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  description: Schema.String,
  risk: ConnectorRisk,
  /** What happens when an agent calls it, after the action's own choice. */
  approval: ConnectorApprovalMode,
  /** The user chose this action's approval instead of its group's. */
  overridden: Schema.Boolean,
  /** Added by Codenine rather than the service, such as sending a Gmail draft. */
  providedByCodenine: Schema.Boolean,
});
export type ConnectorTool = typeof ConnectorTool.Type;

export const ConnectorToolsResult = Schema.Struct({ tools: Schema.Array(ConnectorTool) });

export const ConnectorActivityOutcome = Schema.Literals([
  "auto",
  "allowed",
  "declined",
  "failed",
  "cancelled",
]);
export type ConnectorActivityOutcome = typeof ConnectorActivityOutcome.Type;

export const ConnectorActivityEntry = Schema.Struct({
  at: IsoDateTime,
  tool: TrimmedNonEmptyString,
  /** One line, such as `Sent the draft "Re: Release date" to sam@example.com`. */
  summary: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  outcome: ConnectorActivityOutcome,
});
export type ConnectorActivityEntry = typeof ConnectorActivityEntry.Type;

export const ConnectorActivityInput = Schema.Struct({
  connectionId: ConnectionId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export const ConnectorActivityResult = Schema.Struct({
  entries: Schema.Array(ConnectorActivityEntry),
});

/** `always`: allow it, and stop asking for this action on this connector. */
export const ConnectorApprovalAnswer = Schema.Literals(["allow", "always", "decline"]);
export type ConnectorApprovalAnswer = typeof ConnectorApprovalAnswer.Type;

export const ConnectorApprovalAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: ConnectorApprovalAnswer,
});
export type ConnectorApprovalAnswerInput = typeof ConnectorApprovalAnswerInput.Type;

export class ConnectorError extends Schema.TaggedError<ConnectorError>()("ConnectorError", {
  reason: Schema.Literals([
    "not-found",
    "invalid",
    "sign-in-failed",
    "unreachable",
    "already-answered",
    "failed",
  ]),
  /** Shown to the user as is. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
