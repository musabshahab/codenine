// Simulated Microsoft 365 and Power BI connectors. Nothing leaves this machine: each call is
// recorded with the request production would send, so the demo shows the real contract.

import { logRequest } from "./store.mjs";

const SITE = "contoso.sharepoint.com,ops-site-id,ops-web-id";
const DRIVE = "b!ops-documents-drive";
const TEAM = "19:ops-leadership-team";
const CHANNEL = "19:weekly-review@thread.tacv2";
const GROUP = "ops-bi-workspace";
const DATASET = "wbr-semantic-model";
const REPORT = "wbr-report";

export const DESTINATIONS = {
  sharepoint: [
    { id: "ops-wbr", label: "Operations site › Documents › Weekly business reviews" },
    { id: "ops-leadership", label: "Operations site › Leadership › Board packs" },
  ],
  teams: [
    { id: "ops-weekly", label: "Operations leadership › Weekly review" },
    { id: "north-region", label: "North region › General" },
  ],
  outlook: [
    { id: "ops-leads", label: "ops-leads@contoso.example (12 people)" },
    { id: "exec-ops", label: "exec-operations@contoso.example (5 people)" },
  ],
};

export const CONNECTIONS = [
  {
    id: "entra",
    name: "Microsoft Entra ID",
    purpose: "Sign-in, single sign-on and the people directory",
    demo: "Account picker with fixed users; signed session cookie",
    production:
      "OpenID Connect authorization code flow with PKCE; multitenant app registration; admin consent for Graph scopes; optional SCIM provisioning",
    scopes: ["openid", "profile", "offline_access", "User.Read", "User.ReadBasic.All"],
  },
  {
    id: "sharepoint",
    name: "SharePoint and OneDrive (Microsoft Graph)",
    purpose: "Read source workbooks, save briefings, create sharing links",
    demo: "In-memory document library with two weekly exports",
    production:
      "Graph driveItem APIs; delta queries to notice new files (drive webhooks watch only the root and expire within 30 days, so they need renewal); sharing links obey tenant sharing policy",
    scopes: ["Files.ReadWrite.All", "Sites.Selected (application, per-site grant)"],
  },
  {
    id: "excel",
    name: "Excel workbooks",
    purpose: "Import data and corrections",
    demo: "Real .xlsx parsing in the server; corrections written back as a new file",
    production:
      "Download and parse .xlsx server-side; the Graph Excel API works only on .xlsx in OneDrive for Business or SharePoint, with short-lived sessions and per-tenant throttling",
    scopes: ["Files.ReadWrite.All"],
  },
  {
    id: "powerbi",
    name: "Power BI",
    purpose: "The report the analyst investigates, refreshed by the schedule",
    demo: "Report rendered from the workspace's own semantic model",
    production:
      "Embed with Power BI Embedded (user owns data needs Pro or PPU per viewer below F64; app owns data needs an A, EM or F capacity); dataset refresh through the REST API",
    scopes: ["Report.Read.All", "Dataset.ReadWrite.All"],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    purpose: "Post the approved briefing to a channel",
    demo: "Adaptive card preview",
    production:
      "Graph channel message as the signed-in user (delegated only: app-only posting is for migration). Unattended posts need a Teams bot or a Workflows webhook the customer creates",
    scopes: ["ChannelMessage.Send", "Team.ReadBasic.All", "Channel.ReadBasic.All"],
  },
  {
    id: "outlook",
    name: "Outlook",
    purpose: "Email the briefing to a distribution list",
    demo: "Message preview",
    production:
      "Graph sendMail as the signed-in user. App-only Mail.Send reaches every mailbox until the admin scopes it with Exchange RBAC for Applications; 30 messages a minute per mailbox",
    scopes: ["Mail.Send"],
  },
  {
    id: "automate",
    name: "Scheduling",
    purpose: "Run the weekly workflow without the analyst",
    demo: "In-process scheduler with a 'run now' control",
    production:
      "Durable job queue in the workspace service. Power Automate premium connectors need customer Premium or Process licences, so scheduling stays in the product",
    scopes: ["offline_access (refresh token for unattended runs)"],
  },
];

const graph = "https://graph.microsoft.com/v1.0";

export function recordListFolder(state, folder) {
  logRequest(state, {
    connector: "sharepoint",
    method: "GET",
    url: `${graph}/sites/${SITE}/drive/root:/${encodeURI(folder.replaceAll(" / ", "/"))}:/children`,
    summary: `List files in ${folder}`,
    status: 200,
  });
}

export function recordDownload(state, file) {
  logRequest(state, {
    connector: "sharepoint",
    method: "GET",
    url: `${graph}/drives/${DRIVE}/root:/${encodeURI(`${file.folder.replaceAll(" / ", "/")}/${file.name}`)}:/content`,
    summary: `Download ${file.name}`,
    status: 302,
  });
}

export function recordRefresh(state) {
  logRequest(state, {
    connector: "powerbi",
    method: "POST",
    url: `https://api.powerbi.com/v1.0/myorg/groups/${GROUP}/datasets/${DATASET}/refreshes`,
    summary: "Refresh the semantic model behind the report",
    body: { notifyOption: "NoNotification" },
    status: 202,
  });
}

export function recordEmbedToken(state, userEmail) {
  logRequest(state, {
    connector: "powerbi",
    method: "POST",
    url: `https://api.powerbi.com/v1.0/myorg/groups/${GROUP}/reports/${REPORT}/GenerateToken`,
    summary: `Embed token for ${userEmail} (effective identity, row-level security)`,
    body: { accessLevel: "View" },
    status: 200,
  });
}

/** Saves the briefing file, posts it and emails it; returns what each destination got. */
export function share(
  state,
  { fileName, sizeBytes, title, summary, destinations, sharedBy, link },
) {
  const results = [];
  if (destinations.sharepoint) {
    const folder = DESTINATIONS.sharepoint.find((d) => d.id === destinations.sharepoint);
    const path = `${folder.label.split(" › ").slice(1).join("/")}/${fileName}`;
    logRequest(state, {
      connector: "sharepoint",
      method: "PUT",
      url: `${graph}/drives/${DRIVE}/root:/${encodeURI(path)}:/content`,
      summary: `Upload ${fileName} (${Math.round(sizeBytes / 1024)} KB)`,
      status: 201,
    });
    logRequest(state, {
      connector: "sharepoint",
      method: "POST",
      url: `${graph}/drives/${DRIVE}/items/{item-id}/createLink`,
      summary: "Create an organization-wide view link",
      body: { type: "view", scope: "organization" },
      status: 201,
    });
    results.push({ channel: "sharepoint", target: folder.label, link });
  }
  if (destinations.teams) {
    const channel = DESTINATIONS.teams.find((d) => d.id === destinations.teams);
    const card = adaptiveCard({ title, summary, link, sharedBy });
    logRequest(state, {
      connector: "teams",
      method: "POST",
      url: `${graph}/teams/${TEAM}/channels/${CHANNEL}/messages`,
      summary: `Post an adaptive card to ${channel.label}`,
      body: {
        body: { contentType: "html", content: '<attachment id="wbr-card"></attachment>' },
        attachments: [
          {
            id: "wbr-card",
            contentType: "application/vnd.microsoft.card.adaptive",
            content: "{…card…}",
          },
        ],
      },
      status: 201,
    });
    results.push({ channel: "teams", target: channel.label, card });
  }
  if (destinations.outlook) {
    const list = DESTINATIONS.outlook.find((d) => d.id === destinations.outlook);
    const message = {
      subject: title,
      to: list.label.split(" ")[0],
      body: `${summary}\n\nOpen the briefing: ${link}`,
    };
    logRequest(state, {
      connector: "outlook",
      method: "POST",
      url: `${graph}/me/sendMail`,
      summary: `Email ${list.label}`,
      body: {
        message: {
          subject: message.subject,
          toRecipients: [{ emailAddress: { address: message.to } }],
          body: { contentType: "HTML", content: "…" },
        },
        saveToSentItems: true,
      },
      status: 202,
    });
    results.push({ channel: "outlook", target: list.label, message });
  }
  return results;
}

export function recordUnshare(state) {
  logRequest(state, {
    connector: "sharepoint",
    method: "DELETE",
    url: `${graph}/drives/${DRIVE}/items/{item-id}/permissions/{link-permission-id}`,
    summary: "Remove the sharing link",
    status: 204,
  });
}

function adaptiveCard({ title, summary, link, sharedBy }) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text: summary, wrap: true },
      {
        type: "TextBlock",
        text: `Approved and shared by ${sharedBy}`,
        isSubtle: true,
        size: "Small",
      },
    ],
    actions: [{ type: "Action.OpenUrl", title: "Open briefing", url: link }],
  };
}
