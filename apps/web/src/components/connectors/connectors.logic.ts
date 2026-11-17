import type {
  ConnectionSnapshot,
  ConnectionStatus,
  ConnectorActivityOutcome,
  ConnectorCatalogEntry,
  ConnectorCategory,
  ConnectorConnectInput,
  ConnectorOwnApp,
  ConnectorRisk,
  ConnectorTool,
  OrchestrationV2ConnectorApprovalStatus,
} from "@codenine/contracts";

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  "email-calendar": "Email and calendar",
  "files-docs": "Files and docs",
  messages: "Messages",
  code: "Code",
  projects: "Projects",
  payments: "Payments",
  data: "Data",
  automation: "Automation",
  "web-browser": "Web and browser",
  other: "Other",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ConnectorCategory[];

export const OWN_APP_COMPANY: Record<ConnectorOwnApp, string> = {
  google: "Google",
  slack: "Slack",
};

/** The categories the library has entries in, in a fixed order, for its filter chips. */
export function libraryCategories(
  catalog: ReadonlyArray<Pick<ConnectorCatalogEntry, "category">>,
): ConnectorCategory[] {
  const present = new Set(catalog.map((entry) => entry.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

export function filterLibrary<
  T extends Pick<ConnectorCatalogEntry, "name" | "description" | "category">,
>(
  catalog: ReadonlyArray<T>,
  filter: { readonly query: string; readonly category: ConnectorCategory | null },
): T[] {
  const query = filter.query.trim().toLowerCase();
  return catalog.filter(
    (entry) =>
      (filter.category === null || entry.category === filter.category) &&
      (query === "" ||
        entry.name.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query) ||
        CATEGORY_LABELS[entry.category].toLowerCase().includes(query)),
  );
}

/** How a library connector connects, as its tile says. */
export function connectsWithLabel(
  entry: Pick<ConnectorCatalogEntry, "auth" | "ownApp" | "tokenLabel" | "runsLocally">,
): string {
  if (entry.runsLocally) return "Runs on this computer";
  switch (entry.auth) {
    case "none":
      return "No account needed";
    case "sign-in":
      return "Sign in";
    case "own-app":
      return `Uses your ${OWN_APP_COMPANY[entry.ownApp ?? "google"]} app`;
    case "token":
      return entry.tokenLabel?.trim() || "Access token";
  }
}

export const CONNECTION_STATUS: Record<
  ConnectionStatus,
  { readonly label: string; readonly variant: "success" | "info" | "warning" | "error" }
> = {
  connected: { label: "Connected", variant: "success" },
  connecting: { label: "Connecting", variant: "info" },
  "needs-sign-in": { label: "Needs sign-in", variant: "warning" },
  error: { label: "Error", variant: "error" },
};

/** The line under a connection's name: its account, where it runs, and what its status means. */
export function connectionSummary(
  connection: Pick<ConnectionSnapshot, "account" | "runsLocally" | "statusDetail" | "auth">,
): string {
  return [
    connection.account ? `Signed in as ${connection.account}` : null,
    connection.runsLocally ? "Runs on this computer" : null,
    connection.auth === "none" && !connection.runsLocally ? "No account needed" : null,
    connection.statusDetail,
  ]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" · ");
}

/** Whether a sign-in would send the browser back to `origin`: services take https and this computer. */
export function servicesAcceptOrigin(origin: string): boolean {
  const url = URL.parse(origin);
  if (url === null) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

/**
 * A sign-in or help page to open, only when it is a web address: a custom connector's server
 * picks its sign-in address, and another scheme could run script in this app.
 */
export function webPageUrl(address: string | null | undefined): string | null {
  const url = address == null ? null : URL.parse(address);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
}

/**
 * Where sign-ins return: the page's own address, or, in the desktop app whose own scheme is no
 * web address, the server it runs.
 */
export function signInReturnOrigin(pageOrigin: string, serverHttpBaseUrl: string | null) {
  const page = URL.parse(pageOrigin);
  if (page !== null && (page.protocol === "http:" || page.protocol === "https:")) {
    return page.origin;
  }
  return serverHttpBaseUrl === null ? null : (URL.parse(serverHttpBaseUrl)?.origin ?? null);
}

export function needsOwnAppSetup(
  entry: Pick<ConnectorCatalogEntry, "auth" | "ownApp">,
  savedApps: ReadonlyArray<ConnectorOwnApp>,
): boolean {
  return entry.auth === "own-app" && !savedApps.includes(entry.ownApp ?? "google");
}

export interface ConnectFormValues {
  readonly inputs: Readonly<Record<string, string>>;
  readonly token: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type ConnectFormErrors = Partial<Record<string, string>>;

/** The request that connects a library entry, or what the user still has to fill in. */
export function libraryConnectRequest(
  entry: ConnectorCatalogEntry,
  values: ConnectFormValues,
  options: {
    readonly savedApps: ReadonlyArray<ConnectorOwnApp>;
    readonly returnOrigin: string | null;
  },
):
  | { readonly input: ConnectorConnectInput; readonly errors?: undefined }
  | { readonly input?: undefined; readonly errors: ConnectFormErrors } {
  const errors: ConnectFormErrors = {};
  const inputs: Record<string, string> = {};
  for (const field of entry.inputs) {
    const value = values.inputs[field.key]?.trim() ?? "";
    if (value !== "") inputs[field.key] = value;
    else if (field.required) errors[field.key] = `Enter ${field.label.toLowerCase()}.`;
  }
  if (entry.auth === "token") {
    const token = values.token.trim();
    if (token === "")
      errors.token = `Paste the ${(entry.tokenLabel ?? "access token").toLowerCase()}.`;
    else inputs.token = token;
  }
  const setupApp = needsOwnAppSetup(entry, options.savedApps);
  if (setupApp && values.clientId.trim() === "") errors.clientId = "Paste the client ID.";
  if (setupApp && values.clientSecret.trim() === "") {
    errors.clientSecret = "Paste the client secret.";
  }
  const signsIn = entry.auth === "sign-in" || entry.auth === "own-app";
  if (signsIn && options.returnOrigin === null) {
    errors.form = "This app has no web address a sign-in can come back to.";
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    input: {
      catalogId: entry.id,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(setupApp
        ? { ownApp: { clientId: values.clientId.trim(), clientSecret: values.clientSecret.trim() } }
        : {}),
      ...(signsIn && options.returnOrigin !== null ? { redirectOrigin: options.returnOrigin } : {}),
    },
  };
}

export type CustomConnectorAuth = "none" | "sign-in" | "token";

interface CustomConnectorValues {
  readonly name: string;
  readonly address: string;
  readonly auth: CustomConnectorAuth;
  readonly token: string;
}

/** Splits a command line into words; quotes keep spaces, as a shell would. */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

export function customConnectRequest(
  values: CustomConnectorValues,
  returnOrigin: string | null,
):
  | { readonly input: ConnectorConnectInput; readonly errors?: undefined }
  | { readonly input?: undefined; readonly errors: ConnectFormErrors } {
  const errors: ConnectFormErrors = {};
  const name = values.name.trim();
  const address = values.address.trim();
  if (name === "") errors.name = "Give it a name.";
  const url = URL.parse(address);
  const isWebAddress = url !== null && (url.protocol === "http:" || url.protocol === "https:");
  const [command, ...args] = isWebAddress ? [] : splitCommandLine(address);
  if (!isWebAddress && command === undefined) {
    errors.address = "Enter a web address or a command.";
  }
  if (values.auth === "token" && values.token.trim() === "") errors.token = "Paste the token.";
  if (values.auth === "sign-in" && returnOrigin === null) {
    errors.form = "This app has no web address a sign-in can come back to.";
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    input: {
      custom: {
        name,
        transport: isWebAddress
          ? { type: "http", url: address }
          : { type: "stdio", command: command ?? "", args },
        auth: values.auth,
      },
      ...(values.auth === "token" ? { inputs: { token: values.token.trim() } } : {}),
      ...(values.auth === "sign-in" && returnOrigin !== null
        ? { redirectOrigin: returnOrigin }
        : {}),
    },
  };
}

const RISK_GROUPS: ReadonlyArray<{
  readonly risk: ConnectorRisk;
  readonly title: string;
  readonly hint: string;
}> = [
  { risk: "read", title: "Read", hint: "Looks things up without changing anything." },
  { risk: "change", title: "Change", hint: "Makes changes that can be undone." },
  {
    risk: "irreversible",
    title: "Can't be undone",
    hint: "Sends, deletes or does something else that can't be taken back.",
  },
];

/** A connector's actions under Read, Change and Can't be undone; empty groups are left out. */
export function groupToolsByRisk<T extends Pick<ConnectorTool, "risk">>(tools: ReadonlyArray<T>) {
  return RISK_GROUPS.flatMap((group) => {
    const members = tools.filter((tool) => tool.risk === group.risk);
    return members.length === 0 ? [] : [{ ...group, tools: members }];
  });
}

export const APPROVAL_MODE_LABELS = { auto: "Automatic", ask: "Ask every time" } as const;

export const ACTIVITY_OUTCOME_LABELS: Record<ConnectorActivityOutcome, string> = {
  auto: "Automatic",
  allowed: "Allowed by you",
  declined: "Declined by you",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The approval card's buttons: sending gets words about sending, anything else allow words. */
export function approvalChoiceLabels(action: string) {
  return /^send\b/iu.test(action.trim())
    ? { allow: "Send", always: "Always send without asking", decline: "Don't send" }
    : { allow: "Allow", always: "Always allow", decline: "Don't allow" };
}

/** The quiet line an answered approval card leaves, or null while it waits. */
export function approvalOutcomeLabel(item: {
  readonly approvalStatus: OrchestrationV2ConnectorApprovalStatus;
  readonly remembered?: boolean | undefined;
}): string | null {
  switch (item.approvalStatus) {
    case "pending":
      return null;
    case "allowed":
      return item.remembered === true ? "Allowed, won't ask again" : "Allowed";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Cancelled";
  }
}
