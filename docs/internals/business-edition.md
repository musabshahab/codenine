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
  that person's forwarded sockets at once, and the next HTTP request has no token. Local
  socket invalidation is skipped for managed sessions, because there is no local row to watch.
- **The control server decides scopes.** People get the standard scopes minus access, relay and
  environment upkeep, which belong to the control server and the operator. While the licence
  does not allow work, tokens carry only read scopes, so the workspace's existing per-call
  checks make it read-only without the proxy reading any traffic.
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
  why the control server must run there, and it reaches out only through the installation's egress
  proxy, which allows the hosts on a list by name and never a bare address. On Kubernetes, the
  NetworkPolicies in [`kubernetes.yaml`](../../images/workspace/kubernetes.yaml) hold workspaces to
  the same rules, so they depend on a network plugin that enforces them.
- **The control server answers its own routes under `/control`**, so it never shadows a
  workspace route.
- **Forwarding keeps compression.** HTTP bodies pass through as the workspace compressed them
  (a `fetch` client would unzip them), and the control server deflates WebSocket frames for the
  browser while the hop between the servers stays uncompressed. Without this, a large thread
  reached remote browsers at about four times the size.

## Sleeping workspaces

Only the workspace knows whether anyone has it open and whether its agents have work, so a
managed workspace given `CODENINE_MANAGED_SLEEP_MINUTES` stops itself
([`WorkspaceSleep`](../../apps/server/src/background/WorkspaceSleep.ts)), and the control server
starts it on the next request. Any thread that `mayBeLive` keeps it up, because sleeping would kill
a turn waiting for an answer or stall a pull request watch. A workspace that starts again can have
a new address, so the proxy looks for a person's workspace again whenever the address it knew stops
answering or refuses their token.

## Keys and secrets

Licence keys verify against public keys built into the control server; there is no setting
that trusts another key at run time, since anyone running the server could then mint a
licence. `CODENINE_CONTROL_SECRET_KEY` seals authenticator secrets and the token signing key in
the database. It must live outside the database and its backups, or a stolen backup carries
both the lock and the key.
