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

The control server can start a workspace for each person in Docker or on Kubernetes, or pass
everyone to one workspace server the team shares. Give each person their own unless everyone
trusts each other: in a shared workspace, anyone's agents can reach everyone's files.

### One workspace per person in Docker

The control server starts a person's workspace the first time they open Codenine, which takes a
few seconds. Each has its own volume for the person's projects, settings and agent sign-ins, its
own network, and CPU and memory limits. Agents run as an ordinary user on a read-only system, so
even with full access they cannot reach another person's files or workspace. A workspace's
network leads only to an egress proxy, which lets agents reach the model providers, GitHub and the
main package registries over HTTPS and nothing else: not the Docker host, not your company
network, not the rest of the internet. Git therefore needs HTTPS remotes; SSH remotes do not work.

Run the control server on the machine that runs Docker, which must be Docker Engine on Linux run
as root: the control server reaches each workspace at its address on the workspace's own network,
and rootless Docker and Docker Desktop keep those addresses from the host. Build the workspace
image on that machine, from the checkout marked for business use. Besides Docker, it needs
`patchelf`:

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
- `CODENINE_CONTROL_WORKSPACE_ALLOWED_HOSTS` (optional): more hosts agents may reach, separated by
  commas, such as `git.example.com, .registry.example.com`; a leading dot also allows everything
  under that domain. Agents can always reach Anthropic and OpenAI, GitHub, npm, PyPI, crates.io,
  the Go module proxy and Maven Central.
- `CODENINE_CONTROL_DOCKER_SOCKET` (optional): the Docker socket, `/var/run/docker.sock` unless
  set. The control server's user needs access to it.

A sleeping workspace frees its memory and CPU, and the person's next visit wakes it, which takes a
few seconds. An agent that is working, waiting for an answer or watching a pull request keeps the
workspace awake. Terminals and anything else still running in it stop when it sleeps.

Each workspace is a container named `codenine-<installation ID>-<person ID>`, and its files live
on the volume of the same name ending in `-home`. Back up those volumes. The egress proxy runs
beside them as `codenine-<installation ID>-egress`, from the same image. A new image, including
one rebuilt under the same tag, and changes to these settings reach each workspace the next time
it wakes; one that is awake keeps running as it is. To move someone sooner, stop their container
with `docker stop` while their agents are idle. A change to the allowed hosts replaces the proxy
the next time any workspace starts, which interrupts downloads under way.

### One workspace per person on Kubernetes

Workspaces work the same way on Kubernetes: one pod per person on their own volume claim, locked
down as in Docker, sleeping when idle, and reaching out only through the egress proxy. The cluster
needs a network plugin that enforces NetworkPolicy, and the control server must run in it, in the
`codenine` namespace as the `codenine-control` service account, with the label
`app.kubernetes.io/name: codenine-control`.

Build the workspace image as above and push it to a registry the cluster can pull from. In
[`images/workspace/kubernetes.yaml`](../../images/workspace/kubernetes.yaml), set the egress
proxy's image to it, then apply the file, which sets up the namespace, the control server's
rights, the proxy and the network rules:

```bash
kubectl apply -f images/workspace/kubernetes.yaml
```

Give the proxy its settings from the control server's allowed hosts:

```bash
node apps/control/src/bin.ts workspace egress-config > squid.conf
```

```bash
kubectl -n codenine create configmap codenine-egress --from-file=squid.conf
```

Set the same settings as for Docker on the control server, with
`CODENINE_CONTROL_WORKSPACE_DRIVER` set to `kubernetes` and the image's registry path, plus:

- `CODENINE_CONTROL_WORKSPACE_DISK_GB` (optional): each person's volume claim, 20 GB unless set.
- `CODENINE_CONTROL_WORKSPACE_STORAGE_CLASS` (optional): the storage class for those claims.
- `CODENINE_CONTROL_KUBERNETES_NAMESPACE` (optional): where workspaces run, the control server's
  own namespace unless set.

Each workspace requests a quarter of its CPU and memory limits, so idle ones pack onto fewer nodes.
Pods are named `codenine-<person ID>` and claims end in `-home`, with dashes for underscores. A
workspace that sleeps ends its pod, and the next visit starts a new pod from the current image and
settings. To change the allowed hosts, print the settings again, replace the ConfigMap, and run
`kubectl -n codenine rollout restart deployment/codenine-egress`.

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

Each person has a role, which decides what they can do in their workspace and under **Account**:

| Role             | In their workspace                                                           | Under **Account**                                                    |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Owner            | Everything                                                                   | Everything, including installing the licence and making other owners |
| Admin            | Everything                                                                   | People, the audit log, and the licence without installing one        |
| Department admin | Everything                                                                   | Members and restricted members of their own departments              |
| Member           | Everything                                                                   | Their own sign-in                                                    |
| Restricted       | Agents and previews, with no terminal, no source control and read-only files | Their own sign-in                                                    |
| Auditor          | Looking only                                                                 | The audit log                                                        |

Someone can change only the people whose role they could give, so an admin cannot change, reset or
deactivate an owner. A new role applies at once: the person's open windows reconnect with it. There
is always at least one owner; make someone else an owner before stepping down.

Owners, admins and department admins manage people under **Account**:

- **Invite** someone with a role to get a one-time link for them, which Codenine also emails when a
  mail server is set. Each invited or active person takes a seat on the licence.
- **Change a role** from the list next to their name.
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
are signed in, and sign out of any browser or everywhere at once. The licence and people are on the
same page for the roles that manage them.

If the only owner is locked out, someone with access to the control server can run:

```bash
node apps/control/src/bin.ts people reset --email you@example.com
```

## Read the audit log

Owners, admins and auditors find the audit log under **Account**. It records each change to people
and the licence, with who made it, when, from which address, and the values before and after, and
each sign-in with how the person signed in. Commands run on the control server, such as
`people reset`, appear under the name of the system user who ran them, and Codenine itself
records when it deletes a leaver's files.

The address is the one your reverse proxy reports in `X-Forwarded-For`. The control server believes
that header only from a proxy on the same machine; if yours runs elsewhere, list its network in
`CODENINE_CONTROL_TRUSTED_PROXIES`, such as `10.0.0.0/8`.

## Give people the desktop app

A business build of the desktop app opens your Codenine and nothing else. Build it from the checkout
marked for business use, with your Codenine's address in the same `.env`:

```bash
echo CODENINE_BUSINESS_URL=https://codenine.example.com >> .env
```

Then build it for each platform as in [Development](../operations/development.md), for example:

```bash
vp run dist:desktop:dmg
```

People sign in to the app with their password, or choose **Sign in with your browser** to use a
passkey. The browser brings them back to the app; if it does not, it shows a code to type in the
app, which works once for 5 minutes. They stay signed in until they sign out or an admin signs
them out. Links to other sites open in their browser.
