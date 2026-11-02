# Database Guide — SQLite-style zero-config via PGlite, plus PostgreSQL

Super Schema runs on **two interchangeable database backends**, selected at runtime
by the `DB_PROVIDER` environment variable. Both speak the same PostgreSQL dialect,
so there is **one Prisma schema and one migration history** for both.

| Provider | `DB_PROVIDER` | What it is | Use for |
|----------|---------------|-----------|---------|
| **PGlite** (default) | `pglite` | Embedded PostgreSQL compiled to WASM, running in-process. No server, no setup. | Local dev, demos, single-instance / light deployments |
| **PostgreSQL** | `postgresql` | A real PostgreSQL server via `DATABASE_URL`. | Production, multi-instance, high concurrency |

> **Why PGlite instead of SQLite?** SQLite under Prisma cannot represent our schema —
> it rejects `enum` types (we have 11) and scalar lists / `String[]` (we have 9), and
> would need a custom trigger rewrite. PGlite **is** PostgreSQL, so `provider =
> "postgresql"` stays unchanged and every feature (enums, arrays, `Json`, the
> `plpgsql` audit-immutability trigger) works with **zero model changes**.

---

## Quick start (zero config)

```bash
npm install
npm run dev          # predev auto-runs `prisma generate` + applies migrations to PGlite
```

That's it. A fresh checkout with **no `.env`** boots on embedded PGlite, storing data
in `./data/pglite/` (gitignored). Seed demo data with:

```bash
npm run db:seed
```

## Using PostgreSQL instead

Set in `.env`:

```env
DB_PROVIDER=postgresql
DATABASE_URL=postgresql://user:pass@localhost:5432/superschema
```

Then:

```bash
npm run db:deploy    # runs `prisma migrate deploy` against your database, then installs the built-in message properties
npm run db:seed
npm run dev
```

---

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_PROVIDER` | `pglite` | `pglite` or `postgresql` |
| `PGLITE_DATA_DIR` | `./data/pglite` | PGlite data directory (pglite only) |
| `DATABASE_URL` | — | **Required** when `DB_PROVIDER=postgresql` |
| `E2E_DATABASE_URL` | — | The browser suite's PostgreSQL database (the specs write their fixtures to it directly; it wins over `DATABASE_URL`). `npm run test:e2e:release` sets it to its own throwaway Docker database — see [`docs/testing/e2e.md`](testing/e2e.md) |
| `HEALTH_DB_DEGRADED_MS` | `500` | `GET /api/v1/health`: a database that answers in this many milliseconds or more is `degraded` (HTTP 200). Not a positive number = the default |
| `HEALTH_DB_TIMEOUT_MS` | `5000` | `GET /api/v1/health`: a database that has not answered within this many milliseconds, or fails, makes the probe `unhealthy` (HTTP 503); a hung database cannot hang the probe. The answer never carries the database's own error (it is logged by the server) |
| `SCHEMA_IMPORT_GIT_MODE` | `restricted` | JSON Schema "From URL": `any` or `restricted`. Git-host URLs are fetched with the server's own `gh` credentials; unknown value = `restricted` |
| `SCHEMA_IMPORT_GIT_SCOPES` | (empty) | Comma-separated `owner` or `owner/repo` (case-insensitive) git repositories allowed in `restricted` mode; they hold for the root URL and for every `$ref` into a git host (an `owner` entry covers all its repositories, `owner/repo` only that one). Empty = git-host import disabled |
| `SCHEMA_IMPORT_MAX_YAML_BYTES` | `524288` | Schema import (JSON Schema, OpenAPI, format detection): a YAML document longer than this many bytes is refused BEFORE it is parsed (`YAML documents are limited to 512 KiB; convert to JSON for larger schemas`): the YAML parser alone costs seconds and about 1 GB for a 1.8 MB document. JSON is not affected (it keeps the importers' 2 MB limit). Not a positive whole number = the default |

## npm scripts

| Script | Behavior |
|--------|----------|
| `npm run dev` | `predev` runs `db:generate` + `db.ts ensure`: PGlite gets its pending migrations and the built-in message properties; PostgreSQL gets the built-in message properties only (best effort, no migrations) |
| `npm run build` | `prebuild` runs `db:generate` and the parser worker. A build writes no rows to any database (on PGlite it can still create the embedded directory, which `src/lib/db.ts` opens when it loads) |
| `npm run db:generate` | `prisma generate` |
| `npm run db:deploy` | PGlite: apply pending migrations in-process · PostgreSQL: `prisma migrate deploy`. Then, for either, install the built-in message properties into every tenant. A failure fails the command (exit 1): the production step does not finish without them |
| `npm run db:migrate` | `prisma migrate dev` — **author** a new migration (PostgreSQL only, see below) |
| `npm run db:seed` | `tsx prisma/seed.ts` (provider-aware) |
| `npm run db:studio` | `prisma studio` |

---

## How it works

```
DB_PROVIDER ─▶ src/lib/db-provider.ts ─▶ src/lib/db-adapter.ts ─▶ Prisma driver adapter
                                                │
                            ┌───────────────────┴───────────────────┐
                    postgresql: @prisma/adapter-pg          pglite: src/lib/pglite-adapter (vendored)
```

- **`src/lib/db-provider.ts`** — resolves `DB_PROVIDER` and `PGLITE_DATA_DIR`.
- **`src/lib/db-adapter.ts`** — `createDbAdapter()`, the single factory used by the
  Next.js runtime (`src/lib/db.ts`), the seed script, and CLI tooling.
- **`src/lib/db.ts`** — exports the shared `prisma` client (unchanged call sites).
- **`src/lib/pglite-adapter/`** — the PGlite Prisma driver adapter, **vendored** from
  the MIT `pglite-prisma-adapter` package (see "Vendored adapter" below).
- **`src/lib/pglite-migrate.ts`** — applies committed migration SQL to the embedded
  PGlite database in-process.
- **`scripts/db.ts`** — `ensure` (auto, before `dev`) and `deploy` (`npm run db:deploy`, the production step) entrypoints.

### Why a custom migrator for PGlite

Prisma's `migrate deploy` connects over a wire protocol (a `DATABASE_URL`). Embedded
PGlite runs in-process and exposes no URL, and the installed `@prisma/config` (7.6)
has no `adapter` hook for migrations. So `applyPgliteMigrations()` reads the committed
`prisma/migrations/*/migration.sql` files, runs them against PGlite (same PostgreSQL
dialect), and records applied migrations in a `_pglite_migrations` table. It is
**forward-only** (deploy-style) and idempotent.

---

## Authoring new migrations

The embedded migrator only **applies** migrations. To **create** one, use PostgreSQL
(PGlite cannot run `prisma migrate dev` — no URL / shadow DB endpoint):

```bash
# against any throwaway/local PostgreSQL
DB_PROVIDER=postgresql DATABASE_URL=postgresql://... npm run db:migrate -- --name my_change
```

Commit the generated `prisma/migrations/<timestamp>_my_change/` folder. The PGlite
path picks it up automatically on the next `db:deploy` / `predev`.

### Migration name ordering (read before generating the next migration)

Both runners (`prisma migrate deploy` and the PGlite migrator) apply migrations in **lexical
folder-name order**. The Events/levels program committed date-only, hand-written migrations
(`20261013_add_asset_levels` … `20261017_schema_reference_ghost_edges`) that are dated ahead of the
calendar. A migration generated by `npm run db:migrate` before **2026-10-18** gets a full
`YYYYMMDDHHMMSS` name such as `20261015161500_x`, which sorts **before** `20261015_entity_versioning`
and would run before the tables it alters ("relation does not exist" on a fresh deploy, a PGlite
apply or the `migrate dev` shadow replay).

- Name the next migration **at or after `20261018`** (e.g. `20261018_my_change`, or let Prisma stamp it
  once the real date passes 2026-10-18).
- Do **not** rename the existing folders: applied names are recorded in `_prisma_migrations` /
  `_pglite_migrations`, so a rename makes an already-migrated database try to re-apply them.

Because both backends share one PostgreSQL dialect, **keep migrations portable** — no
SQLite-only or extension-only SQL. The one platform feature in use (the `plpgsql`
audit trigger) runs on PGlite too.

### Access control migration (`20261025230000_access_control`)

Adds scoped roles (`user_roles.scopeKey`, unique `(userId, role, scopeKey)`), `users.disabledAt` / `lastLoginAt`, a unique index on
`lower(users.email)`, `invitations` + `invitation_roles`, `auth_tokens`, `auth_events` and `audit_log.tenantId`. It lower-cases and trims existing
e-mails, backfills before it constrains, adds no extension and deletes nothing. The backfill rules are in the header of its `migration.sql`; in short:
the finest scope a role row names decides its key (`P:` product, `D:` domain, `T:` tenant, else `G`), the tenant of a domain/product row is read from
the domain/product, and an old global row of a role other than `ADMIN` (the old rules made `COMPLIANCE_OFFICER` system-level) becomes one tenant-scoped
row per existing tenant. `audit_log.tenantId` is filled from the entity, field, domain, product, event spec or trait the entry is about (or the tenant
recorded in its own state when that row is gone), and left null for platform-level entries.

**It refuses to run, changing nothing, and prints the rows,** when two users have the same e-mail once trimmed and lower-cased, or when a user holds the
same role in the same scope twice (the old unique key let `NULL` columns repeat, so two identical global `ADMIN` rows were legal). Fix the rows by hand,
then deploy again; on PostgreSQL Prisma remembers the failed attempt, so run `npx prisma migrate resolve --rolled-back 20261025230000_access_control`
first (PGlite records nothing for a refused migration).

Authoring note: `prisma migrate dev` stops with "non-interactive" when it has to warn about a new unique constraint on existing rows, so this
migration's DDL skeleton was produced with `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` (it needs
a shadow database: a temporary `prisma.config.ts` with `datasource.shadowDatabaseUrl`) and then completed by hand; `npm run db:migrate` against a fresh
PostgreSQL applies it and reports the database in sync with `schema.prisma`.

**Rollback** is `prisma/migrations/20261025230000_access_control/rollback.sql`, documented and never run automatically (neither runner reads it): run it
with the application stopped, with `psql -v ON_ERROR_STOP=1 -f ...` (one transaction), then `DELETE FROM "_prisma_migrations" WHERE migration_name =
'20261025230000_access_control'` (PostgreSQL: `prisma migrate resolve --rolled-back` refuses a migration that succeeded, P3012) or
`DELETE FROM "_pglite_migrations" WHERE name = '20261025230000_access_control'` (PGlite), so a later deploy applies it again. It drops the new
tables and columns, restores the old unique key, keeps the role rows the old model can express (global and domain), copies the tenant- and
product-scoped ones to `user_roles_access_control_backup` instead of leaving rows the old code would read as wider, and clears the password hash of any
disabled user so the rollback does not silently re-enable them. Invitations, tokens and auth events are lost (export them first if you need them).

### Webhook endpoint creator (`20261026000000_webhook_endpoint_creator_optional`)

One statement: `webhook_endpoints."createdBy"` loses its NOT NULL (the foreign key to `users` stays, `ON DELETE RESTRICT`). The REST API key is a service principal and no row
of `users`, so an endpoint it creates has no creator; before this, the insert violated the foreign key and the key could not create an endpoint at all. Existing rows keep their creator.
`prisma/schema.prisma` says `createdBy String?` with `onDelete: Restrict, onUpdate: Cascade`, which is what the database has, so `migrate dev` finds no drift. PGlite applies it with
the others (`tests/integration/db/webhook-endpoint-creator-pglite.test.ts`). Its rollback (`rollback.sql`, never run automatically) is `SET NOT NULL` and refuses while an endpoint
has no creator: delete those, or give each a creator, first.

---

## Production notes

- Run `npm run db:deploy` **before** `npm start`. It is the production step: it applies the migrations and installs the built-in message
  properties into every tenant that lacks them, and it exits 1 when that install fails, so a deploy that did not finish does not look done.
  `predev` covers dev only. `npm run build` writes no rows to any database, so a build against a production or staging `DATABASE_URL` changes
  nothing there. The compose stack runs this step in its `migrate` service (see Docker Compose below).
- **PGlite is single-connection, single-process.** Do not use it for multi-instance
  or serverless fan-out — use `DB_PROVIDER=postgresql` there.
- CI (`.github/workflows/ci.yml`) runs the suite against **both** providers.

## Docker Compose

`.docker/docker-compose.yml` runs three services: `db` (PostgreSQL 16), `migrate` (a one-shot `npm run db:deploy`) and `app` (the image of
`.docker/Dockerfile`, PostgreSQL only: its `DB_PROVIDER` is `postgresql`, and the image carries no migrations for the embedded database).

```bash
export NEXTAUTH_SECRET="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"   # hex: the password goes into DATABASE_URL unescaped
docker compose -f .docker/docker-compose.yml up --build
```

- **Both secrets are required.** Compose stops with `set POSTGRES_PASSWORD` or `set NEXTAUTH_SECRET` when one is not exported. The file holds no
  database password.
- **Stored secrets.** Export `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) before the first Git credential or webhook secret is stored.
  Left unset, the key is derived from `NEXTAUTH_SECRET`, and rotating that secret makes the stored secrets unreadable (auth-ops.md, "Stored
  secrets").
- **The order:** `db` is healthy, then `migrate` applies the committed migrations and the built-in message properties and exits `0`, then `app`
  starts. A failed migration, or a built-in message property that cannot be installed, stops the stack before the app serves anything.
- **Published on this machine only.** The app is on <http://127.0.0.1:3000> and the database on `127.0.0.1:5432` (psql, `npm run db:studio`);
  nothing on another machine can connect to either. To reach the app from elsewhere, put a reverse proxy on this host in front of it and set
  `AUTH_URL` to the public address (auth-ops.md, "Trusting the host").
- **The first administrator.** The stack creates no account. Make one with `admin:create` in the `migrate` service, which uses the same database
  and reads both variables, so it needs no terminal:

  ```bash
  export BOOTSTRAP_ADMIN_EMAIL=you@example.com
  export BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 18)"   # or your own, 12 to 72 bytes; save it, it is the password you sign in with
  docker compose -f .docker/docker-compose.yml run --rm -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD migrate npm run admin:create
  ```

  It refuses an e-mail that already has an account. The `migrate` service runs with `NODE_ENV=production`, so a seed run there does not make the
  development account `admin@admin.com` (auth-ops.md, "The seed's administrator").
- **The database is initialised with `POSTGRES_PASSWORD` when the `pgdata` volume is first created.** Later, the password of the database is
  whatever it was set to. To change it, run `ALTER USER` inside the database (the local socket needs no password, so `exec` is enough) and then
  export the new value:

  ```bash
  docker compose -f .docker/docker-compose.yml exec db psql -U superschema -d superschema -c "ALTER USER superschema WITH PASSWORD '<the new value>'"
  ```

  This matters for a volume made by the earlier version of this file, which gave the database the fixed password `password`. Exporting a new
  value without that step makes `app` and `migrate` fail to log in. Export `POSTGRES_PASSWORD=password`, start `db` (`docker compose -f
  .docker/docker-compose.yml up -d db`; `NEXTAUTH_SECRET` must still be exported, Compose checks the whole file), run the `ALTER USER` above, then
  export the new value and start the stack. For a disposable volume, `docker compose -f .docker/docker-compose.yml down -v`
  removes the volume and its data instead.
- **The image does not build from a bare checkout yet.** `docker build -f .docker/Dockerfile .` stops in the `deps` stage at `RUN npm ci` on
  `node:20-alpine` (npm 10.8; seen before the base image moved to `node:22-alpine`, which also ships npm 10 and has not been retried): `npm ci` rejects `package-lock.json` with `EUSAGE` (`Missing: @swc/helpers@0.5.23 from lock file`), because npm 10
  wants that version for an optional peer of `@swc/core` and the lock does not list it. Separately, the five
  `file:../typespec/packages/*` emitter links point at a sibling checkout that the build context does not contain (KD-040 in
  `docs/testing/known-defects.md`). Even with a built image, generating a schema target does not work in it, because the emitter packages are
  not in the runtime image (KD-040).

## Vendored adapter

`src/lib/pglite-adapter/` is an inlined copy of `pglite-prisma-adapter`
(github.com/lucasthevenet/pglite-utils, MIT). It is vendored because that package is
not available in this environment's npm registry; its runtime dependencies
(`@prisma/driver-adapter-utils`, `postgres-array`) are already installed.

To switch to the published package later: `npm install pglite-prisma-adapter`, then
change the import in `src/lib/db-adapter.ts` from `./pglite-adapter` to
`pglite-prisma-adapter`, and delete the vendored folder.
