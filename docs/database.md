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
npm run db:deploy    # runs `prisma migrate deploy` against your database
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
| `SCHEMA_IMPORT_GIT_MODE` | `restricted` | JSON Schema "From URL": `any` or `restricted`. Git-host URLs are fetched with the server's own `gh` credentials; unknown value = `restricted` |
| `SCHEMA_IMPORT_GIT_SCOPES` | (empty) | Comma-separated `owner` or `owner/repo` (case-insensitive) git roots allowed in `restricted` mode. Empty = git-host import disabled |

## npm scripts

| Script | Behavior |
|--------|----------|
| `npm run dev` / `build` | `predev`/`prebuild` first run `db:generate` + `db.ts ensure` |
| `npm run db:generate` | `prisma generate` |
| `npm run db:deploy` | PGlite: apply pending migrations in-process · PostgreSQL: `prisma migrate deploy` |
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
- **`scripts/db.ts`** — `ensure` (auto, pre dev/build) and `deploy` entrypoints.

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

---

## Production notes

- Run `npm run db:deploy` **before** `npm start` — `predev`/`prebuild` only cover
  dev and build, not the production start.
- **PGlite is single-connection, single-process.** Do not use it for multi-instance
  or serverless fan-out — use `DB_PROVIDER=postgresql` there.
- CI (`.github/workflows/ci.yml`) runs the suite against **both** providers.

## Vendored adapter

`src/lib/pglite-adapter/` is an inlined copy of `pglite-prisma-adapter`
(github.com/lucasthevenet/pglite-utils, MIT). It is vendored because that package is
not available in this environment's npm registry; its runtime dependencies
(`@prisma/driver-adapter-utils`, `postgres-array`) are already installed.

To switch to the published package later: `npm install pglite-prisma-adapter`, then
change the import in `src/lib/db-adapter.ts` from `./pglite-adapter` to
`pglite-prisma-adapter`, and delete the vendored folder.
