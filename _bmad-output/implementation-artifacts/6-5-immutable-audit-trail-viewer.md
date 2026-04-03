# Story 6.5: Immutable Audit Trail Viewer

Status: ready-for-dev

## Story
As a **compliance officer**, I want to view and query the complete immutable audit trail for the entire system, so that I can demonstrate compliance and investigate any schema governance question.

## Acceptance Criteria

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

## Tasks / Subtasks

### Backend — Audit Trail Query Service
- [ ] Add `queryAuditTrail(filters, pagination, ctx)` function to `src/services/compliance.service.ts` (or create `src/services/audit.service.ts` if separation is preferred)
- [ ] Define `AuditTrailFilter` Zod schema in `src/types/schemas/compliance.ts`: actionTypes (string[]), userId (string), entityType (enum: entities, fields, governance, emission, override), entityName (string), dateRange ({ from: Date, to: Date })
- [ ] Define `AuditTrailEntry` type: id, action, entityType, entityId, entityName, userId, userName, userAvatar, timestamp, beforeState (JSON), afterState (JSON), changeSummary (string)
- [ ] Implement Prisma query on `audit_log` table with joins to `users` for user info and entity tables for entity names
- [ ] Implement filter composition (AND logic) for all filter types
- [ ] Implement date range filtering using timestamp comparison
- [ ] Implement reverse chronological ordering (newest first)
- [ ] Implement pagination: 50 entries per page with total count
- [ ] Generate `changeSummary` string from diff of beforeState/afterState (e.g., "Updated 3 fields: name, type, classification")
- [ ] RBAC: require Compliance Officer or Admin role for full audit trail access

### Backend — Audit Trail Export
- [ ] Add `exportAuditTrail(filters, ctx)` function — returns all matching entries with no pagination limit
- [ ] Serialize beforeState/afterState as JSON strings for CSV columns

### Backend — oRPC Router
- [ ] Add `compliance.queryAuditTrail` query procedure to `src/server/api/routers/compliance.ts`
- [ ] Add `compliance.exportAuditTrail` query procedure for export (returns all results)

### Database — Immutability Trigger Verification
- [ ] Verify that the PostgreSQL trigger preventing UPDATE/DELETE on `audit_log` exists
- [ ] If not present, create migration with trigger:
  ```sql
  CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
  RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'audit_log table is immutable — UPDATE and DELETE operations are not allowed';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_modification();
  ```
- [ ] Add integration test confirming the trigger rejects UPDATE and DELETE

### Frontend — Audit Trail Tab
- [ ] Add "Audit Trail" tab to `src/app/(dashboard)/compliance/page.tsx` (third tab after Query and Gaps)
- [ ] Create `src/features/compliance/AuditTrailView.tsx` component

### Frontend — Audit Trail Filter Bar
- [ ] Create `src/features/compliance/AuditTrailFilterBar.tsx`
- [ ] Action type filter: multi-select dropdown with options like entity.create, field.update, governance.approve, emission.commit, etc.
- [ ] User filter: searchable dropdown (Combobox) with user list
- [ ] Entity type filter: dropdown — entities, fields, governance, emission, override
- [ ] Entity name filter: text input with debounce
- [ ] Date range filter: two date pickers (from, to) using Shadcn DatePicker
- [ ] "Clear filters" button

### Frontend — Audit Trail List
- [ ] Create `src/features/compliance/AuditTrailList.tsx`
- [ ] Each entry rendered as an expandable card/accordion item
- [ ] Collapsed view: timestamp (absolute format, relative on hover via Tooltip), user avatar (24px) + name, action badge (colored by action category), entity type + entity name (clickable link to entity), change summary text
- [ ] Action badge colors: create (green), update (blue), delete (red), approve (emerald), reject (amber), commit (purple)
- [ ] Pagination: 50 per page with page navigation controls at bottom

### Frontend — Diff Viewer for Audit Entries
- [ ] Create `src/features/compliance/AuditDiffViewer.tsx` or reuse existing `DiffViewer` component
- [ ] Expanded entry shows beforeState and afterState JSONB rendered as formatted JSON
- [ ] Diff highlighting: added properties in green, removed in red, changed in amber
- [ ] Use a JSON diff library (e.g., `deep-diff` or custom) to compute property-level differences
- [ ] Render as side-by-side or unified diff view

### Frontend — Audit Trail Export
- [ ] Add "Export Audit Trail" button (secondary) in the top-right of the Audit Trail tab
- [ ] Fetch all filtered entries via `compliance.exportAuditTrail`
- [ ] Generate CSV with columns: Timestamp, User, Action, Entity Type, Entity Name, Change Summary, Before State (JSON), After State (JSON)
- [ ] Download via Blob URL, file name: `audit-trail-{date}.csv`

## Dev Notes

### Architecture & Patterns
- **Immutable audit_log**: The `audit_log` table has a PostgreSQL trigger that prevents UPDATE and DELETE. This is a non-negotiable security requirement. The trigger must be verified via integration test.
- **Service layer pattern**: Audit trail query logic in the service layer, oRPC is thin wrapper.
- **Result type**: `Result<{ entries: AuditTrailEntry[], total: number }, ServiceError>`.
- **RBAC**: Full audit trail access restricted to Compliance Officer and Admin roles. Authors can view their own audit entries (filtered by userId).
- **Change summary generation**: Computed server-side by diffing beforeState and afterState JSONB. Describes what changed at a high level (e.g., "Updated fields: name, classification").
- **No writes**: This feature only reads from audit_log — it never writes to it. Audit entries are created by `withAudit()` in other services.

### UX/Design Requirements
- **Tab position**: Third tab in the Compliance dashboard — "Query" | "Gaps" | "Audit Trail".
- **Log entry layout**: Card-style entries with clear visual hierarchy. Frosted glass cards.
- **Expandable entries**: Accordion pattern — click to expand and show diff. Smooth expand animation.
- **Action badges**: Colored badges per action category (create=green, update=blue, delete=red, approve=emerald, reject=amber, commit=purple).
- **Diff viewer**: JSON diff with color-coded changes. Monospace font for JSON content. Green for additions, red for removals, amber for changes.
- **Timestamps**: Show absolute time (e.g., "2026-04-02 14:32:05") with relative time on hover ("2 hours ago").
- **Entity links**: Entity name is a clickable link navigating to the entity editor.
- **Filter bar**: Horizontal filter bar above the log list (not a sidebar — different from the Query tab layout).
- **Empty state**: "No audit entries match the current filters" with filter adjustment suggestion.

### File Structure
```
src/services/compliance.service.ts                   # Extended — queryAuditTrail(), exportAuditTrail()
src/types/schemas/compliance.ts                      # Extended — AuditTrailFilter, AuditTrailEntry
src/server/api/routers/compliance.ts                 # Extended — queryAuditTrail, exportAuditTrail procedures
src/app/(dashboard)/compliance/page.tsx              # Extended — Audit Trail tab
src/features/compliance/AuditTrailView.tsx            # Audit Trail tab content
src/features/compliance/AuditTrailFilterBar.tsx       # Filter controls
src/features/compliance/AuditTrailList.tsx            # Log entry list
src/features/compliance/AuditDiffViewer.tsx           # JSON diff viewer for before/after state
prisma/migrations/XXXXXX_audit_log_trigger/          # Trigger migration (if not already present)
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/compliance.service.test.ts`):
  - Audit trail retrieval returns entries in reverse chronological order
  - Filtering by action type narrows results
  - Filtering by user narrows results
  - Filtering by entity type narrows results
  - Filtering by date range narrows results
  - Pagination returns correct entries and total count
  - Export returns all filtered entries without pagination
  - Change summary is correctly generated from before/after state diff
- **Integration tests** (`tests/integration/audit-log-immutability.test.ts`):
  - Attempt to UPDATE an audit_log row via `prisma.$executeRaw` — confirm it throws an error
  - Attempt to DELETE an audit_log row via `prisma.$executeRaw` — confirm it throws an error
  - INSERT into audit_log succeeds (append-only is allowed)
- **E2E tests** (`tests/e2e/audit-trail.spec.ts`):
  - Navigate to Compliance dashboard, switch to Audit Trail tab
  - Log entries are displayed in reverse chronological order
  - Filter by action type — only matching entries shown
  - Expand an entry — before/after diff is displayed with color coding
  - Export button downloads CSV with correct content

### Dependencies & Prerequisites
- Stories 6.1 and 6.2 complete (Compliance dashboard with Query and Gaps tabs)
- `audit_log` table exists and has been populated by `withAudit()` from previous epics
- PostgreSQL trigger for audit_log immutability (created in Epic 2 or earlier)
- Users table with avatar and name for display

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — audit_log table schema, immutable audit trail (append-only, DB-level trigger), withAudit() pattern
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — DiffViewer component, Accordion pattern, Badge semantic colors
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 6, Story 6.5

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
