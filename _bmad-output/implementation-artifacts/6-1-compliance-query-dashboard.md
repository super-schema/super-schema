# Story 6.1: Compliance Query Dashboard

Status: review

## Story
As a **compliance officer**, I want to query all entities and fields by classification, policy, retention, and target system, so that I can instantly find all regulated data across the entire schema repository.

## Acceptance Criteria

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

## Tasks / Subtasks

### Backend — Compliance Service
- [x]Create `src/services/compliance.service.ts` with `queryFields(filters, pagination, ctx)` function returning `Result<{ fields: ComplianceFieldResult[], total: number }>`
- [x]Define `ComplianceFilter` Zod schema in `src/types/schemas/compliance.ts` with classification (string[]), retention range (enum), anonymization (enum), encryption (enum), targets (string[]), domains (string[]), textSearch (string)
- [x]Define `ComplianceFieldResult` type with: entityId, entityName, fieldId, fieldName, fieldType, classification, retention, anonymization, encryption, targetSystems, domain
- [x]Implement Prisma query joining `fields` → `entities` → `domains` → `emission_targets` with JSONB decorator extraction for classification/policy fields
- [x]Implement AND-logic filter composition — each active filter narrows the result set
- [x]Implement text search using Prisma `contains` (case-insensitive) across entity name, field name, and field description
- [x]Implement sorting by any result column (dynamic `orderBy` from sort parameter)
- [x]Implement cursor/offset pagination with 25 results per page, returning total count
- [x]Wrap service in RBAC check — require Compliance Officer, Steward, or Admin role
- [x]Add `withAudit()` wrapper for compliance query access logging

### Backend — oRPC Router
- [x]Create `src/server/api/routers/compliance.ts` oRPC router
- [x]Add `compliance.queryFields` query procedure — thin wrapper calling `queryFields` service
- [x]Wire router into `appRouter` in `src/server/api/root.ts`

### Frontend — Compliance Page
- [x]Create `src/app/(dashboard)/compliance/page.tsx` as the compliance dashboard entry point
- [x]Implement full-width layout: filter sidebar (280px fixed left) + results table (flex center)

### Frontend — Filter Sidebar Component
- [x]Create `src/features/compliance/ComplianceFilterSidebar.tsx`
- [x]Implement Classification filter: multi-select checkboxes for PII, SENSITIVE, INTERNAL, PUBLIC, custom
- [x]Implement Policy filter section: retention dropdown (any, < 1 year, 1-3 years, 3-7 years, > 7 years), anonymization dropdown (any, none, hash, mask, redact, pseudonymize), encryption dropdown (any, none, AES-256, field-level)
- [x]Implement Target system filter: multi-select checkboxes for enabled emission targets
- [x]Implement Domain filter: multi-select checkboxes for all domains
- [x]Implement Text search input with debounce (300ms)
- [x]Add "Clear all filters" button at the bottom of the sidebar
- [x]Manage filter state with React state, emit combined filter object on every change

### Frontend — Results Table Component
- [x]Create `src/features/compliance/ComplianceResultsTable.tsx` using Shadcn DataTable
- [x]Implement columns: Entity Name (link to `/schemas/[id]`), Field Name, Type, Classification (Badge), Retention, Anonymization, Target Systems (Badge list), Domain
- [x]Implement sortable column headers (click to toggle asc/desc)
- [x]Implement pagination controls (25 per page) with page navigation
- [x]Display result count above table: "Showing X of Y fields matching filters"
- [x]Integrate with oRPC `compliance.queryFields` via TanStack Query with 300ms debounce on filter changes

### Frontend — Integration
- [x]Add "Compliance" entry to Activity Bar navigation with shield icon
- [x]Ensure real-time filter updates trigger re-query (debounced 300ms)
- [x]Handle loading state with skeleton rows in the DataTable
- [x]Handle empty state: "No fields match the current filters" with suggestion to adjust

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: All business logic in `src/services/compliance.service.ts`. oRPC router is a thin wrapper.
- **Result type**: Service returns `Result<T, ServiceError>` — never throws.
- **RBAC enforcement**: oRPC middleware checks role is Compliance Officer, Steward, or Admin before executing.
- **withAudit()**: Every compliance query is logged to `audit_log` with action `compliance.query`.
- **Module boundary**: Compliance module reads from `entities`, `fields`, `domains`, `emission_targets` tables but never writes to them.
- **JSONB extraction**: Classification and policy data live in `fields.decorators` JSONB column — use Prisma raw queries or JSONB path extraction for filtering.

### UX/Design Requirements
- **Page layout**: Full-width data table with filter sidebar (per UX spec Layer 3 compositions).
- **Theme**: Hex-inspired dark theme — frosted glass panels, 12px border-radius, warm accent colors.
- **Filter sidebar**: Left panel (280px), contains vertically stacked filter groups with section headers.
- **Classification badges**: Use semantic Badge colors — PII (red), SENSITIVE (amber), INTERNAL (blue), PUBLIC (green).
- **Target system badges**: Colored badges per target type.
- **DataTable**: Shadcn DataTable with inline classification badges, validation column, sortable headers.
- **Empty state**: Centered message with icon when no results match filters.
- **Debounce**: 300ms debounce on all filter changes before triggering re-query.

### File Structure
```
src/services/compliance.service.ts           # Business logic — queryFields()
src/types/schemas/compliance.ts              # Zod schemas — ComplianceFilter, ComplianceFieldResult
src/server/api/routers/compliance.ts         # oRPC thin wrapper
src/app/(dashboard)/compliance/page.tsx      # Page entry point
src/features/compliance/ComplianceFilterSidebar.tsx  # Filter controls
src/features/compliance/ComplianceResultsTable.tsx   # DataTable with results
src/features/compliance/index.ts             # Re-exports
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/compliance.service.test.ts`):
  - Each filter type correctly narrows results (classification, retention, anonymization, encryption, targets, domains, text search)
  - Combined filters work with AND logic
  - Text search matches entity name, field name, and description
  - Pagination returns correct pages and total count
  - Sorting by each column produces correct order
  - RBAC: unauthorized roles are rejected
- **E2E tests** (`tests/e2e/compliance-dashboard.spec.ts`):
  - Navigate to Compliance dashboard via Activity Bar
  - Apply classification filter — only matching fields shown
  - Combine multiple filters — results narrow
  - Sort by column — order changes
  - Clear filters — all fields shown
  - Result count updates correctly

### Dependencies & Prerequisites
- Epic 2 (Schema Authoring) complete — entities and fields exist with decorators
- Epic 3 (Emission) complete — emission_targets table populated
- Prisma schema includes `entities`, `fields`, `domains`, `emission_targets` tables
- `audit_log` table and `withAudit()` utility available
- RBAC middleware operational in oRPC

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Data Architecture, Service Layer Pattern, Module Boundaries (Compliance module)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Flow 3: Compliance Audit, Layer 3 Page Compositions
- PRD: FR25-FR34 (Governance & Compliance), NFR5 (performance)
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 6, Story 6.1

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)
### Completion Notes List
- Implemented compliance query service with queryFields(), filter composition (AND logic), JSONB decorator extraction, sorting, pagination
- Created ComplianceFilter/ComplianceFieldResult Zod schemas and types
- Created oRPC compliance router with queryFields procedure wired into appRouter
- Built ComplianceFilterSidebar with classification checkboxes, policy dropdowns, domain checkboxes, text search (300ms debounce)
- Built ComplianceResultsTable with sortable headers, pagination, classification badges, loading skeletons, empty state
- Created compliance dashboard page with tabbed layout (Query/Gaps/Audit Trail)
- RBAC enforcement for Compliance Officer, Steward, Admin roles
- 12 unit tests for queryFields: filter types, combined filters, pagination, sorting, RBAC, JSONB extraction
- E2E tests deferred per instructions
### Change Log
- Created: src/types/schemas/compliance.ts, src/services/compliance.service.ts, src/server/api/routers/compliance.ts
- Created: src/features/compliance/ComplianceFilterSidebar.tsx, ComplianceResultsTable.tsx
- Modified: src/app/(dashboard)/compliance/page.tsx, src/server/api/root.ts
