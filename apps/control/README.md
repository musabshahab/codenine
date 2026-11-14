# Codenine control server

The control server is the front door of a self-hosted business installation. It keeps the
company's records in PostgreSQL, checks the licence key and holds local accounts: a password and
an authenticator app for each person. Later phases add single sign-on, roles, and routing each
person to their own workspace server.

It answers its own routes under `/control`, so `/api` and `/ws` stay free to forward to a
workspace server. The HTTP API is defined in
[`packages/contracts/src/control.ts`](../../packages/contracts/src/control.ts). Sessions are
HTTP-only cookies, and requests that change something must come from the public URL's origin.

## Run it in development

It needs a PostgreSQL database and Node 26, whose `crypto.argon2` hashes passwords. Migrations
run at start-up.

```bash
export CODENINE_CONTROL_DATABASE_URL=postgres://user:password@127.0.0.1:5432/codenine_control
export CODENINE_CONTROL_SECRET_KEY="$(openssl rand -base64 32)"
node src/bin.ts serve
```

`CODENINE_CONTROL_SECRET_KEY` seals authenticator secrets in the database; keep it out of the
database and its backups. `CODENINE_CONTROL_PUBLIC_URL` (default `http://127.0.0.1:3780`) is
where people reach the installation, and links in invitations point there.
`CODENINE_CONTROL_HOST` (default `127.0.0.1`) and `CODENINE_CONTROL_PORT` (default `3780`) set
where it listens.

The same command runs operator tasks against the database:

- `licence show` prints the installation ID and the licence in use; `licence install <file>`
  installs a key.
- `people invite-owner --email <address> --name <name>` prints a set-up link for the first owner.
- `people reset --email <address>` removes someone's password and authenticator, signs them out
  everywhere and prints a link to set new ones, for an owner who has lost both their
  authenticator and their recovery codes.

## Licence keys

Keys are issued with [`scripts/licence.ts`](../../scripts/licence.ts). The server trusts only
the public keys listed in [`src/licence/LicenceService.ts`](./src/licence/LicenceService.ts),
by key ID. The private key never enters this repository. There is no setting that adds a trusted
key at run time, because anyone running the server could then mint their own licence.

## Database changes

Edit [`src/persistence/schema.ts`](./src/persistence/schema.ts), then run `vp run db:generate`
from this folder to write a migration into `migrations/`. Tests run every migration on PGlite, an
in-memory PostgreSQL.
