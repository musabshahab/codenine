# Codenine control server

The control server is the front door of a self-hosted business installation. It keeps the
company's records in PostgreSQL and checks the licence key. Later phases add sign-in, people and
roles, and routing each person to their own workspace server.

It answers its own routes under `/control`, so `/api` and `/ws` stay free to forward to a
workspace server.

## Run it in development

It needs a PostgreSQL database. Migrations run at start-up.

```bash
export CODENINE_CONTROL_DATABASE_URL=postgres://user:password@127.0.0.1:5432/codenine_control
node src/bin.ts serve
```

`CODENINE_CONTROL_HOST` (default `127.0.0.1`) and `CODENINE_CONTROL_PORT` (default `3780`) set
where it listens. `node src/bin.ts licence show` prints the installation ID and the licence in
use; `node src/bin.ts licence install <file>` installs a key.

## Licence keys

Keys are issued with [`scripts/licence.ts`](../../scripts/licence.ts). The server trusts only
the public keys listed in [`src/licence/LicenceService.ts`](./src/licence/LicenceService.ts),
by key ID. The private key never enters this repository. There is no setting that adds a trusted
key at run time, because anyone running the server could then mint their own licence.

## Database changes

Edit [`src/persistence/schema.ts`](./src/persistence/schema.ts), then run `vp run db:generate`
from this folder to write a migration into `migrations/`. Tests run every migration on PGlite, an
in-memory PostgreSQL.
