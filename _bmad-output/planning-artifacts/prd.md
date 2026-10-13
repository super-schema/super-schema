---
stepsCompleted: [step-01-init, step-02-discovery, step-02b-vision, step-02c-executive-summary, step-03-success, step-04-journeys, step-05-domain, step-06-innovation, step-07-project-type, step-08-scoping, step-09-functional, step-10-nonfunctional, step-11-polish, step-12-complete, step-e-01-discovery, step-e-02-review, step-e-03-edit]
inputDocuments:
  - '_bmad-output/planning-artifacts/product-brief-super-schema.md'
  - '_bmad-output/planning-artifacts/product-brief-super-schema-distillate.md'
  - '_bmad-output/brainstorming/brainstorming-session-2026-03-31-2345.md'
workflowType: 'prd'
documentCounts:
  briefs: 2
  research: 0
  brainstorming: 1
  projectDocs: 0
classification:
  projectType: web_app
  domain: data_infrastructure
  complexity: high
  projectContext: greenfield
lastEdited: '2026-10-12'
editHistory:
  - date: '2026-10-12'
    changes: 'TypeSpec-as-system-of-record architecture pivot — supersedes the original "TypeSpec as invisible intermediate representation" design. Redefines MVP: Phase 1 ships on TypeSpec source as the captured, canonical representation (governance decorator package for classification/retention/PII/etc., relational projection for fast queries, RBAC/audit/drift stay relational). Added Journey 7 (direct TypeSpec capture + bidirectional edit, also the e2e test case). Added FR73-77. Updated Performance/Reliability NFRs, added Concurrency and Versioning NFR sections.'
---

# Product Requirements Document - Super Schema

**Author:** Jay
**Date:** 2026-04-01

## Executive Summary

Super Schema is a full-stack web application that provides a visual, interactive interface for defining universal logical data schemas — eliminating the need for data teams to hand-write TypeSpec, Avro, Protobuf, or any platform-specific schema syntax, while every entry they make is captured directly as TypeSpec, the open, platform-agnostic modeling language. Users create and manage entity definitions through an intuitive UI with full governance metadata (data classification, retention policies, quality rules, lineage) expressed through a Super Schema governance decorator package, and the system automatically emits implementation-specific schemas to 15+ target platforms including BigQuery, Avro, Protobuf, OpenAPI, Spanner, and dbt.

> **Architecture note (2026-10-12):** This supersedes the original "TypeSpec as invisible intermediate representation" design (see Product Scope → Risk Mitigation and Domain-Specific Requirements → Risk Mitigations below for the superseded language and the reasoning for the change).

The core problem: schema definitions in modern enterprises are scattered across 6-10+ teams and tools, each maintained independently, each drifting silently. A single entity like "Customer" exists as Avro in Kafka, DDL in BigQuery, Protobuf for gRPC, OpenAPI for REST, and a row in a governance spreadsheet — with no single source of truth. The result is silent revenue leakage from precision loss, governance chaos where PII classification takes weeks to audit, and feature velocity collapse where engineers are blocked weeks waiting for cross-team schema alignment.

Super Schema solves this by making schema definition a UX problem, not a syntax problem. Data modelers open a web interface, define an entity with enforced precision and governance policies, and every downstream system receives a correctly typed, policy-enforced schema — automatically. The platform is fully open-source (Apache 2.0), designed for on-premise deployment, and positioned as the upstream schema kernel that complements existing catalogs (Atlan, Collibra), registries (Confluent), and transformation tools (dbt).

### What Makes This Special

**UI-first schema authoring, TypeSpec as the captured representation.** No other tool provides a visual interface for defining logical schemas that automatically emit to all major data platforms. Existing tools are either code-only (TypeSpec, Protobuf, Buf) or read-only catalogs (Atlan, Collibra, DataHub). Super Schema bridges the gap — the UI captures intent directly into TypeSpec source, governance metadata attaches through a custom decorator package, and emitters compile that TypeSpec to platform idiom. Because the captured representation is TypeSpec itself — not a proprietary internal format — any entity's definition is a portable, standards-compliant specification usable outside the platform. TypeSpec is open-source and forkable, ensuring zero vendor lock-in.

**Zero-disruption enterprise adoption.** Migration is registration, not regeneration. Existing production schemas (Avro files, BigQuery DDL, Protobuf definitions) get registered and mapped to logical schemas with progressive drift detection — no big-bang cutover. Day 1: register. Day 2: detect drift. Day 90: first entity fully governed.

**Compliance by construction.** Every field carries classification, retention, and policy metadata from authoring time. "Show me every PII field across all systems" is a UI query, not a 5-week archaeology project. Compliance evidence is a byproduct of normal schema work.

## Project Classification

- **Project Type:** Full-stack web application (SPA + RESTful API backend)
- **Domain:** Data infrastructure / data governance
- **Complexity:** High — 15+ emission targets, type mapping matrix, governance workflows, compliance requirements (GDPR, HIPAA, SOC 2), enterprise-grade reliability
- **Project Context:** Greenfield
- **Technology Stack:** To be determined
- **Deployment:** On-premise, fully open-source (Apache License 2.0)

## Success Criteria

### User Success

- **Instant emission:** A data modeler defines an entity in the UI and immediately sees valid, platform-specific schemas generated side by side — no waiting, no manual translation
- **Schema portability:** Any entity's definition can be exported as standards-compliant TypeSpec source, usable outside the platform with TypeSpec's own tooling (CLI, editor extensions, other TypeSpec-consuming systems) — no proprietary export format
- **Change management:** Users create change records comparing current and previous schema versions, with auto-generated migration artifacts (ALTER statements, evolution compatibility checks)
- **Full schema lifecycle in one place:** Create, browse, edit, version, and retire schemas entirely within the UI — no context-switching to separate tools
- **Deployment tracking:** Users see at a glance which schemas are generated, which systems they're deployed or staged to, and the current drift status across all registered implementations
- **Schema change orchestration:** The entire change management lifecycle — from authoring through impact analysis, approval, emission, and deployment tracking — is driven and monitored from the UI

### Business Success

- **Adoption is the metric.** Organizations integrate Super Schema into their data platform as the standard schema management layer
- **Framework integration:** Teams adopt Super Schema as an embedded part of their data engineering workflow — the schema kernel that existing tools plug into
- **Community traction:** Open-source contributors build emitters, integrations, and tooling that expand the ecosystem organically

### Technical Success

- **Emitter accuracy:** Every emitter produces syntactically and semantically correct output for its target platform
- **Built-in validation:** The platform performs syntactic validation of emitted schemas within the UI — users see immediately if generated output is valid
- **Issue detection with override:** Type mapping mismatches and emission issues are surfaced clearly with governed override options
- **Extensible testing:** Manual testing initially, with architecture supporting future validation against real target systems

### Measurable Outcomes

- Time from entity creation to valid emitted schemas: under 30 seconds via UI
- Time to generate migration artifacts for a schema change: under 1 minute
- Emitter syntactic correctness rate: 100% for all supported targets (validated within platform)
- Schema drift detection coverage: every registered implementation checked on each schema change

## Product Scope & Phased Development

### MVP Strategy

**Approach:** Platform MVP — prove "define once, emit everywhere" end-to-end with a complete vertical slice, built on TypeSpec as the captured, canonical representation from day one (not layered in later). The UI must feel production-ready for schema authoring, and the 3 core emitters must produce correct, validated output.

> **Scope decision (2026-10-12):** The TypeSpec-as-system-of-record architecture redefines MVP itself — Phase 1 ships on this model, full stop. It does not land as a later migration phase behind the original Prisma-row-based design.

**Resource Requirements:** Full-stack team with Node.js backend expertise (TypeSpec compiler is Node-based), frontend SPA expertise, and data engineering domain knowledge for emitter validation.

### Phase 1: MVP

**User Journeys Supported:**
- Journey 1 (Priya — First Schema Creation): Full coverage
- Journey 2 (Priya — Schema Change): Full coverage
- Journey 5 (Alex — Admin): Partial — containerized deployment, full auth (local + Gmail + SSO), no RBAC granularity yet
- Journey 6 (API Consumer): Partial — core API for validation and emission

**Must-Have Capabilities:**
- UI for schema authoring with all 8 decorator categories and enforced completeness, captured directly as TypeSpec source extended by the Super Schema governance decorator package
- Real-time TypeSpec compilation and validation on every save — no proprietary intermediate step
- Direct TypeSpec source viewing and editing for any entity, with changes reflected in the UI and vice versa
- 3 core emitters: Avro, BigQuery DDL, OpenAPI — with built-in syntactic validation
- Type translation policies — visible, configurable mapping rules with override mechanism
- Schema versioning with diff comparison
- Change record generation with migration artifacts (ALTER statements, compatibility reports)
- RESTful API for programmatic schema access, validation, and emission
- Authentication: local user management (email/password), Google sign-in, SSO (SAML 2.0 / OIDC)
- In-app notifications for governance events, persisted in database
- Git-native workflow: schema export to Git, PR-based change review with compatibility reports
- Containerized deployment (Docker)

### Phase 2: Growth

- Extended emitters: Protobuf, Spanner DDL, PostgreSQL DDL, dbt models, TypeScript interfaces, Java POJO, Data Catalog JSON, HTML docs
- Schema registration & drift detection for existing schemas (bulk import with AI-assisted mapping)
- Deployment tracking dashboard — schema versions across target systems with drift indicators
- Governance workflows — impact analysis, approval routing, notification hooks, audit trails
- Compliance queryability — filter by classification, policy, target with instant results and export
- Role-based access control with granular permissions
- Domain/workspace management with domain-level policy templates and inheritance
- Full coverage: Journey 3 (Raj — Compliance), Journey 4 (Maya — Governance), Journey 5 (Alex — Full Admin)

### Phase 3: Expansion

- AI-assisted authoring — natural language entity creation, field suggestions, schema standard references
- Semantic layer bridging — business metric composition annotations
- Schema commons — curated canonical domain schemas shareable across organizations
- Catalog/registry integration — native connectors for Atlan, Collibra, DataHub, Confluent
- Compliance platform integration — OneTrust, BigID, Securiti
- Real-system validation — test emitted schemas against actual target systems
- Emitter plugin marketplace with stability contracts and versioned API
- CI/CD integration — PR comment bots, pipeline quality gates
- Full coverage: Journey 6 (API Consumer — CI/CD bot and webhook support)

### Risk Mitigation

**Technical:** Emitter correctness across 15+ targets is the hardest challenge. Mitigated by starting with 3 well-understood targets and validating thoroughly.

> **Superseded (2026-10-12):** The original mitigation read *"TypeSpec IR limitations mitigated by custom decorators and abstraction layer"* — i.e., TypeSpec was kept invisible and swappable specifically to contain its limitations. That framing is reversed: TypeSpec is now the accepted, permanent captured representation, not something to abstract away. The real risks this uncovers — and how they're contained — are: (1) governance/audit/RBAC/drift data that TypeSpec's document model has no primitive for stays in a relational layer, never forced into decorators (see Domain-Specific Requirements → Technical Constraints); (2) concurrent edits to the same entity are handled with optimistic-locking conflict detection, not true merge, for MVP; (3) every compiler upgrade is a controlled, tested event because TypeSpec is now load-bearing, not a disposable export step.

**Market:** Teams may resist centralizing schema authoring. Mitigated by "one team, no org buy-in" adoption track. Competitive window from catalog vendors mitigated by shipping core value proposition first.

**Resource:** TypeSpec expertise is the scarcest skill — mitigated by the visual UI being the primary authoring surface for most users; direct TypeSpec editing is available but optional. Reduced scope fallback: ship with 2 emitters (Avro + BigQuery), deferring OpenAPI to early Phase 2.

## User Journeys

### Journey 1: Priya, Staff Data Engineer — First Schema Creation

**Opening Scene:** Priya has been at a fintech company for 4 years. She maintains 150+ Avro schemas across Kafka topics, a growing BigQuery warehouse, and a set of gRPC services. Every time a field changes on the "Transaction" entity, she manually updates the Avro schema, the BigQuery DDL, the Protobuf definition, and a Confluence page that nobody trusts. Last month, a `decimal` precision mismatch between Avro and BigQuery silently corrupted 3 days of settlement reports.

**Rising Action:** Priya opens the Super Schema UI and creates a new entity: "Transaction." She adds fields through the visual editor — `transaction_id` (string, key), `amount` (decimal with precision 19, scale 4 — the system won't let her skip scale), `currency` (string, ISO 4217). For each field, she sets classification (amount is SENSITIVE), retention policy (7 years), and quality rules (amount > 0). The UI enforces completeness — she can't save without classification on every field.

**Climax:** She clicks "Emit" and instantly sees two panels: a valid BigQuery DDL with `NUMERIC(19,4)`, column OPTIONS for description and classification, and partitioning hints — alongside a valid Avro schema with `bytes` logical type `decimal`. Both syntactically validated in-platform with green checkmarks. One definition, two correct outputs, zero manual translation.

**Resolution:** Priya registers her existing 150 Avro schemas through bulk import. Within a week, Super Schema is detecting drift between her Avro and BigQuery definitions — fields she didn't even know had diverged. She never manually writes an Avro schema again.

**Requirements revealed:** Schema authoring UI with enforced completeness, multi-target emission with side-by-side preview, built-in syntactic validation, bulk schema import/registration, drift detection.

---

### Journey 2: Priya, Staff Data Engineer — Schema Change with Migration Artifacts

**Opening Scene:** Three months later, the product team needs to add a `risk_score` field (decimal, 0.0–1.0) to the Transaction entity and rename `currency` to `currency_code` to align with the ISO standard.

**Rising Action:** She adds the new field with full metadata — classification (INTERNAL), quality rules (range 0.0–1.0), lineage (source: ML risk model v3). She renames `currency` to `currency_code` and adds an alias preserving the old name. The system generates a change record showing the diff between v2 and v3.

**Climax:** She clicks "Generate Migration" and sees: a BigQuery `ALTER TABLE` statement adding the column with correct type and OPTIONS, an Avro schema evolution compatibility report confirming backward compatibility, and a Protobuf impact warning — the rename requires a field number decision. The system flags the Protobuf issue and offers a governed override.

**Resolution:** Priya approves the override for Protobuf (keeping the old field number with the new name), the change record is versioned, and all three emitted schemas update atomically. The deployment tracker shows which environments have the new version and which still run v2.

**Requirements revealed:** Schema versioning with diff, change record generation, ALTER statement generation, evolution compatibility checking, governed overrides, deployment version tracking.

---

### Journey 3: Raj, Chief Data Officer — Compliance Audit

**Opening Scene:** Raj receives notice that the company's SOC 2 audit is in 3 weeks. The auditors want a complete inventory of every system storing PII, what anonymization is applied, and what retention policies govern each field. Last year, this took his team 6 weeks of spreadsheet archaeology across 12 teams.

**Rising Action:** Raj navigates to the compliance query interface and searches: "classification = PII." Instantly, he sees every entity with PII fields, which specific fields are classified, what retention and anonymization policies are attached, and which target systems each entity is emitted to.

**Climax:** He filters to "PII fields without anonymization policy" — three fields surface. One is a newly added field where the data engineer forgot to set anonymization. He flags it for remediation and adds an inline comment tagging the data steward.

**Resolution:** Raj exports the compliance report — a complete, auditable record of PII classification, retention policies, and anonymization coverage across every entity and every target system. What took 6 weeks last year takes 20 minutes.

**Requirements revealed:** Compliance query UI (filter by classification, policy, target), gap detection, export/reporting, inline annotation and tagging, audit trail.

---

### Journey 4: Maya, ML Engineer — Model Output Schema Change

**Opening Scene:** Maya has retrained the fraud detection model. The `risk_score` output changed from an integer (0–100) to a probability float (0.0–1.0). In the old world, she'd just update her model serving config and deploy — downstream teams would discover the type change when their pipelines broke.

**Rising Action:** She changes `risk_score` from `integer` to `decimal(3,2)` in the UI. The system runs impact analysis: 4 downstream consumers are registered. The change is classified as "breaking — data type modification" and triggers the governance workflow.

**Climax:** The system generates a change impact report: BigQuery needs an ALTER (safe), Avro needs a new schema version (backward-incompatible), the REST API contract changes, and the dashboard needs to handle the new range. Notifications go to the data steward and all four consuming team leads.

**Resolution:** The data steward and three of four teams approve within 2 days. The dashboard team requests a 1-week delay. The change is staged but not emitted to the dashboard target until the team confirms readiness. Maya's model deploys on schedule, and no downstream system is surprised.

**Requirements revealed:** Impact analysis engine, governance workflow with approval routing, per-target staged emission, notification system, change status tracking.

---

### Journey 5: Alex, Platform Admin — On-Premise Deployment and Configuration

**Opening Scene:** Alex is a DevOps engineer deploying Super Schema on-premise for a financial services company. All data tooling must be behind their firewall with no external dependencies.

**Rising Action:** Alex pulls container images, deploys to Kubernetes, configures the database backend, sets up SSO integration, and defines user roles — schema authors, data stewards, compliance officers, and read-only viewers. He configures available emitter targets (BigQuery, Avro, Protobuf — no OpenAPI, per company policy).

**Climax:** System health check passes — all services green, TypeSpec compiler operational, emitters validate correctly. He onboards the first team by creating their domain workspace and importing existing Avro schemas.

**Resolution:** Alex monitors via the admin dashboard — active users, schema count, emission frequency, validation error rates. When a new team requests Spanner DDL emission, he enables the emitter plugin and configures Spanner-specific type mapping policies without downtime.

**Requirements revealed:** Containerized deployment, SSO/identity integration, RBAC, configurable emitter availability, admin dashboard, domain/workspace management, emitter plugin management, zero-downtime configuration.

---

### Journey 6: DevOps Pipeline — API Consumer / CI/CD Integration

**Opening Scene:** The platform team has integrated Super Schema's API into their CI/CD pipeline. Every PR that touches a schema definition triggers an automated validation check.

**Rising Action:** A developer modifies the `Customer` entity — adding an `email_verified` boolean field. The CI pipeline calls the Super Schema API to validate, run compatibility checks, and generate a change impact summary.

**Climax:** The API returns a structured response: non-breaking change, all emitters handle it, no governance approval required (auto-approved per policy). The CI check passes green. The PR comment bot posts: "Schema change validated — non-breaking addition. Avro: backward-compatible. BigQuery: ALTER ADD COLUMN. No approval required."

**Resolution:** On merge, the pipeline calls the API to emit updated schemas to all targets and update the deployment tracker. Breaking changes would fail the CI check with a detailed explanation and a link to initiate governance approval in the UI.

**Requirements revealed:** RESTful API for validation, compatibility checking, emission triggering, and deployment tracking. Structured response format for CI/CD. Webhook/event support. Distinct breaking vs non-breaking handling.

---

### Journey 7: Priya, Staff Data Engineer — Direct TypeSpec Capture and Bidirectional Edit

**Opening Scene:** Priya has been using Super Schema's visual editor for a month. Her team's DevOps lead asks whether the "Transaction" entity can be reviewed the same way they review code — as a diffable text file in a PR — rather than only through the UI.

**Rising Action:** Priya opens the "Transaction" entity and switches to the TypeSpec source view. She sees the exact `.tsp` document the platform has been building from her UI actions all along — not a generated preview, the actual stored representation:
```tsp
@businessOwner("payments-team")
model Transaction {
  @key id: string;

  @dataClassification(DataClassification.FINANCIAL)
  @precision(19, 4)
  amount: decimal;

  @dataClassification(DataClassification.PII)
  @pii
  @anonymization(AnonymizationStrategy.tokenize)
  cardNumber: string;
}
```
She edits the text directly, adding a `risk_score` field with a decimal type but no `@precision`. She saves.

**Climax:** The real TypeSpec compiler rejects the save inline, in under 2 seconds: "`decimal-requires-precision`: Property 'risk_score' appears to be decimal/numeric but has no `@precision` specified" — a governance-package linter diagnostic, not a generic parse error. The entity's last valid version remains untouched; nothing corrupts. Priya adds `@precision(5, 4)`, saves again — this time it compiles clean, and the visual field editor instantly reflects the new `risk_score` field with its precision already populated, as if she'd added it through the form.

**Resolution:** Priya exports the entity's TypeSpec source and hands it to the DevOps lead, who reviews it in a PR alongside a generated diff, with no knowledge of Super Schema's UI required. Two days later, a teammate edits `cardNumber`'s classification through the visual UI; Priya's next text-view load shows that change already merged into the source — same document, two authoring surfaces, no divergence.

**Requirements revealed:** Direct TypeSpec source view/edit per entity, real-compiler validation on save (not just syntax — governance-package lint rules), bidirectional consistency between the visual UI and the text view, portable export for external review, last-known-good preserved on a failed save.

---

### Journey Requirements Summary

| Capability Area | Journeys |
|---|---|
| Schema authoring UI (CRUD + decorators) | 1, 2 |
| Multi-target emission with preview | 1, 2 |
| Built-in syntactic validation | 1, 6 |
| Schema versioning and diff | 2, 4 |
| Change records and migration artifacts | 2, 4 |
| Bulk schema import/registration | 1 |
| Drift detection | 1 |
| Compliance query and reporting | 3 |
| Governance workflow (impact analysis, approvals, notifications) | 2, 4 |
| Per-target staged emission | 4 |
| Deployment tracking | 1, 2, 4, 6 |
| Admin: deployment, SSO, RBAC | 5 |
| Admin: system health, monitoring | 5 |
| Admin: domain/workspace management | 5 |
| Admin: emitter plugin management | 5 |
| RESTful API for programmatic access | 6 |
| CI/CD integration | 6 |
| Governed overrides | 2 |
| Direct TypeSpec source view/edit | 7 |
| Real-compiler validation with governance lint rules | 7 |
| Portable TypeSpec export | 7 |

## Domain-Specific Requirements

### Compliance & Regulatory

- Super Schema enables compliance for its users — the compliance metadata model (classifications, retention, anonymization policies) must support GDPR, HIPAA, SOC 2, CCPA, and emerging EU AI Act requirements
- The audit trail for all schema changes, overrides, and governance decisions must be immutable and exportable for auditor consumption
- Classification taxonomy must be extensible — organizations define their own classification levels beyond defaults (PII, SENSITIVE, INTERNAL, PUBLIC)

### Technical Constraints

- **Emitter correctness is existential:** A subtly wrong emitted schema that corrupts production data destroys platform credibility permanently. All emitter output must be syntactically validated within the platform before delivery.
- **On-premise with zero external dependencies:** No cloud service calls, no telemetry, no license servers at runtime. Fully self-contained behind a firewall.
- **TypeSpec compiler runs server-side, in the critical path of every save:** Node.js runtime required. Unlike a purely emission-time compile, the compiler now validates every entity edit before it persists — this is the real-time authoring loop, not a background batch step.
- **Governance, audit, and operational state stay relational, by design:** Role assignments, the immutable audit trail, deployment/drift tracking, and session state are not representable as TypeSpec document content — they describe facts about users, history, and external systems, not about the schema itself. These remain in the relational database alongside the TypeSpec source; they are never forced into decorators.
- **Concurrent schema editing:** Multiple teams editing different entities simultaneously is unconstrained. Two edits to the *same* entity at once are resolved via optimistic version checking — the second save is rejected with a conflict notice, not silently overwritten and not automatically merged, for MVP.
- **Schema volume:** Must support thousands of entities across dozens of domains without performance degradation. A relational projection of each entity's fields, regenerated from its TypeSpec source on every save, keeps governance queries and list views fast without re-parsing TypeSpec per request.

### Integration Requirements

- **Identity providers:** SAML 2.0 and OIDC for enterprise SSO
- **API stability:** Versioned with backward-compatibility guarantees — CI/CD pipelines cannot tolerate breaking changes
- **Emitter plugin interface:** Stable, semantically versioned. Breaking changes require major version bump with 6-month deprecation notice.
- **Notification hooks:** Webhooks for governance workflow events to integrate with Slack, email, PagerDuty, Jira

### Risk Mitigations

> **Superseded (2026-10-12):** *"TypeSpec dependency: Open-source (MIT), forkable. IR layer abstracted — swapping TypeSpec is feasible without changing UI or external API."* TypeSpec is no longer swapped-away-from; it is the permanent captured representation. The vendor/project-risk mitigation now rests on TypeSpec being an open specification and a forkable compiler — if the upstream project stalled, every entity's data remains a readable, portable `.tsp` file, not a proprietary blob locked to a specific compiler build.

- **Emitter maintenance:** Community contribution model with stability contracts. Core emitters (Avro, BigQuery, OpenAPI) project-maintained; extended emitters community-maintained.
- **Schema migration safety:** Registration never modifies or deletes existing production schemas. Read-only mapping with drift reporting. The system only generates artifacts.
- **Data sovereignty:** All data remains within customer infrastructure. No data leaves the deployment perimeter.

## Innovation & Novel Patterns

### Detected Innovation Areas

**1. UI-First Schema Authoring with Invisible IR.** No existing tool provides a visual interface for defining logical schemas that automatically emit to all major data platforms — combining the accessibility of a visual editor with a compiler-based emission pipeline. The closest analogy: Figma made visual design accessible without requiring CSS. Super Schema makes schema definition accessible without requiring TypeSpec, Avro, or DDL.

**2. Universal Logical Schema Layer.** The first tool to treat the logical schema as a distinct architectural layer with its own type system, decorator model, and translation policies — then emit to all targets from that single source. Existing tools are format-specific (Confluent for Avro, Buf for Protobuf, dbt for SQL).

**3. Translation Policies as First-Class Architecture.** Type mapping rules as a visible, configurable, versionable layer between logical schema and emitters — not buried in code. No existing tool surfaces this as a user-controllable, auditable layer with governed overrides.

**4. Migration by Registration.** Zero-disruption adoption: register existing schemas, detect drift progressively, never force regeneration. Every competitor requires "migrate everything first." This eliminates the biggest enterprise adoption blocker.

**5. The UI's Output Is the Portable Artifact.** Every other visual schema tool produces a proprietary export or a read-only snapshot. Super Schema's visual editor writes directly into TypeSpec source — what the UI produces *is* a standards-compliant specification file, reviewable, diffable, and usable with TypeSpec's own ecosystem outside the platform, not an internal format translated into TypeSpec as an afterthought.

### Market Context

- No direct competitor combines UI-based authoring + multi-format emission + governance
- Category analogy: "Terraform for data schemas" — declarative, version-controlled, multi-target
- The data contracts movement has created demand for enforcement infrastructure with no tool filling it
- TypeSpec's maturation makes this technically feasible now — wasn't possible 2 years ago

### Validation Approach

- **Core hypothesis:** Data teams will adopt UI-based schema authoring if emitted output is correct and migration is non-disruptive
- **Validation method:** Generate schemas for known entities and compare against hand-written originals. Built-in syntactic validation provides continuous assurance.
- **Adoption validation:** First production deployment with 50+ schemas registered and 3+ emission targets active

### Risk Mitigation

- **UI doesn't resonate:** API remains available for code-first users — the UI is a layer, not a lock-in. Direct TypeSpec editing is also always available as a second authoring surface.
- **Emitter correctness issues:** Built-in validation catches structural errors; governed overrides handle edge cases
- **Slow adoption:** "One team, no org buy-in" track lets individual teams get value independently

## Web Application Specific Requirements

### Architecture Overview

Super Schema is a single-page application (SPA) with a RESTful API backend, deployed on-premise behind enterprise authentication. The UI is an interactive, state-heavy application closer to an IDE than a content site.

**Frontend:** SPA architecture for complex interactive state (schema editor, multi-panel emission preview, governance dashboards, diff views). Modern evergreen browsers only (Chrome, Edge, Firefox). Technology stack TBD — framework choice should optimize for form-heavy interactive UIs with complex state management. Data refresh via polling.

**Backend:** RESTful API serving the SPA and programmatic access. TypeSpec compiler as a server-side service (Node.js), invoked synchronously on every entity save for parsing, typechecking, and governance lint validation — not only at emission time. Emitter execution pipeline: TypeSpec compilation → type mapping → emission → syntactic validation. Database holds TypeSpec source per entity, a derived relational projection of fields for fast querying, versions, governance records, audit trails, deployment tracking, and notifications. Authentication via local user management (email/password), Google (Gmail) sign-in, and enterprise SSO (SAML 2.0 / OIDC).

**Deployment:** Containerized (Docker/Kubernetes). Zero external runtime dependencies. Configuration-driven emitter availability and type mapping policies.

### Browser Support

| Browser | Support Level |
|---------|--------------|
| Chrome (latest 2 versions) | Full support |
| Edge (Chromium-based) | Full support |
| Firefox (latest 2 versions) | Full support |
| Safari | Not targeted |
| IE11 | Not supported |

### UI Constraints

- **Primary target:** Desktop (1280px+) — professional data management tool on workstations
- **Tablet/Mobile:** Not required
- **State management:** Complex form state — nested entities, arrays of decorators per field, real-time validation, multi-panel preview
- **Code viewer:** Emitted output preview with syntax highlighting for SQL, JSON, YAML, Protobuf (read-only)
- **Diff viewer:** Structured field-level diff with before/after, not raw text diff
- **Form validation:** Real-time enforcement of completeness rules (forced precision, required classification) as the user authors

## Functional Requirements

### Schema Authoring & Management

- **FR1:** Data modelers can create new entity schemas through a visual UI, defining fields with types, precision, and scale
- **FR2:** Data modelers can assign decorator metadata to each field across all 8 categories (structure, semantics, classification, policy, quality, lineage, operational hints, evolution)
- **FR3:** The system enforces completeness at authoring time — fields cannot be saved without required metadata (e.g., precision/scale for decimal, classification for every field)
- **FR4:** Data modelers can edit existing entity schemas, modifying fields, types, and decorator metadata
- **FR5:** Data modelers can browse and search across all entity schemas in the system
- **FR6:** Data modelers can define nested/complex types and entity relationships
- **FR7:** Data modelers can set field aliases to address naming drift across systems
- **FR8:** Data modelers can assign permanent field numbers for Protobuf compatibility
- **FR9:** Data modelers can retire/deprecate entities and fields with replacement references

### TypeSpec Authoring & Portability

- **FR73:** Data modelers can view and directly edit the TypeSpec source for any entity, with edits reflected in the visual UI and vice versa
- **FR74:** The system validates hand-edited TypeSpec source against the real TypeSpec compiler and the governance decorator package's lint rules before accepting a save, surfacing diagnostics inline
- **FR75:** A failed TypeSpec source save never corrupts or partially persists the entity — the last valid version remains intact until a valid edit is saved
- **FR76:** Users can export any entity's TypeSpec source as a portable, standards-compliant `.tsp` file usable outside the platform

### Schema Emission & Validation

- **FR10:** The system can emit implementation-specific schemas from a logical entity definition to multiple target formats simultaneously
- **FR11:** Data modelers can preview emitted output for all selected targets side by side before committing
- **FR12:** The system validates emitted schemas syntactically within the platform (Avro validates against spec, DDL parses, JSON Schema validates, OpenAPI passes linting)
- **FR13:** The system surfaces type mapping mismatches and emission issues clearly to the user
- **FR14:** Data stewards can create governed overrides for type mapping mismatches with audit trail
- **FR15:** The system maintains configurable, versionable type translation policies between the logical schema and each emitter target

### Schema Versioning & Change Management

- **FR16:** The system maintains version history for every entity schema
- **FR17:** Data modelers can compare any two versions of an entity with a structured field-level diff
- **FR18:** The system generates change records documenting what changed between versions
- **FR19:** The system auto-generates migration artifacts for schema changes (ALTER statements for DDL targets, evolution compatibility reports for Avro/Protobuf)
- **FR20:** Data modelers can view the change history and audit trail for any entity

### Schema Registration & Drift Detection

- **FR21:** Data engineers can import existing schemas (Avro files, DDL, Protobuf definitions) via bulk import
- **FR22:** The system can map imported schemas to logical entity definitions with AI-assisted field matching and confidence scores
- **FR23:** The system detects drift between logical entity definitions and registered implementation schemas
- **FR24:** The system generates drift reports showing field-level differences between logical and implementation schemas

### Governance & Compliance

- **FR25:** The system classifies schema changes by type (non-breaking addition, breaking type change, field removal, classification change) and routes to appropriate approval workflow
- **FR26:** Non-breaking changes can be auto-approved per configurable policy
- **FR27:** Breaking changes trigger approval requests to data stewards and impacted team leads
- **FR28:** The system generates change impact reports showing per-target compatibility and affected downstream consumers
- **FR29:** The system supports per-target staged emission — a change can be emitted to some targets while held for others pending approval
- **FR30:** Compliance officers can query all entities and fields by classification, policy, retention, and target system
- **FR31:** Compliance officers can identify gaps (e.g., PII fields without anonymization policy) through filtered queries
- **FR32:** The system can export compliance reports as auditable artifacts
- **FR33:** Users can add inline annotations and tag other users on entities and fields
- **FR34:** The system maintains an immutable audit trail of all schema changes, overrides, approvals, and governance decisions
- **FR77:** Role assignments, the audit trail, deployment/drift tracking, and active-session state are maintained in the relational database, independent of any entity's TypeSpec source — they are never encoded as TypeSpec decorators

### Deployment Tracking

- **FR35:** The system tracks which emitted schema versions are deployed or staged to which target systems
- **FR36:** Data engineers can view deployment status across all targets for any entity
- **FR37:** The system reports drift status for each registered implementation against the current logical version

### Administration & Platform Management

- **FR38:** Administrators can deploy the system via container images to on-premise infrastructure
- **FR39:** Administrators can configure authentication — local user management with email/password, Google (Gmail) sign-in, and enterprise SSO via SAML 2.0 / OIDC
- **FR40:** Administrators can define user roles and permissions (schema authors, data stewards, compliance officers, read-only viewers)
- **FR41:** Administrators can enable/disable emitter targets and configure target-specific type mapping policies
- **FR42:** Administrators can create and manage domain workspaces for multi-team organizations
- **FR43:** Administrators can monitor system health, active users, schema counts, emission frequency, and validation error rates
- **FR44:** The system supports zero-downtime configuration changes (emitter enable/disable, policy updates)
- **FR45a:** Administrators can define custom classification levels beyond system defaults (PII, SENSITIVE, INTERNAL, PUBLIC) — the classification taxonomy is extensible per organization
- **FR45b:** Administrators can define domain-level policy templates with default classifications, retention policies, quality rules, and naming conventions that entities within the domain inherit
- **FR45c:** Domain-level policy inheritance is flattened explicitly into each entity — any consumer of the entity sees the full policy without chasing domain references

### Git-Native Workflow

- **FR55:** Schema definitions can be exported to and synchronized with a Git repository as version-controlled files
- **FR56:** Schema changes can flow through Git pull requests — the system provides PR-based change review with compatibility reports and impact analysis as PR comments
- **FR57:** The system supports Git as a distribution mechanism — emitted schemas are committed to configured Git repositories for downstream consumption
- **FR58:** The system reconciles changes made through the UI with the Git-synchronized representation — the UI and Git stay in sync with conflict detection

### Notifications

- **FR59:** The system provides in-app notifications for governance workflow events (approval requests, change completions, drift alerts, comments/tags)
- **FR60:** Users can view their notification history and mark notifications as read/acknowledged within the UI
- **FR61:** Notifications are persisted in the database with full history for audit purposes
- **FR62:** The notification system is extensible to support future external integrations (Slack, email) via the webhook infrastructure

### API & Integration

- **FR63:** External systems can access schema definitions, validation, compatibility checking, and emission through a versioned RESTful API
- **FR64:** CI/CD pipelines can submit schema changes for validation and receive structured pass/fail responses with detailed compatibility reports
- **FR65:** The API can trigger emission of updated schemas to specified targets
- **FR66:** The system supports webhook endpoints for external integrations to consume governance workflow events
- **FR67:** The API maintains backward compatibility within major versions

### AI-Assisted Authoring

- **FR68:** Data modelers can create entity schemas from natural language descriptions (e.g., "a customer entity with PII financial fields for a fintech")
- **FR69:** The system suggests fields, types, and decorator metadata based on entity name and domain context
- **FR70:** AI-assisted bulk import proposes logical schema mappings for existing schemas with confidence scores for review
- **FR71:** Data modelers can reference schema standards (schema.org, domain-specific standards like financial schema standards, healthcare HL7/FHIR) as a basis for creating new entities — the system maps standard fields, types, and classifications to Super Schema's logical model
- **FR72:** Data modelers can review existing entity schemas against referenced domain standards to identify gaps, missing fields, or deviations from industry conventions

## Non-Functional Requirements

### Performance

- Schema authoring UI reflects a field edit locally: under 200ms
- TypeSpec compilation and validation confirms a saved edit: under 2 seconds at the 95th percentile, measured server-side from save request to accept/reject response
- Emission pipeline (entity → emitted schemas for 3 targets): under 30 seconds
- Schema list and browse (up to 1,000 entities): under 2 seconds, served from the relational field projection without re-parsing TypeSpec source per request
- Schema diff and change record generation: under 5 seconds
- Compliance queries across full entity corpus: under 10 seconds
- API validation and compatibility check responses: under 500ms
- Concurrent user support: at least 50 users without performance degradation

### Security

- All data at rest encrypted (schema definitions, metadata, audit trails, governance records)
- All data in transit encrypted via TLS 1.2+
- Authentication: local user management with email/password, Google (Gmail) sign-in, and enterprise SSO via SAML 2.0 / OIDC
- RBAC enforced at entity, domain/workspace, and system level
- Immutable audit trail — no user (including administrators) can modify or delete audit records
- Zero external calls at runtime — no data leaves the deployment perimeter
- API access authenticated and authorized per the same RBAC model as UI
- Schema metadata with classifications (PII, SENSITIVE) handled with same security controls as classified data

### Scalability

- Enterprise-scale repositories: up to 5,000 entities across 50+ domains without architecture changes
- Emission pipeline scales to 15+ emitter targets per entity without linear performance degradation
- Up to 500 users across multiple teams and domains
- Schema version history retained indefinitely without impacting performance
- Emitter plugin architecture supports adding new targets without modifying core code

### Reliability

- Data integrity for all schema definitions, version history, and audit trails — no silent data loss
- Deterministic emitter output — same input always produces same output
- Graceful handling of TypeSpec compilation failures — a save that fails to parse, typecheck, or pass governance lint rules is rejected in full; the entity's last valid TypeSpec source is never partially overwritten or left in an uncompilable state
- Transactional database operations — schema saves, version creation, and emission succeed or fail atomically
- Recovery from container restarts without data loss or inconsistent state

### Concurrency

- Concurrent edits to different entities never conflict, by construction (independent documents)
- A concurrent edit to the same entity as another in-flight save is detected via optimistic version checking and rejected with an explicit conflict response within 500ms — never silently overwritten and never auto-merged, for MVP
- Conflict rate under normal usage (distinct entities per user) is not expected to measurably affect the 50-concurrent-user target above

### Versioning

- Entity version history is retained indefinitely without degrading list, diff, or compile performance for the current version
- A stored historical TypeSpec source version remains readable as plain text indefinitely, independent of the currently-running compiler version; re-compiling a historical version against a newer compiler is a best-effort operation, not a guarantee

### Integration

- RESTful API conforms to OpenAPI 3.0 with published, versioned documentation
- API backward compatibility guaranteed within major versions
- Emitter plugin interface follows semantic versioning with published stability contract
- Webhook payloads use documented, versioned schema for governance events
- Standard container orchestration support (Docker, Kubernetes)
