# Story 5.3: Change Impact Reports

Status: ready-for-dev

## Story
As a **data steward**, I want to see a detailed impact report for every breaking change showing per-target compatibility and affected consumers, so that I can make informed approval decisions.

## Acceptance Criteria

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

## Tasks / Subtasks

### Impact Report Generator
- [ ] Create `src/services/impact-report.service.ts` (or add to governance.service.ts) with `generateImpactReport(entityId, versionId, classification, ctx): Result<ImpactReport>`
- [ ] Implement summary generation: human-readable one-line summary of the change (e.g., "Breaking change: 1 field removed, 1 type change affecting 3 targets")

### Per-Target Compatibility Analysis
- [ ] For each enabled emission target, call migration artifact generator (Story 4.4) to get migration artifacts
- [ ] Determine compatibility per target: can the target accept the change without migration? With migration? Not at all?
- [ ] Classify migration complexity:
  - "trivial": only ADD COLUMN / optional field additions
  - "moderate": type changes with safe conversions, schema evolution compatible
  - "complex": field removals, breaking type changes, manual intervention required
- [ ] Populate `perTarget` array: `{ target, compatible: boolean, migrationRequired: boolean, migrationComplexity, details: string }`

### Affected Consumer Identification
- [ ] Query entity relationships: find all entities that have fields referencing the changed entity (via relationship decorators or foreign key references)
- [ ] For each affected entity, retrieve: entity name, the specific field that references the changed entity, the relationship type, and the entity owner's email
- [ ] Populate `affectedConsumers` array: `{ entityName, fieldName, relationship, ownerEmail }`

### Migration Artifacts Summary
- [ ] Generate concise summaries of migration artifacts per target:
  - BigQuery: "2 ALTER TABLE statements (1 ADD COLUMN, 1 DROP COLUMN with warning)"
  - Avro: "BACKWARD compatible — only optional field additions"
  - OpenAPI: "1 breaking change — required field removed"
- [ ] Populate `migrationArtifactsSummary` object

### Integration with Governance Request Creation
- [ ] Update `governance.service.ts` `createRequest()`: before creating the request, generate the impact report
- [ ] Store the complete impact report in `governance_requests.impactReport` JSONB column
- [ ] Validate impact report JSONB with Zod before writing

### Zod Schemas & Types
- [ ] Define `ImpactReport` Zod schema in `src/types/schemas/governance.ts` (or separate file)
- [ ] Define `PerTargetImpact` schema: `{ target, compatible, migrationRequired, migrationComplexity, details }`
- [ ] Define `AffectedConsumer` schema: `{ entityName, fieldName, relationship, ownerEmail }`
- [ ] Define `MigrationArtifactsSummary` schema: `{ bigquery, avro, openapi }`
- [ ] Export derived TypeScript types

### Impact Report Display — Governance Dashboard
- [ ] Create `src/features/governance/ImpactReportCard/ImpactReportCard.tsx` — formatted card for displaying impact report
- [ ] Display summary text at top
- [ ] Display per-target breakdown as a table: target name, status icon (green check / red X), compatibility badge, migration complexity badge, details text
- [ ] Display affected consumers as a list: entity name (link), field name, relationship type, owner email
- [ ] Display migration artifacts preview: collapsible section with summary per target, expandable to show full artifacts
- [ ] Integrate ImpactReportCard into Governance Dashboard detail panel (when viewing a request)

### Complexity Badges
- [ ] "trivial" → green badge
- [ ] "moderate" → amber badge
- [ ] "complex" → red badge

### Compatibility Status Icons
- [ ] Compatible → green check icon
- [ ] Migration required → amber warning icon
- [ ] Incompatible → red X icon

### Notification Content Preparation
- [ ] Structure impact report data so it can be consumed by notification service (Epic 7)
- [ ] Include: summary, severity, entity name, change type, per-target headline

### REST API Integration
- [ ] Include impact report data in `/compatibility` API endpoint response

### Testing
- [ ] Unit test: impact report correctly identifies per-target compatibility for a non-breaking change (all targets compatible)
- [ ] Unit test: impact report correctly identifies per-target compatibility for a breaking change (mixed compatibility)
- [ ] Unit test: affected consumers are correctly identified via entity relationship references
- [ ] Unit test: affected consumers list is empty when no entities reference the changed entity
- [ ] Unit test: migration complexity is classified as "trivial" for add-only changes
- [ ] Unit test: migration complexity is classified as "complex" for field removals
- [ ] Unit test: migration artifacts summary is generated correctly for all three targets
- [ ] Playwright E2E: breaking change → governance request created with impact report → view in Governance Dashboard → per-target breakdown visible with correct status → affected consumers listed

## Dev Notes

### Architecture & Patterns

**Service pattern:** Impact report generation is a read-heavy computation that aggregates data from multiple sources (classification, migration artifacts, entity relationships, user data). Returns `Result<ImpactReport>`. No direct DB writes — the report is stored by the governance service when creating the request.

**Data flow:**
```
classifyChange() → ChangeClassification
    ↓
generateMigrationArtifacts() → MigrationArtifacts (per target)
    ↓
queryAffectedConsumers() → AffectedConsumer[]
    ↓
generateImpactReport() → ImpactReport
    ↓
createRequest(impactReport) → stored in governance_requests.impactReport JSONB
```

**Module boundary:** Impact report service depends on:
- Classification service (read) — receives ChangeClassification
- Migration service (read) — calls generateMigrationArtifacts for per-target analysis
- Schema data (read) — entity relationships for affected consumer identification
- User data (read) — owner emails for affected consumers
- Does NOT own the governance_requests table — it produces data that governance service stores

**JSONB validation:** Impact report JSONB is validated with Zod before storage, per architecture rule "Zod schemas on every JSONB write."

### UX/Design Requirements

**Impact report card in Governance Dashboard:**
- Rendered in the detail panel (right side of split layout)
- Summary at top in larger text
- Per-target breakdown as a compact data table with status icons and complexity badges
- Affected consumers as a list with entity name as clickable link (navigates to that entity)
- Migration artifacts preview: collapsible/expandable section — collapsed by default to avoid overwhelming the approver

**Badge design:**
- Complexity: trivial (green), moderate (amber), complex (red)
- Status: compatible (green check), migration required (amber warning), incompatible (red X)
- Use Shadcn Badge component with appropriate variants

**Design principle:** "I understand exactly what I'm approving" — the impact report must make approval decisions feel empowered, not bureaucratic. Information hierarchy: summary first, details available on expansion.

**Frosted glass card:** Use `--glass-bg: rgba(28, 28, 38, 0.8)` with `backdrop-filter: blur(12px)` for the impact report card.

### File Structure
```
src/services/impact-report.service.ts                    — Impact report generation logic
src/types/schemas/governance.ts                          — Add ImpactReport, PerTargetImpact, AffectedConsumer schemas
src/services/governance.service.ts                       — Update createRequest to generate impact report
src/features/governance/ImpactReportCard/
  ├── ImpactReportCard.tsx                               — Impact report display component
  ├── ImpactReportCard.types.ts                          — Props & types
  └── index.ts                                           — Re-export
tests/unit/services/impact-report.service.test.ts        — Unit tests
tests/e2e/impact-report.spec.ts                          — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Mock migration service and relationship queries. Test per-target compatibility analysis, affected consumer identification, complexity classification, summary generation.
- **E2E tests (Playwright):** Full flow from breaking change through governance request creation to viewing impact report in dashboard.

### Dependencies & Prerequisites
- Story 5.2 complete — governance workflow with request creation
- Story 4.4 complete — migration artifact generator for per-target analysis
- Story 5.1 complete — change classification engine
- Entity relationship data available (from schema authoring)
- User data with email available (from auth system)

### References
- Architecture: `governance_requests.impact_report` JSONB column
- Architecture: Service layer pattern, Result type
- Architecture: JSONB Zod validation on every write
- UX Spec: Governance Tracker split layout
- UX Spec: "I understand exactly what I'm approving" — empowered approval experience
- FR28: Change impact reports showing per-target compatibility and affected downstream consumers

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
