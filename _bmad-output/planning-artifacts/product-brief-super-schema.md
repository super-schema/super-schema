---
title: "Product Brief: Super Schema"
status: "complete"
created: "2026-04-01"
updated: "2026-04-01"
inputs:
  - "_bmad-output/brainstorming/brainstorming-session-2026-03-31-2345.md"
  - "ref/SuperSchema.md"
  - "ref/Universal Schema.md"
  - "ref/Super Schema presentation ODSC.pdf"
---

# Product Brief: Super Schema

## Executive Summary

Every enterprise with data spread across multiple platforms faces the same quiet disaster: schema definitions drift. The BigQuery table says `NUMERIC(10,2)`, the Kafka Avro schema says `double`, the API contract says `float` — and somewhere, a customer sees $19.98 instead of $19.99. Multiply that by a billion transactions and the cost is $10 million in silent revenue loss. This is the **schema drift tax** — and every organization with polyglot data systems is paying it.

**Super Schema** is a fully open-source, on-premise universal logical schema specification — **Terraform for data schemas**. Teams define their data models once, with full governance, classification, quality rules, and lineage metadata, and automatically emit implementation-specific schemas for every platform: BigQuery, Avro, Protobuf, OpenAPI, Spanner, dbt, and more. A data modeler describes "a customer entity with PII financial fields for a fintech" in natural language, and Super Schema's AI-assisted authoring drafts a fully decorated logical schema in seconds — ready to emit to every target. Define once, emit everywhere.

Built on Microsoft's TypeSpec as a swappable intermediate representation (never user-facing, forkable if needed), Super Schema is designed to complement — not compete with — existing data catalogs (Atlan, Collibra), schema registries (Confluent), and transformation tools (dbt). It is the upstream **schema kernel** that these tools plug into: the single source of truth that feeds the entire data ecosystem. Super Schema is the enforcement backbone for the emerging **data contracts** movement — not just talking about contracts, but enforcing them across polyglot systems at scale.

## The Problem

Schema definitions in a modern enterprise are scattered across 6-10+ teams and tools. A single entity like "Customer" exists as an Avro schema in Kafka, a BigQuery DDL in the warehouse, a Protobuf definition for gRPC, an OpenAPI spec for REST, a dbt model for transformations, and a row in a governance spreadsheet. Each maintained independently. Each drifting silently.

The consequences are severe and pervasive:

- **Revenue leakage:** `decimal(19,4)` becomes `double` becomes `float` — PostgreSQL stores $19.99 exactly, Kafka/Avro reads 19.989999, the service API renders $19.98. At 1B transactions, that's $10M in silent revenue loss. This is the schema drift tax — and most organizations don't even know they're paying it.
- **Governance chaos:** The average enterprise has no way to answer "show me every field classified as PII across all systems" in under a week. Data classification lives in spreadsheets, tribal knowledge, and best-effort Confluence pages. Regulatory exposure is invisible until an audit reveals it.
- **Feature velocity collapse:** Enterprise-wide schema changes take 3-6 months of cross-team coordination. Individual engineers are blocked 2-4 weeks waiting for schema alignment — the single loudest complaint in daily standup. Over 10 duplicate schema definitions per entity means every change is a multi-team negotiation.
- **Incident amplification:** Schema inconsistencies are a persistent, systemic source of production incidents. When a type mismatch silently corrupts data in a pipeline, the blast radius extends to every downstream consumer — analytics reports, ML models, customer-facing APIs, and compliance records.

Today, teams cope with format-specific tools — Confluent for Kafka schemas, Buf for Protobuf, dbt for SQL — or cobble together ad hoc combinations with shared Confluence pages. Each approach solves one slice. No tool provides a unified logical layer that governs all of them.

## The Solution

Super Schema introduces a logical schema layer that sits above all implementation formats. A data modeler defines an entity once — its fields, types (with enforced precision), data classifications (PII, SENSITIVE, PUBLIC), retention policies, quality rules, lineage references, and operational hints — in a single, technology-agnostic specification.

Automated emitters then translate this logical intent into platform-specific syntax: BigQuery DDL with column OPTIONS and partitioning, Avro schemas with logical types, Protobuf definitions with field numbers, OpenAPI specs, dbt models, data catalog entries, and more.

The system enforces completeness at authoring time — `decimal` without precision and scale is rejected. Where platform impedance mismatches exist (e.g., `decimal` has no native Protobuf representation), governed overrides provide auditable escape hatches approved by data stewards.

**Key capabilities:**

- **Logical schema specification** with 8 decorator categories (structure, semantics, classification, policy, quality, lineage, operational hints, evolution)
- **Automated emission** to 15+ target formats from a single source
- **Type translation policies** as a first-class, visible, auditable architectural layer — not buried in emitter code
- **Zero-disruption adoption** — existing schemas get registered and mapped to logical schemas with progressive drift detection. Day 1: register existing files. Day 2: start detecting drift. Day 90: first entity fully governed. No big-bang cutover required.
- **Governance workflows** — schema changes trigger cross-team coordination based on change type and impact scope, with governed fast-track paths for non-breaking changes so individual engineers are never blocked unnecessarily
- **Compliance by construction** — every field carries classification, retention, and policy metadata from authoring time. Compliance evidence is a byproduct of normal schema work, not a separate audit exercise. Directly supports GDPR, HIPAA, SOC 2, CCPA, and emerging AI Act requirements.
- **AI-assisted authoring** — web UI and AI-powered schema creation that collapses time-to-first-value from days to minutes. Data modelers never touch TypeSpec directly.
- **Git-native workflow** — schema changes flow through pull requests with CI/CD breaking-change detection, automated reviewer notifications, and compatibility reports as PR comments

## What Makes This Different

**No direct competitor occupies this space.** Confluent is Kafka-centric. Buf is Protobuf-only. DataHub and Atlan are discovery catalogs. dbt is SQL/warehouse-scoped. SchemaHero is database DDL only. None provide "define once, emit everywhere" with governance.

Three architectural decisions make Super Schema defensible:

1. **TypeSpec as a swappable IR, not an authoring language.** Users interact through CLI/UI/AI — TypeSpec is generated behind the scenes. This eliminates the adoption barrier of learning a new syntax. TypeSpec is fully open-source and forkable — Super Schema is never locked in to any vendor or underlying technology. If a better IR emerges, the logical model — your investment — is preserved.

2. **Migration is registration, not regeneration.** Every tool in the schema space has failed or stalled on "you must migrate everything first." Super Schema eliminates this objection entirely. Existing production schemas get hard-mapped to logical schemas with AI-assisted bulk import. The system detects drift without forcing immediate remediation. Teams adopt progressively — no "rip out everything and start over."

3. **Translation policies as first-class citizens.** Type mapping rules sit visibly between the logical schema and emitters — configurable, versionable, overridable with audit trails. This bridges the gap between logical purity and implementation reality that other tools ignore or bury in code.

## Who This Serves

**Data Engineers & Architects** — maintaining schemas across multiple platforms. Super Schema eliminates redundant definitions, catches drift automatically, and collapses multi-hour cross-team schema coordination cycles into a single PR review.

**Chief Data Officers & Governance Teams** — responsible for compliance, classification, and data policy enforcement. Super Schema makes "show me every system storing customer SSN with anonymization applied" a 5-minute query, not a 5-week project. Compliance evidence is generated as a byproduct of normal schema authoring.

**ML Engineers** — whose model output type changes ripple through downstream systems. Super Schema gates these changes through governance workflows, ensuring coordination before deployment.

**Platform Teams & Individual Engineers** — building internal developer platforms or just wanting to stop being blocked by schema alignment. A single team can adopt Super Schema for their own schemas and get immediate value (drift detection, automated emission, breaking-change CI) without requiring any other team's buy-in.

**Target:** Both large enterprises managing data across 10+ heterogeneous systems and mid-size teams looking to establish schema management discipline from the start. Two adoption tracks: a **solo/small-team path** (one target, no governance overhead) and an **enterprise path** (registry, governance workflows, catalog integrations — deploy on-premise behind your firewall).

## Success Criteria

- Every implementation-specific schema is emitted from the logical layer, not hand-written
- All schema changes flow through the logical layer with automated compatibili/bmd-cty checks
- Type mappings, governance policies, and compliance metadata are centrally managed and queryable in real time
- Existing schemas are progressively registered with drift detection — without requiring migration
- Schema coordination, compliance audits, and impact analysis are automated workflows — not manual projects
- Active open-source community contributing emitters, integrations, and tooling

## Ecosystem & Integration Vision

Super Schema is not a standalone product — it is the **schema kernel** of the enterprise data stack, designed to be deployed on-premise within your organization's infrastructure.

- **Data catalogs** (Atlan, Collibra, DataHub) consume Super Schema metadata and classifications as their upstream source of truth
- **Schema registries** (Confluent) receive emitted Avro/Protobuf schemas validated against the logical layer
- **Transformation tools** (dbt) generate models from Super Schema entity definitions
- **CI/CD pipelines** enforce schema validation as a quality gate — breaking-change detection as a PR check, embedded in daily engineering workflow
- **Compliance platforms** (OneTrust, BigID, Securiti) consume Super Schema's classification and policy metadata as their source of truth for PII inventory, retention enforcement, and compliance evidence
- **Cloud data platforms** (Snowflake, Databricks, BigQuery) benefit from Super Schema making their platform a canonical emission target

The adoption flywheel: every new emitter target and catalog integration makes Super Schema more valuable, which attracts more contributors, which adds more integrations. Each emitter contribution solves the contributor's own schema pain — write the Iceberg emitter, use Super Schema internally, contribute it back. Your team gets free schema governance; the community gets a new target.

## Open-Source Model

Super Schema is fully open-source under the **Apache License 2.0** — permissive, enterprise-friendly, with no CLA required for contributions.

**Governance:** Community-driven with a public steering committee. Major specification changes follow an RFC process with community review. The emitter API follows semantic versioning with a stability contract — breaking changes require a major version bump with 6-month deprecation notice, so community-contributed emitters are never silently broken.

**Deployment:** Designed for on-premise deployment within your organization's infrastructure. Your schemas, your governance, your data — never leaving your perimeter.

## Vision

If Super Schema succeeds, it becomes the standard for how organizations define, govern, and distribute their data models. Schema changes that take months today happen in hours. Compliance audits that require weeks of archaeology become real-time queries. New platform adoption (adding Iceberg, Delta, or the next data format) becomes a single emitter plugin, not a 6-month schema migration.

Beyond schema consistency, Super Schema naturally extends to **semantic layer bridging** — annotating which fields compose which business metrics (revenue, churn, LTV), making it the authoritative source not just for data structure but for data meaning across the organization.

The ultimate state: **your data model is defined in one place, and every system in your enterprise — from Kafka to BigQuery to your public API — speaks the same truth.**
