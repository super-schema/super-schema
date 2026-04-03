---
title: "Product Brief Distillate: Super Schema"
type: llm-distillate
source: "product-brief-super-schema.md"
created: "2026-04-01"
purpose: "Token-efficient context for downstream PRD creation"
---

# Product Brief Distillate: Super Schema

## Core Identity

- Open-source, on-premise universal logical schema specification — "Terraform for data schemas"
- Enforcement backbone for the data contracts movement
- Complements (not competes with) catalogs (Atlan, Collibra), registries (Confluent), transformation tools (dbt)
- Positioned as the "schema kernel" of the enterprise data stack — upstream source of truth that other tools plug into
- Apache License 2.0, no CLA, community steering committee, RFC process for spec changes
- TypeSpec (Microsoft, open-source) as swappable IR — forkable if needed; users never interact with TypeSpec directly

## Architecture & Design Principles

- **Self-contained entity (FP1):** Every entity carries full 360-degree metadata — policies inherited from domain templates are flattened explicitly. No chasing references up a hierarchy.
- **Maximalist capture (FP2):** The logical schema captures everything any consumer might need (governance, quality rules, lineage, classifications, operational hints) while remaining platform-agnostic in expression
- **Intent over prescription (FP3):** `@storageHint("partition_candidate")` expresses intent; emitters translate to platform idiom. Schema never contains BigQuery DDL or Avro JSON directly.
- **Forced precision (FP5):** `decimal` alone is rejected — precision and scale are mandatory at authoring time. Prevents catastrophic precision loss.
- **Governed overrides (FP6):** Auditable escape hatches for impedance mismatches (e.g., decimal→string in Protobuf). Requires data steward approval.
- **Translation policies first-class (FP7):** Type mapping rules are a visible, configurable, versionable architectural layer between logical schema and emitters — not buried in emitter code.
- **Implementation footprint awareness (FP8):** Logical schema knows which platforms consume it — for impact analysis at change time, not for coupling.
- **Evolution as collaboration trigger (FP9):** Schema changes trigger cross-team coordination workflows, not just compatibility reports.
- **Registry/catalog is external (FP10):** Tracks implementations, drift, versions. Schema itself stays clean and self-contained.
- **TypeSpec as IR, not user-facing (FP11):** Data modelers interact via CLI/UI/AI. TypeSpec is generated behind the scenes, making it swappable.
- **Migration is registration (FP12):** Existing schemas get hard-mapped, not rebuilt. Progressive drift detection. No big-bang cutover.
- **Compliance queryability core (FP13):** "Show me every PII field across all entities" must be answerable in minutes.
- **Enforcement is a spectrum (FP14):** Auto-generated = guaranteed enforcement. Hard-mapped/legacy = periodic audit + drift reporting. System clearly distinguishes both modes.
- **Upstream-gated changes (FP15):** No team can change a source schema's data type and expect downstream to figure it out. Changes trigger governance workflow.

## Decorator Categories (8 Categories)

1. **Structure** — type, nullable, key, nested, field number (permanent for Protobuf)
2. **Semantics** — description, business glossary terms, alias names (tackles naming drift: `customer_email` vs `email` vs `user_email`), example values
3. **Classification** — PII, SENSITIVE, INTERNAL, PUBLIC
4. **Policy** — retention, anonymization, access control, encryption
5. **Quality** — validation rules, constraints, ranges
6. **Lineage** — data source, upstream, downstream
7. **Operational Hints** — partition candidate, index candidate, cluster candidate
8. **Evolution** — deprecated, since-version, replacement field

## Emitter Targets (15+ Mapped)

| Category | Targets |
|----------|---------|
| Streaming/Events | Avro (Kafka), Protobuf (gRPC) |
| Analytical Stores | BigQuery DDL, Apache Iceberg, Parquet schema |
| OLTP Databases | Spanner DDL, Oracle DDL, MySQL DDL, PostgreSQL DDL |
| NoSQL/Wide Column | Bigtable DDL |
| API Contracts | OpenAPI/JSON Schema, TypeScript interfaces, Java POJO |
| Transformation | dbt models |
| Documentation/Governance | Data Catalog JSON, HTML docs |

## Type Mapping Complexity — Critical Detail

Each logical type requires per-target mapping. Example for `decimal(19,4)`:

| Target | Mapping | Precision Risk |
|--------|---------|----------------|
| BigQuery | `NUMERIC(19,4)` | Safe |
| Avro | `bytes` + logical type `decimal` | Safe |
| Protobuf | `string` (no native decimal) | Lossy representation — requires governed override |
| PostgreSQL | `NUMERIC(19,4)` | Safe |
| Oracle | `NUMBER(19,4)` | Safe |
| MySQL | `DECIMAL(19,4)` | Safe |
| Spanner | `NUMERIC` | Partial (fixed precision) |
| Java POJO | `BigDecimal` | Safe |
| TypeScript | `number` (64-bit float) | **Precision loss landmine** — data steward must acknowledge |
| Parquet | `FIXED_LEN_BYTE_ARRAY` + decimal annotation | Safe |
| Iceberg | `decimal(19,4)` | Safe |
| JSON/OpenAPI | `number` or `string` | Depends on choice — needs policy decision |

## Governance Workflow — Approval Matrix

| Change Type | Approval Required |
|-------------|-------------------|
| Add optional field | Auto-approved (non-breaking) |
| Add required field | Data steward approval (breaking for some targets) |
| Change data type | Data steward + impacted team approval |
| Change classification (e.g., INTERNAL → PII) | Compliance officer approval |
| Remove field | Data steward + all consuming team approval |
| Override type mapping | Data steward approval |

## Validation Pipeline (5 Checkpoints)

1. **Authoring time (CLI/UI)** — required fields present, types fully specified, classification assigned
2. **Schema save/commit** — TypeSpec compiles, no breaking changes without approval
3. **Pre-emission** — type mappings resolvable for all registered targets
4. **Post-emission** — generated schemas valid per target (Avro validates, DDL parses)
5. **Runtime/registry** — drift detection — deployed schema matches emitted output

## Schema Scope Levels

| Level | Role |
|-------|------|
| Field | type, classification, quality rules, aliases, field number |
| Entity | retention, business owner, relationships, storage hints |
| Domain | shared policies, common types, standards (flattened into entities per FP1) |
| Registry (external) | implementation tracking, drift detection, version history |

## Competitive Landscape

| Competitor | Approach | Gap Super Schema Fills |
|------------|----------|----------------------|
| Confluent Schema Registry | Schema validation for Kafka (Avro/Proto/JSON) | Kafka-centric — doesn't touch warehouses, APIs, or non-streaming |
| DataHub (LinkedIn/Acryl) | Metadata catalog with 80+ connectors | Read-only — captures schemas but doesn't author, generate, or enforce |
| Buf (BSR) | Protobuf toolchain — lint, breaking changes, SDK gen | Protobuf-only |
| SchemaHero | Declarative schema-as-code for database migrations | Database DDL only — no events, APIs, governance |
| dbt | SQL transformations with contracts and tests | SQL/warehouse-scoped, no multi-format emit |
| Atlan / Collibra | Enterprise data catalogs with governance, classification, lineage | Discovery/policy layers, not schema authoring or code generation |

- **Key whitespace:** No competitor does "define once, emit everywhere" with governance
- **Risk:** Confluent, dbt Labs, and catalog vendors are each expanding toward broader schema governance — the window may narrow over 12-18 months
- **Dominant real-world alternative:** Teams cobbling together dbt + Confluent + shared Confluence page. Brief should address why this "good enough" breaks at scale.

## Market Context

- Data catalog market: $736M (2022) → $3.86B by 2030 at 23.2% CAGR
- Metadata management tools: projected $15.1B by 2026 at 19.0% CAGR
- North America 38% market share; Asia Pacific fastest growing
- TypeSpec has matured enough to be a credible IR foundation — wasn't possible 2 years ago
- Data mesh / data-product architectures require self-describing, interoperable schemas
- Regulatory pressure (EU AI Act, DORA, GDPR, CCPA, HIPAA) making schema-level governance a compliance obligation

## TypeSpec Feasibility — Known Limitations

- No native data catalog integration, lineage tracking, or compliance frameworks
- Limited community: ~4,700 GitHub stars, <1M weekly NPM downloads, ~60 NPM packages (vs Protobuf 65K stars, JSON Schema 60M+ weekly downloads)
- No native Kafka Schema Registry, Confluent, or dbt integration
- Indirect conversion pipeline (TypeSpec → JSON Schema → target) causes fidelity loss — numeric precision suffers, union types require wrapping for Avro, custom validation rules disappear, documentation/metadata stripped
- Cannot express: runtime data governance policies, complex database constraints with referential integrity, data lineage and transformation tracking, comprehensive compliance frameworks, advanced dimensional modeling patterns
- **Mitigation:** Custom decorators compensate for most gaps. Direct emitters (P2 priority) bypass the JSON Schema intermediate step. TypeSpec is open-source and forkable.

## Build Prioritization (from Brainstorming)

| Priority | What | Why |
|----------|------|-----|
| P0 | Logical schema spec format (decorator categories, type system, structure) | Everything else depends on this |
| P1 | Authoring experience (CLI first, then UI, then AI-assisted) | Adoption depends on this — data modelers won't write TypeSpec |
| P2 | 2-3 core emitters (Avro, BigQuery, OpenAPI) | Proves "define once, emit everywhere" end-to-end |
| P3 | Registration & drift detection for existing schemas | Unlocks enterprise adoption without migration pain |
| P4 | Governance workflow (change impact, approvals) | Differentiator for enterprise buyers |

- **User's intent:** Build all functionality — not just MVP. Implementation is incremental (solid foundation first, features layered on), but the product vision and PRD should capture the complete capability set.
- **Estimated timeline from feasibility doc:** Phase 1 (months 1-2) foundation + 3 core converters; Phase 2 (months 3-4) Protobuf/Spanner/TypeScript + catalog integration; Phase 3 (months 5-6) CI/CD + 80% migration; Phase 4 (months 7-8) governance automation

## User Personas (Stress-Tested in Brainstorming)

**Staff Data Engineer (6yr tenure, 200+ Avro schemas):**
- Primary concern: "You're asking me to trust your emitter generates byte-compatible Avro?"
- Resolution: Migration is registration — existing schemas get hard-mapped, not rebuilt. Progressive drift. AI-assisted bulk import with confidence scores.

**Chief Data Officer / Head of Data Governance:**
- Concern 1: "Can I answer 'show me every system that stores customer SSN with anonymization applied' in 5 minutes?" → Yes, compliance queryability is core.
- Concern 2: "What guarantees BigQuery actually has masking applied?" → Enforcement spectrum — auto-generated = guaranteed, legacy = audit + drift report.

**ML Engineer:**
- Concern: "When I retrain my model and risk_score changes from integer to float, I just deploy. Does your system catch that?"
- Resolution: Upstream-gated changes — model output type changes trigger governance workflow before deployment.

## Requirements Hints (Captured During Discovery)

- Two adoption tracks needed: solo/small-team path (local CLI, one target, no governance) and enterprise path (registry, governance, catalog integrations)
- Time-to-first-value target: one developer, one entity, one emitter, 15 minutes. Must work with zero org coordination.
- Emitter API needs stability contract with semantic versioning and 6-month deprecation notice for breaking changes
- Local/offline development must work — no server, network, or registry required for basic emit workflow
- Non-breaking changes should have a fast-track path — governance should never block engineers unnecessarily
- AI-assisted bulk import for existing schema registration — with confidence scores for auto-mapped fields
- PR-native experience: schema change diffs, CI check output, breaking vs non-breaking surfacing in PR comments
- Emitter correctness is trust-critical — needs comprehensive testing strategy. A single subtly wrong emitter output that corrupts production data destroys platform credibility.

## Opportunity Angles for PRD

- **Compliance as a standalone value prop:** CDOs, CISOs, and Legal have separate budgets. Super Schema's classification/policy metadata is direct input for compliance platforms (OneTrust, BigID, Securiti). Frame as "compliance-ready by construction."
- **Semantic layer bridging:** Annotate which fields compose which business metrics (revenue, churn, LTV) — extends Super Schema from data structure to data meaning. Positions against Cube, MetricFlow.
- **Schema commons:** Enterprises in the same vertical (fintech, healthcare, retail) define the same entities repeatedly. A curated public schema commons for canonical domain schemas creates cross-organizational value.
- **Cloud vendor partnerships:** Snowflake, Databricks, BigQuery — each benefits from Super Schema making their platform a canonical emission target. Co-marketing or native integration deals provide distribution.
- **Catalog vendor OEM:** Collibra/Atlan white-label or deep integration where Super Schema powers their "schema authoring" module — fastest path to large enterprise accounts.

## Rejected / Deferred Ideas

- **JSON Schema as intermediate format for all conversions:** Feasibility research shows significant fidelity loss at each step (numeric precision, union types, validation rules, metadata stripping). Direct emitters preferred.
- **Monetization / commercial model:** Explicitly deferred. Fully open-source for now. May consider services later but not part of current scope.
- **Standalone product positioning:** Rejected. Super Schema complements existing catalog platforms, not competes.
- **TypeSpec as user-facing language:** Rejected. Users never write TypeSpec. CLI/UI/AI authoring only.

## Open Questions for PRD

- Exact CLI command structure and authoring UX flow
- Web UI scope and technology choices
- AI-assisted authoring implementation approach (LLM integration, training data, confidence thresholds)
- Emitter plugin API surface design
- Registry architecture (standalone service? Git-native? Both?)
- How governance workflows integrate with existing tools (Jira, Slack, PagerDuty)
- Schema commons: public vs private, curation model, versioning
- Detailed emitter correctness testing strategy (property-based testing? Round-trip validation?)

## Key Quotes & Anchors

- "Your Code is cheap. The Execution is your moat; Design makes it possible. Data Model defines how your company ships their products." — from pitch deck
- "Schema drift tax" — the named concept for the revenue/quality cost of inconsistent schemas
- Price precision example: PostgreSQL NUMERIC(10,2)=19.99 exact → Kafka/Avro double=19.989999 → Service API float=19.98 → customer sees $19.98 = $0.01 lost × 1B transactions = $10M
