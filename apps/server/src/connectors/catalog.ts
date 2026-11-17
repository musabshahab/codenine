import {
  type ConnectorCatalogEntry,
  ConnectorCatalogId,
  type ConnectorOwnApp,
  type ConnectorRisk,
} from "@codenine/contracts";

/** How Codenine reaches a library connector's MCP server, filled in from the connection's inputs. */
export type CatalogServer =
  | {
      readonly type: "http";
      readonly url: string;
      /** Query parameters set from inputs, by input key. */
      readonly queryInputs?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      /** Flags followed by an input's value, by input key. */
      readonly flagInputs?: Readonly<Record<string, string>>;
      /** Environment variables set from inputs, by input key. */
      readonly envInputs?: Readonly<Record<string, string>>;
    };

/** Tools Codenine serves itself beside a service's own, with the same sign-in. */
export type CodenineToolSet = "gmail";

/** Where the signed-in account's name comes from. */
export type AccountSource = "google-id-token" | "github-user";

export interface CatalogConnector {
  readonly entry: ConnectorCatalogEntry;
  readonly server: CatalogServer;
  /** The scopes to ask for, pinned so a service's broader list is never requested. */
  readonly scopes?: ReadonlyArray<string>;
  /** Extra authorize parameters, such as the ones Google needs to return a refresh token. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /** Risks that win over what the service's annotations say. */
  readonly risks?: Readonly<Record<string, ConnectorRisk>>;
  /** Wording for approval cards, finishing "Gmail wants to …", where a tool's name reads badly. */
  readonly actions?: Readonly<Record<string, string>>;
  readonly codenineTools?: CodenineToolSet;
  readonly account?: AccountSource;
}

/** The OAuth endpoints of a company whose services only accept apps the user creates. */
export interface OwnAppEndpoints {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly tokenEndpointAuthMethods: ReadonlyArray<string>;
  /** Where the user creates the app. */
  readonly consoleUrl: string;
}

export const OWN_APP_ENDPOINTS: Readonly<Record<ConnectorOwnApp, OwnAppEndpoints>> = {
  google: {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
  },
  slack: {
    issuer: "https://slack.com",
    authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
    tokenEndpointAuthMethods: ["client_secret_post"],
    consoleUrl: "https://api.slack.com/apps",
  },
};

const GOOGLE_AUTHORIZE_PARAMS = { access_type: "offline", prompt: "consent" };
const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];

const entry = (
  fields: Omit<ConnectorCatalogEntry, "id" | "inputs" | "runsLocally"> & {
    readonly id: string;
    readonly inputs?: ConnectorCatalogEntry["inputs"];
    readonly runsLocally?: boolean;
  },
): ConnectorCatalogEntry => ({
  ...fields,
  id: ConnectorCatalogId.make(fields.id),
  inputs: fields.inputs ?? [],
  runsLocally: fields.runsLocally ?? false,
});

export const CONNECTOR_CATALOG: ReadonlyArray<CatalogConnector> = [
  {
    entry: entry({
      id: "gmail",
      name: "Gmail",
      description: "Search and read email, write drafts, and send them once you say so.",
      category: "email-calendar",
      auth: "own-app",
      ownApp: "google",
      docsUrl: OWN_APP_ENDPOINTS.google.consoleUrl,
    }),
    server: { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
    // gmail.modify covers every tool the server has; gmail.compose covers sending drafts.
    scopes: [
      ...GOOGLE_IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    authorizeParams: GOOGLE_AUTHORIZE_PARAMS,
    risks: { send_draft: "irreversible" },
    actions: { send_draft: "send a draft", create_draft: "write a draft" },
    codenineTools: "gmail",
    account: "google-id-token",
  },
  {
    entry: entry({
      id: "google-calendar",
      name: "Google Calendar",
      description: "See your calendars, find free time and manage events.",
      category: "email-calendar",
      auth: "own-app",
      ownApp: "google",
      docsUrl: OWN_APP_ENDPOINTS.google.consoleUrl,
    }),
    server: { type: "http", url: "https://calendarmcp.googleapis.com/mcp/v1" },
    scopes: [
      ...GOOGLE_IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ],
    authorizeParams: GOOGLE_AUTHORIZE_PARAMS,
    // Responding emails the organiser; deleting can notify every guest.
    risks: { respond_to_event: "irreversible", delete_event: "irreversible" },
    actions: {
      respond_to_event: "respond to an event",
      delete_event: "delete an event",
      create_event: "create an event",
      update_event: "change an event",
    },
    account: "google-id-token",
  },
  {
    entry: entry({
      id: "google-drive",
      name: "Google Drive",
      description: "Search and read your files, and create new ones.",
      category: "files-docs",
      auth: "own-app",
      ownApp: "google",
      docsUrl: OWN_APP_ENDPOINTS.google.consoleUrl,
    }),
    server: { type: "http", url: "https://drivemcp.googleapis.com/mcp/v1" },
    scopes: [
      ...GOOGLE_IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    authorizeParams: GOOGLE_AUTHORIZE_PARAMS,
    account: "google-id-token",
  },
  {
    entry: entry({
      id: "github",
      name: "GitHub",
      description: "Issues, pull requests and code across your repositories.",
      category: "code",
      auth: "token",
      tokenLabel: "Access token",
      tokenHelpUrl: "https://github.com/settings/personal-access-tokens",
    }),
    server: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    risks: {
      merge_pull_request: "irreversible",
      push_files: "irreversible",
      create_or_update_file: "irreversible",
      delete_file: "irreversible",
      delete_repository: "irreversible",
      actions_run_trigger: "irreversible",
    },
    actions: {
      merge_pull_request: "merge a pull request",
      push_files: "push files",
      create_or_update_file: "change a file",
      delete_file: "delete a file",
      delete_repository: "delete a repository",
      actions_run_trigger: "run a workflow",
    },
    account: "github-user",
  },
  {
    entry: entry({
      id: "slack",
      name: "Slack",
      description: "Search and read conversations, and send messages.",
      category: "messages",
      auth: "own-app",
      ownApp: "slack",
      docsUrl: OWN_APP_ENDPOINTS.slack.consoleUrl,
    }),
    server: { type: "http", url: "https://mcp.slack.com/mcp" },
    scopes: [
      "search:read.public",
      "search:read.private",
      "search:read.mpim",
      "search:read.im",
      "search:read.files",
      "search:read.users",
      "channels:history",
      "groups:history",
      "mpim:history",
      "im:history",
      "canvases:read",
      "canvases:write",
      "users:read",
      "users:read.email",
      "chat:write",
    ],
    risks: { slack_send_message: "irreversible", slack_schedule_message: "irreversible" },
    actions: {
      slack_send_message: "send a message",
      slack_schedule_message: "schedule a message",
    },
  },
  {
    entry: entry({
      id: "notion",
      name: "Notion",
      description: "Search, read and update pages and databases.",
      category: "files-docs",
      auth: "sign-in",
    }),
    server: { type: "http", url: "https://mcp.notion.com/mcp" },
  },
  {
    entry: entry({
      id: "linear",
      name: "Linear",
      description: "Issues, projects and cycles in your workspace.",
      category: "projects",
      auth: "sign-in",
    }),
    server: { type: "http", url: "https://mcp.linear.app/mcp" },
  },
  {
    entry: entry({
      id: "atlassian",
      name: "Jira and Confluence",
      description: "Issues and pages across your Atlassian sites.",
      category: "projects",
      auth: "sign-in",
    }),
    // Without tools=all the server offers a few meta-tools that would hide each action from approval.
    server: { type: "http", url: "https://mcp.atlassian.com/v2/mcp?tools=all" },
  },
  {
    entry: entry({
      id: "sentry",
      name: "Sentry",
      description: "Errors, issues and releases from your projects.",
      category: "code",
      auth: "sign-in",
    }),
    server: { type: "http", url: "https://mcp.sentry.dev/mcp" },
  },
  {
    entry: entry({
      id: "stripe",
      name: "Stripe",
      description: "Customers, payments and subscriptions in your account.",
      category: "payments",
      auth: "sign-in",
    }),
    server: { type: "http", url: "https://mcp.stripe.com" },
    risks: {
      create_refund: "irreversible",
      create_payment_link: "irreversible",
      update_subscription: "irreversible",
      cancel_subscription: "irreversible",
    },
    actions: {
      create_refund: "refund a payment",
      create_payment_link: "create a payment link",
      update_subscription: "change a subscription",
      cancel_subscription: "cancel a subscription",
    },
  },
  {
    entry: entry({
      id: "supabase",
      name: "Supabase",
      description: "Query databases and manage projects. Starts read-only.",
      category: "data",
      auth: "sign-in",
      inputs: [
        {
          key: "projectRef",
          label: "Project ID",
          placeholder: "abcdefghijklmnopqrst",
          help: "Keep agents to one project. It is in the project's settings.",
          secret: false,
          required: false,
        },
      ],
    }),
    server: {
      type: "http",
      url: "https://mcp.supabase.com/mcp?read_only=true",
      queryInputs: { projectRef: "project_ref" },
    },
  },
  {
    entry: entry({
      id: "cloudflare",
      name: "Cloudflare",
      description: "Workers, DNS and the rest of your account.",
      category: "code",
      auth: "sign-in",
    }),
    server: { type: "http", url: "https://mcp.cloudflare.com/mcp" },
    // `execute` runs code against the whole account API.
    risks: { execute: "irreversible" },
    actions: { execute: "run code against your account" },
  },
  {
    entry: entry({
      id: "zapier",
      name: "Zapier",
      description: "Actions in thousands of apps. Each action an agent runs uses Zapier tasks.",
      category: "automation",
      auth: "token",
      tokenLabel: "Connection key",
      tokenHelpUrl: "https://mcp.zapier.com",
    }),
    server: { type: "http", url: "https://mcp.zapier.com/api/v1/connect" },
  },
  {
    entry: entry({
      id: "context7",
      name: "Library docs",
      description: "Current documentation and code examples for libraries.",
      category: "code",
      auth: "none",
    }),
    server: { type: "http", url: "https://mcp.context7.com/mcp" },
  },
  {
    entry: entry({
      id: "deepwiki",
      name: "Code wiki",
      description: "Explanations of public GitHub repositories.",
      category: "code",
      auth: "none",
    }),
    server: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    entry: entry({
      id: "exa",
      name: "Web search",
      description: "Search the web and read pages.",
      category: "web-browser",
      auth: "none",
    }),
    server: { type: "http", url: "https://mcp.exa.ai/mcp" },
  },
  {
    entry: entry({
      id: "playwright",
      name: "Browser",
      description: "A browser on this computer that agents can open pages in and use.",
      category: "web-browser",
      auth: "none",
      runsLocally: true,
      inputs: [
        {
          key: "browserPath",
          label: "Browser program",
          placeholder: "/usr/bin/chromium",
          help: "Use a browser already on this computer instead of downloading one.",
          secret: false,
          required: false,
        },
      ],
    }),
    server: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      flagInputs: { browserPath: "--executable-path" },
    },
  },
  {
    entry: entry({
      id: "postgres",
      name: "PostgreSQL",
      description: "Query a Postgres database without changing it. Needs uv on this computer.",
      category: "data",
      auth: "none",
      runsLocally: true,
      inputs: [
        {
          key: "databaseUrl",
          label: "Database address",
          placeholder: "postgresql://user:password@localhost:5432/app",
          secret: true,
          required: true,
        },
      ],
    }),
    server: {
      type: "stdio",
      command: "uvx",
      args: ["postgres-mcp", "--access-mode=restricted"],
      envInputs: { databaseUrl: "DATABASE_URI" },
    },
  },
];

const byId = new Map(CONNECTOR_CATALOG.map((connector) => [connector.entry.id, connector]));

export const catalogConnector = (id: ConnectorCatalogId): CatalogConnector | undefined =>
  byId.get(id);
