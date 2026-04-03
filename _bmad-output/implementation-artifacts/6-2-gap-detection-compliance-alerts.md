# Story 6.2: Gap Detection & Compliance Alerts

Status: ready-for-dev

## Story
As a **compliance officer**, I want to identify fields with missing or incomplete compliance policies, so that I can remediate governance gaps before audits.

## Acceptance Criteria

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

## Tasks / Subtasks

### Backend — Gap Detection Service
- [ ] Add `detectGaps(filters, ctx)` function to `src/services/compliance.service.ts` returning `Result<{ gaps: ComplianceGap[], summary: GapSummary }>`
- [ ] Define `ComplianceGap` type in `src/types/schemas/compliance.ts`: entityId, entityName, fieldId, fieldName, gapType (enum: PII_NO_ANONYMIZATION, SENSITIVE_NO_ENCRYPTION, UNCLASSIFIED, NO_RETENTION), severity (enum: CRITICAL, WARNING), suggestedFix (string)
- [ ] Define `GapSummary` type: criticalCount, warningCount, affectedEntityCount, countsByGapType (Record<GapType, number>)
- [ ] Implement PII-without-anonymization detection: query fields where `decorators.classification.level = 'PII'` AND (`decorators.policy.anonymization` is null OR "none")
- [ ] Implement SENSITIVE-without-encryption detection: query fields where `decorators.classification.level = 'SENSITIVE'` AND (`decorators.policy.encryption` is null OR "none")
- [ ] Implement unclassified-field detection: query fields where `decorators.classification.level` is null or not set
- [ ] Implement missing-retention detection: query fields where classification is PII or SENSITIVE AND `decorators.policy.retention` is null
- [ ] Generate suggested fix text for each gap type (static mapping)
- [ ] Compute gap summary from detected gaps
- [ ] Support optional domain/entity filters on gap detection
- [ ] Wrap in RBAC check — require Compliance Officer, Steward, or Admin role

### Backend — oRPC Router
- [ ] Add `compliance.detectGaps` query procedure to `src/server/api/routers/compliance.ts`
- [ ] Input: optional filters (domains, entities). Output: `{ gaps, summary }`

### Frontend — Gaps Tab
- [ ] Add "Gaps" tab to `src/app/(dashboard)/compliance/page.tsx` using Shadcn Tabs (pill-style)
- [ ] Create `src/features/compliance/ComplianceGapsView.tsx` component

### Frontend — Gap Summary Bar
- [ ] Create gap summary bar above the table: "X critical gaps, Y warnings across Z entities"
- [ ] Display per-gap-type counts as colored badges (red for critical, amber for warning)

### Frontend — Gap Results Table
- [ ] Create `src/features/compliance/ComplianceGapsTable.tsx` using Shadcn DataTable
- [ ] Implement columns: Entity Name, Field Name, Gap Type (Badge — colored by type), Severity (Badge — red/amber), Suggested Fix
- [ ] Make rows clickable — clicking navigates to `/schemas/[entityId]` with query params for fieldId and decorator tab
- [ ] Style severity badges: red for CRITICAL, amber for WARNING
- [ ] Style gap type badges with distinct colors per type

### Frontend — Navigation Integration
- [ ] Implement click-to-navigate: on gap row click, navigate to entity editor with `?fieldId={fieldId}&panel=classification` or `?panel=policy` based on gap type
- [ ] Ensure entity editor reads URL params to auto-select field and open correct decorator tab

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `detectGaps()` lives in the same `compliance.service.ts` as `queryFields()` — shared module boundary.
- **Result type**: Returns `Result<{ gaps, summary }, ServiceError>`.
- **JSONB path queries**: Gap detection requires querying into `fields.decorators` JSONB column — use Prisma `$queryRaw` or `$queryRawUnsafe` with PostgreSQL JSONB operators (`->`, `->>`, `IS NULL`).
- **Suggested fix mapping**: Static map from gap type to human-readable fix string. No AI or dynamic generation.
- **Navigation contract**: Gap row click produces a URL like `/schemas/{entityId}?fieldId={fieldId}&panel=classification`. The entity editor (Epic 2) must support these query params.

### UX/Design Requirements
- **Tab style**: Hex-style pill tabs with gradient active indicator (per UX spec Tabs customization).
- **Gap type badges**: Distinct colors — PII_NO_ANONYMIZATION (red), SENSITIVE_NO_ENCRYPTION (amber), UNCLASSIFIED (red), NO_RETENTION (amber).
- **Severity badges**: Red for CRITICAL, amber for WARNING.
- **Suggested fix column**: Plain text, left-aligned, actionable language.
- **Summary bar**: Prominent display above the table with icon indicators. Use a frosted-glass card.
- **Clickable rows**: Entire row is clickable with hover highlight. Cursor: pointer.
- **Empty state**: "No compliance gaps detected — all fields are properly classified and configured" with a green checkmark icon.

### File Structure
```
src/services/compliance.service.ts           # Extended — detectGaps()
src/types/schemas/compliance.ts              # Extended — ComplianceGap, GapSummary types
src/server/api/routers/compliance.ts         # Extended — detectGaps procedure
src/app/(dashboard)/compliance/page.tsx      # Extended — Gaps tab
src/features/compliance/ComplianceGapsView.tsx    # Gaps tab content
src/features/compliance/ComplianceGapsTable.tsx   # Gap results DataTable
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/compliance.service.test.ts`):
  - PII field without anonymization is detected as CRITICAL gap
  - SENSITIVE field without encryption is detected as WARNING gap
  - Unclassified fields are detected as CRITICAL gap
  - Fields with PII/SENSITIVE without retention are detected as WARNING gap
  - Fields with complete policies produce no gaps
  - Gap counts in summary are correct
  - Domain filter narrows gap detection scope
- **E2E tests** (`tests/e2e/compliance-gaps.spec.ts`):
  - Navigate to Compliance dashboard, switch to Gaps tab
  - Gaps are displayed with correct severity badges
  - Gap summary shows correct counts
  - Clicking a gap row navigates to entity editor with correct field selected
  - Empty state shown when no gaps exist

### Dependencies & Prerequisites
- Story 6.1 (Compliance Query Dashboard) complete
- Entity editor supports URL query params for field selection and panel opening (Epic 2)
- Prisma schema includes `fields.decorators` JSONB with classification and policy data

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — JSONB decorator schema, Compliance module boundary
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Flow 3: gap detection step, Badge semantic colors
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 6, Story 6.2

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
