# Business edition

A business installation puts a control server ([`apps/control`](../../apps/control)) in front of
workspace servers running in `managed` mode. The control server owns identity: people, sign-in,
sessions and the licence. A workspace owns the work and trusts the control server for who is
asking.

## The trust boundary

A managed workspace accepts one credential: a token its control server signs for the request
in hand. The control server mints one for every forwarded `/api` request and every forwarded
`/ws` connection. The token names the control server's installation ID, the workspace ID, the
person, the control server session and the scopes, and it expires within minutes. The shapes
are in [`workspaceToken.ts`](../../packages/contracts/src/workspaceToken.ts); verification
checks key ID, signature, type, issuer, audience and time.

- **The workspace stores nothing about these sessions.** It never sees the control server's
  cookie, and it refuses cookies, its own sessions, pairing, bootstrap exchange and DPoP. It
  also issues no sessions or pairing links, so `codenine auth` and `codenine pair` fail plainly.
  Revocation therefore happens on the control server: sign-out, a reset or deactivation ends
  that person's forwarded sockets at once, and the next HTTP request has no token. A role change
  ends their sockets too, so they reconnect with the new role's scopes. Local
  socket invalidation is skipped for managed sessions, because there is no local row to watch.
- **The control server decides scopes.** People get the standard scopes minus access, relay and
  environment upkeep, which belong to the control server and the operator, and their role
  narrows that ([`roles.ts`](../../apps/control/src/admin/roles.ts)). While the licence does not
  allow work, tokens carry only read scopes, so the workspace's existing per-call checks make it
  read-only without the proxy reading any traffic.
- **Control server permissions live in contracts** ([`control.ts`](../../packages/contracts/src/control.ts)),
  so the admin pages show what the server allows. The server checks every change, and someone
  manages only the people whose role they could give: otherwise an admin could reset an owner's
  sign-in and take the account over with the link.
- **Scopes are not isolation.** As [Environment authentication](./environment-auth.md)
  explains, `terminal:operate` and `orchestration:operate` reach everything the workspace's
  user can. Separate people get separate workspaces; one shared workspace is for a team that
  already trusts each other. With per-person workspaces each token's audience is that person's
  workspace, so even a misrouted request carries a token no other workspace accepts.
- **The workspace port is internal.** The control server forwards only `/api`, `/ws` and the
  workspace descriptor under `/.well-known/codenine`, each with a token. The workspace still
  serves `/mcp` with its own sessions so its agent processes can reach their tools, so the
  workspace must be reachable only from the control server. The Docker driver publishes no port:
  each workspace sits alone on an internal network that only the Docker host can reach, which is
  why the control server must run there, and it reaches out only through an egress proxy, which
  allows the hosts on a list by name and never a bare address. On Kubernetes, the
  NetworkPolicies in [`kubernetes.yaml`](../../images/workspace/kubernetes.yaml) hold workspaces to
  the same rules, so they depend on a network plugin that enforces them.
- **The control server answers its own routes under `/control`**, so it never shadows a
  workspace route.
- **The business desktop app is a window, not a client.** It loads the control server's address
  with no preload, so pages there get nothing a browser tab would not, and keeps them on that
  address. Browser sign-in hands back a single-use code through a `codenine://` link, which the
  window redeems only with the state it stored when it started, so a link from elsewhere cannot
  sign it in to another account.
- **Forwarding keeps compression.** HTTP bodies pass through as the workspace compressed them
  (a `fetch` client would unzip them), and the control server deflates WebSocket frames for the
  browser while the hop between the servers stays uncompressed. Without this, a large thread
  reached remote browsers at about four times the size.

## The audit log

Entries are only ever added, and they copy in the names they mention, so they read the same after
someone changes their email or leaves. Every admin change goes through
[`Administration`](../../apps/control/src/admin/Administration.ts), which records one entry once the
change has been made, and records nothing when nothing changed. Commands on the control server go
through it too, as an operator with an owner's rights: whoever can run them can already reach the
database, and their changes still belong in the log. Sign-ins are recorded where sessions start, so
every way of signing in is covered. An entry is written after its change commits, not in the same
transaction, because changes reach mail and workspaces; a database failure in between leaves a
change without its entry, and the request fails.

Exports keep a cursor per destination in the database and move it only after the destination took
a batch, inside a transaction that locks the cursor with `SKIP LOCKED`, so control servers sharing a
database send each batch from one of them, and a failure resends rather than skips. Retention
removes nothing a destination has not taken, so a long outage there delays deletion instead of
losing entries.

## Workspace profiles

What a workspace is made from comes from layers applied from the top: the company's profile, the
department's, its teams', then the person's time-limited exceptions
([`layering.ts`](../../apps/control/src/profiles/layering.ts)). A layer changes only what the layers
above left open, as Claude's and Codex's own admin settings do: it cannot change a setting above it
locked, lift a blocked terminal, or reach a blocked host. Without that rule, a department admin, who
edits their own department's layer, could undo the company's limits.

A workspace belongs to a person in one department, so its ID, and the audience of its tokens, is
`<person>.<department>`; outside departments it is the person's ID alone. A browser session remembers
the department chosen in it, and choosing another ends that session's forwarded sockets, so the app
reconnects to the other workspace instead of carrying a token from one into the other.

Each layer keeps its versions. A new one goes to everyone or first to a test group; rolling back
publishes a copy of the version everyone had before, so the history only grows and the audit log
names every step. Previews load all layers once and resolve every affected workspace in memory.

A running workspace is never made again, since that would end its agents' work, so a new size or
image waits for its next start. The terminal and hosts apply at once, because neither needs a
restart: the terminal lives in each connection's token scopes, so the people whose terminal changed
reconnect, and on Docker each set of hosts has its own egress proxy, with a workspace's network
carrying exactly one under the name `egress`, so new hosts swap the proxy on that network. Every
admin action that changes a layer, an exception or a team puts its changes into effect through
[`Administration`](../../apps/control/src/admin/Administration.ts); the Docker driver also checks
every workspace's proxy at start-up and hourly, for what changes without one: the installation's
hosts, a change made while it was down, an exception that ran out. Kubernetes workspaces share the
installation's one proxy, so profiles' hosts do not apply there yet.

## Single sign-on

Every setup names its email domains, and only addresses there are accepted from it, so one
identity provider cannot sign anyone in to another's domain; Google tokens must also name the
Workspace as their hosted domain. People are found by the provider's subject first and by email
only the first time ([`SingleSignOn.ts`](../../apps/control/src/sso/SingleSignOn.ts)). A sign-in is
a row the browser that started it must finish, proved by a hashed cookie, which stops login CSRF.
SAML posts its response cross-site, which carries no lax cookie, so the response only names the
person and the browser finishes with a same-site GET; the signed assertion must answer that row's
own request ID, rather than any ID in a cache. Required single sign-on is refused unless an owner
can still sign in with a password, and emergency owners are owners only, because these settings
can lock everyone out or take over any account.

## Provisioning

SCIM users are people and SCIM groups are departments, with no mapping between them, so an
identity provider that finds a group by name, as Entra ID and Okta do before creating one, joins
an existing department ([`scim.ts`](../../apps/control/src/provisioning/scim.ts)). Every change
goes through `Administration` as a provisioning actor, so the audit log, sign-outs, workspace
retirement and seat checks are the admin pages' own. That actor has an owner's reach, because
offboarding must reach owners too; for the same reason only owners hold `security:manage`, which
creates its token, and `keepAnOwner` still protects the last owner. A user the identity provider
deletes stays as a deactivated person, so the audit log and file retention keep working, and
`control_directory_people` hides them from SCIM, which expects a 404 after a delete.

## Emergency access

An owner's look at someone's workspace lives on the owner's own session, not on the person or the
workspace, so it ends with that browser, its hour or a click, and no other session can reach it.
The workspace sees the owner in its tokens, with the read-only scopes of a licence that does not
allow work, so its own checks keep the look read-only and attribute anything to the owner. Opening
it emails the person and writes an audit entry, as the plan requires; it is owners' alone, like the
other settings that can reach anyone's data.

## Sleeping workspaces

Only the workspace knows whether anyone has it open and whether its agents have work, so a
managed workspace given `CODENINE_MANAGED_SLEEP_MINUTES` stops itself
([`WorkspaceSleep`](../../apps/server/src/background/WorkspaceSleep.ts)), and the control server
starts it on the next request. Any thread that `mayBeLive` keeps it up, because sleeping would kill
a turn waiting for an answer or stall a pull request watch. A workspace that starts again can have
a new address, so the proxy looks for a person's workspace again whenever the address it knew stops
answering or refuses their token.

## The AI gateway

Workspaces call AI providers through the control server's gateway
([`gateway/`](../../apps/control/src/gateway)), which holds the company's keys and records every
call's tokens and cost, never what was said. It listens on its own address
(`CODENINE_CONTROL_GATEWAY_HOST` and `_PORT`) that only workspaces should reach, apart from the pages
and API people use.

- **Every workspace reaches it as `http://codenine-gateway:8080`,** set in its environment with its
  token, so Claude in the app and in a terminal use it alike. On Docker the egress proxy answers to
  that name on each workspace's network and passes those requests, and only those, to the control
  server; on Kubernetes it is a service. Anthropic is off the egress allow list, so the gateway is
  the only way to Claude.

- **A workspace's token is stable and checked on every call.** It is signed with the workspace
  token key but has its own type, so neither kind passes for the other. It names only the person
  and department, so it stays the same while the workspace is made from the same settings and is
  not a reason to make the container again. Revocation happens at the gateway: a deactivated
  person, or one no longer in the department, is refused within 30 seconds.
- **Refusals use statuses the CLIs do not retry.** Claude Code and Codex retry 408, 409, 429 and
  5xx, so the gateway's own refusals are 401, 403 or 404 in Anthropic's error shape. A provider's
  errors pass through unchanged.
- **Bodies pass through as they arrive.** The gateway asks the provider for uncompressed replies
  and reads usage from the stream as it passes, so a stream is never held back to be metered. A
  reply cut off by the workspace is recorded with what it used so far.
- **Usage comes from `usage.iterations` when a reply has it.** With server-side fallbacks or
  compaction, the top-level usage covers only the attempt that produced the reply; each iteration
  is priced at its own model.
- **Prices are an estimate.** They come from a table in the source
  ([`claudePricing.ts`](../../apps/control/src/gateway/claudePricing.ts)), versioned on every
  usage row, adjusted by each account's percentage. The provider's invoice is what the company
  pays. Bedrock and Vertex AI set their own prices; the adjustment covers regional endpoints.
- **The gateway honours `HTTPS_PROXY` and `NO_PROXY`** when it calls providers, as company
  networks often require.

## Keys and secrets

Licence keys verify against public keys built into the control server; there is no setting
that trusts another key at run time, since anyone running the server could then mint a
licence. `CODENINE_CONTROL_SECRET_KEY` seals authenticator secrets and the token signing key in
the database. It must live outside the database and its backups, or a stolen backup carries
both the lock and the key.
