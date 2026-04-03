# Story 4.4: Migration Artifact Generation

Status: ready-for-dev

## Story
As a **data modeler**, I want auto-generated migration artifacts for schema changes (ALTER statements, evolution compatibility reports), so that I can safely apply schema changes to production target systems.

## Acceptance Criteria

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

## Tasks / Subtasks

### Service Layer — Migration Service
- [ ] Create `src/services/migration.service.ts` with `generateMigrationArtifacts(entityId, fromVersion, toVersion, ctx): Result<MigrationArtifacts>`
- [ ] Implement internal diff retrieval: call `compareVersions()` from version service to get the `DiffResult` between fromVersion and toVersion
- [ ] Implement per-target artifact generator dispatch: iterate enabled targets, call target-specific generator for each

### BigQuery Migration Generator
- [ ] Implement `generateBigQueryMigration(entityName, domainName, diff): MigrationArtifact[]`
- [ ] Added fields: generate `ALTER TABLE {domain}.{entity} ADD COLUMN {col} {bqType} OPTIONS(description="{desc}")`
- [ ] Removed fields: generate commented-out `-- ALTER TABLE {domain}.{entity} DROP COLUMN {col}` with warning "Manual review required — dropping columns deletes data"
- [ ] Type changes: generate `ALTER TABLE {domain}.{entity} ALTER COLUMN {col} SET DATA TYPE {newType}` with compatibility warning for unsafe conversions (e.g., STRING → INTEGER)
- [ ] Use type mapping policies to resolve logical types to BigQuery types

### Avro Migration Generator
- [ ] Implement `generateAvroMigration(diff): MigrationArtifact`
- [ ] Compute compatibility classification:
  - BACKWARD: only additions of optional (nullable) fields
  - FORWARD: consumers using old schema can read new data
  - FULL: both backward and forward compatible
  - BREAKING: field removed, type changed incompatibly, required field added
- [ ] Generate `{ compatible: boolean, compatibility: string, details: string[] }` report
- [ ] Detail each change with its compatibility impact

### OpenAPI Migration Generator
- [ ] Implement `generateOpenAPIMigration(diff): MigrationArtifact`
- [ ] Generate changelog listing added/removed/modified properties with types
- [ ] Flag breaking changes: removed required field, added required field, type change
- [ ] Flag non-breaking changes: added optional field, description change

### Storage
- [ ] After generation, store artifacts in `entity_versions.migration_artifacts` JSONB column for the target version
- [ ] Validate JSONB with Zod schema before writing

### Zod Schemas & Types
- [ ] Define `MigrationArtifacts` Zod schema in `src/types/schemas/migration.ts`: `{ targets: [{ targetFormat, artifacts: MigrationArtifact[] }] }`
- [ ] Define `MigrationArtifact` schema: `{ type: string, content: string, warnings: string[] }`
- [ ] Define `AvroCompatibilityReport` schema: `{ compatible: boolean, compatibility: "BACKWARD"|"FORWARD"|"FULL"|"BREAKING", details: string[] }`
- [ ] Export derived TypeScript types

### oRPC Router
- [ ] Add `version.generateMigration` mutation to `src/server/api/routers/version.ts` — input: entityId, fromVersion, toVersion
- [ ] Returns `MigrationArtifacts`

### UI — Generate Migration Button
- [ ] Add "Generate Migration" button to each version entry in the Version History Panel
- [ ] On click, call `version.generateMigration` with previousVersion → selectedVersion
- [ ] Show loading state during generation

### UI — Migration Artifacts Panel
- [ ] Create `src/components/custom/MigrationPanel/MigrationPanel.tsx` — tabbed panel, one tab per target
- [ ] Implement syntax highlighting: SQL highlighting for BigQuery tab, JSON highlighting for Avro tab, YAML/text for OpenAPI tab (use Shiki or Prism, same as EmissionPreviewPanel)
- [ ] Display warnings prominently in amber: destructive operations, breaking changes, lossy conversions
- [ ] Add copy-to-clipboard button per tab

### Testing
- [ ] Unit test: BigQuery — added field generates correct ALTER TABLE ADD COLUMN
- [ ] Unit test: BigQuery — removed field generates commented-out DROP COLUMN with warning
- [ ] Unit test: BigQuery — type change generates ALTER COLUMN SET DATA TYPE with compatibility warning
- [ ] Unit test: Avro — additions only → BACKWARD compatible
- [ ] Unit test: Avro — field removal → BREAKING
- [ ] Unit test: Avro — type change → BREAKING
- [ ] Unit test: Avro — additions + removals → correctly classifies
- [ ] Unit test: OpenAPI — removed required field flagged as breaking
- [ ] Unit test: OpenAPI — added required field flagged as breaking
- [ ] Unit test: OpenAPI — added optional field flagged as non-breaking
- [ ] Unit test: OpenAPI — type change flagged as breaking
- [ ] Integration test: complex change (add field + modify type + remove field) → correct artifacts for all three targets
- [ ] Playwright E2E: click "Generate Migration" → tabs appear → BigQuery tab shows ALTER statements → Avro tab shows compatibility report → warnings highlighted in amber

## Dev Notes

### Architecture & Patterns

**Service pattern:** `migration.service.ts` follows the standard service layer pattern. Returns `Result<MigrationArtifacts>`. Never throws. Uses `withAudit()` when storing generated artifacts.

**Module boundary:** Migration service depends on:
- Version service (read-only) — to get version snapshots and compute diffs
- Type mapping policies (read-only) — to resolve logical types to target-specific types
- Does NOT depend on emission service directly — migration generates ALTER/compatibility artifacts, not full schema re-emission

**Storage:** Generated artifacts are stored in `entity_versions.migration_artifacts` JSONB, validated by Zod before write. This allows artifacts to be retrieved without re-generation.

**Database schema:**
```
entity_versions — id, entity_id, version_number, snapshot (JSONB), change_record (JSONB),
                  migration_artifacts (JSONB), created_by, created_at
```

**BigQuery type mapping:** Uses the same type mapping policies as the BigQuery emitter. Logical types (string, integer, decimal, boolean, etc.) are resolved to BigQuery types (STRING, INT64, NUMERIC, BOOL, etc.) using `type_mapping_policies` table.

### UX/Design Requirements

**"Generate Migration" button:** Secondary button style (muted bg, border). Appears next to each version in the Version History Panel.

**Migration panel:** Tabbed layout matching EmissionPreviewPanel pattern — one tab per target. Uses the same syntax highlighting library (Shiki/Prism).

**Warnings display:**
- Amber background for warning blocks
- Use `--field-suggestion` / `var(--warning)` color token
- Destructive operations (DROP COLUMN) get additional red icon
- Warnings are positioned above the code content in each tab

**Copy button:** Icon-only button (24x24) in tab header, copies content to clipboard.

### File Structure
```
src/services/migration.service.ts                       — Business logic
src/services/migration/bigquery.generator.ts             — BigQuery ALTER generation
src/services/migration/avro.generator.ts                 — Avro compatibility report
src/services/migration/openapi.generator.ts              — OpenAPI changelog
src/types/schemas/migration.ts                           — Zod schemas + TS types
src/server/api/routers/version.ts                        — Add generateMigration mutation
src/components/custom/MigrationPanel/
  ├── MigrationPanel.tsx                                 — Tabbed panel component
  ├── MigrationPanel.types.ts                            — Props & types
  └── index.ts                                           — Re-export
tests/unit/services/migration.service.test.ts            — Unit tests (all generators)
tests/integration/migration.integration.test.ts          — Integration test
tests/e2e/migration-artifacts.spec.ts                    — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Test each target generator independently with various diff scenarios (add, remove, modify). Verify SQL syntax, compatibility classification, breaking change detection.
- **Integration test (Vitest):** Complex multi-change scenario with real diff computation across all three targets.
- **E2E tests (Playwright):** Full flow from clicking "Generate Migration" through viewing tabbed artifacts with warnings.

### Dependencies & Prerequisites
- Story 4.1 complete — version history with snapshots
- Story 4.2 complete — `compareVersions()` for diff computation
- Type mapping policies available (from Epic 3)
- Syntax highlighting library (Shiki/Prism) already integrated for EmissionPreviewPanel
- `entity_versions.migration_artifacts` JSONB column exists

### References
- Architecture: `entity_versions` table with `migration_artifacts` JSONB column
- Architecture: Type mapping policies, emitter intermediate model
- Architecture: Service layer pattern, Result type, withAudit()
- UX Spec: EmissionPreviewPanel pattern (tabbed code viewer with syntax highlighting)
- FR19: Auto-generate migration artifacts for schema changes

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
