# Running Codenine for a team

A business installation has two servers. The **control server** is where people sign in and
where the licence lives. The **workspace server** is where the agents work. People open the
control server's address in a browser, and it passes them through to the workspace.

Both run from a checkout of this repository with Node 26. Commands below run from its root.

## Set up the control server

It needs a PostgreSQL database. Build the web app for business use first:

```bash
CODENINE_BUSINESS_EDITION=1 vp run --filter @codenine/web build
```

Then start the control server with these settings:

- `CODENINE_CONTROL_DATABASE_URL`: the PostgreSQL connection string.
- `CODENINE_CONTROL_SECRET_KEY`: 32 random bytes in base64, for example from
  `openssl rand -base64 32`. Keep it out of the database and its backups.
- `CODENINE_CONTROL_PUBLIC_URL`: the address people use, such as `https://codenine.example.com`.
  People must open Codenine at exactly this address; changes sent from any other are refused.
- `CODENINE_CONTROL_WEB_DIR`: `apps/web/dist`.
- `CODENINE_CONTROL_WORKSPACE_URL`: where the control server reaches the workspace server, such
  as `http://127.0.0.1:3773`.

```bash
node apps/control/src/bin.ts serve
```

It listens on `127.0.0.1:3780`, which `CODENINE_CONTROL_HOST` and `CODENINE_CONTROL_PORT`
change. It serves plain HTTP, so put it behind a reverse proxy that answers on your HTTPS
address.

## Connect the workspace server

Print what the workspace needs to trust the control server:

```bash
node apps/control/src/bin.ts workspace key
```

Set the three `CODENINE_MANAGED_…` values it prints on the workspace server and start it in
managed mode, on the address and port `CODENINE_CONTROL_WORKSPACE_URL` names:

```bash
node apps/server/src/bin.ts serve --mode managed --host 127.0.0.1 --port 3773
```

Only the control server may reach the workspace server's port. If the workspace runs on another
machine, bind `--host` to a private address that only the control server can reach. People never
sign in to the workspace directly.

## Invite the first owner

```bash
node apps/control/src/bin.ts people invite-owner --email you@example.com --name "Your Name"
```

Open the printed link. It asks for a password and an authenticator app, then shows ten recovery
codes. Each recovery code signs you in once if you lose your phone, so keep them somewhere safe.

## Install the licence

Open `/admin` on the control server's address and paste the licence key under **Licence**. The
page also shows the installation ID, which a licence can be tied to. On the control server
itself, `node apps/control/src/bin.ts licence install <file>` does the same.

Until a working licence is installed, Codenine is read-only: people can look at their work but
agents cannot change anything. The licence page warns 30 days before the licence ends, and work
continues through the grace period after it. A renewal can be installed early; it takes over
when it starts.

## Manage people

Owners and admins manage people on `/admin`:

- **Invite** someone to get a one-time link to send them. Each invited or active person takes a
  seat on the licence.
- **Deactivate** someone to sign them out everywhere and free their seat.
- **Reset sign-in** for someone who lost their authenticator and recovery codes. It removes
  their password and authenticator and gives you a new link for them.
- **Unlock** someone after ten failed sign-in attempts; otherwise the lock lifts after 15
  minutes.

Everyone can see where they are signed in on `/admin` and sign out of any browser, or
everywhere at once.

If the only owner is locked out, someone with access to the control server can run:

```bash
node apps/control/src/bin.ts people reset --email you@example.com
```
