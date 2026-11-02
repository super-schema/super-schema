<div align="center">

<img src="src/app/icon.svg" alt="Super Schema logo" width="96" height="96" />

# Super Schema

**One model. Many schemas.**

Design the logical shape of your data once, then reuse it across schemas, APIs, and events,
with governance built in.

[Website](https://super-schema.github.io/) ·
[Get started](https://super-schema.github.io/get-started.html) ·
[Docs](#documentation) ·
[Report a bug](https://github.com/super-schema/super-schema/issues)

[![CI](https://github.com/super-schema/super-schema/actions/workflows/ci.yml/badge.svg)](https://github.com/super-schema/super-schema/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.22.2%20%3C25-339933?logo=node.js&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)
![TypeSpec](https://img.shields.io/badge/TypeSpec-1.x-0078D4)
![Status](https://img.shields.io/badge/status-pre--release-orange)

</div>

---

Super Schema is a self-hosted schema management platform. You describe an entity (its fields,
types, descriptions, ownership, and classification) as a single **logical model**. Super Schema
compiles it through [TypeSpec](https://typespec.io/) into the physical formats your systems
need: JSON Schema, OpenAPI 3, Avro, Protobuf, Java, and BigQuery, Spanner, or PostgreSQL DDL.
It also uses the same entities as payloads in AsyncAPI event contracts.

Instead of keeping a JSON Schema for the API, an Avro schema for Kafka, and a DDL file for the
warehouse in sync by hand, you keep one definition and treat every format as a reviewed,
versioned output of it.

> [!NOTE]
> Super Schema is **pre-release** (`0.1.0`). Expect breaking changes. Known gaps are tracked openly
> in [`docs/testing/known-defects.md`](docs/testing/known-defects.md).

## Table of contents

- [Features](#features)
- [Supported formats](#supported-formats)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Database](#database)
- [Deploying with Docker](#deploying-with-docker)
- [REST API](#rest-api)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Author](#author)

## Features

**Modeling**
- **Logical-first entity design.** Build entities with the visual Field Studio, write TypeSpec
  directly, or paste a definition. Reuse custom scalars, enums, and unions across entities.
- **Import existing schemas** from JSON Schema (from a file or a URL, with `$ref` resolution),
  OpenAPI, Avro, Protobuf, BigQuery, and TypeSpec. The format is detected automatically.
- **Organized workspaces.** A Tenant → Domain → Product → Entity hierarchy, with shared
  definitions at broader levels.
- **References and lineage.** Entities reference each other instead of copying structure. The
  lineage view shows the relationships declared in your catalog.

**Generation and delivery**
- **Multi-target generation** through the TypeSpec compiler and its emitters, with each
  target's diagnostics shown next to the generated artifact.
- **Event contracts.** Design AsyncAPI 3.0 documents (channels, messages, servers, operations)
  that use your entities as message payloads, with built-in CloudEvents and W3C Trace Context
  message properties.
- **Versioning.** Drafts, published versions, history and diffs, and pinned references that
  let consumers depend on a specific version.
- **Deployments and Git.** Track deployments of generated schemas, and sync schemas to a Git
  repository with optional pull-request review (always, breaking changes only, or never).

**Governance**
- **Classification and compliance.** Field-level data classification (for example PII),
  retention policies, compliance queries and exports, and a governance approval workflow.
- **Business glossary** linked to the fields it defines.
- **Immutable audit trail.** A database trigger keeps audit rows append-only, and credentials
  are redacted before they're written.
- **Notifications and webhooks.** In-app notifications plus signed, tenant-scoped webhook
  deliveries to public HTTPS endpoints.

**Platform**
- **Deny-by-default access control.** A role ladder
  (`VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN`) held at platform, tenant, domain,
  or product scope.
- **Authentication.** Local accounts (invite-only by default) plus optional Google, GitHub,
  Microsoft Entra ID, Okta, Keycloak, or generic OIDC sign-in through Auth.js.
- **Optional AI assistant** for natural-language entity creation and field suggestions. It
  runs **only** against a local or self-hosted LLM (Ollama or any OpenAI-compatible server), so
  nothing leaves your network.
- **REST API v1** with API keys, rate limiting, an OpenAPI description, and a health probe.
- **Localized UI** in English, Spanish, French, German, Japanese, and Chinese.
- **Zero-config local database.** It runs on embedded PostgreSQL (PGlite) with no server to
  install, or on a regular PostgreSQL server in production.

## Supported formats

### Generation targets

| Target | Emitter package | Stability |
| --- | --- | --- |
| JSON Schema | `@typespec/json-schema` | Stable |
| OpenAPI 3 | `@typespec/openapi3` | Stable |
| Avro | `@typespec/avro` ¹ | Stable |
| BigQuery DDL | `@typespec/bigquery` ¹ | Stable |
| PostgreSQL DDL | `@typespec/postgres` ¹ | Stable |
| Spanner DDL | `@typespec/spanner` ¹ | Stable |
| Protobuf | `@typespec/protobuf` | Preview |
| Java POJO (Jackson) | `@typespec/java-pojo` ¹ | Preview |
| HTTP clients: JS, Python, Java, C# | `@typespec/http-client-*` | Preview |
| HTTP servers: JS, C# | `@typespec/http-server-*` | Alpha |

¹ These are linked from a sibling TypeSpec checkout. See
[Prerequisites](#prerequisites).

Each format has its own limits. Review the generated artifact and its diagnostics before you
adopt an output. The full catalog lives in
[`src/lib/schema-targets/catalog.ts`](src/lib/schema-targets/catalog.ts).

### Import formats

JSON Schema (file or URL) · OpenAPI · Avro · Protobuf · BigQuery · TypeSpec

## How it works

```mermaid
flowchart LR
    subgraph In["Author"]
        VB["Visual builder"]
        TS["TypeSpec editor"]
        IM["Import<br/>JSON Schema · OpenAPI · Avro<br/>Protobuf · BigQuery · TypeSpec"]
    end

    subgraph Core["Super Schema"]
        LM["Logical model<br/>Tenant → Domain → Product → Entity"]
        GOV["Governance<br/>classification · retention<br/>glossary · approvals · audit"]
        SRC["TypeSpec source"]
    end

    subgraph Out["Deliver"]
        TSP["tsp compiler + emitters"]
        ART["JSON Schema · OpenAPI · Avro<br/>Protobuf · Java · DDL"]
        EV["AsyncAPI 3.0 event specs"]
        PUB["Versions · deployments<br/>Git PRs · webhooks · REST API"]
    end

    VB --> LM
    TS --> LM
    IM --> LM
    LM <--> GOV
    LM --> SRC --> TSP --> ART
    LM --> EV
    ART --> PUB
    EV --> PUB
```

1. **Model the meaning.** Fields, logical types, descriptions, ownership, and classification
   are stored as a logical entity.
2. **Connect definitions.** Entities reference other entities, shared types, API contracts, and
   event payloads.
3. **Generate and inspect.** The entity is rendered to TypeSpec and compiled by the `tsp` CLI
   with the emitter for each target. Compiler runs are capped and queued so a busy server
   degrades gracefully.
4. **Publish deliberately.** A published version captures a known definition. Consumers pin
   it, and webhooks, Git sync, and the REST API carry it to downstream systems.

### Tech stack

| Layer | Technology |
| --- | --- |
| Framework | [Next.js 16](https://nextjs.org/) (App Router), [React 19](https://react.dev/), TypeScript 6 |
| Schema engine | [TypeSpec](https://typespec.io/) compiler and emitters, AsyncAPI parser, protobuf.js |
| Data | [Prisma 7](https://www.prisma.io/) on PostgreSQL 16 or embedded [PGlite](https://pglite.dev/) |
| Auth | [Auth.js v5](https://authjs.dev/) |
| API | Next.js route handlers, [oRPC](https://orpc.unnoq.com/), [zod 4](https://zod.dev/) |
| UI | Tailwind CSS 4, Base UI, CodeMirror 6, React Flow, TanStack Query, next-intl |
| Testing | [Vitest](https://vitest.dev/), Testing Library, [Playwright](https://playwright.dev/), axe-core |

## Getting started

### Prerequisites

- **Node.js 22.22.2 or later**. `package.json` accepts `>=22.22.2 <25`; CI uses Node 22. Node 20 is end-of-life and is no longer supported.
- **npm** (the lockfile is `package-lock.json`).
- **Git**.
- **TypeSpec emitter packages (optional).** The Avro, Java POJO, BigQuery, PostgreSQL, and
  Spanner emitters are `file:` dependencies on a built TypeSpec checkout next to this
  repository:

  ```text
  parent/
  ├── super-schema/      ← this repository
  └── typespec/          ← provides packages/{avro,java-pojo,bigquery,postgres,spanner}
  ```

  These packages aren't published to npm yet. Without them, the app still runs, and JSON Schema,
  OpenAPI 3, and Protobuf generation still work. **Admin → Health** lists the emitters that are
  missing.

### Install and run

```bash
git clone https://github.com/super-schema/super-schema.git
cd super-schema
npm ci

cp .env.example .env    # set NEXTAUTH_SECRET; development accepts any value
npm run dev             # generates the Prisma client and applies migrations to PGlite
```

Open [http://localhost:3000](http://localhost:3000).

`npm run dev` needs no database server. Data is stored in `./data/pglite/`, which is gitignored.

### Create the first administrator

```bash
npm run db:seed
```

Outside production, the seed creates the development administrator **`admin@admin.com` /
`admin`**. Production never gets that account. Create a real administrator with:

```bash
npm run admin:create -- --email you@example.com
```

Or set both `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` before seeding. Nobody becomes an administrator just
by registering first. See [`docs/auth-ops.md`](docs/auth-ops.md).

To try event specs with sample data, run `npm run db:seed-events-demo`.

### Useful scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server (`predev` generates Prisma, migrates PGlite, builds the parser worker) |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |
| `npm test` | Vitest (watch mode in a terminal; `npx vitest run` runs once) |
| `npm run db:deploy` | Apply migrations (PGlite in-process, or `prisma migrate deploy` on PostgreSQL) |
| `npm run db:migrate` | Author a new migration (against PostgreSQL) |
| `npm run db:seed` | Seed data and the first administrator |
| `npm run db:studio` | Prisma Studio |
| `npm run admin:create` | Create an administrator account |

## Configuration

All settings are environment variables. [`.env.example`](.env.example) documents every one of
them. The ones you're most likely to change:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_PROVIDER` | `pglite` | `pglite` (embedded) or `postgresql` |
| `DATABASE_URL` | — | Required when `DB_PROVIDER=postgresql` |
| `NEXTAUTH_SECRET` / `AUTH_SECRET` | — | Signs sessions. In production it must be at least 32 characters (`openssl rand -base64 32`) and can't be a known development value |
| `NEXTAUTH_URL` | — | Public origin of the app |
| `SECRETS_ENCRYPTION_KEY` | derived from the auth secret | Encrypts stored Git credentials and webhook signing secrets (AES-256-GCM). Set it before you store any secret, so that rotating the auth secret doesn't make them unreadable |
| `AUTH_REGISTRATION` | `invite` | `invite`, `open`, or `closed` |
| `AUTH_PROVIDERS` | none | Extra sign-in providers: `google`, `github`, `microsoft-entra-id`, `okta`, `keycloak`, `oidc` ([`docs/auth.md`](docs/auth.md)) |
| `AUTH_TRUST_PROXY` | unset | `1` when a trusted reverse proxy sets `X-Forwarded-For` |
| `API_KEY`, `API_KEY_TENANT_ID`, `API_KEY_ROLE` | unset | REST API service key, its tenant, and its role |
| `API_RATE_LIMIT_PER_MINUTE` | `100` | Requests per minute per authenticated API caller |
| `TSP_MAX_CONCURRENT_RUNS` | half the CPU cores | Concurrent TypeSpec compiler processes (about 100 MB each) |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL` | unset | Local LLM for the AI assistant ([`docs/ai-setup.md`](docs/ai-setup.md)) |

## Database

Super Schema runs on two interchangeable backends that speak the same PostgreSQL dialect. That
means one Prisma schema and one migration history for both.

| Provider | `DB_PROVIDER` | Use for |
| --- | --- | --- |
| **PGlite** (default) | `pglite` | Local development, demos, single-instance deployments |
| **PostgreSQL** | `postgresql` | Production, multiple instances, high concurrency |

To switch to PostgreSQL:

```bash
# .env
DB_PROVIDER=postgresql
DATABASE_URL=postgresql://superschema:password@localhost:5432/superschema
```

```bash
npm run db:deploy && npm run db:seed && npm run dev
```

Write new migrations against PostgreSQL (`npm run db:migrate`). PGlite applies them in-process.
The full guide is [`docs/database.md`](docs/database.md).

## Deploying with Docker

The Compose stack runs PostgreSQL 16, a one-shot migrator, and the app. It publishes ports on
`127.0.0.1` only, so put your reverse proxy in front.

```bash
export NEXTAUTH_SECRET="$(openssl rand -base64 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export SECRETS_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # recommended

docker compose -f .docker/docker-compose.yml up --build
```

The startup order is: the database becomes healthy, the migrations run (`npm run db:deploy`),
then the app starts. The stack creates no account; see
[Create the first administrator](#create-the-first-administrator).

> [!WARNING]
> The Docker image doesn't include emitter packages yet, so it can import, edit, and compile
> schemas but **can't generate targets**. `/api/v1/health` reports `degraded` in this case. This is
> tracked as KD-040 in [`docs/testing/known-defects.md`](docs/testing/known-defects.md). For
> generation, run `npm run build && npm start` on a host that has the emitter packages.

## REST API

The REST API lives under `/api/v1`. It covers schemas, event specs, governance, compliance,
glossary, lineage, annotations, emission, notifications, and webhooks.

- **Authentication:** a signed-in session, or `Authorization: Bearer <API_KEY>`. The key is a
  service principal with one tenant and one role.
- **OpenAPI description:** `GET /api/v1/docs`
- **Health probe:** `GET /api/v1/health` returns `healthy`, `degraded`, or `unhealthy` (503).

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/api/v1/schemas
```

Authenticated callers are limited to `API_RATE_LIMIT_PER_MINUTE` requests per minute.
Unauthenticated callers get 20 per minute.

## Testing

```bash
npx vitest run                  # unit and integration tests
npm run test:coverage           # with coverage
npx playwright install          # once, for the browser suite
npm run test:e2e:smoke          # fast end-to-end tier
npm run test:e2e:regression     # full regression tier
```

CI runs the unit and integration suite against **both** database providers. The end-to-end
suite has smoke, regression, nightly, and visual tiers. It's documented in
[`docs/testing/e2e.md`](docs/testing/e2e.md), with coverage in
[`docs/testing/e2e-coverage-matrix.md`](docs/testing/e2e-coverage-matrix.md) and access-control
proofs in [`docs/testing/access-control.md`](docs/testing/access-control.md).

## Project structure

```text
super-schema/
├── src/
│   ├── app/                 # Next.js routes: (auth), (dashboard), api/ (REST v1 and internal)
│   ├── features/            # Feature modules (UI + logic per feature)
│   ├── components/          # Shared UI components
│   ├── lib/                 # Domain logic: compiler, importers, typespec, access, compliance, lineage, ...
│   ├── services/            # Server services (events, classification, version history, health)
│   ├── server/              # Server-only wiring
│   ├── emitters/            # Native emitter extension point (targets run through TypeSpec today)
│   └── i18n/                # Locale configuration
├── prisma/                  # Prisma schema, migrations, seed
├── scripts/                 # DB, admin, e2e and maintenance scripts
├── tests/                   # unit/, integration/, e2e/, fixtures/
├── vendor/                  # Vendored TypeSpec libraries
├── docs/                    # Guides and test documentation
└── .docker/                 # Dockerfile and Compose stack
```

## Documentation

| Guide | Covers |
| --- | --- |
| [`docs/database.md`](docs/database.md) | PGlite and PostgreSQL, migrations, Docker Compose |
| [`docs/auth.md`](docs/auth.md) | Sign-in providers, redirect URIs, account linking |
| [`docs/auth-ops.md`](docs/auth-ops.md) | Operating auth: secrets, administrators, throttling, API keys, webhooks, stored secrets |
| [`docs/ai-setup.md`](docs/ai-setup.md) | Connecting a local LLM |
| [`docs/testing/e2e.md`](docs/testing/e2e.md) | The browser test suite |
| [`docs/testing/known-defects.md`](docs/testing/known-defects.md) | Known defects and gaps |
| [super-schema.github.io](https://super-schema.github.io/) | Product overview and the modeling workflow |

## Contributing

Contributions are welcome. Before you open a pull request:

1. Open an issue for anything larger than a small fix, so the approach can be agreed first.
2. Keep changes focused, and use [Conventional Commits](https://www.conventionalcommits.org/)
   (`fix(events): …`, `feat(importers): …`, `docs: …`).
3. Add or update tests. `npx vitest run`, `npm run lint`, and `npx tsc --noEmit` should pass.
4. For schema changes, write the migration against PostgreSQL with `npm run db:migrate`, and
   check that it applies on PGlite too.
5. Document new environment variables in `.env.example` and the relevant guide.

By submitting a contribution, you agree that it's licensed under the
[Apache License 2.0](LICENSE) (section 5 of the license).

## Security

Please **don't open a public issue** for a security vulnerability. Report it privately, either
through GitHub's [private vulnerability reporting](https://github.com/super-schema/super-schema/security)
or by email to [jaysen@apache.org](mailto:jaysen@apache.org). Include the steps to reproduce,
and you'll get an acknowledgement.

## License

Super Schema is licensed under the [Apache License 2.0](LICENSE). You may use, modify, and
distribute it, including in commercial and closed-source products, as long as you follow the
license terms:

- **Keep the attribution.** If you distribute Super Schema or a work derived from it, include
  the license and the contents of the [`NOTICE`](NOTICE) file, which credits the project and
  its author.
- **Mark your changes.** Modified files must say that you changed them.
- **Use a different name.** The license grants no rights to the name or logo. Forks and
  derived products need their own name; see the [trademark policy](TRADEMARKS.md).

Third-party code included in this repository keeps its own license. See the end of
[`LICENSE`](LICENSE).

### Credit and citation

If you build on Super Schema, please credit the project and its author where your users can
see it, for example: "Based on [Super Schema](https://github.com/super-schema/super-schema)
by Jay Sen". To cite it, use GitHub's **Cite this repository** button, which reads
[`CITATION.cff`](CITATION.cff).

## Author

**Jay Sen** · [jaysen@apache.org](mailto:jaysen@apache.org) ·
[super-schema.github.io](https://super-schema.github.io/)

<div align="center">
<sub>Built on <a href="https://typespec.io/">TypeSpec</a>. One model, many schemas.</sub>
</div>
