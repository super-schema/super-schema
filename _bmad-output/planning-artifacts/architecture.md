---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
status: 'complete'
completedAt: '2026-04-02'
lastStep: 8
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/planning-artifacts/ux-design-specification.md'
  - '_bmad-output/planning-artifacts/product-brief-super-schema.md'
  - '_bmad-output/planning-artifacts/product-brief-super-schema-distillate.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-03-31-2345.md'
  - '_bmad-output/planning-artifacts/prd-validation-report.md'
  - 'ref/SuperSchema.md'
  - 'ref/Universal Schema.md'
workflowType: 'architecture'
project_name: 'super-schema'
user_name: 'Jay'
date: '2026-04-02'
lastEdited: '2026-10-12'
editHistory:
  - date: '2026-10-12'
    changes: 'TypeSpec-as-system-of-record pivot, matching prd.md same date. Data Architecture, TypeSpec Integration, and Git Integration sections rewritten: typespec_source (text) is now canonical, fields table becomes a derived/regenerated projection, JSONB decorator schema superseded by the @superschema/typespec-enterprise governance package, swappable-IR goal dropped. DB-DDL emission routes through real upstream TypeSpec packages (Spanner/BigQuery/Postgres/MySQL/Oracle/Iceberg/Parquet). Requirements coverage updated to 77/77 (FR73-77). Risk Assessment updated: compile latency elevated to High, added concurrent-edit and compiler-upgrade risks.'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**72 Functional Requirements across 10 capability areas:**

| Capability Area | FRs | Architectural Implication |
|---|---|---|
| Schema Authoring & Management | FR1-FR9 | Complex form state, real-time validation, entity data model with decorators |
| Schema Emission & Validation | FR10-FR15 | TypeSpec compiler integration, emitter plugin architecture, per-target validators |
| Versioning & Change Management | FR16-FR20 | Version control data model, structured diff engine, migration artifact generator |
| Registration & Drift Detection | FR21-FR24 | Schema parser/importer per format, AI field matching, drift diff engine |
| Governance & Compliance | FR25-FR34 | Workflow engine, approval routing, notification dispatch, compliance query, immutable audit |
| Deployment Tracking | FR35-FR37 | Deployment state model, target system registry |
| Administration & Platform | FR38-FR45c | Auth (local+Google+SSO), RBAC, domain/workspace model, extensible taxonomy, policy inheritance |
| Git-Native Workflow | FR55-FR58 | Git integration, PR comments, bidirectional sync, conflict detection |
| Notifications | FR59-FR62 | In-app + DB persistence, extensible to external |
| API & Integration | FR63-FR67 | Versioned REST API, webhook dispatch |
| AI-Assisted Authoring | FR68-FR72 | LLM integration, schema standard library, field suggestion engine |

**NFRs driving architecture:** UI < 200ms, emission < 30s, API < 500ms, 50 concurrent users, 5,000 entities, 500 users, encryption at rest + transit, RBAC, immutable audit, zero external calls, deterministic emission, transactional operations.

### Scale & Complexity

- **Complexity:** Enterprise-high
- **Domain:** Full-stack web (SPA + API + compiler integration)
- **Components:** 12-15 major services/modules
- **Unique challenge:** TypeSpec compiler (Node.js) as runtime service behind abstraction layer

### Technical Constraints

| Constraint | Impact |
|---|---|
| TypeSpec compiler is Node.js | Backend must support Node.js runtime |
| On-premise, zero external deps | Fully containerized, no cloud services |
| TypeSpec never user-facing | UI → API → TypeSpec compiler → emitters behind abstraction |
| Emitter plugin architecture | Pluggable, independently versioned, stable API contract |
| Immutable audit trail | Append-only store, no modification by any user |
| Git bidirectional sync | Export, import, conflict detection, PR integration |
| AI authoring on-premise | Local/self-hosted LLM or optional feature |

### Cross-Cutting Concerns

1. **Auth & RBAC** — every endpoint, view, data access. Entity/domain/system scoping.
2. **Audit Trail** — every write operation logged immutably across all services.
3. **Multi-layer Validation** — authoring time, TypeSpec compilation, emission syntax, compatibility.
4. **Versioning** — schema versions, emitter API versions, REST API versions, IR version.
5. **Domain Scoping** — entities belong to domains, domains have policy templates, users have per-domain permissions.
6. **Notification Dispatch** — governance events, drift, compliance gaps. Extensible (in-app → Slack/email).

## Starter Template & Technology Stack

### Selected Stack: Next.js + Shadcn/ui + Docker

**Initialization:**
```bash
npx create-next-app@latest super-schema  # Official Next.js 16.2 scaffolding
cd super-schema
npx shadcn@latest init                    # Add component library
npm install @orpc/server @orpc/client @orpc/react @orpc/openapi  # Add oRPC
npm install prisma @prisma/client         # Add Prisma ORM
npm install next-auth@5                   # Add Auth.js v5
npm install @typespec/compiler            # Add TypeSpec compiler
```

### Technology Decisions

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.x | Full-stack monolith, SSR-capable, API routes |
| Language | TypeScript (strict) | 5.x | Type safety across frontend + backend |
| ORM | Prisma | 7.x | Type-safe DB access, migration management |
| Database | PostgreSQL | 16+ | Relational, JSON support, enterprise-grade |
| Auth | Auth.js v5 + Prisma adapter | 5.x beta | Local + Google + SSO via adapters |
| Unified API | oRPC | latest | End-to-end type safety for UI ↔ server + auto-generated OpenAPI for CI/CD, webhooks |
| UI Components | Shadcn/ui (Radix + Tailwind) | latest | Accessible primitives, full customization |
| Styling | Tailwind CSS | 4.x | Utility-first, design token system |
| Schema IR | TypeSpec compiler | latest | Server-side compilation, emitter execution |
| Env Config | @t3-oss/env-nextjs | — | Validated environment variables |
| Deployment | Docker + docker-compose | — | On-premise containerized (app + PostgreSQL) |
| SSO | BoxyHQ SAML Jackson | — | Enterprise SAML/OIDC middleware |

### API Strategy

**Single unified API layer:**
- **oRPC** — all UI ↔ server communication AND external/CI/CD access. Typesafe routers for schema CRUD, emission, governance, compliance queries, notifications. `@orpc/openapi` auto-generates OpenAPI 3.0 spec from router definitions for external API docs — no separate REST API routes needed.

### What Starter Provides vs Manual Additions

| Provided by create-next-app | Added Manually |
|---|---|
| Next.js + TypeScript + Tailwind | Shadcn/ui component library |
| ESLint config | Prisma + PostgreSQL setup |
| — | oRPC (`@orpc/server`, `@orpc/client`, `@orpc/react`, `@orpc/openapi`) |
| — | Auth.js v5 + Google + Credentials + SSO providers |
| — | TypeSpec compiler integration |
| — | Hex-inspired dark theme tokens |
| — | Docker + docker-compose |
| — | Vitest + Playwright testing |
| — | Custom emitter plugin architecture |

## Core Architectural Decisions

### Party Mode Review Refinements

Architectural decisions reviewed by Winston (Architect), Amelia (Developer), and Murat (Test Architect). Key refinements adopted:

| Refinement | Decision | Rationale |
|---|---|---|
| On-save compilation | **Synchronous** — stays in critical path | User must see compilation errors immediately. Aligns with "validate continuously" UX principle. |
| Git sync (MVP) | **Export-only** — bidirectional import deferred to Phase 2 | Bidirectional sync is a distributed systems problem. Export-only removes conflict resolution complexity from MVP. |
| JSONB validation | **Zod schemas on every JSONB write** — non-negotiable | PostgreSQL doesn't validate JSONB structure. Application-level Zod validation is the data integrity layer. |
| Service layer pattern | **Adopted** — shared business logic, thin oRPC wrappers | Prevents dual API maintenance. One source of truth for logic. |
| Emitter intermediate model | **Adopted** — emitters receive Super Schema model, not TypeSpec internals | Decouples emitter API from TypeSpec compiler internals. Makes IR swappable without changing emitters. |
| Connection pooling | **Prisma connection pool + PgBouncer** | 50 concurrent users with serverless-style handlers will exhaust PostgreSQL connections without pooling. |
| Compiler interface | **Interface + mock pattern** | TypeSpec compiler behind an interface for testability. Unit tests mock, integration tests use real compiler. |

### Data Architecture

**Database:** PostgreSQL 16+ with Prisma ORM

**Storage model:** TypeSpec source as canonical representation + relational projection + JSONB for operational metadata

> **Superseded (2026-10-12):** The original model treated `entities`/`fields` rows as canonical and generated TypeSpec from them on demand ("Hybrid relational + JSONB", decorator JSONB validated by Zod). That direction is reversed — see TypeSpec Integration below for the new pipeline and rationale (full analysis: the "TypeSpec as System of Record" memo from the 2026-10-12 session).

**Core tables:**

```
entities          — id, name, domain_id, version, status, owner, description,
                    typespec_source (text, CANONICAL — the entity's TypeSpec document),
                    metadata (JSONB — non-schema operational metadata only)
fields            — id, entity_id, name, type, precision, scale, nullable, is_key,
                    description, classification, sort_order
                    DERIVED, read-only projection: regenerated by parsing typespec_source
                    after every save. Never independently written — exists purely so
                    governance queries ("every PII field") and list views don't need to
                    re-parse TypeSpec per request. Source of truth is always the entity's
                    typespec_source.
entity_versions   — id, entity_id, version_number, typespec_source_snapshot (text),
                    change_record (JSONB), migration_artifacts (JSONB), created_by, created_at
domains           — id, name, description, policy_template (JSONB)
emission_targets  — id, entity_id, target_type, emitted_output (text), validation_status,
                    validation_details (JSONB), last_emitted_at, version_id
deployment_tracking — id, emission_target_id, environment, status, deployed_version_id, drift_report (JSONB)
governance_requests — id, entity_id, version_id, change_type, status, impact_report (JSONB)
governance_approvals — id, request_id, approver_id, decision, comment, decided_at
audit_log         — append-only: id, action, entity_type, entity_id, user_id, timestamp,
                    before_state (JSONB), after_state (JSONB)
notifications     — id, user_id, type, title, body, entity_ref, read, created_at
type_mapping_policies — id, target_type, source_type, mapped_type, is_override, approved_by
users, sessions, accounts — Auth.js managed via Prisma adapter
user_roles        — id, user_id, role, domain_id (nullable for system-level roles)
```

**Deliberately unchanged by the TypeSpec pivot:** `audit_log`, `user_roles`, `deployment_tracking`, `governance_requests`/`governance_approvals`, `notifications`, `users`/`sessions`/`accounts`. These describe users, history, approvals, and external-system state — not schema content — and have no TypeSpec representation regardless of decorator design. They stay exactly as they are, joined to entities by `entity_id`, same as today.

**Governance metadata (moved from JSONB to TypeSpec decorators):**

The decorator categories below are no longer a Zod-validated JSONB blob on the `fields` row — they are expressed as TypeSpec decorators from the `@superschema/typespec-enterprise` governance package (prototyped, verified against `@typespec/compiler` 0.60.1), compiled and typechecked, not merely schema-validated:

```tsp
@businessOwner("payments-team")
@steward("jane@example.com")
model Transaction {
  @key id: string;

  @dataClassification(DataClassification.FINANCIAL)
  @precision(19, 4)
  amount: decimal;

  @dataClassification(DataClassification.PII)
  @pii
  @anonymization(AnonymizationStrategy.tokenize)
  cardNumber: string;

  @retentionPolicy("7-years")
  @qualityRule("amount > 0")
  @sourceMapping("kafka", "transactions-topic", "card_number")
  ...
}
```

Mapping from the old JSONB categories: `structure` → native TypeSpec optionality/`@key`; `semantics` → `@doc`/aliases; `classification` → `@dataClassification`/`@pii`; `policy` → `@retentionPolicy`/`@anonymization`; `quality` → `@qualityRule`; `lineage` → `@sourceMapping`; `operationalHints`/`evolution` → package extension, tracked as a follow-on story (not yet in the governance package as of 2026-10-12). Avro/Protobuf physical binding options (`logicalType`, `fixedSize`, `defaultValue`, `order`, field numbers, `oneofGroup`) — previously `EmissionTargetStatus.formatOptions` — become decorators in the same package (`@avro.logicalType(...)` etc.), superseding that column/table entirely.

**Caching:** No dedicated cache for MVP. TanStack Query client-side with stale-while-revalidate. Prisma connection pooling for server-side.

### Authentication & Security

**Auth stack:** Auth.js v5 + Prisma adapter + BoxyHQ SAML Jackson

**Providers:** Local (email/bcrypt password), Google OAuth 2.0, Enterprise SSO (SAML/OIDC via BoxyHQ)

**RBAC model:**

| Role | Scope | Permissions |
|---|---|---|
| Viewer | Domain or System | Read entities, view emissions, browse compliance |
| Author | Domain | Create/edit entities, emit, view governance |
| Steward | Domain | Author + approve/reject governance, manage overrides |
| Compliance Officer | System | Query compliance across all domains, export reports |
| Admin | System | All permissions + user/domain/emitter management |

**Implementation:** Role + domain checked in oRPC middleware on every procedure. Next.js middleware protects routes.

**Security:** TLS 1.2+, encryption at rest (PostgreSQL disk-level), immutable audit log (insert-only, DB-level trigger prevents UPDATE/DELETE), zero external calls at runtime.

### API & Communication

**Service layer pattern (adopted from party mode review):**

```
src/services/           ← Business logic (pure functions, testable)
├── schema.service.ts
├── emission.service.ts
├── governance.service.ts
├── compliance.service.ts
├── ...

src/server/api/routers/ ← oRPC wrappers (thin, call services)
├── schema.ts
├── emission.ts
├── ...
```

**Error handling:** Standardized shape with `suggestedFix`:
```typescript
{ code: string, message: string, details?: object, suggestedFix?: string }
```

### TypeSpec Integration

> **Superseded (2026-10-12):** The original pipeline generated TypeSpec *from* a DB-canonical model on every save ("TypeSpec Generator (DB model → .tsp in memory)") and kept the compiler's output translated into an internal `SuperSchemaModel` specifically so "the IR is swappable." Both are reversed below: TypeSpec source is now the write target itself, and swappability is no longer a design goal.

**Compilation pipeline (synchronous on save, surgical not whole-document):**

```
UI field edit → saveField mutation
  → Load entity's current typespec_source
  → Locate the target model-property node via the real compiler's AST (by name)
  → Splice just that node's text span with the new declaration
     (type, decorators from the governance package) — rest of the document untouched
  → ICompilerService.compile(splicedSource)
    → Real TypeSpec Compiler (@typespec/compiler) — parse, typecheck, run
      @superschema/typespec-enterprise governance lint rules
    → Return: success + compiled Program, or error + diagnostics
  → If error: reject the save in full, return diagnostic with suggestedFix to UI,
    typespec_source on disk is UNCHANGED (optimistic version check also runs here —
    if the stored version moved since the UI last loaded it, reject as a conflict
    before even attempting the splice)
  → If success: persist the new typespec_source, regenerate the derived `fields`
    projection by parsing the compiled Program, bump entity version, return success
```

A full raw-text edit (Journey 7: the TypeSpec source view) follows the same path minus the splice step — the user's edited text replaces `typespec_source` wholesale, same compile-validate-or-reject gate.

**Compiler service interface (unchanged shape, different internals):**

```typescript
interface ICompilerService {
  compile(source: string): Promise<CompilationResult>;
  emit(compiledModel: SuperSchemaModel, target: string, policies: MappingPolicy[]): Promise<EmitterResult>;
  validate(output: string, targetFormat: string): Promise<ValidationResult>;
}
```

**Emitter model — `SuperSchemaModel` is now a real-compiler projection, not a swap boundary.**

Emitters still receive a `SuperSchemaModel` shape rather than raw TypeSpec `Program`/`Type` objects directly — that part of the design holds up and is kept, because it's genuinely useful emitter ergonomics, not because the IR needs to be swappable (it doesn't; TypeSpec is permanent). `SuperSchemaModel` is now produced by walking the real compiled `Program`, not by a parallel implementation:

```typescript
interface SuperSchemaModel {
  entity: { name: string; domain: string; version: number; metadata: EntityMetadata };
  fields: Array<{ name: string; type: LogicalType; decorators: DecoratorSet }>;
  relationships: Array<{ target: string; cardinality: string }>;
}

interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
```

**Database-DDL targets route through real upstream TypeSpec packages, not custom emitters.** As of 2026-10-12, `@typespec/db`-adjacent packages for Spanner, BigQuery, PostgreSQL, MySQL, Oracle, Iceberg, and Parquet exist and compile against `@typespec/compiler` 0.60.1 (built in a sibling checkout, commit `79f2d429c`). Super Schema's DB-DDL emission for these targets becomes "compile the entity's TypeSpec source with the matching upstream emitter," not a maintained custom emitter per target. Avro and OpenAPI remain Super Schema's own emitters (no upstream TypeSpec equivalent at this quality level yet), now consuming the real-compiler-derived `SuperSchemaModel` instead of one derived from Prisma rows directly.

**Governance package:** `@superschema/typespec-enterprise` — a real `createTypeSpecLibrary`-based TypeSpec library (decorators: `@dataClassification`, `@pii`, `@businessOwner`, `@steward`, `@retentionPolicy`, `@anonymization`, `@qualityRule`, `@key`, `@precision`, `@sourceMapping`; linter rules: `require-classification`, `pii-requires-anonymization`, `pii-requires-restricted-classification`, `decimal-requires-precision`, etc.). Needs extension before this architecture ships: Avro/Protobuf binding decorators (superseding `EmissionTargetStatus.formatOptions`), and the `operationalHints`/`evolution` categories not yet covered.

### Git Integration (MVP: Export-Only)

**MVP scope:** The entity's `typespec_source` is already the source of truth and already a plain text file format — Git distribution is now a direct export of the real artifact, not a proprietary JSON projection of it.

> **Simplified (2026-10-12):** The original design exported a `.superschema.json` "logical definition" alongside emitted outputs. That file no longer exists as a concept — `typespec_source` *is* the logical definition, and it's already `.tsp` text.

```
On Emit:
  DB → Git Sync Service → Push to configured Git repo
  ├── schemas/{domain}/{entity}.tsp             (the entity's typespec_source, verbatim)
  ├── schemas/{domain}/{entity}.bq.sql            (emitted BigQuery)
  ├── schemas/{domain}/{entity}.avro.json         (emitted Avro)
  └── schemas/{domain}/{entity}.openapi.yaml      (emitted OpenAPI)
```

**Phase 2 addition:** Bidirectional sync with conflict detection, PR-based import, webhook-triggered Git → DB sync. This is materially easier now than under the old design — importing a hand-edited `.tsp` from Git is the same compile-and-replace path as Journey 7's in-app text editor, not a separate JSON-reconciliation problem.

### Frontend Architecture

**State management:**
- Server state: TanStack Query via oRPC hooks (stale-while-revalidate, polling)
- Form state: react-hook-form + zod (field-level dirty tracking, real-time validation)
- UI state: React context (panels, tabs, view mode) → localStorage persistence
- URL state: Next.js App Router (entity = URL param, activity section = route)

**Code organization (feature-based):**

```
src/
├── app/                    ← Next.js App Router pages
│   ├── (auth)/             ← Auth pages (login, register)
│   ├── (dashboard)/        ← Main app layout
│   │   ├── schemas/        ← Schema editor views
│   │   ├── compliance/     ← Compliance dashboard
│   │   ├── governance/     ← Governance tracker
│   │   ├── lineage/        ← Lineage graph view
│   │   └── admin/          ← Admin panel
│   └── api/[...orpc]/       ← oRPC route handler (serves UI + OpenAPI)
├── components/
│   ├── ui/                 ← Shadcn/ui components (customized)
│   └── custom/             ← Super Schema custom components
├── features/               ← Feature-specific logic
│   ├── schema-editor/
│   ├── emission/
│   ├── governance/
│   └── ...
├── services/               ← Business logic (shared by oRPC routers)
├── server/api/routers/     ← oRPC routers
├── hooks/                  ← Reusable React hooks
├── lib/                    ← Utilities, TypeSpec compiler wrapper
├── emitters/               ← Emitter plugins
└── types/                  ← Shared TypeScript types
```

**Performance:** Code splitting per route, lazy loading for LineageDAG/DiffViewer/EmissionPreview, debounced emission preview (1s), virtual scrolling for lists > 100 items.

### Infrastructure & Deployment

**Docker composition (2 containers):**

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgresql://superschema:password@db:5432/superschema
      NEXTAUTH_SECRET: ...
    depends_on: [db]

  db:
    image: postgres:16
    volumes: ["pgdata:/var/lib/postgresql/data"]
    ports: ["5432:5432"]

volumes:
  pgdata:
```

**No Redis, no message queue for MVP.** All operations synchronous. Background tasks (drift detection, bulk import) can use Next.js API routes with longer timeout if needed.

**Testing strategy:**
- **Vitest** — unit + integration tests. Mock compiler service for unit tests. Real compiler for integration.
- **Playwright** — E2E tests for critical user journeys.
- **Zod** — runtime validation on all JSONB writes (continuous data integrity).

### Decision Impact: Updated Implementation Sequence

1. Project initialization (create-next-app + Prisma + oRPC + Auth.js + Shadcn + Docker + PostgreSQL)
2. Prisma schema (all tables defined above)
3. Zod schemas for JSONB validation
4. Auth system (Auth.js + RBAC middleware)
5. Service layer + oRPC routers (schema CRUD first)
6. TypeSpec compiler service (interface + implementation)
7. Schema editor UI (core experience)
8. Emission pipeline (3 core emitters with intermediate model)
9. Versioning + diff + migration artifacts
10. Git export service
11. Governance workflows + notifications
12. Compliance queries + export
13. Admin panel
14. OpenAPI spec generation via `@orpc/openapi`
15. Testing (Vitest + Playwright)

## Implementation Patterns & Consistency Rules

### Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Component files | PascalCase | `SchemaFieldRow.tsx` |
| Service/util files | camelCase | `schema.service.ts` |
| Route files | kebab-case folder + `route.ts` | `api/v1/schemas/route.ts` |
| React components | PascalCase | `<EntityCard />` |
| Functions/variables | camelCase | `getEntityById` |
| Types/interfaces | PascalCase, `I` prefix for interfaces | `SuperSchemaModel`, `ICompilerService` |
| DB tables | snake_case plural | `entity_versions` |
| DB columns | snake_case | `created_at` |
| oRPC procedures | camelCase | `schema.getById` |
| Env variables | SCREAMING_SNAKE | `DATABASE_URL` |

### Code Patterns

**Service function (every business operation):**
```typescript
export async function saveEntity(input: SaveEntityInput, ctx: ServiceContext): Promise<Result<Entity, ServiceError>> {
  // 1. Zod validate  2. Check RBAC  3. Business logic  4. Prisma write
  // 5. TypeSpec compile  6. Audit log  7. Return Result (never throw)
}
```

**oRPC wrapper (thin):**
```typescript
save: protectedProcedure.input(SaveEntityInputSchema).mutation(({ input, ctx }) => saveEntity(input, ctx))
```

**Result type (never throw):**
```typescript
type Result<T, E = ServiceError> = { success: true; data: T } | { success: false; error: E };
```

**Shared Zod schemas:** Frontend + backend share schemas from `src/types/schemas/`. Never duplicate validation.

**Audit trail:** Every write operation wrapped in `withAudit()` — no exceptions.

**RBAC:** Every oRPC procedure checks role + domain via middleware.

### Component Pattern

```
src/components/custom/SchemaFieldRow/
├── SchemaFieldRow.tsx        ← Component
├── SchemaFieldRow.types.ts   ← Props + types
├── useSchemaFieldRow.ts      ← Logic hook
└── index.ts                  ← Re-export
```

## Project Structure

```
super-schema/
├── .docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── src/
│   ├── app/                          ← Next.js App Router
│   │   ├── layout.tsx
│   │   ├── (auth)/login, register
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx            ← Activity bar + sidebar + status bar
│   │   │   ├── schemas/[id]/page.tsx ← Entity editor
│   │   │   ├── compliance/page.tsx
│   │   │   ├── governance/page.tsx
│   │   │   ├── lineage/page.tsx
│   │   │   └── admin/
│   │   └── api/
│   │       ├── [...orpc]/route.ts
│   │       └── auth/[...nextauth]/route.ts
│   ├── components/ui/                ← Shadcn (Hex-themed)
│   ├── components/custom/            ← 8 custom components
│   ├── components/layout/            ← ActivityBar, Sidebar, StatusBar, RightPanel
│   ├── features/                     ← Feature-specific UI + logic
│   ├── services/                     ← Business logic (shared by oRPC routers)
│   ├── server/api/routers/           ← oRPC thin wrappers
│   ├── lib/compiler/                 ← ICompilerService + TypeSpec implementation + mock
│   ├── lib/type-mapping/             ← Translation policies + overrides
│   ├── emitters/                     ← Emitter plugins (bigquery, avro, openapi)
│   ├── types/schemas/                ← Shared Zod schemas
│   ├── types/models.ts               ← SuperSchemaModel, EmitterResult
│   └── hooks/                        ← Reusable React hooks
├── tests/
│   ├── unit/                         ← Vitest (mock compiler)
│   ├── integration/                  ← Vitest (real compiler + DB)
│   └── e2e/                          ← Playwright
├── tailwind.config.ts                ← Hex theme tokens
├── vitest.config.ts
└── playwright.config.ts
```

### Module Boundaries

| Module | Owns | Depends On | Never Touches |
|---|---|---|---|
| Schema Editor | Entity CRUD, fields, decorators | Compiler service | Governance decisions |
| Emission | Emitter execution, validation | Compiler, type mapping | Schema CRUD |
| Versioning | Version history, diff, migrations | Schema data (read) | Emission, governance |
| Governance | Approvals, impact analysis, notifications | Schema versions (read), RBAC | Schema CRUD |
| Compliance | Queries, gap detection, export | Schema + decorators (read) | Schema CRUD |
| Admin | Users, domains, emitters, config | Auth, config tables | Business logic |
| Compiler | TypeSpec compilation, IR generation | TypeSpec npm package | DB, UI, auth |
| Emitters | Target code generation + validation | SuperSchemaModel, policies | DB, compiler internals |
| Git | Export to Git repos | Schema + emitted output (read) | Schema CRUD |

## Architecture Validation

### Requirements Coverage: 77/77 FRs mapped ✅

All FRs map to architectural components. FR68-72 (AI Authoring) deferred to Phase 3 due to on-premise LLM constraint. FR73-77 (TypeSpec Authoring & Portability, added 2026-10-12) map to the TypeSpec Integration section above.

### NFR Validation: All covered ✅

UI reflects edit < 200ms (optimistic local state), compile/validate confirms < 2s P95 (synchronous compiler call, monitored), emission < 30s (synchronous pipeline), API < 500ms (oRPC direct), 50 users (connection pooling), 5,000 entities (PostgreSQL + `fields` projection indexing), encryption (TLS + disk), immutable audit (append-only trigger), zero external calls (Docker bundled), deterministic emission (emitter design), transactional ops (Prisma transactions), concurrency conflict detection (optimistic version check on `entities.version`), version readability (`entity_versions.typespec_source_snapshot` stored as plain text, not a serialized AST).

### Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| TypeSpec compile latency on save | **High** (was Medium — now gates *every* save, not just emission) | Monitor P95. Async/optimistic-UI fallback if > 2s. Surgical AST splice instead of whole-document reparse keeps typical edits small. |
| Concurrent edits to the same entity | High (new 2026-10-12) | Optimistic version check rejects the second writer with a conflict response. No merge/CRDT in MVP — explicit accepted limitation. |
| `@typespec/compiler` version upgrades | High (new 2026-10-12) | TypeSpec is now load-bearing storage, not a disposable export step. Pin compiler version; test upgrades against a corpus of stored entities before rolling out; historical `entity_versions` snapshots are plain text and remain readable even if a newer compiler can't recompile them. |
| Governance decorator package completeness | Medium (new 2026-10-12) | `@superschema/typespec-enterprise` covers classification/PII/retention/anonymization/quality/lineage/precision today; Avro/Protobuf binding decorators and `operationalHints`/`evolution` categories are a tracked follow-on, not yet built as of 2026-10-12. |
| Emitter correctness | High | Syntactic validators. Manual testing MVP. Database-DDL targets now lean on real upstream TypeSpec emitter packages (Spanner/BigQuery/Postgres/MySQL/Oracle/Iceberg/Parquet), reducing custom-emitter surface area versus the original plan. |
| Auth.js v5 beta | Medium | Pin version. Monitor stable release. |
| Connection exhaustion | Medium | PgBouncer. Admin monitoring. |
