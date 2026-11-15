# Running Codenine for a team

A business installation has a **control server**, where people sign in and the licence lives,
and **workspace servers**, where agents work: one for each person, or one the team shares.
People open the control server's address in a browser, and it passes each of them through to
their workspace.

Everything runs from a checkout of this repository with Node 26. Commands below run from its
root.

## Set up the control server

It needs a PostgreSQL database. Mark the checkout for business use, so that every build from it
leaves out the services a business installation does not use, then build the web app:

```bash
echo CODENINE_BUSINESS_EDITION=1 >> .env
```

```bash
vp run --filter @codenine/web build
```

Then start the control server with these settings, and those for
[where agents work](#choose-where-agents-work):

- `CODENINE_CONTROL_DATABASE_URL`: the PostgreSQL connection string.
- `CODENINE_CONTROL_SECRET_KEY`: 32 random bytes in base64, for example from
  `openssl rand -base64 32`. Keep it out of the database and its backups.
- `CODENINE_CONTROL_PUBLIC_URL`: the address people use, such as `https://codenine.example.com`.
  People must open Codenine at exactly this address; changes sent from any other are refused.
- `CODENINE_CONTROL_WEB_DIR`: `apps/web/dist`.
- `CODENINE_CONTROL_SMTP_URL` and `CODENINE_CONTROL_MAIL_FROM` (optional): your mail server, such as
  `smtps://user:password@mail.example.com:465`, and the sender, such as
  `Codenine <codenine@example.com>`. With them, Codenine emails invitations and reset links, and
  people can reset a forgotten password themselves. Without them, admins send each link by hand.

```bash
node apps/control/src/bin.ts serve
```

It listens on `127.0.0.1:3780`, which `CODENINE_CONTROL_HOST` and `CODENINE_CONTROL_PORT`
change. It serves plain HTTP, so put it behind a reverse proxy that answers on your HTTPS
address.

## Choose where agents work

The control server can start a workspace for each person in Docker, or pass everyone to one
workspace server the team shares. Give each person their own unless everyone trusts each other:
in a shared workspace, anyone's agents can reach everyone's files.

### One workspace per person

The control server starts a person's workspace the first time they open Codenine, which takes a
few seconds. Each has its own volume for the person's projects, settings and agent sign-ins, its
own network, and CPU and memory limits. Agents run as an ordinary user on a read-only system, so
even with full access they cannot reach another person's files or workspace. They can reach the
internet and anything the Docker host serves on its network addresses, so keep the database and
other services on the host bound to `127.0.0.1`.

Run the control server on the machine that runs Docker, since each workspace answers only there.
Build the workspace image on that machine, from the checkout marked for business use. Besides
Docker, it needs `patchelf`:

```bash
vp run --filter codenine build
```

```bash
node apps/server/scripts/cli.ts build-exe
```

```bash
node scripts/build-cli-archive.ts --platform linux --arch x64 --version 1.0.0
```

```bash
images/workspace/build.sh release-cli/codenine-1.0.0-linux-x64.tar.gz codenine-workspace:1.0.0
```

The image holds the workspace server, Claude Code, Codex, Git and the GitHub CLI. Then set these
on the control server:

- `CODENINE_CONTROL_WORKSPACE_DRIVER`: `docker`.
- `CODENINE_CONTROL_WORKSPACE_IMAGE`: the image, such as `codenine-workspace:1.0.0`.
- `CODENINE_CONTROL_WORKSPACE_CPUS` and `CODENINE_CONTROL_WORKSPACE_MEMORY_GB` (optional): each
  workspace's limits, 2 CPUs and 4 GB unless set.
- `CODENINE_CONTROL_WORKSPACE_SLEEP_MINUTES` (optional): how long a workspace waits, with nobody
  having Codenine open and no agent working, before it sleeps. 30 unless set; `0` keeps
  workspaces awake.
- `CODENINE_CONTROL_WORKSPACE_RETENTION_DAYS` (optional): how long a deactivated person's files
  are kept before they are deleted. 30 unless set.
- `CODENINE_CONTROL_DOCKER_SOCKET` (optional): the Docker socket, `/var/run/docker.sock` unless
  set. The control server's user needs access to it.

A sleeping workspace frees its memory and CPU, and the person's next visit wakes it, which takes a
few seconds. An agent that is working, waiting for an answer or watching a pull request keeps the
workspace awake. Terminals and anything else still running in it stop when it sleeps.

Each workspace is a container named `codenine-<installation ID>-<person ID>`, and its files live
on the volume of the same name ending in `-home`. Back up those volumes. A new image, including
one rebuilt under the same tag, and changes to these settings reach each workspace the next time
it wakes; one that is awake keeps running as it is. To move someone sooner, stop their container
with `docker stop` while their agents are idle.

### One shared workspace server

Set `CODENINE_CONTROL_WORKSPACE_URL` on the control server to where it reaches the workspace
server, such as `http://127.0.0.1:3773`. Then print what the workspace needs to trust the control
server:

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

Open the printed link. It asks for a password and a second step, a passkey or an authenticator
app, then shows ten recovery codes. Each recovery code signs you in once if you lose your passkey or
phone, so keep them somewhere safe. Passkeys need the control server's address to be a host name,
not an IP address.

## Install the licence

Open `/admin` on the control server's address and paste the licence key under **Licence**. The
page also shows the installation ID, which a licence can be tied to. On the control server
itself, `node apps/control/src/bin.ts licence install <file>` does the same.

Until a working licence is installed, Codenine is read-only: people can look at their work but
agents cannot change anything. The licence page warns 30 days before the licence ends, and work
continues through the grace period after it. A renewal can be installed early; it takes over
when it starts.

## Manage people

Owners and admins manage people under **Account**:

- **Invite** someone to get a one-time link for them, which Codenine also emails when a mail server
  is set. Each invited or active person takes a seat on the licence.
- **Deactivate** someone to sign them out everywhere and free their seat. With one workspace per
  person, their workspace stops too. Their files are kept for 30 days and come back if you
  reactivate them in that time; after that they are deleted.
- **Reset sign-in** for someone who lost their passkeys, authenticator and recovery codes. It
  removes all of them and their password, and gives you a new link for them.
- **Unlock** someone after ten failed sign-in attempts; otherwise the lock lifts after 15
  minutes.

When a mail server is set, people who forget their password can choose **Forgot your password?**
on the sign-in page. The emailed link works for an hour, and they still need their passkey,
authenticator app or a recovery code.

Everyone can open **Account** at the bottom of the sidebar to add or remove passkeys, see where they
are signed in, and sign out of any browser or everywhere at once. Owners and admins manage the
licence and people from the same page.

If the only owner is locked out, someone with access to the control server can run:

```bash
node apps/control/src/bin.ts people reset --email you@example.com
```
