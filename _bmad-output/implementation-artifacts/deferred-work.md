# Deferred Work Tracker

> Comprehensive list of all deferred items discovered during implementation.
> Organized by priority. Updated 2026-04-05.

---

## CRITICAL: Items that affect functionality

| # | Description | Story | Effort |
|---|-------------|-------|--------|
| C1 | **No authorization check on field mutations** — Any authenticated user can update/delete any field by guessing the field ID. Pre-existing in `actions.ts`. RBAC authorization is story 8-1. | 2-11 | L |
| C2 | **TypeSpecCompilerService not wired** — `typespec-compiler.ts` deferred; entity save flow does not call TypeSpec generator after Prisma write. Requires `@typespec/compiler` package. | 3-1 | M |
| C3 | **Prisma migrations skipped for emission tables** — `entity_versions` and `emission_targets` Prisma models not created; emission runs directly without persisting results. | 3-6 | M |
| C4 | **Prisma migrations skipped for governance tables** — Governance requests, change classification, and overrides use in-memory stores instead of database tables. Data lost on restart. | 5-1, 5-2, 3-7 | L |
| C5 | **Version history stored in metadata JSONB** — Version snapshots stored in entity `metadata` JSONB under `versionHistory` key instead of dedicated `entity_versions` table. Not scalable. | 4-1 | L |
| C6 | **Annotations stored in audit_log** — No dedicated annotations table; annotations piggyback on `audit_log` with action `annotation.create`. Limits querying and permissions. | 6-4 | M |
| C7 | **In-memory user/role/domain stores** — `user.service.ts` and `domain-admin.service.ts` use in-memory Maps. All RBAC/domain data lost on restart. | 1-4, 8-1, 8-2 | L |
| C8 | **API key management uses env var** — Simple `API_KEY` env var validation instead of per-user API keys table (`user_api_keys`). No key rotation or scoping. | 3-8 | M |
| C9 | **Notification service triggers not wired** — Trigger functions exist but are not called from governance/annotation/emission services. | 7-1 | M |
| C10 | **Webhook retry without background worker** — Uses piggyback retry during next `dispatchEvent()` call. Retries only happen when new events fire. | 7-3 | M |

## HIGH: Items that affect quality/completeness

| # | Description | Story | Effort |
|---|-------------|-------|--------|
| H1 | **No input sanitization on decorator keys** — Only `decorators.typespec` is validated; other top-level keys in decorators JSONB pass through unchecked. | 2-11 | S |
| H2 | **domainPolicy unsafe type assertion** — `entity.domain` cast to `{ policyTemplate?: Record<string, unknown> }` without Zod validation. Runtime crash if JSONB is non-object. | 2-11 | S |
| H3 | **Inconsistent null-check operators in addFieldAction** — Mixed use of `!= null`, `!== undefined`, and truthy checks for optional field parameters. | 2-11 | S |
| H4 | **E2E tests deferred across all stories** — Playwright E2E tests skipped for every story. No integration testing with running app + database. | All | L |
| H5 | **oRPC routers deferred** — Version, classification, governance, and API key management routers not created. Using Next.js server actions as workaround. | 4-1, 5-1, 3-8 | M |
| H6 | **Component tests deferred** — `OverrideDialog.test.tsx` and other component tests require jsdom environment setup. | 3-7 | M |
| H7 | **withAudit() integration deferred** — Audit wrapping for type mapping overrides requires DB-backed store to persist audit entries. | 3-7 | M |
| H8 | **Migration artifact UI not built** — `MigrationPanel.tsx`, "Generate Migration" button, syntax highlighting, and copy-to-clipboard all deferred. Only core generators implemented. | 4-4 | L |
| H9 | **User dropdown filter in change history** — Filter by user requires additional user lookup query not yet implemented. | 4-3 | S |
| H10 | **Type mapping overrides in-memory** — Override store is in-memory; will need migration to Prisma when `type_mapping_policies` table is created. | 3-2 | M |
| H11 | **next-auth beta version with caret range** — `next-auth@^5.0.0-beta.30` may auto-upgrade to newer betas with breaking changes. Pin to stable when v5 releases. | 1-1 | S |
| H12 | **PostgreSQL immutability trigger not verified** — Requires live database to test; documented but not validated. | 6-5 | S |
| H13 | **Emit flow not wired to version creation** — Emit commits do not trigger `createVersion()`. Versioning and emission are disconnected. | 4-1 | M |
| H14 | **Hardcoded AUTHOR role fallback** — `entity.ts` and `domain.ts` routers use `userRole: "AUTHOR"` TODO placeholder until RBAC (story 8-1). | 2-1, 2-1b | S |

## MEDIUM: Nice-to-have improvements

| # | Description | Story | Effort |
|---|-------------|-------|--------|
| M1 | **Ghost text suggestions in amber validation state** — Visual ghost text overlay when fields are in warning state. | 2-5 | M |
| M2 | **Ghost text UI in field rows** — Autocomplete ghost text rendering and dismissal tracking in field editor rows. | 2-6 | M |
| M3 | **Array/Map/Object nested type picker UIs** — Inline sub-field editor for complex nested types. Schema/storage layer done; visual editor deferred. | 2-7 | L |
| M4 | **Deprecation form, retirement banner, sidebar strikethrough** — Visual lifecycle indicators for deprecated/retired fields. | 2-8 | M |
| M5 | **Global keyboard shortcuts** — Cmd+S (save), Cmd+N (new entity), Cmd+E (edit), slash commands. Only Cmd+K palette implemented. | 2-9 | M |
| M6 | **Dagre auto-layout, node click popover, domain filter** — Lineage graph polish: better layout algorithm, click-to-inspect, and domain-level filtering. | 2-10 | M |
| M7 | **Versioning panel conditional rendering** — Panel should only render when domain has `@versioned` policy. Currently always visible. | 2-11 | S |
| M8 | **@doc markdown toolbar and rendered preview** — Formatting toolbar and rendered markdown preview for decorator documentation. Current edit/preview shows raw text. | 2-11 | S |
| M9 | **Live debounced emission preview** — Currently emit-on-button-click only. `useEmissionPreview` hook for live preview deferred. | 3-6 | M |
| M10 | **Syntax highlighting with Shiki/Prism** — Code viewers use `<pre>` with monospace. Proper syntax highlighting deferred. | 3-6 | S |
| M11 | **Notification polling to WebSocket/SSE upgrade** — MVP uses 30-second TanStack Query polling. Real-time push deferred. | 7-1, 7-2 | M |
| M12 | **System health dashboard charts** — Simple numeric display only. No charts or visualizations for MVP. | 8-4 | M |
| M13 | **Auto-refresh/polling for health dashboard** — Manual refresh only. No auto-refresh interval. | 8-4 | S |
| M14 | **Multi-repo Git support** — Single Git config per instance. Multi-repo deferred to Phase 2. | 10-1 | L |
| M15 | **Automated deployment detection** — Manual "Mark as Deployed" only. CI/CD integration deferred to Phase 2. | 9-3 | L |
| M16 | **Advanced fuzzy matching for standards** — Entity name matching uses simple substring/case-insensitive. Levenshtein deferred. | 11-2 | S |
| M17 | **Custom standard templates** — Only bundled standards supported. Admin-configurable custom standards directory deferred. | 11-2 | M |
| M18 | **API rate limiting** — Architecture supports it but no middleware implemented. Stub exists but does nothing. | 3-8 | M |
| M19 | **Compatibility endpoint** — Deferred; requires version diffing infrastructure not yet built. | 3-8 | M |
| M20 | **Lineage graph node positions not persisted** — Layout recalculated on each view. Position persistence deferred. | 2-10 | S |
| M21 | **Password reset flow** — No password reset mechanism in MVP. Can be added later. | 1-4 | M |
| M22 | **Enterprise SSO (BoxyHQ SAML Jackson)** — Full story 1-6 not implemented. Google OAuth only. | 1-6 | L |
| M23 | **Webhook management admin UI** — Backend webhook service done but no admin panel UI. Deferred to Epic 8. | 7-3 | M |
| M24 | **Deployments page empty state** — `deployments/page.tsx` has TODO to fetch from API; shows empty state. | 9-3 | S |
| M25 | **PR status webhook sync** — PR status synced on-demand via `syncPrStatus()`. No webhook listener for real-time GitHub status updates. | 10-2 | M |
| M26 | **Auto-approval policy configurability** — Non-breaking changes always auto-approved. Per-domain configurable auto-approval rules deferred. | 5-2 | M |

---

## SOR (Single Source of Record) Enhancements — Deferred from Party Mode Review

> These items transform Super Schema from a "TypeSpec Studio" into an enterprise data SOR.
> Business Concept Registry is being implemented. The rest are deferred.

### HIGH: Enterprise SOR Features

| # | Description | Source | Effort |
|---|-------------|--------|--------|
| S1 | **External System Registry** — Prisma models for ExternalSystem + FieldSystemLink. Track source/sink systems per field (e.g., "Salesforce CRM → customer_id"). Enables rich lineage. | Winston/Amelia | L |
| S2 | **Domain Target Configuration** — DomainTarget model so each domain can configure which emitters are active (Payments→BigQuery+Avro, Analytics→BigQuery+dbt). Scopes drift detection. | Winston | M |
| S3 | **Bidirectional Drift Detection** — If a BigQuery table is altered directly (outside Super Schema), detect the change and prompt: "Update logical model?" Requires polling or webhook from target systems. | John | L |
| S4 | **Data Contract Testing** — Downstream consumers register which fields they depend on. Super Schema alerts them and blocks breaking changes to those fields. Consumer-driven contracts. | Murat | L |
| S5 | **CI/CD GitHub Action** — GitHub Action that runs on PRs: validates schema changes, runs compatibility checks against all targets, generates report comment on the PR. | John/Winston | M |
| S6 | **Schema Registry Push** — Push emitted Avro schemas to Confluent Schema Registry, OpenAPI specs to API gateways. Bidirectional sync. | Winston | L |
| S7 | **Catalog Sync** — Export/sync to DataHub, Atlan, Amundsen, AWS Glue Data Catalog. Super Schema as design-time companion to runtime catalogs. | Victor | L |
| S8 | **Import from More Sources** — dbt schema.yml, Terraform schemas, Confluent Schema Registry, AWS Glue Catalog, DataHub export. Bootstrap SOR from existing infrastructure. | John | L |

### MEDIUM: UX Improvements for SOR

| # | Description | Source | Effort |
|---|-------------|--------|--------|
| S9 | **Entity Canvas View** — Drag-and-drop entity relationship diagram (ERD) using React Flow. Zoom in to see fields, zoom out to see domain relationships. Figma-meets-ERD. | Sally | L |
| S10 | **"What Would Break?" Preview** — Before any change, show blast radius: affected targets, downstream consumers, compatibility classification. Pre-change impact analysis. | Sally/Murat | M |
| S11 | **Cross-Entity Concept Consistency** — When creating a field, if a matching Business Concept exists, auto-suggest the canonical type and classification. Enforce naming consistency across entities. | Mary | M |
| S12 | **Schema Compatibility SLA** — Each entity can declare a compatibility level (BACKWARD, FORWARD, FULL, NONE). Breaking changes to BACKWARD-compatible entities require steward approval. | Victor | M |

