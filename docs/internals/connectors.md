# Connectors

A connector is a service agents can use, such as Gmail or GitHub. Codenine is the MCP client to
each connected service and serves its tools again to the chat's provider. The code lives in
[`apps/server/src/connectors/`](../../apps/server/src/connectors/). This page holds the decisions
that span the gateway, the providers and sign-in.

## Credentials never leave Codenine

Tokens, refresh tokens, secret inputs, the user's own Google and Slack apps and dynamic client
registrations live in the server's secret store. `connectors.json` holds only what a client may see.
A provider gets one MCP server per connection at `/mcp/connectors/<id>`, authorised with the same
per-chat bearer as Codenine's own MCP server, and never a service's token. Keep it that way: a
provider holding a token could call the service without the approval and activity checks below,
and disconnecting could not take its access back.

## Codenine asks, the provider does not

Every action is classified read, change or irreversible: the user's choice for that action wins,
then the catalogue's pin, then the service's annotations (`readOnlyHint: true` is read,
`destructiveHint: false` is change, anything else is irreversible, as the MCP spec says an
unannotated tool may be destructive). Annotations are hints the service writes, so the catalogue
pins tools whose effect they understate, such as Calendar's `respond_to_event`, which emails the
organiser.

The gateway does the asking: an approval card in the chat, a wait of up to ten minutes, and the
activity log. Providers are told never to prompt for these servers (Claude pre-approves
`mcp__<id>__*`; Codex sets `default_tools_approval_mode = "approve"`). A provider prompt would ask
twice and skip the user's per-connection choices. Plan mode refuses anything that is not read.

## Which connections a chat reaches

A chat that talks to an [agent](./agents.md) uses the agent's list. Any other chat uses its own list
when it has one, otherwise the connections on by default. Either way, connections missing a
credential are left out. The gateway checks this on every request. The provider session manager
hands each provider the current list before every turn and makes it part of the thread's load key:
Claude rebuilds its query when the MCP servers change, and Codex keeps a loaded thread's servers on
resume, so its thread is unloaded first when the list changed.

Tool lists are cached on disk, so a chat listing tools does not start a local program; it starts
when an agent calls one, and stops after ten idle minutes or when Codenine stops.

## Signing in

A service sends the browser back to `<the origin the browser uses>/oauth/connectors/callback`.
Google, Slack and the services Codenine registers with accept only https or localhost redirect
addresses, so signing in from any other origin fails before it starts, with a message that says so.
Dynamic client registrations are saved per authorization server and redirect address, so another
address registers again.

Codenine never offers a client ID metadata document: that needs an https page Codenine hosts, and
Codenine has no hosted service. Services with dynamic registration register Codenine; Google and
Slack, which have none, use an app the user creates once per company.
