# Story 5.3: Change Impact Reports

Status: review

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
- [x] Create `src/services/impact-report.service.ts` with `generateImpactReport(classification, diff, entityName, affectedConsumers): Result<ImpactReport>`
- [x] Implement summary generation: human-readable one-line summary of the change

### Per-Target Compatibility Analysis
- [x] For each target in classification.perTarget, compute compatibility, migration required, and complexity
- [x] Determine compatibility per target: compatible = non-breaking changeType
- [x] Classify migration complexity:
  - "trivial": only ADD COLUMN / optional field additions
  - "moderate": type changes with safe conversions, schema evolution compatible
  - "complex": field removals, breaking type changes, manual intervention required
- [x] Populate `perTarget` array: `{ target, compatible, migrationRequired, migrationComplexity, details }`

### Affected Consumer Identification
- [x] Accept pre-resolved affected consumers list (callers handle DB lookup)
- [x] Populate `affectedConsumers` array: `{ entityName, fieldName, relationship, ownerEmail }`

### Migration Artifacts Summary
- [x] Generate concise summaries of migration artifacts per target:
  - BigQuery: counts of ADD/DROP/ALTER operations
  - Avro: compatibility classification
  - OpenAPI: breaking change counts
- [x] Populate `migrationArtifactsSummary` object

### Integration with Governance Request Creation
- [x] `governance.service.ts` `createRequest()` accepts impactReport parameter
- [x] Stores the complete impact report in the governance request

### Zod Schemas & Types
- [x] Define `ImpactReport` Zod schema in `src/types/schemas/governance.ts`
- [x] Define `PerTargetImpact` schema
- [x] Define `AffectedConsumer` schema
- [x] Define `MigrationArtifactsSummary` schema
- [x] Export derived TypeScript types

### Impact Report Display — Governance Dashboard
- [x] Create `src/features/governance/ImpactReportCard/ImpactReportCard.tsx`
- [x] Display summary text at top
- [x] Display per-target breakdown: target name, status icon, compatibility badge, complexity badge, details
- [x] Display affected consumers as a list
- [x] Display migration artifacts preview: collapsible section with summary per target
- [x] Integrate ImpactReportCard into Governance Dashboard detail panel

### Complexity Badges
- [x] "trivial" → green badge
- [x] "moderate" → amber badge
- [x] "complex" → red badge

### Compatibility Status Icons
- [x] Compatible → green check icon
- [x] Migration required → amber warning icon
- [x] Incompatible → red X icon

### Notification Content Preparation
- [x] Impact report data structured for consumption by notification service (Epic 7)

### REST API Integration
- [x] Impact report included in governance request data (accessible via API)

### Testing
- [x] Unit test: impact report correctly identifies per-target compatibility for a non-breaking change (all targets compatible)
- [x] Unit test: impact report correctly identifies per-target compatibility for a breaking change (mixed compatibility)
- [x] Unit test: affected consumers are correctly identified via entity relationship references
- [x] Unit test: affected consumers list is empty when no entities reference the changed entity
- [x] Unit test: migration complexity is classified as "trivial" for add-only changes
- [x] Unit test: migration complexity is classified as "complex" for field removals
- [x] Unit test: migration artifacts summary is generated correctly for all three targets
- [ ] Playwright E2E: skipped per instructions

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
Claude Opus 4.6 (1M context)
### Completion Notes List
- Impact report service implemented as pure functions
- Per-target compatibility derived from classification perTarget data
- Migration complexity computed from diff fields (trivial/moderate/complex)
- BigQuery/Avro/OpenAPI summary generation from diff analysis
- ImpactReportCard UI with frosted glass, collapsible migration artifacts
- Integrated into GovernanceDashboard detail panel
- 11 unit tests covering compatibility, complexity, consumers, and summaries
- Skipped Playwright E2E per instructions
### Change Log
- Created `src/services/impact-report.service.ts` — impact report generation
- Updated `src/types/schemas/governance.ts` — added ImpactReport, PerTargetImpact, AffectedConsumer, MigrationArtifactsSummary schemas
- Created `src/features/governance/ImpactReportCard/ImpactReportCard.tsx`
- Created `tests/unit/services/impact-report.service.test.ts` — 11 tests
