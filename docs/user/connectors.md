# Connectors

Connectors let agents and chats use other services: search and send email, find free time in a
calendar, open issues, query a database. Codenine keeps every sign-in on the computer it runs on,
so a connector works the same with every model, and model providers never see your sign-ins.

## Connect a service

Open **Connectors** under **Build** in the sidebar. Each tile in the **Library** says how it
connects:

- **Sign in** opens the service's sign-in page in a new tab.
- **Uses your Google app** or **Uses your Slack app** needs an app you create once; see
  [Google and Slack](#google-and-slack).
- **Access token** (or the service's own word for it) takes a token or API key the service gave
  you.
- **No account needed** and **Runs on this computer** connect right away, after any value they need,
  such as a database address.

**Add custom connector** adds any MCP server, by its web address or by a command that runs on the
computer Codenine runs on.

If you use more than one computer, choose one at the top of the page. Each computer keeps its own
connectors.

## Google and Slack

Google and Slack only accept apps that each person creates. The first Google connector you connect,
such as Gmail, walks you through it:

1. In Google Cloud, create a project and turn on the product's API and its MCP API.
2. Set up the consent screen. Choose **Internal** if you use Google Workspace. Otherwise publish
   the app: while it is in **Testing**, Google signs you out every 7 days.
3. Create an OAuth client of type **Web application** with the redirect address the dialog shows,
   then paste its client ID and secret.

Codenine saves the app with your other keys, so the next Google connector goes straight to signing
in. To fix a mistyped secret or switch apps, choose **Use a different Google app** when you
connect. Slack works the same way, with an app you create at api.slack.com/apps.

## Sign-ins need localhost or https

After you sign in, the service sends you back to Codenine, and it only accepts `localhost` or an
`https` address. If you opened Codenine another way, such as by its address on your local network,
Codenine warns you before you sign in. Open Codenine on the computer it runs on, or at its https
address, and connect from there.

## What agents may do

A connector's page sorts its actions into **Read**, **Change** and **Can't be undone**. Each group
runs **Automatic** or **Ask every time**, and a single action can differ from its group: choose it
in the list. Some actions come from Codenine rather than the service, such as sending a Gmail
draft.

When an action asks first, the chat shows what it would do. **Allow** (or **Send**) lets it run
once, **Always allow** stops asking for that action on that connector, and **Don't allow** declines
it. An agent's own choices come first in its chats, and on its cards **Always allow for this agent**
changes the agent's choice instead: see [Agents](agents.md#ask-first-or-run-on-their-own).
**Recent activity** on the connector's page lists what agents did and who allowed it.

**Test connection** checks that the service still answers. **Sign in again** appears when a
service has signed Codenine out. **Disconnect** removes the connector with its sign-in and activity.

## Choose connectors for a chat

New chats use the connectors that are **On by default in chats**, a switch on each connector's
page. In a chat, the **+** menu next to the message box turns connectors on or off for that chat
only, and the ones it uses show above the message box. Once a chat picks its own, changing the
defaults no longer changes it. A chat with an [agent](./agents.md) uses the agent's connectors
instead.

## Not here yet

Figma, Asana, HubSpot, Vercel and Microsoft 365 only accept apps they have approved, so the library
does not have them yet.
