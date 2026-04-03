---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - '_bmad-output/planning-artifacts/prd.md'
  - '_bmad-output/planning-artifacts/architecture.md'
  - '_bmad-output/planning-artifacts/ux-design-specification.md'
---

# Super Schema - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Super Schema, decomposing the requirements from the PRD, UX Design, and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: Data modelers can create new entity schemas through a visual UI, defining fields with types, precision, and scale
FR2: Data modelers can assign decorator metadata to each field across all 8 categories (structure, semantics, classification, policy, quality, lineage, operational hints, evolution)
FR3: The system enforces completeness at authoring time — fields cannot be saved without required metadata (e.g., precision/scale for decimal, classification for every field)
FR4: Data modelers can edit existing entity schemas, modifying fields, types, and decorator metadata
FR5: Data modelers can browse and search across all entity schemas in the system
FR6: Data modelers can define nested/complex types and entity relationships
FR7: Data modelers can set field aliases to address naming drift across systems
FR8: Data modelers can assign permanent field numbers for Protobuf compatibility
FR9: Data modelers can retire/deprecate entities and fields with replacement references
FR10: The system can emit implementation-specific schemas from a logical entity definition to multiple target formats simultaneously
FR11: Data modelers can preview emitted output for all selected targets side by side before committing
FR12: The system validates emitted schemas syntactically within the platform (Avro validates against spec, DDL parses, JSON Schema validates, OpenAPI passes linting)
FR13: The system surfaces type mapping mismatches and emission issues clearly to the user
FR14: Data stewards can create governed overrides for type mapping mismatches with audit trail
FR15: The system maintains configurable, versionable type translation policies between the logical schema and each emitter target
FR16: The system maintains version history for every entity schema
FR17: Data modelers can compare any two versions of an entity with a structured field-level diff
FR18: The system generates change records documenting what changed between versions
FR19: The system auto-generates migration artifacts for schema changes (ALTER statements for DDL targets, evolution compatibility reports for Avro/Protobuf)
FR20: Data modelers can view the change history and audit trail for any entity
FR21: Data engineers can import existing schemas (Avro files, DDL, Protobuf definitions) via bulk import
FR22: The system can map imported schemas to logical entity definitions with AI-assisted field matching and confidence scores
FR23: The system detects drift between logical entity definitions and registered implementation schemas
FR24: The system generates drift reports showing field-level differences between logical and implementation schemas
FR25: The system classifies schema changes by type (non-breaking addition, breaking type change, field removal, classification change) and routes to appropriate approval workflow
FR26: Non-breaking changes can be auto-approved per configurable policy
FR27: Breaking changes trigger approval requests to data stewards and impacted team leads
FR28: The system generates change impact reports showing per-target compatibility and affected downstream consumers
FR29: The system supports per-target staged emission — a change can be emitted to some targets while held for others pending approval
FR30: Compliance officers can query all entities and fields by classification, policy, retention, and target system
FR31: Compliance officers can identify gaps (e.g., PII fields without anonymization policy) through filtered queries
FR32: The system can export compliance reports as auditable artifacts
FR33: Users can add inline annotations and tag other users on entities and fields
FR34: The system maintains an immutable audit trail of all schema changes, overrides, approvals, and governance decisions
FR35: The system tracks which emitted schema versions are deployed or staged to which target systems
FR36: Data engineers can view deployment status across all targets for any entity
FR37: The system reports drift status for each registered implementation against the current logical version
FR38: Administrators can deploy the system via container images to on-premise infrastructure
FR39: Administrators can configure authentication — local user management with email/password, Google (Gmail) sign-in, and enterprise SSO via SAML 2.0 / OIDC
FR40: Administrators can define user roles and permissions (schema authors, data stewards, compliance officers, read-only viewers)
FR41: Administrators can enable/disable emitter targets and configure target-specific type mapping policies
FR42: Administrators can create and manage domain workspaces for multi-team organizations
FR43: Administrators can monitor system health, active users, schema counts, emission frequency, and validation error rates
FR44: The system supports zero-downtime configuration changes (emitter enable/disable, policy updates)
FR45a: Administrators can define custom classification levels beyond system defaults (PII, SENSITIVE, INTERNAL, PUBLIC) — the classification taxonomy is extensible per organization
FR45b: Administrators can define domain-level policy templates with default classifications, retention policies, quality rules, and naming conventions that entities within the domain inherit
FR45c: Domain-level policy inheritance is flattened explicitly into each entity — any consumer of the entity sees the full policy without chasing domain references
FR55: Schema definitions can be exported to and synchronized with a Git repository as version-controlled files
FR56: Schema changes can flow through Git pull requests — the system provides PR-based change review with compatibility reports and impact analysis as PR comments
FR57: The system supports Git as a distribution mechanism — emitted schemas are committed to configured Git repositories for downstream consumption
FR58: The system reconciles changes made through the UI with the Git-synchronized representation — the UI and Git stay in sync with conflict detection
FR59: The system provides in-app notifications for governance workflow events (approval requests, change completions, drift alerts, comments/tags)
FR60: Users can view their notification history and mark notifications as read/acknowledged within the UI
FR61: Notifications are persisted in the database with full history for audit purposes
FR62: The notification system is extensible to support future external integrations (Slack, email) via the webhook infrastructure
FR63: External systems can access schema definitions, validation, compatibility checking, and emission through a versioned RESTful API
FR64: CI/CD pipelines can submit schema changes for validation and receive structured pass/fail responses with detailed compatibility reports
FR65: The API can trigger emission of updated schemas to specified targets
FR66: The system supports webhook endpoints for external integrations to consume governance workflow events
FR67: The API maintains backward compatibility within major versions
FR68: Data modelers can create entity schemas from natural language descriptions (e.g., "a customer entity with PII financial fields for a fintech")
FR69: The system suggests fields, types, and decorator metadata based on entity name and domain context
FR70: AI-assisted bulk import proposes logical schema mappings for existing schemas with confidence scores for review
FR71: Data modelers can reference schema standards (schema.org, domain-specific standards) as a basis for creating new entities
FR72: Data modelers can review existing entity schemas against referenced domain standards to identify gaps, missing fields, or deviations

### NonFunctional Requirements

NFR1: Schema authoring UI interactions (field add, edit, decorator change): under 200ms response
NFR2: Emission pipeline (entity → emitted schemas for 3 targets): under 30 seconds
NFR3: Schema list and browse (up to 1,000 entities): under 2 seconds
NFR4: Schema diff and change record generation: under 5 seconds
NFR5: Compliance queries across full entity corpus: under 10 seconds
NFR6: API validation and compatibility check responses: under 500ms
NFR7: Concurrent user support: at least 50 users without performance degradation
NFR8: All data at rest encrypted (schema definitions, metadata, audit trails, governance records)
NFR9: All data in transit encrypted via TLS 1.2+
NFR10: Authentication: local user management with email/password, Google sign-in, and enterprise SSO via SAML 2.0 / OIDC
NFR11: RBAC enforced at entity, domain/workspace, and system level
NFR12: Immutable audit trail — no user (including administrators) can modify or delete audit records
NFR13: Zero external calls at runtime — no data leaves the deployment perimeter
NFR14: API access authenticated and authorized per the same RBAC model as UI
NFR15: Schema metadata with classifications (PII, SENSITIVE) handled with same security controls as classified data
NFR16: Enterprise-scale repositories: up to 5,000 entities across 50+ domains without architecture changes
NFR17: Emission pipeline scales to 15+ emitter targets per entity without linear performance degradation
NFR18: Up to 500 users across multiple teams and domains
NFR19: Schema version history retained indefinitely without impacting performance
NFR20: Emitter plugin architecture supports adding new targets without modifying core code
NFR21: Data integrity for all schema definitions, version history, and audit trails — no silent data loss
NFR22: Deterministic emitter output — same input always produces same output
NFR23: Graceful handling of TypeSpec compilation failures — clear error messages without corrupting state
NFR24: Transactional database operations — schema saves, version creation, and emission succeed or fail atomically
NFR25: Recovery from container restarts without data loss or inconsistent state
NFR26: RESTful API conforms to OpenAPI 3.0 with published, versioned documentation
NFR27: API backward compatibility guaranteed within major versions
NFR28: Emitter plugin interface follows semantic versioning with published stability contract
NFR29: Webhook payloads use documented, versioned schema for governance events
NFR30: Standard container orchestration support (Docker, Kubernetes)

### Additional Requirements

- **Starter Template:** `create-next-app` (official Next.js 16.2 scaffolding) + Shadcn/ui + Docker — clean baseline, manually adding Prisma, oRPC, Auth.js. Replaces T3 starter (stale, Next.js 15, bundled tRPC)
- **Unified API layer:** oRPC for BOTH UI ↔ server communication (type-safe RPC) AND external/CI/CD access (auto-generated OpenAPI spec from same router) — eliminates need for separate REST API routes
- **Service layer pattern:** Shared business logic in `src/services/`, thin oRPC router wrappers — single source of truth for logic
- **Result type pattern:** Service functions return `Result<T, E>` (never throw) — standardized error shape with `suggestedFix`, leveraging oRPC's end-to-end typesafe errors
- **Compiler service interface:** `ICompilerService` with compile/emit/validate methods — interface + mock pattern for testability
- **Emitter intermediate model:** Emitters receive `SuperSchemaModel` (not TypeSpec internals) — decouples emitters from TypeSpec IR
- **Synchronous compilation on save:** TypeSpec compilation stays in critical path — user must see errors immediately
- **Git sync MVP scope:** Export-only (database is source of truth) — bidirectional sync deferred to Phase 2
- **JSONB validation:** Zod schemas on every JSONB write — non-negotiable data integrity layer
- **Connection pooling:** Prisma connection pool + PgBouncer for 50 concurrent users
- **Hybrid relational + JSONB storage:** Core entity/field data relational, decorator metadata as validated JSONB
- **Audit trail enforcement:** Every write operation wrapped in `withAudit()`, append-only with DB-level trigger preventing UPDATE/DELETE
- **Docker composition:** 2 containers (app + PostgreSQL) — no Redis, no message queue for MVP
- **Testing strategy:** Vitest (unit + integration), Playwright (E2E), Zod (runtime validation)
- **Auth stack:** Auth.js v5 + Prisma adapter + BoxyHQ SAML Jackson for SSO
- **RBAC implementation:** Role + domain checked in oRPC middleware on every procedure; Next.js middleware protects routes
- **oRPC replaces tRPC:** End-to-end typesafe errors, built-in OpenAPI generation, native type support (no superjson), built-in plugins (CORS, CSRF), OpenTelemetry integration
- **OpenAPI auto-generation:** oRPC's `@orpc/openapi` generates OpenAPI 3.0 spec directly from router definitions — external API docs are a byproduct, not manual work

### UX Design Requirements

UX-DR1: Implement Hex-inspired dark theme with obsidian background (#14141C), warm light text (#e3e1e4), amethyst (#A477B2) and rose-quartz (#F5C0C0) accents — full color token system in Tailwind config
UX-DR2: Implement frosted glass panel treatment — backdrop blur (12px), semi-transparent backgrounds (rgba(28,28,38,0.8)), inset shadows, gradient borders on active elements
UX-DR3: Implement VS Code-style three-column IDE layout — Activity Bar (48px icon-only left rail), Left Sidebar (240-320px resizable/collapsible domain/entity navigation), Center Panel (flex entity editor), Right Panel (320-480px resizable/collapsible detail/preview), Status Bar (24px bottom)
UX-DR4: Implement Top Bar (48px) — Logo, Cmd+K command palette search, notification bell with badge count, user avatar/menu
UX-DR5: Build SchemaFieldRow custom component — inline editing, type icon, classification badge, validation ring (green/amber/red), hover-to-reveal action menu, drag handle for reorder, monospace field names
UX-DR6: Build EmissionPreviewPanel custom component — multi-tab syntax-highlighted code viewer (Shiki/Prism for SQL, JSON, YAML, Protobuf), validation indicator per tab (checkmark/warning), copy button, diff toggle
UX-DR7: Build TypePickerGrid custom component — visual icon grid grouped by category (primitives, complex, temporal, etc.), search filter, presented in a Popover
UX-DR8: Build ValidationIndicator custom component — animated SVG ring (green=complete, amber=suggestion, red=error) with tooltip showing details, spring animation
UX-DR9: Build EntityCard custom component — tile view card showing entity name, field count, classification summary badges, emission target indicators, drift status
UX-DR10: Build LineageDAG custom component — interactive entity relationship graph using React Flow/d3, clickable nodes with popover inspect, cardinality edges
UX-DR11: Build NotificationCenter custom component — dropdown popover panel, notifications grouped by type, mark-as-read, action buttons to navigate to source
UX-DR12: Build DiffViewer custom component — structured field-level diff with before/after columns, color-coded rows (green=added, red=removed, amber=modified), change highlighting
UX-DR13: Implement Command Palette (Cmd+K) — sections for Recent, Entities, Fields, Actions; arrow key + Enter navigation; search across all entity names, field names, and actions
UX-DR14: Implement field name autocomplete from domain standards (schema.org, HL7/FHIR), same-domain entity fields, and common patterns (id, created_at, status)
UX-DR15: Implement type auto-suggestion based on field name patterns — amount→decimal with precision prompt, email→string with format rule, created_at→timestamp, is_active→boolean, status→enum
UX-DR16: Implement classification auto-suggestion based on field semantics — email/phone/ssn→PII, password/token/secret→SENSITIVE, amount/balance→SENSITIVE
UX-DR17: Implement entity-level progress bar showing field completion percentage (X of Y fields complete) with per-field validation ring status
UX-DR18: Implement live emission preview — right panel updates emitted output in real-time as user edits fields (debounced 1s), no explicit "preview" action needed
UX-DR19: Implement tile/list view toggle for entity browsing — tile view (EntityCards) and list view (sortable DataTable with name, domain, version, last modified, emission status, drift)
UX-DR20: Implement keyboard shortcuts — Ctrl+N (new entity), Ctrl+S (save), Ctrl+E (emit), Tab (next field/suggestion), Enter (accept/expand), Escape (close/dismiss), "/" (slash command field creation)
UX-DR21: Implement slash command field creation — "/" triggers type picker inline (/string, /decimal, /enum, /ref), Notion-style
UX-DR22: Implement hover-to-reveal pattern — field row action menus (duplicate, delete, move) visible only on hover, clean at rest
UX-DR23: Implement decorator detail panel — right panel with tabbed categories (Structure, Semantics, Classification, Policy, Quality, Lineage, Operational, Evolution) using progressive disclosure
UX-DR24: Implement domain policy inheritance indicators — inherited values shown with "↳ Inherited from [Domain]" badge, editing removes inheritance
UX-DR25: Customize all 14 Shadcn/ui components with Hex dark theme — custom color tokens, 12px border-radius, frosted glass treatment on panels/popovers
UX-DR26: Implement typography system — Inter/system-ui for UI, JetBrains Mono/Fira Code for code/data, defined type scale from 11px caption to 28px display
UX-DR27: Implement spacing system on 4px base unit — tokens from space-1 (4px) to space-10 (40px)
UX-DR28: Implement depth/surface system — 5 layers (Base, Surface 1, Surface 2, Glass, Overlay) with progressive shadow and blur
UX-DR29: Implement micro-animation system — panel expand (200ms), field hover (150ms), validation ring (300ms spring), toast slide-in (250ms spring), tab switch (150ms), all respecting prefers-reduced-motion
UX-DR30: Implement semantic classification badge colors — PII (warm red bg), SENSITIVE (amber bg), INTERNAL (blue bg), PUBLIC (green bg) with matching text colors
UX-DR31: Implement empty state patterns — "Create your first entity" + "Import existing schemas" for no entities, "Add your first field — type / for suggestions" for no fields, etc.
UX-DR32: Implement error handling UX patterns — inline validation (red ring + message, no modals), toast for API errors with retry, concurrent edit conflict dialog, "suggested fix" on all errors
UX-DR33: Implement responsive panel behavior — panels auto-collapse below 1280px, standard at 1280-1600px, comfortable at 1600-1920px, spacious above 1920px; drag-to-resize with double-click collapse; widths saved to localStorage
UX-DR34: Implement login/auth pages — centered frosted glass card, support for local email/password, Google sign-in, and SSO login flows

### FR Coverage Map

FR1: Epic 2 - Create entity schemas through visual UI
FR2: Epic 2 - Assign decorator metadata across 8 categories
FR3: Epic 2 - Enforce completeness at authoring time
FR4: Epic 2 - Edit existing entity schemas
FR5: Epic 2 - Browse and search entity schemas
FR6: Epic 2 - Define nested/complex types and relationships
FR7: Epic 2 - Set field aliases
FR8: Epic 2 - Assign permanent field numbers (Protobuf)
FR9: Epic 2 - Retire/deprecate entities and fields
FR10: Epic 3 - Emit to multiple target formats simultaneously
FR11: Epic 3 - Preview emitted output side by side
FR12: Epic 3 - Validate emitted schemas syntactically
FR13: Epic 3 - Surface type mapping mismatches
FR14: Epic 3 - Governed overrides for type mapping
FR15: Epic 3 - Configurable type translation policies
FR16: Epic 4 - Maintain version history
FR17: Epic 4 - Compare versions with structured diff
FR18: Epic 4 - Generate change records
FR19: Epic 4 - Auto-generate migration artifacts
FR20: Epic 4 - View change history and audit trail
FR21: Epic 9 - Bulk import existing schemas
FR22: Epic 9 + Epic 11 - AI-assisted field matching for imports (Story 9.1 deterministic + Story 11.4 AI-enhanced)
FR23: Epic 9 - Detect drift between logical and implementation schemas
FR24: Epic 9 - Generate drift reports
FR25: Epic 5 - Classify schema changes by type
FR26: Epic 5 - Auto-approve non-breaking changes per policy
FR27: Epic 5 - Breaking changes trigger approval requests
FR28: Epic 5 - Generate change impact reports
FR29: Epic 5 - Per-target staged emission
FR30: Epic 6 - Query entities by classification, policy, retention, target
FR31: Epic 6 - Identify compliance gaps through filtered queries
FR32: Epic 6 - Export compliance reports
FR33: Epic 6 - Inline annotations and user tagging
FR34: Epic 6 - Immutable audit trail
FR35: Epic 9 - Track emitted schema versions per target
FR36: Epic 9 - View deployment status across targets
FR37: Epic 9 - Drift status per registered implementation
FR38: Epic 1 - Deploy via container images
FR39: Epic 1 - Configure authentication (local, Google, SSO)
FR40: Epic 8 - Define user roles and permissions
FR41: Epic 8 - Enable/disable emitter targets and type mapping policies
FR42: Epic 2 (Story 2.1d) + Epic 8 (Story 8.2) - Domain selection UI (user-facing) + domain workspace admin management
FR43: Epic 8 - Monitor system health and metrics
FR44: Epic 8 - Zero-downtime configuration changes
FR45a: Epic 8 - Custom classification taxonomy
FR45b: Epic 8 - Domain-level policy templates
FR45c: Epic 8 - Domain policy inheritance flattening
FR55: Epic 10 - Export schema definitions to Git
FR56: Epic 10 - PR-based change review with compatibility reports
FR57: Epic 10 - Git as distribution mechanism for emitted schemas
FR58: Epic 10 - Reconcile UI and Git changes (MVP: export-only, conflict detection deferred to Phase 2 per Architecture decision)
FR59: Epic 7 - In-app notifications for governance events
FR60: Epic 7 - Notification history with read/acknowledged
FR61: Epic 7 - Notifications persisted in database
FR62: Epic 7 - Extensible notification system
FR63: Epic 3 - RESTful API for schema access, validation, emission
FR64: Epic 3 - CI/CD structured pass/fail responses
FR65: Epic 3 - API-triggered emission
FR66: Epic 7 - Webhook endpoints for governance events
FR67: Epic 3 - API backward compatibility within major versions
FR68: Epic 11 - Natural language entity creation
FR69: Epic 11 - Field/type/decorator suggestions
FR70: Epic 11 - AI-assisted bulk import mapping (Story 11.4)
FR71: Epic 11 - Reference schema standards
FR72: Epic 11 - Review entities against domain standards

## Epic List

### Epic 1: Project Bootstrap & Authentication
The application is deployable on-premise and users can register, log in (local/Google/SSO), and access the IDE-style workspace with the Hex-inspired dark theme.
**FRs covered:** FR38, FR39
**UX-DRs:** UX-DR1-4, UX-DR25-29, UX-DR33, UX-DR34
**Additional:** create-next-app (Next.js 16.2) + Prisma + oRPC + Auth.js + Shadcn/ui + Docker, design system foundation

### Epic 2: Schema Authoring & Management (11 stories)
Users land on a domain selection screen after login, choosing or creating a domain before managing entities. Data modelers can then create, edit, and browse entities within the selected domain with full field metadata across all 8 decorator categories. Autocomplete suggests field names, types, and classifications. Complex types, relationships, aliases, field lifecycle, and lineage visualization are supported.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR42
**UX-DRs:** UX-DR5, UX-DR7, UX-DR8, UX-DR9, UX-DR10, UX-DR13-17, UX-DR19-24, UX-DR30, UX-DR31, UX-DR32

### Epic 3: Schema Emission, Validation & API
Data modelers can emit schemas to Avro, BigQuery, and OpenAPI targets, preview output side-by-side with syntax highlighting, and see validation results. Type mapping policies are configurable with governed overrides. External systems can access schemas, validate, check compatibility, and trigger emission via versioned REST API (auto-generated from oRPC). Includes dedicated emitter test harness.
**FRs covered:** FR10, FR11, FR12, FR13, FR14, FR15, FR63, FR64, FR65, FR67
**UX-DRs:** UX-DR6, UX-DR18

### Epic 4: Schema Versioning & Change Management
Data modelers can track version history, compare any two versions with structured field-level diffs, view change records, and generate migration artifacts (ALTER statements, evolution compatibility reports).
**FRs covered:** FR16, FR17, FR18, FR19, FR20
**UX-DRs:** UX-DR12

### Epic 5: Governance & Change Workflows
The system classifies schema changes (breaking/non-breaking), routes approvals to data stewards and impacted team leads, generates change impact reports showing per-target compatibility, and supports per-target staged emission.
**FRs covered:** FR25, FR26, FR27, FR28, FR29

### Epic 6: Compliance & Audit
Compliance officers can query all entities by classification, policy, retention, and target system. Gap detection identifies missing policies. Reports are exportable as auditable artifacts. Users can add inline annotations and tag others. The system maintains an immutable audit trail of all changes, overrides, and governance decisions.
**FRs covered:** FR30, FR31, FR32, FR33, FR34

### Epic 7: Notifications & Webhooks
Users receive in-app notifications for governance workflow events (approval requests, change completions, drift alerts, comments/tags). Notification history is viewable with read/acknowledged status, persisted in the database. Webhook endpoints allow external integrations to consume governance events.
**FRs covered:** FR59, FR60, FR61, FR62, FR66
**UX-DRs:** UX-DR11

### Epic 8: Administration & Platform Management
Admins can manage users/roles (RBAC), create domain workspaces with policy templates, configure emitters and type mapping policies, monitor system health, and define custom classification taxonomies — all with zero-downtime.
**FRs covered:** FR40, FR41, FR42, FR43, FR44, FR45a, FR45b, FR45c
**UX-DRs:** UX-DR24

### Epic 9: Schema Registration & Deployment Tracking
Data engineers can import existing schemas (Avro, DDL, Protobuf) via bulk import, see drift detection between logical and implementation schemas, and track which emitted versions are deployed or staged across all target systems.
**FRs covered:** FR21, FR22, FR23, FR24, FR35, FR36, FR37

### Epic 10: Git-Native Workflow
Schema definitions and emitted output are exported to Git repositories as version-controlled files. PR-based change review with compatibility reports. (MVP: export-only; bidirectional sync deferred to Phase 2.)
**FRs covered:** FR55, FR56, FR57, FR58

### Epic 11: AI-Assisted Authoring (Phase 3) (4 stories)
Data modelers can create schemas from natural language, get field/type/decorator suggestions from domain context, reference industry standards (schema.org, HL7/FHIR), review entities against domain schemas for gaps, and get AI-enhanced import matching.
**FRs covered:** FR68, FR69, FR70, FR71, FR72

---

## Epic 1: Project Bootstrap & Authentication (5 stories)

The application is deployable on-premise via Docker and users can register, log in (local email/password, Google, SSO), and access the IDE-style workspace with the Hex-inspired dark theme. This epic establishes the project foundation, design system, application shell, and authentication system.

### Story 1.1: Project Scaffolding, Docker Environment & Test Infrastructure

As a **developer**,
I want the project scaffolded with all core dependencies, Docker composition, and test infrastructure configured,
So that the team has a runnable development environment with CI-ready testing from day one.

**Acceptance Criteria:**

**Given** no project exists yet
**When** the scaffolding is complete
**Then** the following project structure exists:
**And** Next.js 16.2 is initialized via `create-next-app` with TypeScript, Tailwind CSS, ESLint, and App Router
**And** the following dependencies are installed: `@orpc/server`, `@orpc/client`, `@orpc/react`, `@orpc/openapi`, `prisma`, `@prisma/client`, `next-auth@beta`, `@auth/prisma-adapter`, `@typespec/compiler`
**And** Shadcn/ui is initialized with default configuration
**And** the project directory structure follows the Architecture document layout (`src/app/`, `src/components/ui/`, `src/components/custom/`, `src/components/layout/`, `src/features/`, `src/services/`, `src/server/api/routers/`, `src/lib/`, `src/emitters/`, `src/types/schemas/`, `src/hooks/`, `tests/unit/`, `tests/integration/`, `tests/e2e/`)
**And** a `docker-compose.yml` exists with two services: `app` (Next.js on port 3000) and `db` (PostgreSQL 16 with persistent volume on port 5432)
**And** a `Dockerfile` exists for the app service with multi-stage build (deps → build → runtime)
**And** `.env.example` exists with all required environment variables (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`)
**And** `@t3-oss/env-nextjs` is configured in `src/env.ts` with validated environment variables
**And** Vitest is configured in `vitest.config.ts` with path aliases matching `tsconfig.json`, coverage reporter enabled, and a sample test in `tests/unit/sample.test.ts` that passes
**And** Playwright is configured in `playwright.config.ts` targeting Chromium with base URL `http://localhost:3000`, and a sample E2E test in `tests/e2e/sample.spec.ts` that verifies the app loads
**And** `npm run dev` starts the development server successfully
**And** `npm test` runs Vitest and all tests pass
**And** `docker compose up` builds and starts both containers, and the app is accessible at `http://localhost:3000`

---

### Story 1.2: Design System Foundation

As a **developer**,
I want the Hex-inspired dark theme design system implemented with all tokens, customized Shadcn/ui components, and foundational CSS utilities,
So that all subsequent UI work uses a consistent, polished visual foundation.

**Acceptance Criteria:**

**Given** the project is scaffolded (Story 1.1 complete)
**When** the design system is implemented
**Then** `tailwind.config.ts` defines the complete color token system: `background: #14141C`, `foreground: #e3e1e4`, `card: #1c1c26`, `popover: #22222e`, `primary: #A477B2`, `secondary: #F5C0C0`, `muted: #2a2a36`, `muted-foreground: #8a8694`, `accent: #3a3a48`, `border: #333340`, `destructive: #e55b5b`, `success: #5bc27a`, `warning: #e5a93b`, `info: #6ba3e8`
**And** semantic classification badge colors are defined: PII (`rgba(229,91,91,0.15)` bg / `#e55b5b` text), SENSITIVE (`rgba(229,169,59,0.15)` bg / `#e5a93b` text), INTERNAL (`rgba(107,163,232,0.15)` bg / `#6ba3e8` text), PUBLIC (`rgba(91,194,122,0.15)` bg / `#5bc27a` text)
**And** typography uses Inter/system-ui for UI text and JetBrains Mono/Fira Code for code/data elements, with the defined type scale (display 28px through mono-small 12px)
**And** spacing tokens are defined on 4px base unit (`space-1` through `space-10`)
**And** the depth/surface system is implemented with 5 layers: Base (#14141C), Surface 1 (#1c1c26 + shadow), Surface 2 (#22222e + deeper shadow), Glass (rgba with backdrop-blur 12px), Overlay (rgba with blur 4px)
**And** CSS custom properties exist for `--glass-bg`, `--glass-blur`, `--gradient-border`, `--field-complete`, `--field-suggestion`, `--field-error`, `--mono-size`, `--transition-spring`
**And** border-radius defaults to 12px globally
**And** micro-animation CSS utilities exist: panel expand (200ms ease-out), field hover (150ms ease-in-out), validation ring (300ms spring), toast slide-in (250ms spring), tab switch (150ms ease-in-out), with `prefers-reduced-motion` respected
**And** all 14 Shadcn/ui components (DataTable, Command, Tabs, Sheet, Popover, Select/Combobox, Badge, Toast, Dialog, Form, Tooltip, Accordion, DropdownMenu, Input) are customized with dark theme tokens, 12px border-radius, and frosted glass treatment where specified
**And** a unit test verifies that all color tokens are correctly defined in the Tailwind config
**And** a visual test page exists at `/dev/design-system` (dev-only route) that renders all customized Shadcn/ui components, badges, surfaces, and typography for visual verification

---

### Story 1.3: Application Shell & IDE Layout

As a **data modeler**,
I want the IDE-style application shell with Activity Bar, Sidebar, Center Panel, Right Panel, Top Bar, and Status Bar,
So that I have a professional workspace layout for schema management.

**Acceptance Criteria:**

**Given** the design system is implemented (Story 1.2 complete)
**When** an authenticated user navigates to the application
**Then** the layout renders with the following structure:
**And** a **Top Bar** (48px height) is displayed with: logo/app name on the left, a search input placeholder (Cmd+K visual only — command palette functionality deferred to Epic 2), a notification bell icon with badge placeholder, and a user avatar with dropdown menu (profile, logout)
**And** an **Activity Bar** (48px width, icon-only left rail) is displayed with navigation icons for: Schema Editor (default active), Lineage Graph, Governance Dashboard, Compliance, Admin — clicking each icon changes the active route and shows a gradient left border on the active item
**And** a **Left Sidebar** (240px default, resizable 240-320px, collapsible) is displayed with a placeholder tree view labeled "Domains & Entities" and a search input
**And** a **Center Panel** (flex: 1) is displayed as the main content area with an empty state message: "Create your first entity" with a call-to-action button
**And** a **Right Panel** (320px default, resizable 320-480px, collapsible) is displayed with placeholder content labeled "Detail Panel"
**And** a **Status Bar** (24px height) is displayed at the bottom with placeholder segments: domain indicator, validation count, schema version, sync status
**And** panels are resizable via drag handles and collapsible via double-click on the drag handle
**And** panel widths persist to `localStorage` and restore on page reload
**And** at viewport widths below 1280px, the Sidebar and Right Panel auto-collapse and a warning is shown
**And** at 1280-1600px, standard widths apply (sidebar 240px, right panel 320px)
**And** at 1600-1920px, comfortable widths apply (sidebar 280px, right panel 400px)
**And** at viewports above 1920px, spacious widths apply (sidebar 320px, right panel 480px) with max-width on center panel
**And** a Playwright E2E test verifies: the layout renders with all 6 sections visible at 1440px width, Activity Bar navigation switches the active route, sidebar collapses and expands, panel widths persist after reload
**And** a Playwright E2E test verifies: at 1200px width, sidebar and right panel auto-collapse

---

### Story 1.4: Local User Authentication

As a **user**,
I want to register with email/password and log in to access the application,
So that I can securely access my schema workspace.

**Acceptance Criteria:**

**Given** the application shell exists (Story 1.3 complete)
**When** the authentication system is implemented
**Then** a Prisma schema exists with `users`, `accounts`, `sessions`, and `verification_tokens` tables (Auth.js Prisma adapter schema), and the database migration runs successfully
**And** Auth.js v5 is configured with the Credentials provider (email + bcrypt-hashed password)
**And** a **Register page** (`/register`) exists with a centered frosted glass card containing: email input, password input (min 8 chars), confirm password input, "Create Account" primary button, and "Already have an account? Sign in" link
**And** a **Login page** (`/login`) exists with a centered frosted glass card containing: email input, password input, "Sign In" primary button, and "Don't have an account? Register" link
**And** registration creates a new user in the database with bcrypt-hashed password and redirects to the dashboard
**And** registration validates: email format, password minimum 8 characters, passwords match — showing inline error messages (red ring + message below input) for validation failures
**And** registration rejects duplicate email addresses with an error message "An account with this email already exists"
**And** login authenticates against stored credentials and redirects to the dashboard
**And** login shows an inline error message "Invalid email or password" for incorrect credentials (no distinction between wrong email vs wrong password)
**And** unauthenticated users are redirected to `/login` when accessing any dashboard route
**And** a user menu in the Top Bar shows the user's email and a "Sign Out" option that destroys the session and redirects to `/login`
**And** Next.js middleware protects all `/(dashboard)/*` routes, redirecting unauthenticated requests to `/login`
**And** an oRPC base context (`createRPCContext`) extracts the session from the request and makes it available to all procedures
**And** `publicProcedure` and `protectedProcedure` oRPC base procedures are defined — `protectedProcedure` throws `ORPCError('UNAUTHORIZED')` if no session exists
**And** integration tests verify: successful registration creates a user, duplicate email is rejected, login with valid credentials returns a session, login with invalid credentials fails, protected oRPC procedures reject unauthenticated requests
**And** a Playwright E2E test verifies the full flow: navigate to `/login` → click register link → fill registration form → submit → redirected to dashboard → sign out → redirected to login → sign in with created credentials → dashboard loads

---

### Story 1.5: Google & SSO Authentication

As an **enterprise user**,
I want to log in with my Google account or my company's SSO provider,
So that I can use my existing identity without creating a separate password.

**Acceptance Criteria:**

**Given** local authentication works (Story 1.4 complete)
**When** Google and SSO providers are configured
**Then** Auth.js is configured with the Google OAuth 2.0 provider using `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables
**And** BoxyHQ SAML Jackson is integrated for enterprise SSO (SAML 2.0 / OIDC) using `JACKSON_URL`, `SAML_AUDIENCE`, and `SAML_CALLBACK` environment variables
**And** all new environment variables are added to `src/env.ts` validation schema as optional (SSO and Google are opt-in)
**And** the **Login page** is updated to show provider buttons: "Continue with Google" (with Google icon) and "Continue with SSO" (with key/shield icon) — displayed above the email/password form with a divider labeled "or"
**And** the **Register page** shows the same provider buttons — OAuth/SSO flows create accounts automatically on first login
**And** Google sign-in opens the Google OAuth consent screen, and on successful auth, creates/links the user account and redirects to dashboard
**And** SSO sign-in redirects to the configured SAML/OIDC identity provider, and on successful auth, creates/links the user account and redirects to dashboard
**And** if Google or SSO environment variables are not configured, the corresponding button is hidden from the login/register pages (graceful degradation for on-premise deployments without Google/SSO)
**And** the `accounts` table links multiple auth providers to a single user — a user who registered with email can later link their Google account (same email) without creating a duplicate user
**And** integration tests verify: Google provider is registered when env vars are set, Google provider is absent when env vars are missing, SAML Jackson provider is registered when configured, mock OAuth callback creates a user session
**And** a Playwright E2E test verifies: login page shows Google button when configured, login page hides Google button when env var is missing, clicking Google button initiates OAuth flow (redirects to Google)

---

## Epic 2: Schema Authoring & Management

Users land on a domain selection screen after login, choosing or creating a domain before managing entities. Data modelers can then create, edit, and browse entities within the selected domain with full field metadata across all 8 decorator categories. Autocomplete suggests field names, types, and classifications. Complex types, relationships, aliases, and field lifecycle management are supported.

### Story 2.1: Database Schema, Zod Validation & Core Utilities

As a **developer**,
I want the database tables for entities, fields, and domains with Zod validation and audit infrastructure,
So that all schema authoring features have a solid data foundation.

**Acceptance Criteria:**

**Given** the project has Auth.js and Prisma configured (Epic 1 complete)
**When** the data model and core utilities are implemented
**Then** the Prisma schema defines the following tables with all columns from the Architecture document:
**And** `domains` table: `id` (cuid), `name` (unique string), `description` (text), `policyTemplate` (JSONB), `createdAt`, `updatedAt`
**And** `entities` table: `id` (cuid), `name` (string), `domainId` (FK to domains), `version` (int, default 1), `status` (enum: DRAFT, ACTIVE, DEPRECATED, RETIRED), `ownerId` (FK to users), `description` (text), `metadata` (JSONB), `createdAt`, `updatedAt` — with unique constraint on `(name, domainId)`
**And** `fields` table: `id` (cuid), `entityId` (FK to entities), `name` (string), `type` (string), `precision` (int, nullable), `scale` (int, nullable), `nullable` (boolean, default true), `isKey` (boolean, default false), `fieldNumber` (int, nullable), `description` (text), `aliases` (text[]), `classification` (string, nullable), `sortOrder` (int), `decorators` (JSONB), `createdAt`, `updatedAt` — with unique constraint on `(entityId, name)`
**And** `audit_log` table: `id` (cuid), `action` (string), `entityType` (string), `entityId` (string), `userId` (FK to users), `timestamp` (datetime, default now), `beforeState` (JSONB, nullable), `afterState` (JSONB, nullable) — append-only with a PostgreSQL trigger that prevents UPDATE and DELETE operations on this table
**And** `domains` table includes an `isSystem` (boolean, default false) column to mark system-seeded domains that cannot be deleted by users
**And** Prisma migration runs successfully and creates all tables
**And** a database seed script (`prisma/seed.ts`) creates two default system domains: **"Public"** (description: "Shared domain for general-purpose entities accessible to all users", isSystem: true) and **"Playground"** (description: "Sandbox domain for developers to experiment with entity creation", isSystem: true) — these domains are created idempotently (skip if already exist)
**And** a Zod schema (`DecoratorSchema`) is defined in `src/types/schemas/decorator.schema.ts` matching the Architecture document's decorator structure (structure, semantics, classification, policy, quality, lineage, operationalHints, evolution) — all categories optional with `.partial()`
**And** a Zod schema (`EntityMetadataSchema`) is defined for entity metadata JSONB validation
**And** a `withAudit()` utility function exists in `src/lib/audit.ts` that wraps any Prisma write operation and inserts a corresponding row into `audit_log` with before/after state — every write must go through this
**And** a `Result<T, E>` type is defined in `src/types/result.ts` with `{ success: true; data: T } | { success: false; error: E }` and a `ServiceError` type with `{ code: string; message: string; details?: object; suggestedFix?: string }`
**And** unit tests verify: Prisma migration creates all tables, Zod DecoratorSchema rejects invalid structures (missing required nested fields, wrong types), Zod EntityMetadataSchema validates correctly, `withAudit()` creates audit_log entries with correct before/after state, the PostgreSQL trigger prevents UPDATE/DELETE on audit_log rows

---

### Story 2.1b: Entity & Domain Service Layer with oRPC Routers

As a **developer**,
I want service functions and oRPC routers for domain and entity CRUD operations,
So that the UI can create, read, update, and delete domains and entities.

**Acceptance Criteria:**

**Given** the database schema and core utilities exist (Story 2.1 complete)
**When** the domain and entity service layers are implemented
**Then** `src/services/domain.service.ts` exports: `createDomain(input, ctx): Result<Domain>`, `getDomains(ctx): Result<Domain[]>`, `getDomainById(id, ctx): Result<Domain>`
**And** `src/services/entity.service.ts` exports: `createEntity(input, ctx): Result<Entity>`, `getEntities(filters, ctx): Result<Entity[]>`, `getEntityById(id, ctx): Result<Entity>`, `updateEntity(id, input, ctx): Result<Entity>`, `deleteEntity(id, ctx): Result<void>`
**And** every service function validates JSONB inputs (metadata, policyTemplate) with the corresponding Zod schema before writing — invalid JSONB returns a `Result` error with `suggestedFix`
**And** every service write operation uses `withAudit()` — no direct Prisma writes bypass audit logging
**And** oRPC routers exist in `src/server/api/routers/` for `domain` and `entity` — each router is a thin wrapper calling the corresponding service function via `protectedProcedure`
**And** unit tests verify: domain CRUD operations return correct Result types, entity CRUD operations return correct Result types, duplicate entity name within same domain returns error, Zod validation rejects invalid metadata JSONB
**And** integration tests verify: full entity lifecycle (create → read → update → delete) with database, audit_log contains entries for all write operations

---

### Story 2.1c: Field Service Layer with oRPC Router

As a **developer**,
I want service functions and an oRPC router for field CRUD and reordering,
So that the UI can manage fields within entities.

**Acceptance Criteria:**

**Given** the domain and entity services exist (Story 2.1b complete)
**When** the field service layer is implemented
**Then** `src/services/field.service.ts` exports: `createField(entityId, input, ctx): Result<Field>`, `updateField(id, input, ctx): Result<Field>`, `deleteField(id, ctx): Result<void>`, `reorderFields(entityId, fieldIds, ctx): Result<void>`
**And** every field service function validates decorator JSONB with the DecoratorSchema before writing — invalid decorators return a `Result` error with `suggestedFix`
**And** every field service write operation uses `withAudit()`
**And** an oRPC router exists in `src/server/api/routers/field.ts` — thin wrapper calling field service functions via `protectedProcedure`
**And** `reorderFields()` updates the `sortOrder` column for all specified fields in a single transaction
**And** `createField()` sets `sortOrder` to the next available value (max existing sortOrder + 1)
**And** unit tests verify: field CRUD operations return correct Result types, decorator Zod validation rejects invalid structures, reorderFields updates sortOrder correctly, duplicate field name within same entity returns error
**And** integration tests verify: full field lifecycle (create → update → reorder → delete) with database, audit_log contains entries for all field operations

---

### Story 2.1d: Domain Selection & Management UI

As an **administrator**,
I want a domain management landing page with a card grid where I can view, create, and select domains,
So that logical entities are always organized under a domain and users start their workflow by choosing a domain context.

**Acceptance Criteria:**

**Given** the domain service layer and database schema exist (Stories 2.1–2.1c complete)
**When** the domain management UI is implemented
**Then** navigating to `/schemas` (the main entry point after login) renders a **Domain Selection page** showing all domains as a responsive card grid in the center panel
**And** each domain card displays: domain name (heading), description (truncated to 2 lines), logical entity count badge, created date, and a status indicator — system domains show a "System" badge; custom domains show the creator's name
**And** the two seeded system domains (**Public** and **Playground**) always appear first in the grid, visually distinguished with a subtle border accent (e.g., primary color border for Public, secondary for Playground)
**And** the **Playground** domain card includes a tagline: "Experiment freely — create test entities without affecting production domains"
**And** only users with **Admin** role see a **"+ Create Domain"** button in the page header — clicking it opens a dialog/modal with: name (required, unique, validated on blur), description (textarea), and a "Create" button
**And** domain creation validates: name is unique (checked against the server), name is non-empty, name follows a slug-friendly format (alphanumeric, hyphens, spaces allowed, max 64 chars)
**And** the **Left Sidebar** displays an **explorer-style tree hierarchy** (like VS Code's file explorer) showing all domains as top-level collapsible folders with their logical entities as child items underneath:
```
▾ Public (3)
    Customer
    Order
    Product
▾ Playground (1)
    TestEntity
▸ Payment (0)
```
**And** each domain node in the tree shows: folder icon, domain name, entity count badge; clicking a domain in the tree navigates to `/schemas/{domain-slug}` and expands/collapses the domain's entity list
**And** each logical entity node in the tree shows: entity name (monospace), colored dot for status (green=ACTIVE, amber=DRAFT, gray=DEPRECATED); clicking an entity navigates to `/schemas/{domain-slug}/{entityId}`
**And** right-clicking a domain node in the tree shows a context menu with: "New Entity" (opens inline input or popover to create a logical entity in that domain), and for Admin users: "Edit Domain", "Delete Domain" (disabled if domain has entities or is a system domain)
**And** a **"+ New Entity"** action is available via: (1) right-click context menu on a domain in the sidebar tree, (2) a "+" icon button on hover of a domain node — both create a new logical entity within that domain
**And** a **search input** at the top of the sidebar filters domains and entities by name across the entire tree in real-time (< 200ms) — matching text is highlighted, non-matching branches are hidden
**And** clicking a domain card in the center panel navigates to `/schemas/{domain-slug}` — the domain slug is derived from the domain name (lowercased, spaces to hyphens)
**And** the `/schemas/{domain-slug}` route renders the entity workspace scoped to the selected domain — the center panel shows entity list/tile views; the sidebar tree auto-expands the selected domain
**And** the **TopBar** or a breadcrumb bar shows the current domain context: "Domains" (link to `/schemas`) → "{Domain Name}" — providing navigation context and a quick way back to the domain grid
**And** the **StatusBar** domain indicator (already present) reflects the currently selected domain name
**And** system domains (isSystem: true) cannot be deleted — the delete option is hidden for system domains
**And** admin users can delete custom (non-system) domains only if they contain **zero logical entities** — attempting to delete a domain with entities shows: "Cannot delete — {count} entities exist in this domain. Move or delete them first."
**And** the domain selection page includes a **search/filter bar** at the top of the center panel card grid to filter domains by name as the user types
**And** if there are only the default domains (e.g., fresh install with Public and Playground), the page still shows the card grid — no auto-redirect
**And** the page uses the project's existing design system: `surface-glass` cards, `text-heading-2` for names, `text-body-small` for descriptions, `badge` component for entity counts, and `animate-auth-fade-up` for entrance animation
**And** unit tests verify: domain cards render with correct data, sidebar tree renders domain→entity hierarchy, search filter works across tree, create domain dialog validates inputs, admin-only create button visibility, right-click context menu actions
**And** a Playwright E2E test verifies: user logs in → sees domain grid + sidebar tree → clicks a domain card → navigates to `/schemas/{slug}` → sidebar auto-expands domain → clicks breadcrumb → returns to domain grid; admin creates a new domain via header button → it appears in grid and tree; user right-clicks domain in tree → creates a new logical entity

---

### Story 2.2: Entity Browsing within Domain — Tile/List Views & Implemented Schemas

As a **data modeler**,
I want to browse and search logical entities within the selected domain with tile and list view options, and see implemented schemas when viewing an entity,
So that I can quickly find any logical entity and understand its implementation state across targets.

**Acceptance Criteria:**

**Given** the domain selection UI and sidebar explorer tree exist (Story 2.1d complete)
**When** the entity browsing UI is implemented
**Then** navigating to `/schemas/{domain-slug}` renders the **center panel** with a list of logical entities in the selected domain, with a **tile/list toggle** button in the top-right
**And** **Tile view** displays EntityCard components in a responsive grid — each card shows: logical entity name, field count, classification summary badges (count of PII/SENSITIVE/INTERNAL/PUBLIC fields), status badge, version number, last modified date
**And** **List view** displays a DataTable with sortable columns: Name, Version, Status, Fields, Last Modified — clicking a column header sorts ascending/descending with sort indicator
**And** the tile/list toggle state persists to localStorage and restores on reload
**And** clicking a logical entity (in tile/list view or in the sidebar tree) navigates to `/schemas/{domain-slug}/{entityId}` — the **logical entity detail page**
**And** the logical entity detail page shows the entity editor (fields, decorators, metadata) in the center panel
**And** the logical entity detail page includes an **"Implemented Schemas"** section (below or as a tab alongside the field editor) that lists all emitted/registered implementation schemas for this logical entity — showing: target format (Avro, BigQuery, OpenAPI, etc.), emitted version, validation status (pass/fail badge), last emitted date, and a link to view the emitted output
**And** if no implemented schemas exist for the entity, the section shows: "No implementations yet — emit this entity to generate target schemas" with an "Emit" action button
**And** a **breadcrumb bar** is displayed above the center panel: "Domains" (link to `/schemas`) → "{Domain Name}" (link to `/schemas/{domain-slug}`) → "{Entity Name}" (when viewing an entity)
**And** the sidebar tree highlights the currently selected domain and entity — the selected domain is auto-expanded
**And** creating a new logical entity (via sidebar context menu, "+" hover button, or a "New Entity" button in the center panel empty state) navigates to the new entity's editor within the current domain
**And** an **empty state** is displayed when the domain has no logical entities: illustration, "Create your first logical entity" heading, "Get started by defining your first logical entity in {domain name}" description, and a primary "Create Entity" button
**And** the entity list fetches data via oRPC using TanStack Query with stale-while-revalidate caching, filtered by the current domain ID from the URL
**And** a Playwright E2E test verifies: user selects domain → center panel shows entities, sidebar tree shows entities under domain → tile/list toggle works and persists → clicking an entity navigates to entity detail → "Implemented Schemas" section is visible → breadcrumb navigates back → empty state displays when domain has no entities → creating entity from sidebar and from empty state both work

---

### Story 2.3: Schema Field Editor — Create, Edit, Delete Fields

As a **data modeler**,
I want to create, edit, and delete fields on an entity using an inline grid editor,
So that I can define the structure of my data entities visually.

**Acceptance Criteria:**

**Given** entity browsing and navigation work (Story 2.2 complete)
**When** a user navigates to an entity editor view (`/schemas/[id]`)
**Then** the **Center Panel** displays the entity header with: entity name (editable inline), domain badge, version number, status badge, and entity description (editable inline)
**And** below the header, a **field grid** (Airtable-style DataTable) displays all fields with columns: drag handle (hover-reveal only), Name (monospace, inline-editable), Type (icon + label), Classification (badge), Key (icon indicator), Description (truncated, inline-editable)
**And** clicking the **"+ Add Field"** button at the bottom of the grid (or pressing "/" anywhere) adds a new empty field row at the bottom with the name input focused
**And** field **Name** is inline-editable — clicking the name cell enters edit mode with a monospace text input; pressing Enter or Tab confirms the edit; pressing Escape cancels
**And** field **Type** is selectable — clicking the type cell opens the **TypePickerGrid** popover: a visual icon grid grouped by category (Primitives: string, integer, decimal, boolean, float; Temporal: date, time, datetime, timestamp; Complex: enum, array, map, object; Special: reference), with a search filter at the top; selecting a type closes the popover and updates the cell
**And** when **decimal** type is selected, a precision/scale prompt appears inline (two number inputs) — both are required and must be filled before the type is confirmed
**And** when **enum** type is selected, a values editor appears — a tag-style input where the user types values and presses Enter to add each one
**And** field **Classification** is selectable — clicking the badge opens a dropdown with options: PII (red badge), SENSITIVE (amber badge), INTERNAL (blue badge), PUBLIC (green badge), and any custom classifications; selecting one updates the badge
**And** field **Key** toggle — clicking the key icon cell toggles `isKey` between true/false with visual indicator change
**And** **Hover-to-reveal actions** — hovering over a field row reveals a "..." menu icon on the right edge; clicking it opens a DropdownMenu with: Duplicate (copies field with "field_name_copy" name), Move Up, Move Down, Delete (with red text)
**And** **Drag-to-reorder** — the drag handle (visible on hover) allows dragging field rows to reorder them; the new order is saved to `sortOrder` via the field service
**And** **Delete confirmation** — deleting a field shows a destructive Dialog: "Delete field '{name}'? This cannot be undone." with Cancel (ghost) and Delete (destructive) buttons
**And** all field changes are saved automatically via oRPC mutation (debounced 500ms after last edit) — the Status Bar shows "Saving..." during save and "Saved" with a checkmark on success
**And** a Playwright E2E test verifies: adding a field, editing name/type/classification, deleting a field, drag-to-reorder, duplicate field, decimal type prompts for precision/scale

---

### Story 2.4: Decorator Detail Panel — 8-Category Tabbed Editing

As a **data modeler**,
I want to edit all 8 decorator categories for a field in a tabbed right panel,
So that I can fully describe each field's metadata without leaving the editor view.

**Acceptance Criteria:**

**Given** the field editor works (Story 2.3 complete)
**When** a user clicks on a field row in the grid
**Then** the **Right Panel** updates to show the decorator detail panel for that field — the panel title shows the field name in monospace
**And** the panel has **8 tabs** corresponding to decorator categories, displayed as pill-style tabs with gradient active indicator:
**And** **Structure tab**: nullable toggle (boolean), isKey toggle, fieldNumber input (integer, optional), with tooltips explaining each option
**And** **Semantics tab**: description textarea, aliases tag input (type + Enter to add, click X to remove), glossary terms tag input
**And** **Classification tab**: classification level dropdown (PII, SENSITIVE, INTERNAL, PUBLIC, custom levels), custom level text input (when "Custom" selected)
**And** **Policy tab**: retention period dropdown (30 days, 90 days, 1 year, 3 years, 5 years, 7 years, indefinite, custom), anonymization method dropdown (none, hash, mask, redact, pseudonymize), encryption dropdown (none, AES-256, field-level)
**And** **Quality tab**: quality rules list — each rule has a type dropdown (range, regex, not_null, unique, enum_values, min_length, max_length, custom) and params form that adapts to the rule type; "Add Rule" button appends a new rule; rules can be removed individually
**And** **Lineage tab**: source text input, upstream references tag input (entity.field format, with autocomplete from existing entities), downstream references tag input
**And** **Operational Hints tab**: partition toggle, index toggle, cluster toggle — with descriptive labels and tooltips for each
**And** **Evolution tab**: deprecated toggle, since date input (date picker), replacement reference input (entity.field format with autocomplete)
**And** all tab inputs use react-hook-form with the Zod DecoratorSchema for validation — invalid inputs show inline red ring + error message
**And** changes in any tab are saved automatically via oRPC mutation (debounced 500ms) — updating the `decorators` JSONB column on the field record
**And** when a different field is clicked in the grid, the right panel updates to show that field's decorators — the previously edited field's changes are saved before switching
**And** if a domain has a policyTemplate, inherited values are pre-populated in the Classification, Policy, and Quality tabs with an "↳ Inherited from [Domain Name]" badge — editing a value removes the inheritance indicator
**And** unit tests verify: DecoratorSchema validation rejects invalid structures, each decorator category saves correctly to JSONB, inherited values are correctly populated from domain template
**And** a Playwright E2E test verifies: clicking a field opens the detail panel, switching tabs shows correct content, editing a decorator value saves successfully, switching fields updates the panel, inherited values display correctly

---

### Story 2.5: Completeness Enforcement & Validation Indicators

As a **data modeler**,
I want real-time visual feedback on field completeness and validation status,
So that I know exactly what metadata is missing and can achieve full schema quality.

**Acceptance Criteria:**

**Given** the field editor and decorator panel work (Stories 2.3-2.4 complete)
**When** completeness enforcement is implemented
**Then** each field row in the grid displays a **ValidationIndicator** — an animated SVG ring on the left edge of the row:
**And** **Green ring** — field is complete: all required metadata filled (name, type, classification at minimum)
**And** **Amber ring** — field has pending suggestions: optional decorators that have auto-suggested values not yet reviewed by the user
**And** **Red ring** — field is missing required metadata: name empty, type not selected, or classification not set
**And** hovering over the ValidationIndicator shows a **Tooltip** listing what's missing or pending — e.g., "Missing: classification" or "Suggestion: classification → PII (based on field name 'email')"
**And** the ring animation uses spring easing (300ms) and transitions between colors smoothly; `prefers-reduced-motion` disables the spring and uses opacity fade only
**And** an **entity-level progress bar** is displayed above the field grid: "X of Y fields complete" with a percentage — the bar fills with success green color
**And** the progress bar counts a field as "complete" when it has: name, type, and classification all set (minimum required metadata per FR3)
**And** **Type-specific required fields** are enforced: decimal type requires precision AND scale — selecting decimal without filling both shows a red ring with tooltip "Missing: precision, scale"; enum type requires at least one value defined
**And** the **entity cannot be emitted** (emit button disabled with tooltip "X fields incomplete") until all fields have at least the minimum required metadata (name, type, classification)
**And** the **Save** operation is NOT blocked by incomplete fields — users can save partial work — but validation indicators remain visible
**And** unit tests verify: ValidationIndicator renders correct color for each state, progress bar calculates percentage correctly, decimal without precision/scale shows error, entity with incomplete fields disables emit
**And** a Playwright E2E test verifies: adding a field shows red ring, filling name/type/classification turns ring green, progress bar updates as fields complete, decimal without scale shows amber/red indicator

---

### Story 2.6: Autocomplete System — Field Name, Type & Classification Suggestions

As a **data modeler**,
I want intelligent autocomplete suggestions for field names, types, and classifications,
So that I can author schemas faster with fewer errors.

**Acceptance Criteria:**

**Given** the field editor and validation work (Stories 2.3-2.5 complete)
**When** the autocomplete system is implemented
**Then** when typing a **field name**, an autocomplete dropdown appears with suggestions from three sources, ranked by relevance:
**And** **Domain standard suggestions**: common field names from schema.org patterns (e.g., "name", "email", "address", "phone", "dateCreated", "identifier") — these are bundled as a static JSON dataset in `src/lib/schema-standards/`
**And** **Same-domain field suggestions**: field names from other entities in the same domain — labeled with "(from Entity.field)" suffix
**And** **Common pattern suggestions**: standard field patterns (id, created_at, updated_at, status, is_active, description, name, type) — always available regardless of domain
**And** the dropdown shows max 8 suggestions, updated as the user types with < 100ms response time; arrow keys navigate, Enter selects, Escape dismisses, typing continues to filter
**And** when a field **name is entered or selected**, the system **auto-suggests a type** based on name patterns:
**And** `amount`, `price`, `cost`, `balance`, `salary`, `total` → suggest `decimal` with precision prompt
**And** `email`, `url`, `uri`, `phone`, `address`, `name`, `description`, `title`, `label` → suggest `string`
**And** `created_at`, `updated_at`, `deleted_at`, `timestamp`, `date`, `born_at` → suggest `timestamp` or `date`
**And** `is_*`, `has_*`, `can_*`, `should_*` (boolean prefix patterns) → suggest `boolean`
**And** `status`, `type`, `category`, `role`, `state`, `level` → suggest `enum`
**And** `count`, `quantity`, `age`, `year`, `order`, `rank`, `position` → suggest `integer`
**And** `*_id`, `id` → suggest `string` with isKey=true
**And** the type suggestion appears as ghost text in the type cell — pressing Tab accepts the suggestion, typing overwrites it
**And** when a field **name is entered**, the system **auto-suggests a classification** based on name semantics:
**And** `email`, `phone`, `ssn`, `social_security`, `address`, `name`, `first_name`, `last_name`, `date_of_birth`, `passport` → suggest PII (displayed as amber "Suggested: PII" badge)
**And** `password`, `token`, `secret`, `api_key`, `credential`, `private_key` → suggest SENSITIVE
**And** `amount`, `balance`, `salary`, `income`, `credit_card`, `account_number`, `routing_number` → suggest SENSITIVE
**And** all other fields → no classification suggestion (user must manually select)
**And** classification suggestions appear as a **dismissible amber badge** next to the classification cell — clicking the badge accepts the suggestion, clicking X dismisses it
**And** suggestion acceptance and dismissal actions are tracked (accepted/dismissed) so dismissed suggestions don't reappear for the same field name pattern
**And** unit tests verify: name autocomplete returns correct suggestions for each source, type suggestions map correctly for all documented patterns, classification suggestions trigger for all documented field names, suggestions are filtered as user types
**And** a Playwright E2E test verifies: typing "email" suggests PII classification and string type, typing "amount" suggests decimal type and SENSITIVE classification, Tab accepts type suggestion, arrow keys navigate autocomplete dropdown

---

### Story 2.7: Complex Types, Relationships, Aliases & Field Numbers

As a **data modeler**,
I want to define complex types, entity relationships, field aliases, and permanent field numbers,
So that I can model sophisticated data structures and cross-system compatibility.

**Acceptance Criteria:**

**Given** the field editor with autocomplete works (Stories 2.3-2.6 complete)
**When** complex type support is implemented
**Then** the **TypePickerGrid** includes a "Complex" category with the following types:
**And** **Array type**: selecting "array" prompts for an element type via a nested type picker — the field displays as "array<string>" or "array<decimal(19,4)>" in the type cell
**And** **Map type**: selecting "map" prompts for key type and value type — displayed as "map<string, integer>"
**And** **Object/Nested type**: selecting "object" creates an inline nested field editor — the user can add sub-fields within the parent field, each with their own name, type, and decorators; nested fields are stored in the parent field's decorators JSONB under a `nestedFields` key; the UI indents nested fields with a visual tree connector
**And** **Reference type**: selecting "reference" opens a dropdown of existing entities in the system — selecting an entity creates a relationship; the field stores the referenced entity ID; the reference is displayed with entity name and a link icon
**And** when a **Reference** is created, a row is added to a `relationships` array on the parent entity's metadata JSONB: `{ targetEntityId, fieldId, cardinality }` where cardinality is selectable: "one-to-one", "one-to-many", "many-to-one", "many-to-many"
**And** the **Semantics tab** in the decorator panel includes an **Aliases** section: a tag-style input where users type alias names and press Enter to add each one; aliases are stored in the field's `aliases` text[] column; each alias displays as a removable tag
**And** the **Structure tab** in the decorator panel includes a **Field Number** input: an integer input for Protobuf compatibility; a tooltip explains "Permanent field number for Protobuf wire compatibility — once assigned, should not change"; validation ensures no two fields in the same entity share a field number
**And** the Prisma schema is updated if needed to support the `relationships` structure (or it's stored as entity metadata JSONB)
**And** unit tests verify: array type stores element type correctly, map type stores key/value types, nested fields are saved to decorators JSONB, reference creates a relationship record, aliases are stored and retrieved correctly, duplicate field numbers within an entity are rejected
**And** a Playwright E2E test verifies: creating an array<string> field, creating a reference to another entity, adding aliases to a field, setting a field number

---

### Story 2.8: Entity & Field Lifecycle — Deprecation, Retirement & Status Management

As a **data modeler**,
I want to deprecate and retire entities and fields with replacement references,
So that I can manage the full lifecycle of schema definitions and guide consumers to updated versions.

**Acceptance Criteria:**

**Given** entities and fields can be fully authored (Stories 2.1-2.7 complete)
**When** lifecycle management is implemented
**Then** the entity header includes a **status dropdown**: DRAFT, ACTIVE, DEPRECATED, RETIRED — with the current status displayed as a colored badge (green=ACTIVE, amber=DRAFT, orange=DEPRECATED, gray=RETIRED)
**And** changing entity status to **DEPRECATED** opens an inline form: "Deprecated since" date picker (defaults to today), "Replacement entity" searchable dropdown (all active entities), optional "Migration notes" textarea — all stored in entity metadata JSONB
**And** changing entity status to **RETIRED** requires the entity to be in DEPRECATED status first — attempting to retire a non-deprecated entity shows an error: "Entity must be deprecated before it can be retired"
**And** **DEPRECATED** entities display a persistent amber banner at the top of the editor: "This entity is deprecated since {date}. Replacement: {entity name}" with a link to the replacement entity
**And** **RETIRED** entities display a persistent gray banner: "This entity is retired since {date}. It is read-only." — all editing is disabled for retired entities (field grid is view-only, add field button hidden, decorator panel shows values but inputs are disabled)
**And** in the **sidebar**, deprecated entities show an orange dot indicator and retired entities show a gray dot with strikethrough text
**And** the **Evolution tab** in the decorator detail panel supports field-level deprecation: deprecated toggle, "since" date picker, "replacement" field reference input (entity.field format with autocomplete to other fields in any entity)
**And** deprecated fields display with a strikethrough visual treatment on the field name in the grid and an orange "Deprecated" badge
**And** the entity service validates status transitions: DRAFT→ACTIVE, ACTIVE→DEPRECATED, DEPRECATED→RETIRED are allowed; all other transitions are rejected with an error
**And** status changes are recorded in the audit trail via `withAudit()`
**And** unit tests verify: valid status transitions succeed, invalid transitions are rejected, deprecated entity stores replacement reference, retired entity blocks edits, field-level deprecation stores correctly
**And** a Playwright E2E test verifies: changing entity status to DEPRECATED shows the deprecation form and banner, retired entity is read-only, deprecated fields show strikethrough

---

### Story 2.9: Command Palette & Global Keyboard Shortcuts

As a **data modeler**,
I want a command palette (Cmd+K) and keyboard shortcuts for all common actions,
So that I can navigate and operate the tool efficiently without reaching for the mouse.

**Acceptance Criteria:**

**Given** entity browsing and editing work (Stories 2.2-2.8 complete)
**When** the command palette and keyboard shortcuts are implemented
**Then** pressing **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) opens the **Command Palette** — a centered overlay using the Shadcn Command component with frosted glass background
**And** the command palette has four sections, each with a header label: **Recent** (last 5 accessed entities), **Entities** (all entities searchable by name), **Fields** (all fields searchable by name, showing "Entity → Field" format), **Actions** (New Entity, Save, Emit, Show Diff, Export)
**And** typing in the search input filters all sections simultaneously — matching text is highlighted with the primary accent color
**And** arrow keys (Up/Down) navigate through results, Enter selects the highlighted item, Escape closes the palette
**And** selecting an **Entity** navigates to its editor view; selecting a **Field** navigates to its entity and auto-selects the field (opening the decorator panel); selecting an **Action** triggers the corresponding action
**And** the command palette is implemented using Shadcn's `<Command>` component with `<CommandGroup>` for sections and `<CommandItem>` for results
**And** **Global keyboard shortcuts** are active when no input is focused:
**And** `Ctrl+N` / `Cmd+N` — opens the new entity creation popover (same as sidebar + button)
**And** `Ctrl+S` / `Cmd+S` — saves the current entity (prevents browser default save dialog)
**And** `Ctrl+E` / `Cmd+E` — triggers emission for the current entity (disabled if fields incomplete)
**And** `/` (slash) — when the field grid is focused but no cell is in edit mode, inserts a new field row with the TypePickerGrid open (Notion-style slash command)
**And** `Tab` — when in the field grid, moves focus to the next editable cell; when in autocomplete, cycles through suggestions
**And** `Enter` — when a field row is focused, opens the decorator detail panel for that field; when in autocomplete, accepts the selected suggestion
**And** `Escape` — closes any open panel, popover, or palette; if detail panel is open, closes it; if command palette is open, closes it
**And** keyboard shortcuts are displayed in **tooltips** on all action buttons — e.g., the Save button tooltip shows "Save (⌘S)"
**And** a Playwright E2E test verifies: Cmd+K opens palette, typing filters results, selecting an entity navigates to it, Ctrl+S saves, Escape closes palette, / adds a new field with type picker

---

### Story 2.10: Lineage DAG — Interactive Entity Relationship Graph

As a **data modeler**,
I want to see entity relationships as an interactive graph,
So that I can understand how entities are connected and trace data lineage visually.

**Acceptance Criteria:**

**Given** entities with relationships exist (Story 2.7 creates reference-type relationships)
**When** the Lineage DAG view is implemented
**Then** the **Lineage Graph** view (Activity Bar → Lineage) displays an interactive directed acyclic graph (DAG) of all entities and their relationships using React Flow
**And** each entity is a **graph node** rendered as a card: entity name (heading), field count badge, classification summary badges (PII/SENSITIVE count), domain label, status indicator (green/amber/gray)
**And** **relationship edges** connect entities with: arrow direction indicating the reference direction (from referencing entity to referenced entity), cardinality label on the edge ("1:1", "1:N", "N:1", "N:M"), and edge color (primary accent for active, muted for deprecated entities)
**And** the graph supports **zoom** (scroll wheel), **pan** (drag background), and **fit-to-view** (button that auto-fits all nodes in the viewport)
**And** clicking a **node** opens a popover showing: entity name, description, field list (name + type + classification for each), and a "Open in Editor" button that navigates to the entity editor view
**And** the graph supports **filtering** by domain — a domain filter dropdown at the top of the view shows/hides entities by domain
**And** the graph layout uses an **automatic layout algorithm** (dagre or ELK via React Flow) that arranges nodes hierarchically based on relationship direction — entities with no incoming references at the top, downstream entities below
**And** the graph is **read-only** — relationships are created/edited in the entity editor (Story 2.7), not in the graph view
**And** when no entities with relationships exist, an empty state is displayed: "No entity relationships found. Create references between entities to see the lineage graph."
**And** the graph node positions are **not persisted** — layout is recalculated on each view (MVP simplification)
**And** performance: the graph renders smoothly with up to 100 entities and 200 edges; entities beyond that threshold show a warning: "Large graph — consider filtering by domain for better performance"
**And** unit tests verify: nodes are created for all entities with relationships, edges correctly represent relationship direction and cardinality, domain filter shows/hides correct nodes, node popover shows correct entity data
**And** a Playwright E2E test verifies: navigating to Lineage view shows graph with nodes and edges, clicking a node opens popover, "Open in Editor" navigates to entity, domain filter hides entities from unselected domains, empty state shows when no relationships exist

---

## Epic 3: Schema Emission, Validation & API

Data modelers can emit schemas to Avro, BigQuery, and OpenAPI targets, preview output side-by-side with syntax highlighting, and see validation results. Type mapping policies are configurable with governed overrides. External systems can access schemas, validate, check compatibility, and trigger emission via versioned API (auto-generated from oRPC).

### Story 3.1: Compiler Service & SuperSchemaModel Intermediate Representation

As a **developer**,
I want the TypeSpec compiler service behind an abstraction interface that produces a SuperSchemaModel IR,
So that emitters are decoupled from TypeSpec internals and the compiler is testable via mocks.

**Acceptance Criteria:**

**Given** entities and fields can be authored with full decorators (Epic 2 complete)
**When** the compiler service is implemented
**Then** an `ICompilerService` interface is defined in `src/lib/compiler/types.ts` with three methods:
**And** `compile(source: string): Promise<CompilationResult>` — compiles TypeSpec source and returns the compiled program or error diagnostics
**And** `emit(model: SuperSchemaModel, target: string, policies: MappingPolicy[]): Promise<EmitterResult>` — emits a schema for a specific target using the intermediate model
**And** `validate(output: string, targetFormat: string): Promise<ValidationResult>` — validates emitted output against the target format's specification
**And** a `SuperSchemaModel` interface is defined in `src/types/models.ts` matching the Architecture document: `entity` (name, domain, version, metadata), `fields` (array with name, type, LogicalType, decorators), `relationships` (array with target, cardinality)
**And** a `TypeSpecCompilerService` class implements `ICompilerService` in `src/lib/compiler/typespec-compiler.ts` — it uses `@typespec/compiler` to compile TypeSpec source in-memory (no file I/O), and translates the compiled TypeSpec `Program` into a `SuperSchemaModel`
**And** a `MockCompilerService` class implements `ICompilerService` in `src/lib/compiler/mock-compiler.ts` — it returns pre-defined outputs for testing without requiring the TypeSpec compiler
**And** a **TypeSpec generator** exists in `src/lib/compiler/typespec-generator.ts` that converts a database entity (Prisma entity + fields + decorators) into a valid TypeSpec `.tsp` source string — this maps field types, decorators, and relationships to TypeSpec syntax
**And** the compilation pipeline is wired into the entity save flow: on save → Zod validate → Prisma write → TypeSpec generator → ICompilerService.compile() → if error, return compilation error with diagnostics to UI; if success, store compilation status on entity
**And** compilation errors are returned as `Result` errors with: error message, line/column location in generated TypeSpec (mapped back to field name), and `suggestedFix` when determinable (e.g., "Add precision and scale to decimal field 'amount'")
**And** a `MappingPolicy` type is defined: `{ sourceType: string; targetType: string; targetFormat: string; mappedType: string; isOverride: boolean; approvedBy?: string }`
**And** unit tests (using MockCompilerService): TypeSpec generator produces valid TypeSpec for entities with various field types (string, integer, decimal, boolean, enum, array, reference), compilation pipeline returns success for valid entities, compilation pipeline returns descriptive errors for invalid entities
**And** integration tests (using real TypeSpecCompilerService): a complete entity with 5+ fields of mixed types compiles successfully, generated TypeSpec is syntactically valid

---

### Story 3.2: Type Translation Policies & Mapping Engine

As a **data modeler**,
I want configurable type translation policies between logical types and target formats,
So that I can control how my logical schema maps to platform-specific types and see warnings for lossy mappings.

**Acceptance Criteria:**

**Given** the compiler service and SuperSchemaModel exist (Story 3.1 complete)
**When** the type mapping engine is implemented
**Then** a `type_mapping_policies` table exists in Prisma: `id` (cuid), `targetFormat` (string — e.g., "bigquery", "avro", "openapi"), `sourceType` (string — logical type), `mappedType` (string — target-specific type), `isLossy` (boolean — true if mapping loses information), `lossDescription` (string, nullable — explains what information is lost), `isOverride` (boolean, default false), `approvedBy` (FK to users, nullable), `createdAt`, `updatedAt`
**And** a **default mapping policy dataset** is seeded for three targets, covering all logical types:
**And** BigQuery mappings: string→STRING, integer→INT64, decimal(p,s)→NUMERIC(p,s), boolean→BOOL, float→FLOAT64, date→DATE, time→TIME, datetime→DATETIME, timestamp→TIMESTAMP, enum→STRING, array→ARRAY, map→STRUCT (lossy)
**And** Avro mappings: string→string, integer→long, decimal(p,s)→bytes/decimal logical type, boolean→boolean, float→double, date→int/date logical type, timestamp→long/timestamp-millis, enum→enum, array→array, map→map
**And** OpenAPI mappings: string→string, integer→integer/int64, decimal→number/double (lossy — precision lost), boolean→boolean, float→number/float, date→string/date, timestamp→string/date-time, enum→string+enum, array→array
**And** `src/lib/type-mapping/mapping-engine.ts` exports a `resolveMapping(sourceType: LogicalType, targetFormat: string, policies: MappingPolicy[]): MappingResult` function that: looks up the mapping for the source type and target, applies any override policies (override takes precedence over default), returns `{ mappedType, isLossy, lossDescription, isOverride }`
**And** `src/services/type-mapping.service.ts` exports: `getMappingsForTarget(targetFormat, ctx): Result<MappingPolicy[]>`, `createOverride(input, ctx): Result<MappingPolicy>` — overrides require the user to have Steward or Admin role
**And** when a mapping is **lossy**, the system flags it with a warning (amber indicator) — the warning includes the `lossDescription` explaining what information is lost (e.g., "decimal precision reduced to float64 — values beyond 15 significant digits will be rounded")
**And** unit tests verify: default mappings return correct target types for all logical types across all three targets, lossy mappings are flagged correctly, override policies take precedence over defaults, missing mappings return an error with suggestedFix
**And** seed script (`prisma/seed.ts`) populates all default mapping policies on database initialization

---

### Story 3.3: BigQuery DDL Emitter

As a **data modeler**,
I want to emit valid BigQuery DDL from my entity definition,
So that I can deploy my schema to BigQuery with correct types, column descriptions, and partitioning hints.

**Acceptance Criteria:**

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the BigQuery emitter is implemented
**Then** `src/emitters/bigquery/bigquery.emitter.ts` implements the `Emitter` interface with `name: "bigquery"`, `version: "1.0.0"`, `targetFormat: "bigquery-ddl"`
**And** the `emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult` method generates a `CREATE TABLE` DDL statement that:
**And** uses the entity name as table name (converted to snake_case if needed)
**And** maps each field to a BigQuery column using the mapping engine — type resolved via `resolveMapping()` with BigQuery policies
**And** includes `OPTIONS(description='...')` on each column using the field's description from the semantics decorator
**And** includes column OPTIONS for classification metadata: `OPTIONS(description='...', labels=['classification:PII'])` when classification is set
**And** adds `NOT NULL` constraint for fields where `nullable = false`
**And** generates `PARTITION BY` clause for fields with `operationalHints.partition = true` — supports DATE, TIMESTAMP, DATETIME partition types
**And** generates `CLUSTER BY` clause for fields with `operationalHints.cluster = true`
**And** the `validate(output: string): ValidationResult` method performs syntactic validation: checks that the DDL is parseable SQL, verifies all BigQuery-specific syntax (OPTIONS, PARTITION BY, CLUSTER BY) is well-formed — returns `{ valid: true }` or `{ valid: false, errors: [...] }`
**And** lossy mappings are included as SQL comments above the affected column: `-- WARNING: map type mapped to STRUCT (lossy — nested key ordering not preserved)`
**And** the emitter is deterministic — same SuperSchemaModel input always produces identical output
**And** unit tests verify: simple entity (3 fields: string, integer, boolean) produces valid DDL, decimal(19,4) maps to NUMERIC(19,4), nullable/non-nullable handling, partition/cluster BY clauses, column OPTIONS with description and classification, lossy mapping produces warning comment, empty entity produces valid empty table DDL
**And** integration test: a real entity with 10+ fields of mixed types is compiled and emitted — the output DDL is syntactically valid

---

### Story 3.4: Avro Schema Emitter

As a **data modeler**,
I want to emit valid Avro schema JSON from my entity definition,
So that I can use my schema with Kafka, data pipelines, and other Avro-consuming systems.

**Acceptance Criteria:**

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the Avro emitter is implemented
**Then** `src/emitters/avro/avro.emitter.ts` implements the `Emitter` interface with `name: "avro"`, `version: "1.0.0"`, `targetFormat: "avro"`
**And** the `emit()` method generates a valid Avro schema JSON object with: `type: "record"`, `name` (entity name in PascalCase), `namespace` (derived from domain name as reversed dot notation, e.g., domain "payments" → "com.superschema.payments"), `fields` array
**And** each field is mapped to an Avro field with: `name` (original field name), `type` (resolved via mapping engine — nullable fields use Avro union `["null", "type"]`), `doc` (field description), `aliases` (from field aliases array, if any)
**And** `decimal` type maps to Avro `bytes` with logical type `decimal` and `precision`/`scale` attributes
**And** `enum` type maps to Avro `enum` with `symbols` array from the enum values
**And** `array` type maps to Avro `array` with `items` set to the element type
**And** `map` type maps to Avro `map` with `values` set to the value type (keys are always strings in Avro)
**And** the `validate()` method checks the output against the Avro specification: valid JSON, correct record structure, all field types are valid Avro types, unions are properly formed — returns validation result
**And** field metadata is preserved in `doc` fields and as custom properties where Avro supports them
**And** unit tests verify: simple entity produces valid Avro JSON, nullable fields produce union types, decimal produces bytes with logical type, enum produces symbols array, aliases are included, array and map types are correct, validation passes for all generated schemas
**And** integration test: round-trip test — emit Avro schema, validate it, verify it matches expected structure

---

### Story 3.5: OpenAPI Schema Emitter

As a **data modeler**,
I want to emit valid OpenAPI 3.0 schema components from my entity definition,
So that I can use my schema in REST API specifications and documentation.

**Acceptance Criteria:**

**Given** the type mapping engine exists (Story 3.2 complete)
**When** the OpenAPI emitter is implemented
**Then** `src/emitters/openapi/openapi.emitter.ts` implements the `Emitter` interface with `name: "openapi"`, `version: "1.0.0"`, `targetFormat: "openapi"`
**And** the `emit()` method generates a valid OpenAPI 3.0 schema component YAML with: `components.schemas.{EntityName}` containing `type: object`, `properties`, `required` array (non-nullable fields), and `description`
**And** each field maps to an OpenAPI property with: correct `type` and `format` (resolved via mapping engine), `description` from semantics decorator, `nullable: true` for nullable fields
**And** `decimal` maps to `type: number, format: double` with an `x-precision` and `x-scale` extension preserving the original precision (with lossy warning)
**And** `enum` maps to `type: string` with `enum` array listing all values
**And** `array` maps to `type: array` with `items` referencing the element type schema
**And** `date` maps to `type: string, format: date`; `timestamp` maps to `type: string, format: date-time`
**And** `boolean` maps to `type: boolean`; `integer` maps to `type: integer, format: int64`
**And** `reference` type maps to `$ref: '#/components/schemas/{ReferencedEntityName}'`
**And** quality rules are translated to OpenAPI validation keywords where applicable: range → `minimum`/`maximum`, min_length → `minLength`, max_length → `maxLength`, regex → `pattern`
**And** the `validate()` method checks: valid YAML, correct OpenAPI 3.0 schema structure, all types are valid OpenAPI types, required array only lists non-nullable fields
**And** unit tests verify: simple entity produces valid OpenAPI YAML, nullable/required handling, enum with values, array items, reference produces $ref, quality rules map to validation keywords, decimal lossy mapping flagged
**And** integration test: emitted OpenAPI schema validates against the OpenAPI 3.0 specification

---

### Story 3.6: Emission Pipeline, Preview Panel & Live Updates

As a **data modeler**,
I want to see emitted output for all targets side-by-side with live updates as I edit,
So that I can immediately verify how my logical schema translates to each platform.

**Acceptance Criteria:**

**Given** all three emitters work (Stories 3.3-3.5 complete)
**When** the emission pipeline and preview panel are implemented
**Then** a Prisma migration creates the `entity_versions` table: `id` (cuid), `entityId` (FK to entities), `versionNumber` (int), `snapshot` (JSONB — complete entity + fields + decorators frozen at this version), `changeRecord` (JSONB, nullable), `migrationArtifacts` (JSONB, nullable), `createdBy` (FK to users), `createdAt`
**And** a Prisma migration creates the `emission_targets` table: `id` (cuid), `entityId` (FK to entities), `targetType` (string — bigquery/avro/openapi), `emittedOutput` (text — the generated schema), `validationStatus` (enum: VALID/INVALID/WARNING), `validationDetails` (JSONB — errors/warnings), `lastEmittedAt` (datetime), `versionId` (FK to entity_versions, nullable for preview)
**And** the **emission service** (`src/services/emission.service.ts`) orchestrates the full pipeline: entity + fields from DB → TypeSpec generator → compile → for each enabled target: resolve mappings → emit → validate → store result
**And** the **Right Panel** includes an "Emission Preview" view (switchable from decorator view via tabs at panel top) — the **EmissionPreviewPanel** component
**And** the EmissionPreviewPanel shows **tabs for each enabled target** (BigQuery, Avro, OpenAPI) — each tab displays:
**And** syntax-highlighted code using Shiki or Prism: SQL highlighting for BigQuery DDL, JSON for Avro, YAML for OpenAPI
**And** a **validation indicator** in the tab header: green checkmark for VALID, amber warning icon for WARNING (lossy mappings), red X for INVALID
**And** a **copy button** (hover-reveal) that copies the emitted output to clipboard with a "Copied!" toast
**And** line numbers displayed in the code viewer
**And** **Live preview updates** — as the user edits fields in the center panel, the emission preview updates automatically, debounced at 1 second after last edit; a subtle flash animation highlights lines that changed
**And** an **"Emit" button** in the entity header (primary button, Ctrl+E shortcut) commits the emission — this writes the emitted output to `emission_targets` and creates an `entity_version` snapshot; the button shows "Emitting..." spinner during the operation
**And** the Emit button is **disabled** when fields are incomplete (tooltip: "X fields need required metadata") or when there are compilation errors
**And** if emission produces **warnings** (lossy mappings), a summary is shown below the tabs: "2 warnings: decimal→float64 lossy mapping in 'amount', 'price'" — clickable to highlight the affected lines
**And** if emission produces **errors** (validation failures), the error tab shows in red with error details and `suggestedFix` if available
**And** unit tests verify: emission pipeline runs all three emitters, results are stored in emission_targets, live preview debounces at 1s, validation status is correctly set
**And** a Playwright E2E test verifies: creating an entity with 3 fields → emission preview shows all three target tabs with syntax-highlighted output → validation indicators are green → clicking copy copies to clipboard → clicking Emit commits and shows success toast

---

### Story 3.7: Type Mapping Overrides with Governance

As a **data steward**,
I want to create governed overrides for type mappings when the default translation isn't suitable,
So that I can control how specific types map to targets with full audit trail.

**Acceptance Criteria:**

**Given** the emission pipeline and type mapping engine work (Stories 3.2, 3.6 complete)
**When** type mapping override governance is implemented
**Then** when a **lossy mapping warning** appears in the emission preview, clicking the warning opens an **override dialog** (Sheet from right panel) showing: source type, target format, current mapped type, loss description, and options
**And** the override dialog allows the steward to: accept the lossy mapping (acknowledge warning — dismisses it for this entity), create a **global override** (changes the mapping for all entities — requires Steward or Admin role), or create a **per-entity override** (changes the mapping for this entity only)
**And** creating an override requires: new mapped type (text input with autocomplete from valid target types), justification text (required), and is logged with the approver's user ID
**And** override mappings are stored in `type_mapping_policies` with `isOverride: true` and `approvedBy` set to the current user
**And** overrides are displayed in the emission preview with a blue "Override" badge next to the affected line
**And** the `withAudit()` wrapper records all override creation/modification in the audit trail
**And** only users with **Steward** or **Admin** role can create global overrides — Author role can only create per-entity overrides; Viewer role cannot create any overrides
**And** unit tests verify: override takes precedence over default mapping, per-entity override takes precedence over global override, non-Steward users cannot create global overrides, audit trail records override creation
**And** a Playwright E2E test verifies: clicking a lossy warning opens override dialog, creating an override updates the emission preview, override badge is displayed

---

### Story 3.8: External API via oRPC OpenAPI Generation

As an **API consumer**,
I want a versioned REST API for accessing schemas, validation, compatibility checking, and emission,
So that CI/CD pipelines and external tools can integrate with Super Schema programmatically.

**Acceptance Criteria:**

**Given** the emission pipeline and services work (Stories 3.1-3.6 complete)
**When** the external API is implemented
**Then** oRPC's `@orpc/openapi` generates an OpenAPI 3.0 specification from all existing oRPC routers — the spec is served at `/api/v1/openapi.json`
**And** the following API endpoints are available (all requiring authentication via API key or session):
**And** `GET /api/v1/schemas` — list all entities with pagination, filtering by domain, status, and search query
**And** `GET /api/v1/schemas/:id` — get entity details including all fields and decorators
**And** `POST /api/v1/schemas/:id/validate` — validate the entity against all enabled targets, returning a structured response: `{ valid: boolean, targets: [{ target, status, errors?, warnings? }] }`
**And** `POST /api/v1/schemas/:id/emit` — trigger emission for specified targets (or all enabled), returning: `{ entityId, version, targets: [{ target, output, validationStatus, warnings? }] }`
**And** `POST /api/v1/schemas/:id/compatibility` — check compatibility of current version against previous version, returning: `{ compatible: boolean, changeType: "breaking"|"non-breaking"|"none", changes: [...], perTarget: [{ target, compatible, details }] }`
**And** all API responses use the standardized error shape: `{ code, message, details?, suggestedFix? }`
**And** API responses include appropriate HTTP status codes: 200 (success), 201 (created), 400 (validation error), 401 (unauthorized), 403 (forbidden), 404 (not found), 500 (server error)
**And** the API supports **API key authentication** — a `user_api_keys` table stores hashed API keys linked to users; keys are created/revoked via user settings; API requests include the key in `Authorization: Bearer <key>` header
**And** API rate limiting is NOT implemented for MVP but the architecture supports adding it later
**And** CI/CD pipeline integration: the `/validate` and `/compatibility` endpoints return machine-parseable JSON that a CI pipeline can use for pass/fail decisions — the response includes a `ci` field with `{ pass: boolean, summary: string }` for easy integration
**And** integration tests verify: all API endpoints return correct responses for valid/invalid inputs, authentication rejects requests without valid API key, validate endpoint returns correct per-target status, emit endpoint triggers emission and returns output, compatibility endpoint correctly identifies breaking vs non-breaking changes
**And** a `/api/v1/docs` route serves a Swagger UI rendering the auto-generated OpenAPI spec

---

## Epic 4: Schema Versioning & Change Management

Data modelers can track version history, compare any two versions with structured field-level diffs, view change records, and generate migration artifacts (ALTER statements, evolution compatibility reports).

### Story 4.1: Version History Data Model & Service

As a **data modeler**,
I want every entity change to create a versioned snapshot with automatic change records,
So that I have a complete history of how my schemas evolved over time.

**Acceptance Criteria:**

**Given** entities can be authored and emitted (Epics 2-3 complete), and the `entity_versions` table exists (created in Story 3.6)
**When** the versioning system is implemented
**Then** a **version service** (`src/services/version.service.ts`) exports: `createVersion(entityId, ctx): Result<EntityVersion>`, `getVersions(entityId, ctx): Result<EntityVersion[]>`, `getVersionById(versionId, ctx): Result<EntityVersion>`, `getVersionByNumber(entityId, versionNumber, ctx): Result<EntityVersion>`
**And** `createVersion()` is called automatically when the user clicks **"Save as Version"** (or when Emit commits) — it snapshots the current entity state (entity metadata + all fields with decorators) as JSONB, increments the version number, and generates a change record by diffing against the previous version snapshot
**And** the **change record** JSONB contains: `{ previousVersion: number, changes: [{ type: "added"|"removed"|"modified", fieldName: string, details: { before?: FieldSnapshot, after?: FieldSnapshot, changedProperties: string[] } }] }`
**And** the entity's `version` column is incremented to match the new version number
**And** the entity header in the editor UI shows the current version number and a **"History"** button — clicking it opens a version history panel in the Right Panel
**And** the version history panel lists all versions in reverse chronological order: version number, created by (user name), created at (relative time — "2 hours ago"), and a one-line summary of changes (e.g., "Added 2 fields, modified 1 field")
**And** clicking a version in the history list shows the change record details for that version — what was added, removed, or modified
**And** the audit trail records version creation via `withAudit()`
**And** unit tests verify: creating a version snapshots the current state, change record correctly identifies added/removed/modified fields, version number increments correctly, multiple versions can be created for the same entity
**And** a Playwright E2E test verifies: modifying an entity and saving as version → version appears in history list → clicking version shows change details → version number updates in entity header

---

### Story 4.2: Structured Field-Level Diff Viewer

As a **data modeler**,
I want to compare any two versions of an entity with a structured field-level diff,
So that I can see exactly what changed between versions at a glance.

**Acceptance Criteria:**

**Given** version history exists (Story 4.1 complete)
**When** the diff viewer is implemented
**Then** the version history panel includes a **"Compare"** button — clicking it enters comparison mode where the user selects two versions (dropdowns: "Version A" and "Version B")
**And** after selecting two versions, the **DiffViewer** component renders in the Center Panel (replacing the field grid temporarily):
**And** the DiffViewer displays a structured table with columns: Field Name, Change Type (badge), Version A Value, Version B Value
**And** **Added fields** (in B but not A) are highlighted with a green background and "Added" badge
**And** **Removed fields** (in A but not B) are highlighted with a red background and "Removed" badge
**And** **Modified fields** (in both but changed) are highlighted with an amber background and "Modified" badge — the specific changed properties are listed (e.g., "type: string → integer, classification: PUBLIC → PII")
**And** **Unchanged fields** are displayed in muted color without highlighting
**And** a **summary bar** above the diff table shows: "X added, Y removed, Z modified, W unchanged" with a count for each change type
**And** the diff viewer supports **property-level expansion** — clicking a modified field row expands it to show all changed decorator properties in a nested before/after format
**And** a **"Close Diff"** button returns to the normal field grid editor
**And** the diff can also be accessed from the version history panel by clicking a **"View Diff"** button on any version — this automatically compares that version with the immediately preceding version
**And** the `version.service.ts` exports a `compareVersions(entityId, versionA, versionB, ctx): Result<DiffResult>` function that computes the field-level diff between two version snapshots
**And** unit tests verify: diff correctly identifies added, removed, and modified fields; property-level changes are captured for modified fields; comparing identical versions returns empty diff; comparing non-adjacent versions works correctly
**And** a Playwright E2E test verifies: entering comparison mode, selecting two versions, diff displays with correct highlighting, expanding a modified field shows property changes, closing diff returns to editor

---

### Story 4.3: Change Records & Change History View

As a **data modeler**,
I want to view the complete change history and audit trail for any entity,
So that I can understand who changed what and when for governance and troubleshooting.

**Acceptance Criteria:**

**Given** versioning and diff work (Stories 4.1-4.2 complete)
**When** the change history view is implemented
**Then** the entity editor has a **"Change History"** view tab (alongside Editor, Emission Preview) — switching to this tab shows the full change history
**And** the change history view displays a **timeline** of all changes in reverse chronological order, pulling from two sources: version records (from `entity_versions`) and audit trail entries (from `audit_log` for this entity)
**And** each timeline entry shows: timestamp (relative + absolute on hover), user who made the change (avatar + name), change type (version, field edit, decorator change, status change, override, emission), and a summary description
**And** **Version entries** are prominent (larger card) and show: version number, change record summary (X fields added, Y modified, Z removed), and an "Expand" button to see the full change record
**And** **Audit trail entries** are compact (single line) and show: action performed (e.g., "Updated field 'amount' classification to PII"), user, timestamp
**And** the timeline is **filterable** — a filter bar at the top allows filtering by: change type (versions, field edits, decorator changes, emissions, governance), user, and date range
**And** the timeline supports **pagination** — initial load shows the last 50 entries; "Load More" button at the bottom fetches the next page
**And** clicking any timeline entry that references a version opens the diff viewer for that version vs. previous version
**And** unit tests verify: change history combines version records and audit trail correctly, filtering by change type works, pagination returns correct pages
**And** a Playwright E2E test verifies: navigating to change history tab shows timeline, making a change and refreshing shows the new entry, filtering by type reduces visible entries, expanding a version entry shows the change record

---

### Story 4.4: Migration Artifact Generation

As a **data modeler**,
I want auto-generated migration artifacts for schema changes (ALTER statements, evolution compatibility reports),
So that I can safely apply schema changes to production target systems.

**Acceptance Criteria:**

**Given** versioning and diff work (Stories 4.1-4.2 complete)
**When** migration artifact generation is implemented
**Then** a **migration service** (`src/services/migration.service.ts`) exports: `generateMigrationArtifacts(entityId, fromVersion, toVersion, ctx): Result<MigrationArtifacts>`
**And** `MigrationArtifacts` contains per-target migration output: `{ targets: [{ targetFormat, artifacts: MigrationArtifact[] }] }` where `MigrationArtifact = { type: string, content: string, warnings: string[] }`
**And** **BigQuery migration**: for added fields → `ALTER TABLE {table} ADD COLUMN {col} {type} OPTIONS(...)` statements; for removed fields → commented-out `ALTER TABLE {table} DROP COLUMN {col}` with warning "Manual review required — dropping columns deletes data"; for type changes → `ALTER TABLE {table} ALTER COLUMN {col} SET DATA TYPE {newType}` with compatibility warning if not safe
**And** **Avro migration**: generates an evolution compatibility report: `{ compatible: boolean, compatibility: "BACKWARD"|"FORWARD"|"FULL"|"BREAKING", details: string[] }` — backward compatible if only additions and optional fields; forward compatible if consumers can read new with old schema; breaking if field removed or type changed incompatibly
**And** **OpenAPI migration**: generates a changelog: list of added/removed/modified properties with their types, noting which changes are breaking for API consumers (removed required field = breaking, added required field = breaking, type change = breaking)
**And** a **"Generate Migration"** button appears in the version history panel next to each version — clicking it generates migration artifacts from the previous version to the selected version
**And** the migration artifacts are displayed in a **tabbed panel** (one tab per target) with syntax-highlighted content (SQL for BigQuery, JSON for Avro, YAML/text for OpenAPI)
**And** migration artifacts are stored in the `entity_versions.migrationArtifacts` JSONB column for the target version
**And** warnings are displayed prominently in amber: destructive operations (DROP COLUMN), breaking compatibility changes, and lossy type conversions
**And** unit tests verify: BigQuery ALTER statements are syntactically correct for add/remove/modify scenarios, Avro compatibility is correctly classified (backward, forward, full, breaking), OpenAPI changelog correctly identifies breaking changes
**And** integration test: a complete entity change (add field, modify type, remove field) generates correct migration artifacts for all three targets
**And** a Playwright E2E test verifies: clicking "Generate Migration" shows migration tabs, BigQuery tab shows ALTER statements, Avro tab shows compatibility report, warnings are highlighted

---

## Epic 5: Governance & Change Workflows

The system classifies schema changes (breaking/non-breaking), routes approvals to data stewards and impacted team leads, generates change impact reports showing per-target compatibility, and supports per-target staged emission.

### Story 5.1: Change Classification Engine

As a **data modeler**,
I want the system to automatically classify my schema changes as breaking or non-breaking,
So that I know the impact of my changes before committing them.

**Acceptance Criteria:**

**Given** versioning and migration artifacts exist (Epic 4 complete)
**When** the change classification engine is implemented
**Then** a **classification service** (`src/services/classification.service.ts`) exports: `classifyChange(entityId, fromVersion, toVersion, ctx): Result<ChangeClassification>`
**And** `ChangeClassification` contains: `{ changeType: "non-breaking"|"breaking"|"classification-change", severity: "low"|"medium"|"high"|"critical", reasons: string[], perTarget: [{ target, changeType, details }] }`
**And** **Non-breaking changes** are classified as: adding a new optional (nullable) field, adding a new decorator/metadata, modifying description or non-structural decorators, adding an alias
**And** **Breaking changes** are classified as: removing a field, changing a field's type, making a nullable field non-nullable, renaming a field (without alias), changing an enum's values (removing a value), changing precision/scale to a less precise value
**And** **Classification changes** are flagged separately (medium severity): changing a field's classification level (e.g., INTERNAL → PII) — these may require governance review even though they don't break structure
**And** the classification considers **per-target impact**: a change might be non-breaking for BigQuery (ADD COLUMN is safe) but breaking for Avro (removing an enum value is backward-incompatible) — `perTarget` captures this
**And** on entity save (when changes exist from the last version), the classification runs automatically and the result is displayed in the **Status Bar** as a badge: green "Non-breaking" or red "Breaking (X reasons)" or amber "Classification change"
**And** the classification is also available via the `/compatibility` API endpoint (Story 3.8)
**And** unit tests verify: all documented breaking change patterns are classified correctly, all documented non-breaking patterns are classified correctly, per-target classification differs when appropriate (e.g., Avro vs BigQuery), classification change is detected separately from structural changes
**And** integration test: a complex change (add field + modify type + change classification) produces a classification with multiple reasons and per-target breakdown

---

### Story 5.2: Governance Workflow & Approval Routing

As a **data steward**,
I want breaking changes to require my approval before they can be emitted,
So that no breaking schema change reaches production without review.

**Acceptance Criteria:**

**Given** change classification works (Story 5.1 complete)
**When** the governance workflow is implemented
**Then** the Prisma schema includes `governance_requests` table: `id` (cuid), `entityId` (FK), `versionId` (FK to entity_versions), `changeType` (string — breaking/non-breaking/classification-change), `status` (enum: PENDING, APPROVED, REJECTED, AUTO_APPROVED), `impactReport` (JSONB), `requestedBy` (FK to users), `createdAt`, `updatedAt`
**And** the Prisma schema includes `governance_approvals` table: `id` (cuid), `requestId` (FK to governance_requests), `approverId` (FK to users), `decision` (enum: APPROVED, REJECTED), `comment` (text, nullable), `decidedAt` (datetime)
**And** a **governance service** (`src/services/governance.service.ts`) exports: `createRequest(entityId, versionId, classification, ctx): Result<GovernanceRequest>`, `approveRequest(requestId, comment, ctx): Result<GovernanceApproval>`, `rejectRequest(requestId, comment, ctx): Result<GovernanceApproval>`, `getRequestsForEntity(entityId, ctx): Result<GovernanceRequest[]>`, `getPendingRequests(ctx): Result<GovernanceRequest[]>`
**And** **Non-breaking changes** are auto-approved per default policy — a governance_request is created with status AUTO_APPROVED and no human approval is needed; the entity can be emitted immediately
**And** **Breaking changes** create a governance_request with status PENDING — the entity CANNOT be emitted until the request is approved; the Emit button shows "Pending Approval" with amber badge
**And** approval requests are **routed** to: all users with Steward role in the entity's domain, and all users who own entities that reference this entity (impacted team leads, if relationship references exist)
**And** the **Governance Dashboard** (Activity Bar → Governance) shows: pending requests assigned to the current user, all requests for entities in the user's domain, and a history of past decisions
**And** each request in the dashboard shows: entity name, change summary, severity, requested by, requested at, and action buttons: "Approve" (primary) and "Reject" (destructive)
**And** approving or rejecting requires an optional **comment** (text input) — the decision is recorded in `governance_approvals`
**And** when a request is **approved** (by at least one Steward), the request status changes to APPROVED and the entity can be emitted; when **rejected**, status changes to REJECTED and the requestor is notified
**And** all governance decisions are recorded in the audit trail via `withAudit()`
**And** unit tests verify: non-breaking changes are auto-approved, breaking changes create pending requests, approval changes status and enables emission, rejection blocks emission, only Steward/Admin can approve/reject, audit trail records all decisions
**And** a Playwright E2E test verifies: making a breaking change → Emit button shows "Pending Approval" → navigating to Governance Dashboard → request appears → approving → returning to entity → Emit button is enabled → emitting succeeds

---

### Story 5.3: Change Impact Reports

As a **data steward**,
I want to see a detailed impact report for every breaking change showing per-target compatibility and affected consumers,
So that I can make informed approval decisions.

**Acceptance Criteria:**

**Given** governance workflow exists (Story 5.2 complete)
**When** impact report generation is implemented
**Then** the governance service generates an **impact report** when creating a governance request — stored in `governance_requests.impactReport` JSONB
**And** the impact report contains: `{ summary: string, changeClassification: ChangeClassification, perTarget: [{ target, compatible, migrationRequired, migrationComplexity: "trivial"|"moderate"|"complex", details: string }], affectedConsumers: [{ entityName, fieldName, relationship, ownerEmail }], migrationArtifactsSummary: { bigquery: string, avro: string, openapi: string } }`
**And** **Per-target compatibility** is computed by running the migration artifact generator (Story 4.4) for each enabled target — the report summarizes whether each target can accept the change, what migration is needed, and how complex it is
**And** **Affected consumers** are identified by querying entity relationships: any entity that has a reference to the changed entity is an affected consumer — the report lists the entity name, the specific reference field, and the owner's email
**And** the impact report is displayed in the **Governance Dashboard** when viewing a request — a formatted card showing: summary, per-target breakdown (table with target, status icon, complexity badge), affected consumers list, and migration artifacts preview (collapsible)
**And** the impact report is also included in **notifications** sent to approvers (Story 7 — Epic 7 will add notification delivery, but the report content is generated here)
**And** the impact report is available via the `/compatibility` API endpoint response (enhancing Story 3.8)
**And** unit tests verify: impact report correctly identifies per-target compatibility for mixed breaking/non-breaking changes, affected consumers are correctly identified via relationship references, migration complexity is accurately classified
**And** a Playwright E2E test verifies: a breaking change creates a governance request with impact report → the report is visible in the Governance Dashboard → per-target breakdown shows correct status → affected consumers are listed

---

### Story 5.4: Per-Target Staged Emission

As a **data steward**,
I want to emit a schema change to some targets while holding others pending approval or readiness,
So that I can stage deployments progressively without blocking all targets.

**Acceptance Criteria:**

**Given** governance and impact reports work (Stories 5.2-5.3 complete)
**When** per-target staged emission is implemented
**Then** the **Emit dialog** (triggered by clicking Emit on an entity with a breaking change) shows a **per-target checklist** instead of emitting to all targets at once
**And** the checklist shows each enabled target with: target name, compatibility status (badge), migration complexity, and a checkbox to include/exclude from this emission batch
**And** targets that are **non-breaking compatible** are pre-checked by default; targets that are **breaking** are unchecked with an amber warning
**And** the user can check/uncheck individual targets — clicking "Emit Selected" emits only to the checked targets
**And** the `emission_targets` table tracks per-target emission status: targets that were emitted in this batch get updated with the new output and `lastEmittedAt`; targets that were held keep their previous emitted output
**And** the entity's **deployment tracking** (Status Bar and entity header) shows a per-target status: "v3 emitted" (green), "v2 current, v3 staged" (amber), helping the user see which targets have the latest version
**And** a **"Stage for Later"** option allows the user to mark a target for deferred emission — this creates a record indicating the target is awaiting readiness, and the governance request remains open for that target
**And** when a staged target is later ready, the user can return to the Emit dialog and emit to the remaining targets — the emission uses the same version snapshot (not the current entity state, which may have changed further)
**And** unit tests verify: partial emission only writes to selected targets, unselected targets retain previous output, staged emission stores the version snapshot for later use, emitting staged targets uses the correct snapshot
**And** a Playwright E2E test verifies: breaking change → Emit shows per-target checklist → unchecking one target → emitting → checked targets show v3 → unchecked target shows v2 → returning later and emitting the remaining target

---

## Epic 6: Compliance & Audit

Compliance officers can query all entities by classification, policy, retention, and target system. Gap detection identifies missing policies. Reports are exportable as auditable artifacts. Users can add inline annotations and tag others. The system maintains an immutable audit trail of all changes, overrides, and governance decisions.

### Story 6.1: Compliance Query Dashboard

As a **compliance officer**,
I want to query all entities and fields by classification, policy, retention, and target system,
So that I can instantly find all regulated data across the entire schema repository.

**Acceptance Criteria:**

**Given** entities exist with classification and policy decorators (Epics 2-3 complete)
**When** the compliance dashboard is implemented
**Then** the **Compliance** view (Activity Bar → Compliance) displays a full-width query interface with a **filter sidebar** on the left and a **results table** in the center
**And** the filter sidebar provides the following filter controls (all combinable):
**And** **Classification filter**: multi-select checkboxes for PII, SENSITIVE, INTERNAL, PUBLIC, and any custom classifications — selecting one or more filters results to fields matching those classifications
**And** **Policy filter**: retention period range (dropdown: any, < 1 year, 1-3 years, 3-7 years, > 7 years), anonymization method (dropdown: any, none, hash, mask, redact, pseudonymize), encryption (dropdown: any, none, AES-256, field-level)
**And** **Target system filter**: multi-select for enabled emission targets (BigQuery, Avro, OpenAPI) — filters to entities that have been emitted to the selected targets
**And** **Domain filter**: multi-select for all domains — filters to entities within selected domains
**And** **Text search**: free-text search across entity name, field name, and description
**And** the **results table** displays field-level results (not entity-level) with columns: Entity Name (link to editor), Field Name, Type, Classification (badge), Retention, Anonymization, Target Systems (badges), Domain
**And** results update in real-time as filters are changed (debounced 300ms)
**And** the results table supports **sorting** by any column (click header) and **pagination** (25 results per page with navigation)
**And** a **result count** is displayed above the table: "Showing X of Y fields matching filters"
**And** performance: queries across the full entity corpus (up to 5,000 entities) return in under 10 seconds (NFR5)
**And** the compliance service (`src/services/compliance.service.ts`) exports: `queryFields(filters, pagination, ctx): Result<{ fields: ComplianceFieldResult[], total: number }>`
**And** unit tests verify: each filter type correctly narrows results, combined filters work (AND logic), text search matches entity name/field name/description, pagination returns correct pages
**And** a Playwright E2E test verifies: navigating to Compliance dashboard, applying classification filter shows only matching fields, combining filters narrows results, sorting by column works, clearing filters shows all fields

---

### Story 6.2: Gap Detection & Compliance Alerts

As a **compliance officer**,
I want to identify fields with missing or incomplete compliance policies,
So that I can remediate governance gaps before audits.

**Acceptance Criteria:**

**Given** the compliance query dashboard works (Story 6.1 complete)
**When** gap detection is implemented
**Then** the compliance dashboard includes a **"Gaps"** tab alongside the main query tab — switching to it shows a gap analysis view
**And** the gap analysis automatically detects and displays the following gap types:
**And** **PII fields without anonymization policy**: fields classified as PII where `policy.anonymization` is "none" or not set — displayed with red severity badge
**And** **SENSITIVE fields without encryption**: fields classified as SENSITIVE where `policy.encryption` is "none" or not set — displayed with amber severity badge
**And** **Fields without classification**: any field where classification is not set — displayed with red severity badge "Unclassified"
**And** **Fields without retention policy**: fields with classification PII or SENSITIVE where `policy.retention` is not set — displayed with amber severity badge
**And** each gap is displayed as a row in a DataTable: Entity Name, Field Name, Gap Type (badge), Severity (badge), Suggested Fix
**And** the **Suggested Fix** column provides actionable text: e.g., "Set anonymization policy for PII field" or "Add classification to field"
**And** clicking a gap row navigates to the entity editor with the specific field selected and the relevant decorator tab (Classification or Policy) open in the right panel
**And** a **gap summary** is displayed above the table: "X critical gaps, Y warnings across Z entities" with counts per gap type
**And** the compliance service exports: `detectGaps(filters, ctx): Result<{ gaps: ComplianceGap[], summary: GapSummary }>`
**And** unit tests verify: PII without anonymization is detected, SENSITIVE without encryption is detected, unclassified fields are detected, gap counts are correct, clicking a gap navigates to the correct field
**And** a Playwright E2E test verifies: navigating to Gaps tab shows detected gaps, clicking a gap navigates to the entity editor with the correct field selected

---

### Story 6.3: Compliance Report Export

As a **compliance officer**,
I want to export compliance query results and gap analysis as auditable reports,
So that I can provide evidence to auditors without manual data collection.

**Acceptance Criteria:**

**Given** compliance queries and gap detection work (Stories 6.1-6.2 complete)
**When** report export is implemented
**Then** the compliance dashboard has an **"Export"** button (secondary button in the top-right) that opens an export options popover
**And** the export popover offers format options: **CSV** (tabular data) and **PDF** (formatted report with headers and summary)
**And** **CSV export** includes all currently filtered/visible fields with columns: Entity, Field, Type, Classification, Retention, Anonymization, Encryption, Targets, Domain, Gap Type (if on Gaps tab) — respecting current filters and sort order
**And** **PDF export** generates a formatted report with: report title ("Super Schema Compliance Report"), generation date, applied filters summary, total counts, a table of all matching fields, gap analysis summary (if exported from Gaps tab), and a footer with "Generated by Super Schema — [date] — [user]"
**And** the export includes **all results** (not just the current page) — pagination is ignored for export
**And** the exported file name follows the pattern: `compliance-report-{date}-{filters}.{csv|pdf}` (e.g., `compliance-report-2026-04-02-pii.csv`)
**And** the export is triggered client-side (CSV via blob download, PDF via a library like jsPDF or server-generated) — no external service calls
**And** unit tests verify: CSV contains correct headers and data matching the filter, PDF generation produces a valid file, all results are included regardless of pagination
**And** a Playwright E2E test verifies: clicking Export → selecting CSV → file downloads with correct content, applying filters → export only includes filtered results

---

### Story 6.4: Inline Annotations & User Tagging

As a **data modeler**,
I want to add annotations to entities and fields and tag other users,
So that I can communicate context, flag issues, and collaborate on schema decisions.

**Acceptance Criteria:**

**Given** entities and fields can be browsed and edited (Epic 2 complete)
**When** inline annotations are implemented
**Then** the Prisma schema includes an `annotations` table: `id` (cuid), `entityId` (FK to entities, nullable), `fieldId` (FK to fields, nullable), `authorId` (FK to users), `content` (text), `taggedUserIds` (string[]), `resolved` (boolean, default false), `createdAt`, `updatedAt` — with constraint that either entityId or fieldId must be set
**And** the entity editor shows an **annotation icon** (comment bubble) on each field row — clicking it opens an annotation panel in the right panel
**And** the annotation panel shows existing annotations for the selected field as a **threaded list**: author avatar + name, timestamp (relative), content, tagged users as badges
**And** a **new annotation input** at the bottom of the panel: textarea with placeholder "Add a comment...", **@-mention** support (typing "@" opens a user dropdown with search), and a "Post" button
**And** @-mentioned users are stored in `taggedUserIds` and will receive a notification (when notifications are implemented in Epic 7)
**And** annotations can be marked as **resolved** (checkbox or "Resolve" button) — resolved annotations are visually muted and collapsible
**And** entity-level annotations are accessible via an "Annotations" section in the entity header — below the entity description
**And** the annotation icon on a field row shows a **count badge** when annotations exist (e.g., "3")
**And** annotations service (`src/services/annotation.service.ts`) exports: `createAnnotation(input, ctx): Result<Annotation>`, `getAnnotations(entityId?, fieldId?, ctx): Result<Annotation[]>`, `resolveAnnotation(id, ctx): Result<Annotation>`
**And** all annotation operations are recorded in the audit trail
**And** unit tests verify: annotation creation with tagged users, retrieval by entity and field, resolve marks annotation correctly, @-mention extracts user IDs
**And** a Playwright E2E test verifies: clicking annotation icon opens panel, posting an annotation appears in list, @-mention shows user dropdown, resolving an annotation changes its visual state

---

### Story 6.5: Immutable Audit Trail Viewer

As a **compliance officer**,
I want to view and query the complete immutable audit trail for the entire system,
So that I can demonstrate compliance and investigate any schema governance question.

**Acceptance Criteria:**

**Given** audit trail records exist from all previous epics (withAudit() in place since Story 2.1)
**When** the audit trail viewer is implemented
**Then** the **Compliance dashboard** includes an **"Audit Trail"** tab alongside Query and Gaps
**And** the audit trail tab displays a **system-wide chronological log** of all audit entries from the `audit_log` table in reverse chronological order
**And** each entry shows: timestamp (absolute + relative on hover), user (avatar + name), action (badge — e.g., "entity.create", "field.update", "governance.approve", "emission.commit"), entity type + entity name (link), and a summary of what changed
**And** expanding an entry shows: `beforeState` and `afterState` JSONB rendered as a formatted diff (JSON diff viewer — added properties in green, removed in red, changed in amber)
**And** the audit trail is **filterable** by: action type (multi-select), user (searchable dropdown), entity type (entities, fields, governance, emission, override), entity name (text search), date range (date pickers)
**And** the audit trail supports **pagination**: 50 entries per page with navigation
**And** a **"Export Audit Trail"** button exports the filtered audit entries as CSV with all columns including serialized beforeState/afterState
**And** the `audit_log` table's PostgreSQL trigger preventing UPDATE/DELETE is verified to be active — attempting to update or delete an audit record via raw SQL fails with an error
**And** unit tests verify: audit trail retrieval returns correct entries, filtering narrows results correctly, pagination works, export includes all filtered entries
**And** integration test: verify the PostgreSQL trigger — attempt to UPDATE and DELETE audit_log rows via raw Prisma query and confirm both fail
**And** a Playwright E2E test verifies: navigating to Audit Trail tab shows log entries, filtering by action type works, expanding an entry shows before/after diff, export downloads correctly

---

## Epic 7: Notifications & Webhooks

Users receive in-app notifications for governance workflow events (approval requests, change completions, drift alerts, comments/tags). Notification history is viewable with read/acknowledged status, persisted in the database. Webhook endpoints allow external integrations to consume governance events.

### Story 7.1: In-App Notification System

As a **data modeler**,
I want to receive in-app notifications when governance events affect my schemas,
So that I can respond to approvals, changes, and alerts without manually checking.

**Acceptance Criteria:**

**Given** governance workflows and annotations exist (Epics 5-6 complete)
**When** the notification system is implemented
**Then** the `notifications` table exists in Prisma: `id` (cuid), `userId` (FK to users — the notification recipient), `type` (enum: APPROVAL_REQUEST, APPROVAL_DECISION, CHANGE_COMPLETE, DRIFT_ALERT, ANNOTATION_TAG, ANNOTATION_REPLY, COMPLIANCE_GAP), `title` (string), `body` (text), `entityRef` (JSONB — `{ entityId, fieldId?, versionId? }` for navigation), `read` (boolean, default false), `createdAt`
**And** a **notification service** (`src/services/notification.service.ts`) exports: `createNotification(input, ctx): Result<Notification>`, `getNotificationsForUser(userId, filters, pagination, ctx): Result<{ notifications: Notification[], unreadCount: number }>`, `markAsRead(notificationId, ctx): Result<Notification>`, `markAllAsRead(userId, ctx): Result<void>`
**And** notifications are **automatically created** by the following triggers (integrated into existing services):
**And** **Governance approval request** → notify all Stewards in the entity's domain: "Approval needed: {entityName} v{version} — breaking change"
**And** **Governance decision** → notify the requestor: "Your change to {entityName} was approved/rejected by {stewardName}"
**And** **Annotation @-mention** → notify tagged users: "{authorName} tagged you on {entityName}.{fieldName}"
**And** **Emission complete** → notify the entity owner: "{entityName} v{version} emitted to {targetCount} targets"
**And** notification creation does NOT block the triggering operation — if notification creation fails, the original operation still succeeds (fire-and-forget with error logging)
**And** all notifications are persisted in the database for audit purposes (FR61)
**And** unit tests verify: each trigger creates the correct notification type with correct recipient, notification retrieval returns unread count, markAsRead updates correctly, notification failure doesn't block the triggering operation
**And** integration test: a full governance flow (breaking change → approval → emit) creates the expected chain of notifications for the correct users

---

### Story 7.2: Notification Center UI

As a **data modeler**,
I want to see my notifications in a dropdown panel and navigate to the source of each notification,
So that I can quickly review and act on governance events.

**Acceptance Criteria:**

**Given** the notification system exists (Story 7.1 complete)
**When** the notification center UI is implemented
**Then** the **notification bell icon** in the Top Bar shows a **red badge** with the unread notification count — the badge is hidden when count is 0
**And** clicking the bell icon opens the **NotificationCenter** component — a dropdown popover panel (320px wide, max 480px tall, scrollable)
**And** notifications are **grouped by type** with section headers: "Approvals", "Changes", "Mentions", "Alerts"
**And** each notification displays: type icon (colored by type), title (bold), body (truncated to 2 lines), relative timestamp ("5 min ago", "yesterday"), and unread indicator (blue dot on left edge)
**And** clicking a notification: marks it as read (blue dot disappears, badge count decrements), navigates to the source entity/field (using entityRef — opens the entity editor, selects the field if fieldId is present, opens the governance panel if it's an approval request), and closes the notification center
**And** a **"Mark all as read"** button at the top of the panel marks all notifications as read and clears the badge
**And** the notification list **polls for new notifications** every 30 seconds — new notifications are prepended to the list with a subtle slide-in animation
**And** an **empty state** is displayed when no notifications exist: "All caught up — no pending actions" with a checkmark icon
**And** the notification center shows the **last 50 notifications** — a "View All" link at the bottom navigates to a full-page notification history (simple DataTable with all columns: type, title, body, from, date, read status, with filtering)
**And** unit tests verify: badge count matches unread count, clicking notification marks as read, polling fetches new notifications, grouping by type works correctly
**And** a Playwright E2E test verifies: bell icon shows badge count, clicking opens panel, clicking a notification navigates to source entity, "Mark all as read" clears badge, empty state displays when no notifications

---

### Story 7.3: Webhook Infrastructure for External Integrations

As a **platform administrator**,
I want to configure webhook endpoints that receive governance events,
So that external tools (Slack, email, PagerDuty) can be notified of schema changes.

**Acceptance Criteria:**

**Given** the notification system exists (Story 7.1 complete)
**When** webhook infrastructure is implemented
**Then** the Prisma schema includes a `webhook_endpoints` table: `id` (cuid), `url` (string — the target URL), `events` (string[] — list of event types to subscribe to), `secret` (string — HMAC signing secret), `active` (boolean, default true), `createdBy` (FK to users), `createdAt`, `updatedAt`
**And** a **webhook service** (`src/services/webhook.service.ts`) exports: `createEndpoint(input, ctx): Result<WebhookEndpoint>`, `updateEndpoint(id, input, ctx): Result<WebhookEndpoint>`, `deleteEndpoint(id, ctx): Result<void>`, `getEndpoints(ctx): Result<WebhookEndpoint[]>`, `dispatchEvent(event, ctx): Promise<void>`
**And** subscribable event types include: `governance.request.created`, `governance.request.approved`, `governance.request.rejected`, `emission.completed`, `drift.detected`, `compliance.gap.detected`
**And** `dispatchEvent()` sends an HTTP POST to all active endpoints subscribed to the event type with: JSON payload containing `{ event: string, timestamp: string, data: object }`, HMAC-SHA256 signature in `X-Webhook-Signature` header computed with the endpoint's secret, and `Content-Type: application/json`
**And** dispatch is **fire-and-forget** — failures are logged but do not block the triggering operation; a `webhook_deliveries` table tracks delivery attempts: `id`, `endpointId`, `event`, `payload` (JSONB), `statusCode` (int, nullable), `error` (text, nullable), `deliveredAt`
**And** retry logic: failed deliveries (non-2xx response or timeout after 10s) are retried up to 3 times with exponential backoff (10s, 60s, 300s) — retries are managed via a simple queue checked on the next incoming request (no background worker for MVP)
**And** the webhook service is integrated into the notification service: when a notification-triggering event occurs, both in-app notification AND webhook dispatch happen
**And** webhook management UI is part of the **Admin panel** (Epic 8 will add the admin UI, but the service and data model are built here)
**And** only **Admin** role users can create/manage webhook endpoints
**And** unit tests verify: webhook dispatch sends correct payload with HMAC signature, failed delivery is logged, retry logic respects exponential backoff, only subscribed events are dispatched to each endpoint, admin-only access is enforced
**And** integration test: create webhook endpoint → trigger a governance event → verify HTTP request is sent with correct payload and signature

---

## Epic 8: Administration & Platform Management

Admins can manage users/roles (RBAC), create domain workspaces with policy templates, configure emitters and type mapping policies, monitor system health, and define custom classification taxonomies — all with zero-downtime.

### Story 8.1: User & Role Management (RBAC)

As an **administrator**,
I want to manage users and assign roles with domain-scoped permissions,
So that I can control who can author, approve, and administer schemas.

**Acceptance Criteria:**

**Given** basic authentication works (Epic 1 complete)
**When** RBAC user management is implemented
**Then** the Prisma schema includes a `user_roles` table: `id` (cuid), `userId` (FK to users), `role` (enum: VIEWER, AUTHOR, STEWARD, COMPLIANCE_OFFICER, ADMIN), `domainId` (FK to domains, nullable — null means system-level role), `createdAt`
**And** a user can have **multiple roles** — one per domain plus optionally a system-level role; the most permissive applicable role is used for any given action
**And** the RBAC model enforces permissions as defined in the Architecture document:
**And** **Viewer** (domain or system): read entities, view emissions, browse compliance
**And** **Author** (domain): Viewer + create/edit entities in that domain, emit, view governance
**And** **Steward** (domain): Author + approve/reject governance requests, create type mapping overrides
**And** **Compliance Officer** (system): query compliance across all domains, export reports, view audit trail
**And** **Admin** (system): all permissions + user/role management, domain management, emitter configuration, system health
**And** oRPC middleware is updated: `protectedProcedure` checks session; new `authorProcedure`, `stewardProcedure`, `complianceProcedure`, and `adminProcedure` base procedures check the required role (and domain scope where applicable) — unauthorized access returns `ORPCError('FORBIDDEN')` with message "Requires {role} role" and `suggestedFix: "Contact your administrator"`
**And** the **Admin Panel** (Activity Bar → Admin) includes a **Users tab** displaying a DataTable of all users: email, name, roles (badges per domain), last login, status
**And** clicking a user opens a detail panel: edit name, view linked auth providers, and a **roles editor** — a list of current roles (role + domain badge) with "Remove" button on each, and an "Add Role" button that opens a form: role dropdown + domain dropdown (or "System-level" checkbox for COMPLIANCE_OFFICER/ADMIN)
**And** only **Admin** role users can access the Admin Panel — non-admin users see the Admin icon in the Activity Bar grayed out with tooltip "Requires Admin role"
**And** the first user who registers in a fresh installation is automatically assigned the **Admin** role (bootstrap mechanism)
**And** an admin cannot remove their own Admin role (safety check) — attempting to do so shows error "Cannot remove your own admin role"
**And** unit tests verify: each role permits only its documented operations, domain-scoped roles only apply within their domain, system-level roles apply globally, most permissive role is used, first user gets Admin role, admin cannot self-remove
**And** integration test: create users with different roles → verify each user can/cannot perform expected operations via oRPC procedures
**And** a Playwright E2E test verifies: admin can view user list, add a role to a user, remove a role, non-admin user cannot access Admin panel

---

### Story 8.2: Domain Workspace Management & Policy Templates

As an **administrator**,
I want to create domain workspaces with policy templates that entities inherit,
So that teams have consistent default policies without manual configuration per entity.

**Acceptance Criteria:**

**Given** RBAC and the domain data model exist (Stories 2.1, 8.1 complete)
**When** domain workspace management is implemented
**Then** the **Admin Panel** includes a **Domains tab** displaying all domains in a DataTable: name, description, entity count, policy template status (badge: "Configured" or "No template"), created date
**And** clicking a domain opens a detail panel with:
**And** **Domain info** section: editable name, editable description
**And** **Policy template** section: a structured form for defining default policies that entities in this domain inherit:
**And** Default classification level (dropdown: PII, SENSITIVE, INTERNAL, PUBLIC, none)
**And** Default retention period (dropdown matching Policy tab options)
**And** Default quality rules (list of rule templates that can be added/removed — same UI as the field-level quality rules editor)
**And** Naming conventions (text input — e.g., "snake_case fields, PascalCase entities")
**And** The policy template is stored in `domains.policyTemplate` JSONB, validated by a Zod schema
**And** a **"+ Create Domain"** button opens a creation form: name (required, unique), description, and initial policy template (optional — can be configured later)
**And** when an entity is created in a domain with a policy template, the template values are **auto-populated** into each new field's decorators as defaults — the field shows an "↳ Inherited from {Domain}" badge next to inherited values
**And** inheritance is **flattened** per FR45c: the inherited values are written directly into the field's decorator JSONB at creation time — consumers reading the field see the full policy without needing to look up the domain; if a user edits an inherited value, the inheritance indicator is removed and the value becomes field-owned
**And** changing a domain's policy template does NOT retroactively update existing entities — it only affects new entities and new fields created after the change; a confirmation dialog warns: "Template changes apply to future entities only. Existing entities are not affected."
**And** unit tests verify: domain creation with policy template, entity creation inherits template values, editing inherited value removes inheritance, template change doesn't affect existing entities, domain name uniqueness
**And** a Playwright E2E test verifies: creating a domain with policy template, creating an entity in that domain → fields show inherited values, editing an inherited value removes the badge

---

### Story 8.3: Emitter Configuration & Type Mapping Administration

As an **administrator**,
I want to enable/disable emitter targets and configure type mapping policies,
So that I can control which emission formats are available and how types translate.

**Acceptance Criteria:**

**Given** emitters and type mapping exist (Epic 3 complete)
**When** emitter administration is implemented
**Then** the **Admin Panel** includes an **Emitters tab** displaying all available emitters in a card grid: emitter name, version, target format, status (badge: Enabled/Disabled), last emission timestamp, total emission count
**And** each emitter card has an **Enable/Disable toggle** — toggling changes the emitter's availability immediately (zero-downtime, FR44); disabled emitters do not appear in the emission preview tabs or the Emit dialog
**And** clicking an emitter card opens a detail panel showing:
**And** **Emitter info**: name, version, target format, description
**And** **Type mapping policies table**: all mapping rules for this target — source type, mapped type, lossy indicator, override indicator; each row is editable by Admin
**And** an "**Add Override**" button that allows creating a new global type mapping override (same form as Story 3.7 but accessible from admin without needing a specific entity context)
**And** a "**Test Emitter**" button that runs the emitter against a sample entity (user selects from existing entities via dropdown) and displays the output with validation result — this lets admins verify the emitter works before enabling it for all users
**And** emitter enable/disable state is stored in a `system_config` table (or an `emitter_config` table): `id`, `emitterName`, `enabled` (boolean), `configOverrides` (JSONB), `updatedBy`, `updatedAt`
**And** configuration changes are recorded in the audit trail
**And** changes take effect immediately — no restart required (FR44)
**And** unit tests verify: enabling/disabling emitter changes availability in emission service, type mapping admin edits are persisted, test emitter runs and returns output, config changes are audited
**And** a Playwright E2E test verifies: admin can enable/disable an emitter, disabled emitter doesn't appear in emission preview, testing emitter against a sample entity shows output

---

### Story 8.4: System Health Monitoring Dashboard

As an **administrator**,
I want to monitor system health, active users, schema counts, and emission metrics,
So that I can ensure the platform is operating correctly and understand usage patterns.

**Acceptance Criteria:**

**Given** the application is running with entities, emissions, and users (Epics 1-3 complete)
**When** the health dashboard is implemented
**Then** the **Admin Panel** includes a **Health tab** displaying a system health dashboard with the following sections:
**And** **Service Status** section: a status card showing: Application (green/red with uptime), Database (green/red with connection pool status), TypeSpec Compiler (green/red — tested by compiling a trivial schema)
**And** **Usage Metrics** section showing current counts: Total Entities, Total Fields, Total Domains, Total Users, Total Emissions (all time)
**And** **Activity Metrics** section showing recent activity: Active Users (last 24h — count of users who performed any action), Emissions Today, Schema Changes Today, Governance Requests Pending
**And** **Error Summary** section: count of TypeSpec compilation errors (last 24h), count of emission validation failures (last 24h), count of API errors (last 24h) — each clickable to see the error details from audit trail
**And** a **"Run Health Check"** button that actively tests: database connection (simple query), TypeSpec compiler (compile a trivial model), emitter validation (emit + validate a sample) — returns green/red per component with error details if failed
**And** all metrics are computed from existing data (audit_log, entity counts, emission_targets) — no separate metrics collection infrastructure for MVP
**And** metrics are **refreshed** when the Health tab is loaded and can be manually refreshed via a "Refresh" button — no auto-polling
**And** a `/api/v1/health` REST endpoint returns a JSON health check response: `{ status: "healthy"|"degraded"|"unhealthy", components: { database, compiler, emitters }, timestamp }` — this endpoint does NOT require authentication (for monitoring tools)
**And** unit tests verify: health check correctly reports component status, metrics queries return correct counts, `/health` endpoint returns correct response
**And** a Playwright E2E test verifies: Health tab shows all sections with data, Run Health Check returns results, error counts reflect actual errors

---

### Story 8.5: Custom Classification Taxonomy

As an **administrator**,
I want to define custom classification levels beyond the system defaults,
So that my organization can use its own data classification scheme.

**Acceptance Criteria:**

**Given** RBAC and the admin panel exist (Story 8.1 complete)
**When** custom classification taxonomy is implemented
**Then** the **Admin Panel** includes a **Classifications tab** displaying the classification taxonomy as an editable list
**And** **System default classifications** are displayed first: PII, SENSITIVE, INTERNAL, PUBLIC — these cannot be deleted but their display colors can be customized
**And** an **"Add Classification"** button opens a form: level name (required, unique, uppercase), display color (color picker or preset), description (text), and severity order (integer — determines sort order in dropdowns)
**And** custom classifications are stored in a `classification_levels` table: `id` (cuid), `name` (string, unique), `displayColor` (string — hex color), `bgColor` (string — hex with alpha for badge background), `textColor` (string — hex for badge text), `description` (text), `sortOrder` (int), `isSystem` (boolean — true for defaults, false for custom), `createdAt`
**And** the four system defaults (PII, SENSITIVE, INTERNAL, PUBLIC) are seeded with their existing colors from the UX design spec
**And** custom classifications appear in **all classification dropdowns** throughout the application — the field editor's classification selector, compliance query filters, and autocomplete suggestions all include custom levels
**And** custom classification badge colors render correctly using the configured colors
**And** deleting a custom classification is only allowed if **no fields** currently use it — attempting to delete a classification in use shows: "Cannot delete — {count} fields use this classification. Reassign them first."
**And** unit tests verify: custom classification appears in dropdowns, deletion blocked when in use, classification with same name as existing is rejected, sort order determines dropdown position
**And** a Playwright E2E test verifies: admin creates a custom classification → it appears in the field editor classification dropdown → assigning it to a field shows the correct badge color → attempting to delete while in use shows error

---

## Epic 9: Schema Registration & Deployment Tracking

Data engineers can import existing schemas (Avro, DDL, Protobuf) via bulk import, see drift detection between logical and implementation schemas, and track which emitted versions are deployed or staged across all target systems.

### Story 9.1: Schema Import & Bulk Import

As a **data engineer**,
I want to import existing Avro, BigQuery DDL, and Protobuf schemas into Super Schema,
So that I can register my production schemas without recreating them manually.

**Acceptance Criteria:**

**Given** entities and the emission pipeline exist (Epics 2-3 complete)
**When** schema import is implemented
**Then** the sidebar header includes an **"Import"** button (next to "+ New Entity") that opens an import dialog
**And** the import dialog supports three import modes:
**And** **Single file import**: drag-and-drop or file picker for one schema file — the system detects the format (Avro JSON, BigQuery DDL, Protobuf .proto) by file extension and content analysis
**And** **Bulk import**: drag-and-drop a folder or multiple files — the system processes each file and creates entities for each detected schema
**And** **Paste import**: a textarea where users can paste schema content directly — format auto-detected from content
**And** an **import service** (`src/services/import.service.ts`) exports: `importSchema(content, format, options, ctx): Result<ImportResult>` and `bulkImport(files, options, ctx): Result<BulkImportResult>`
**And** **Avro import parser** (`src/lib/importers/avro.importer.ts`): parses Avro JSON → creates entity with name from `name` field, fields from `fields` array, types mapped from Avro types to logical types (reverse of Avro emitter mapping), nullable detected from union types
**And** **BigQuery DDL import parser** (`src/lib/importers/bigquery.importer.ts`): parses CREATE TABLE DDL → extracts table name, column names/types, NULL/NOT NULL constraints, OPTIONS for descriptions — maps BigQuery types to logical types
**And** **Protobuf import parser** (`src/lib/importers/protobuf.importer.ts`): parses .proto file → extracts message name, field names/types/numbers, maps Protobuf types to logical types, preserves field numbers
**And** after parsing, the import shows a **review screen**: proposed entity with all parsed fields displayed in a preview table — entity name (editable), domain selector, and per-field: name, detected type, confidence indicator (green=high, amber=medium, red=low for ambiguous type mappings)
**And** the user can **edit any field** in the review screen before confirming import — adjusting types, adding classifications, or removing unwanted fields
**And** clicking "**Confirm Import**" creates the entity and all fields in the database
**And** for **bulk import**, a progress bar shows import progress ("Processing 5 of 23 files...") and a summary at the end: "Imported X entities, Y fields, Z warnings"
**And** import errors (unparseable files, unknown types) are displayed inline with "Skip" and "Manual Fix" options — the import continues for valid files
**And** imported entities are linked to their source format in entity metadata: `{ importedFrom: { format, originalContent, importedAt } }` — this enables drift detection (Story 9.2)
**And** unit tests verify: Avro parser extracts fields and types correctly, BigQuery parser handles CREATE TABLE with OPTIONS, Protobuf parser preserves field numbers, ambiguous type mappings show low confidence, bulk import handles mixed formats
**And** a Playwright E2E test verifies: single file import (Avro JSON) → review screen shows parsed entity → confirm creates entity with correct fields → entity appears in sidebar

---

### Story 9.2: Drift Detection Engine

As a **data engineer**,
I want to detect drift between my logical schema and registered implementation schemas,
So that I know when production schemas have diverged from the source of truth.

**Acceptance Criteria:**

**Given** schema import and emission exist (Stories 9.1, Epic 3 complete)
**When** drift detection is implemented
**Then** a **drift service** (`src/services/drift.service.ts`) exports: `detectDrift(entityId, ctx): Result<DriftReport>`, `detectDriftForAll(ctx): Result<DriftReport[]>`
**And** `DriftReport` contains: `{ entityId, entityName, targets: [{ targetFormat, driftStatus: "in-sync"|"drifted"|"unknown", differences: DriftDifference[] }] }` where `DriftDifference = { fieldName, type: "added"|"removed"|"type-mismatch"|"metadata-mismatch", logicalValue, implementationValue }`
**And** drift is detected by comparing: the **current emitted output** for each target (from `emission_targets.emittedOutput`) against the **imported/registered implementation** (from entity metadata `importedFrom.originalContent`)
**And** comparison logic uses the same parsers from the import service — parse both the emitted output and the registered implementation into a normalized field list, then diff them
**And** **In-sync**: all fields match (name, type, nullability) between logical emission and registered implementation
**And** **Drifted**: differences exist — added fields (in logical but not implementation), removed fields (in implementation but not logical), type mismatches, metadata mismatches
**And** the drift report is stored in the `deployment_tracking` table: `id`, `emissionTargetId` (FK), `environment` (string), `status` (DEPLOYED/STAGED/DRIFTED), `deployedVersionId` (FK to entity_versions, nullable), `driftReport` (JSONB), `checkedAt`
**And** drift detection runs **on-demand** (user clicks "Check Drift" on an entity) and can also be triggered via the API (`POST /api/v1/schemas/:id/drift`)
**And** drift indicators are displayed in the UI:
**And** **Sidebar**: entities with drift show an amber dot next to their name
**And** **Entity header**: a "Drift" badge shows per-target drift status (green/amber per target)
**And** **Deployment section** in the Right Panel (new tab): shows per-target drift status with expandable diff details
**And** a **notification** (type: DRIFT_ALERT) is created when drift is detected — sent to the entity owner
**And** unit tests verify: in-sync schemas produce no differences, added/removed fields are detected, type mismatches are detected, drift status is correctly categorized, drift report is stored
**And** a Playwright E2E test verifies: importing a schema → modifying the entity → running drift detection → drift badge appears → expanding shows differences

---

### Story 9.3: Deployment Tracking Dashboard

As a **data engineer**,
I want to see which schema versions are deployed to which systems with drift status,
So that I have a single view of schema state across all target systems.

**Acceptance Criteria:**

**Given** drift detection exists (Story 9.2 complete)
**When** the deployment tracking dashboard is implemented
**Then** the **entity editor** includes a "Deployment" tab in the Right Panel showing per-target deployment status
**And** each target row shows: target format icon + name, currently emitted version (e.g., "v3"), deployed version (e.g., "v2" if tracking is available, or "Unknown" if not tracked), drift status badge (In Sync/Drifted/Unknown), last checked timestamp
**And** a **"Check Drift"** button per target runs drift detection for that specific target and updates the status
**And** a **"Mark as Deployed"** button per target allows the user to manually mark a version as deployed to a target/environment — this is a manual tracking mechanism for MVP (automated deployment detection deferred to Phase 2)
**And** the **"Mark as Deployed"** dialog asks for: environment name (dropdown or text: "production", "staging", "development"), and confirms the version being marked
**And** the deployment status is tracked in the `deployment_tracking` table with the environment and version
**And** the **Status Bar** shows a compact deployment summary for the current entity: "Emitted: v3 | Deployed: BigQuery v3 ✓, Avro v2 ⚠️" — green check for in-sync, amber warning for version mismatch or drift
**And** a **system-wide deployment overview** is accessible from the Activity Bar → a new "Deployments" section under Schema Editor — this shows a DataTable of all entities with columns: Entity, Domain, Current Version, and per-target columns showing deployed version + drift status (color-coded)
**And** the deployment overview DataTable is sortable and filterable: filter by domain, drift status, target
**And** unit tests verify: marking a version as deployed updates tracking, drift status reflects correct version comparison, deployment overview shows all entities with correct status
**And** a Playwright E2E test verifies: entity Deployment tab shows per-target status, marking as deployed updates the display, Check Drift updates drift status, deployment overview shows system-wide status

---

## Epic 10: Git-Native Workflow

Schema definitions and emitted output are exported to Git repositories as version-controlled files. PR-based change review with compatibility reports. (MVP: export-only; bidirectional sync deferred to Phase 2.)

### Story 10.1: Git Export Service & Configuration

As a **data engineer**,
I want schema definitions and emitted output automatically exported to a Git repository,
So that my schemas are version-controlled, diffable, and consumable by downstream pipelines.

**Acceptance Criteria:**

**Given** entities can be versioned and emitted (Epics 2-4 complete)
**When** the Git export service is implemented
**Then** the Prisma schema includes a `git_config` table: `id` (cuid), `repositoryUrl` (string), `branch` (string, default "main"), `basePath` (string, default "schemas/"), `authMethod` (enum: SSH_KEY, PERSONAL_ACCESS_TOKEN, GITHUB_APP), `authCredential` (string — encrypted), `enabled` (boolean, default false), `lastSyncAt` (datetime, nullable), `lastSyncStatus` (enum: SUCCESS, FAILED, PENDING), `createdBy` (FK to users), `createdAt`, `updatedAt`
**And** a **Git export service** (`src/services/git.service.ts`) exports: `configureRepository(input, ctx): Result<GitConfig>`, `exportEntity(entityId, ctx): Result<GitExportResult>`, `exportAll(ctx): Result<GitExportResult>`, `testConnection(configId, ctx): Result<{ connected: boolean, error?: string }>`
**And** the export service writes files to the configured Git repository following the Architecture document's file structure:
**And** `{basePath}/{domain}/{entity}.superschema.json` — the logical entity definition (entity metadata + all fields with decorators as JSON)
**And** `{basePath}/{domain}/{entity}.bq.sql` — emitted BigQuery DDL (if BigQuery emitter is enabled)
**And** `{basePath}/{domain}/{entity}.avro.json` — emitted Avro schema (if Avro emitter is enabled)
**And** `{basePath}/{domain}/{entity}.openapi.yaml` — emitted OpenAPI schema (if OpenAPI emitter is enabled)
**And** each export creates a **Git commit** with message: "Update {entityName} v{version} — {changeSummary}" and the author set to the user who triggered the emission
**And** export is triggered **automatically on Emit** (when Git is configured and enabled) — after successful emission, the exported files are committed and pushed
**And** export is also available **manually** via a "Push to Git" button in the entity header (secondary button) and via the API (`POST /api/v1/schemas/:id/git-export`)
**And** the **Admin Panel** includes a **Git tab** for repository configuration: repository URL input, branch input, base path input, auth method selector (SSH key textarea / PAT input / GitHub App config), and a "Test Connection" button that verifies Git access
**And** if Git push fails (network error, auth failure, conflict), the error is logged and shown as a toast: "Git push failed: {reason}. Emission was saved locally." — the emission itself is NOT rolled back
**And** the `git_config.lastSyncAt` and `lastSyncStatus` track the last export attempt
**And** unit tests verify: export generates correct file paths and content, commit message includes entity name and version, export failure doesn't roll back emission, file structure matches architecture spec
**And** integration test (using a temporary Git repo): configure repository → emit entity → verify files are committed to the repo with correct structure

---

### Story 10.2: PR-Based Change Review with Compatibility Reports

As a **data engineer**,
I want schema changes exported as Git pull requests with compatibility reports,
So that team members can review schema changes through their existing Git workflow.

**Acceptance Criteria:**

**Given** Git export works (Story 10.1 complete)
**When** PR-based review is implemented
**Then** when a **breaking change** is emitted and Git is configured, the export service creates a **pull request** (instead of pushing directly to the main branch):
**And** a new branch is created: `schema/{entity-name}/v{version}` (e.g., `schema/transaction/v3`)
**And** the changed files are committed to the new branch
**And** a PR is created via the Git provider's API (GitHub initially — using `GITHUB_TOKEN` env var):
**And** PR title: "Schema: {entityName} v{version} — {changeType}"
**And** PR body includes: change summary (from change record), change classification (breaking/non-breaking), per-target compatibility report (from impact analysis), migration artifact summaries (ALTER statements, compatibility), governance approval status, and a link back to the entity in Super Schema UI
**And** **Non-breaking changes** are pushed directly to the configured branch (no PR) with a commit containing the change summary in the commit message
**And** the PR body is formatted as Markdown with collapsible sections for migration artifacts (using `<details>` tags)
**And** the Git config includes a `prReviewMode` setting: "always" (PR for all changes), "breaking-only" (PR only for breaking changes, default), or "never" (always direct push)
**And** the PR status is tracked in a `git_pull_requests` table: `id`, `entityId`, `versionId`, `prUrl` (string), `prNumber` (int), `status` (OPEN, MERGED, CLOSED), `createdAt`
**And** the entity's Git status is displayed in the entity header: "Git: pushed ✓" (green), "Git: PR #123 open" (amber link), or "Git: not configured" (muted)
**And** unit tests verify: breaking change creates PR with correct branch name, non-breaking change pushes directly, PR body includes all required sections (compatibility, migration, governance), prReviewMode setting controls behavior
**And** integration test (using GitHub API mock): emit a breaking change → PR is created with correct body → PR URL is stored in database

---

## Epic 11: AI-Assisted Authoring (Phase 3)

Data modelers can create schemas from natural language, get field/type/decorator suggestions from domain context, reference industry standards (schema.org, HL7/FHIR), and review entities against domain schemas for gaps.

### Story 11.1: Natural Language Entity Creation

As a **data modeler**,
I want to create entity schemas by describing them in natural language,
So that I can quickly scaffold schemas without manually adding each field.

**Acceptance Criteria:**

**Given** entity authoring works (Epic 2 complete)
**When** natural language entity creation is implemented
**Then** the "New Entity" creation flow includes an **"AI Assist"** toggle/tab — switching to it shows a textarea with placeholder: "Describe your entity... e.g., 'A customer entity for a fintech with PII financial fields, account information, and contact details'"
**And** an **AI service** (`src/services/ai.service.ts`) exports: `generateEntityFromDescription(description, domainContext, ctx): Result<EntitySuggestion>` where `EntitySuggestion = { entityName, description, fields: FieldSuggestion[] }` and `FieldSuggestion = { name, type, classification, description, confidence }`
**And** the AI service integrates with a **configurable LLM backend** — the architecture supports: local/self-hosted LLM (Ollama, vLLM) via `AI_PROVIDER` and `AI_BASE_URL` environment variables, with a fallback to disabled if not configured
**And** the LLM prompt includes: the user's description, the domain context (domain name, existing entities in domain for consistency), the available type system (string, integer, decimal, boolean, enum, array, map, reference, date, timestamp), and the classification options (PII, SENSITIVE, INTERNAL, PUBLIC)
**And** the generated suggestion is displayed in a **review interface** (same as the import review screen from Story 9.1): proposed entity name, description, and a field list where each field shows: name, suggested type, suggested classification, confidence indicator, and is fully editable
**And** the user can **accept all**, **accept individual fields**, **edit any field**, **add more fields**, or **remove unwanted fields** before confirming creation
**And** clicking "Create Entity" creates the entity with all accepted/edited fields — standard entity creation flow from that point
**And** if the AI backend is not configured (`AI_PROVIDER` not set), the "AI Assist" tab shows: "AI assistance is not configured. Contact your administrator to set up a local LLM." — the feature degrades gracefully
**And** the AI service does NOT send any schema data to external services — all communication is with the configured local/self-hosted LLM endpoint (FR: zero external calls at runtime)
**And** unit tests verify: AI service constructs correct prompt, suggestion parsing handles well-formed and malformed LLM responses, graceful degradation when AI is not configured, field confidence scoring works
**And** a Playwright E2E test (with mocked AI backend): entering a description → AI generates suggestions → review screen shows fields → editing and confirming creates the entity correctly

---

### Story 11.2: Schema Standard Reference Library

As a **data modeler**,
I want to reference industry schema standards (schema.org, HL7/FHIR, financial standards) when creating entities,
So that my schemas align with established conventions and I don't miss standard fields.

**Acceptance Criteria:**

**Given** entity authoring with autocomplete works (Epic 2 complete)
**When** the schema standard reference library is implemented
**Then** a **standards library** exists in `src/lib/schema-standards/` containing bundled JSON datasets for:
**And** **schema.org**: common entity templates (Person, Organization, Product, Event, Place, CreativeWork, etc.) with fields, types, and descriptions mapped to Super Schema's type system
**And** **Financial schemas**: common financial entity templates (Transaction, Account, Payment, Invoice, Currency) with fields including precision/scale for monetary values and appropriate PII/SENSITIVE classifications
**And** **Healthcare HL7/FHIR**: common healthcare entity templates (Patient, Practitioner, Observation, Condition, Medication) with appropriate PII classifications and compliance metadata
**And** each standard template contains: `{ standardName, entityName, description, fields: [{ name, type, classification, description, qualityRules? }], source, version }`
**And** the **entity creation flow** includes a **"From Standard"** option — a searchable dropdown showing all available standard templates grouped by source (schema.org, Financial, Healthcare)
**And** selecting a standard template **pre-populates** the entity with all standard fields — each field is marked with a "📋 From {standardName}" badge and is fully editable
**And** the **autocomplete system** (Story 2.6) is enhanced to include standard fields: when creating a field on a "Customer" entity, the autocomplete suggests fields from schema.org's Person/Customer standard that haven't been added yet
**And** a **"Review Against Standard"** button in the entity header allows comparing an existing entity against a selected standard — the result shows: matching fields (green), missing fields from the standard (amber, with "Add" button), extra fields not in the standard (neutral, no action needed)
**And** the standard library is **bundled** (not fetched at runtime) — fully offline-compatible, updated only with application releases
**And** the standards data is extensible — administrators can add custom standard templates via a JSON file in a configurable directory (deferred to future — for now, only bundled standards)
**And** unit tests verify: standard templates are valid JSON with correct structure, entity creation from standard populates all fields correctly, review against standard identifies matching/missing/extra fields, autocomplete includes standard suggestions
**And** a Playwright E2E test verifies: creating entity from schema.org Person standard → fields are pre-populated → editing a standard field removes the badge → review against standard shows matching/missing fields

---

### Story 11.3: AI-Assisted Field Suggestions from Domain Context

As a **data modeler**,
I want the system to suggest fields, types, and decorators based on entity name and domain context,
So that I get intelligent recommendations as I build out my schemas.

**Acceptance Criteria:**

**Given** entity authoring and the AI service exist (Stories 2.3, 11.1 complete)
**When** domain-context field suggestions are implemented
**Then** when a user creates a new entity and enters the **entity name**, the system generates field suggestions combining two sources:
**And** **Standard library match**: if the entity name matches or closely matches a standard template (e.g., "Customer" matches schema.org Person/Customer), suggest fields from that standard (no AI needed — rule-based)
**And** **AI-generated suggestions**: if AI is configured, the AI service generates field suggestions based on: entity name, domain context (other entities in the domain, common field patterns), and any description the user provided
**And** suggestions are displayed in a **suggestion panel** below the entity name input: "Suggested fields for '{entityName}':" with a list of suggested fields — each showing name, type, classification, and source (Standard/AI/Pattern)
**And** the user can **accept individual fields** (click "+" to add to entity), **accept all** (button at top), or **dismiss** (click X on the panel)
**And** accepted fields are added to the entity's field list with all suggested metadata pre-filled — the user can then edit as normal
**And** the suggestion panel appears **once** on entity creation (not on every visit) — a "Show Suggestions" button allows re-triggering
**And** suggestions are **ranked** by confidence: standard library matches first (highest confidence), then AI suggestions (medium confidence), then pattern-based suggestions (lower confidence)
**And** if AI is not configured, only standard library and pattern-based suggestions are shown — the feature works without AI, just with fewer suggestions
**And** the field autocomplete (Story 2.6) is enhanced: when adding a field to an entity that has pending suggestions, the autocomplete dropdown shows "Suggested" fields at the top (separated by a header) before standard autocomplete results
**And** unit tests verify: entity name matching against standards works (exact and fuzzy), AI suggestions are ranked by confidence, accepting a suggestion adds the field correctly, dismissing hides the panel, suggestions work without AI configured
**And** a Playwright E2E test verifies: creating entity "Customer" → suggestion panel shows fields from schema.org → accepting individual fields adds them → dismissing hides panel

---

### Story 11.4: AI-Enhanced Schema Import with Confidence Scoring

As a **data engineer**,
I want AI-assisted field matching during schema import with confidence scores,
So that ambiguous type mappings and field matches are resolved intelligently rather than manually.

**Acceptance Criteria:**

**Given** the schema import service (Story 9.1) and AI service (Story 11.1) exist
**When** AI-enhanced import is implemented
**Then** the import service's `importSchema()` function is enhanced: when the AI service is configured, after the deterministic parser extracts fields, the AI service is called to improve field matching and type resolution
**And** the AI service provides: improved type suggestions for ambiguous mappings (e.g., a BigQuery STRING column named "amount" → AI suggests `decimal` instead of `string`), confidence scores (0.0-1.0) for each field's type mapping, and suggested classifications based on field names and context
**And** the import review screen displays AI-enhanced confidence indicators: high confidence (> 0.8, green), medium confidence (0.5-0.8, amber), low confidence (< 0.5, red with "Review recommended" badge)
**And** for bulk import, the AI service processes each file and provides per-entity mapping suggestions with an overall quality score
**And** the AI service prompt includes: the source schema content, the target logical type system, existing entities in the target domain for naming consistency, and the classification taxonomy
**And** if the AI service is not configured, the import falls back to deterministic parsing with rule-based confidence scores (same as Story 9.1 baseline behavior) — no degradation
**And** unit tests verify: AI-enhanced import produces higher confidence scores than deterministic-only for ambiguous types, AI suggestions are correctly merged with parser output, graceful fallback when AI is not configured
**And** a Playwright E2E test (with mocked AI backend): importing an ambiguous schema → AI-enhanced confidence scores are displayed → AI type suggestions differ from deterministic defaults → accepting AI suggestions creates correct fields

