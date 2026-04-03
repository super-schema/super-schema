# Story 4.3: Change Records & Change History View

Status: ready-for-dev

## Story
As a **data modeler**, I want to view the complete change history and audit trail for any entity, so that I can understand who changed what and when for governance and troubleshooting.

## Acceptance Criteria

**Given** versioning and diff work (Stories 4.1-4.2 complete)
**When** the change history view is implemented
**Then** the entity editor has a **"Change History"** view tab (alongside Editor, Emission Preview) — switching to this tab shows the full change history
**And** the change history view displays a **timeline** of all changes in reverse chronological order, pulling from two sources: version records (from `entity_versions`) and audit trail entries (from `audit_log` for this entity)
**And** each timeline entry shows: timestamp (relative + absolute on hover), user who made the change (avatar + name), change type (version, field edit, decorator change, status change, override, emission), and a summary description
**And** **Version entries** are prominent (larger card) and show: version number, change record summary (X fields added, Y modified, Z removed), and an "Expand" button to see the full change record
**And** **Audit trail entries** are compact (single line) and show: action performed (e.g., "Updated field 'amount' classification to PII"), user, timestamp
**And** the timeline is **filterable** — a filter bar at the top allows filtering by: change type (versions, field edits, decorator changes, emissions, governance), user, and date range
**And** the timeline supports **pagination** — initial load shows the last 50 entries; "Load More" button at the bottom fetches the next page
**And** clicking any timeline entry that references a version opens the diff viewer for that version vs. previous version
**And** unit tests verify: change history combines version records and audit trail correctly, filtering by change type works, pagination returns correct pages
**And** a Playwright E2E test verifies: navigating to change history tab shows timeline, making a change and refreshing shows the new entry, filtering by type reduces visible entries, expanding a version entry shows the change record

## Tasks / Subtasks

### Service Layer
- [ ] Create `src/services/change-history.service.ts` (or add to `version.service.ts`) with `getChangeHistory(entityId, filters, pagination, ctx): Result<ChangeHistoryPage>`
- [ ] Implement query that merges two data sources: `entity_versions` records and `audit_log` entries for the given entity
- [ ] Normalize both sources into a unified `TimelineEntry` type with: id, timestamp, userId, userName, userAvatar, entryType ("version"|"audit"), changeType, summary, metadata (version number, change record, etc.)
- [ ] Sort merged entries by timestamp descending
- [ ] Implement filtering: by change type (versions, field edits, decorator changes, emissions, governance), by user, by date range
- [ ] Implement cursor-based pagination: return 50 entries per page with "hasMore" flag and cursor for next page

### Zod Schemas & Types
- [ ] Define `TimelineEntry` Zod schema in `src/types/schemas/change-history.ts`
- [ ] Define `ChangeHistoryPage` schema: `{ entries: TimelineEntry[], hasMore: boolean, nextCursor?: string }`
- [ ] Define `ChangeHistoryFilters` schema: `{ changeTypes?: string[], userId?: string, dateFrom?: Date, dateTo?: Date }`

### oRPC Router
- [ ] Add `version.getChangeHistory` query to `src/server/api/routers/version.ts` — input: entityId, filters (optional), cursor (optional)
- [ ] Return paginated `ChangeHistoryPage`

### Change History View Tab
- [ ] Add "Change History" tab to entity editor view switcher (alongside Editor, Emission Preview)
- [ ] Create `src/features/schema-editor/ChangeHistoryView/ChangeHistoryView.tsx` — full timeline view
- [ ] Create `src/features/schema-editor/ChangeHistoryView/ChangeHistoryView.types.ts`
- [ ] Create `src/features/schema-editor/ChangeHistoryView/useChangeHistoryView.ts` — data fetching, filter state, pagination

### Timeline Component
- [ ] Create `src/components/custom/ChangeTimeline/ChangeTimeline.tsx` — renders list of timeline entries
- [ ] Implement **version entries** as larger cards: version number badge, change record summary ("Added 2 fields, modified 1 field, removed 0 fields"), "Expand" button
- [ ] Implement **audit trail entries** as compact single-line items: action description, user, timestamp
- [ ] Display timestamps as relative ("2 hours ago") with absolute datetime on hover tooltip
- [ ] Display user info: avatar (or initial circle) + name
- [ ] Display change type indicator/icon for each entry type

### Filter Bar
- [ ] Create filter bar at top of timeline view
- [ ] Add change type multi-select filter: versions, field edits, decorator changes, emissions, governance
- [ ] Add user filter: dropdown of users who have made changes to this entity
- [ ] Add date range filter: from/to date pickers

### Pagination
- [ ] Implement "Load More" button at bottom of timeline
- [ ] On click, fetch next page using cursor and append to existing entries
- [ ] Hide "Load More" when `hasMore` is false

### Version Entry Expansion & Diff Navigation
- [ ] Implement "Expand" button on version entries — expands inline to show full change record (added/removed/modified fields)
- [ ] Implement click-to-diff: clicking a version entry that references a version opens the DiffViewer (Story 4.2) comparing that version with the preceding version

### Testing
- [ ] Unit test: change history merges version records and audit trail correctly
- [ ] Unit test: entries are sorted by timestamp descending
- [ ] Unit test: filtering by change type returns only matching entries
- [ ] Unit test: filtering by user returns only that user's entries
- [ ] Unit test: filtering by date range returns entries within range
- [ ] Unit test: pagination returns correct page size (50) with hasMore flag
- [ ] Unit test: second page starts from correct cursor position
- [ ] Playwright E2E: navigate to Change History tab → timeline displays → make a change and refresh → new entry appears → filter by type → entries reduce → expand a version entry → change record details visible

## Dev Notes

### Architecture & Patterns

**Data sources:**
- `entity_versions` table: version snapshots with change records — these are the "major events"
- `audit_log` table: append-only log of all write operations — these are the granular events

Both are queried by `entity_id` and merged into a unified timeline. The service normalizes both into `TimelineEntry` objects before returning.

**Query strategy:** Two separate Prisma queries (one for `entity_versions`, one for `audit_log` filtered by `entity_type = 'entity'` and `entity_id`), then merge and sort in application code. Pagination is cursor-based on timestamp.

**Service pattern:** Returns `Result<ChangeHistoryPage>`. No throws. Read-only operation — no `withAudit()` needed.

**Module boundary:** Change history reads from both `entity_versions` and `audit_log` tables. It does not write to either. It may link to the DiffViewer (Story 4.2) for navigation but does not own diff logic.

### UX/Design Requirements

**View switching:** "Change History" is a tab alongside "Editor" and "Emission Preview" in the entity editor. Uses the same view switching pattern as Airtable (from UX spec).

**Timeline layout:**
- Version entries: larger card with frosted glass background, version number badge, change summary, expand button
- Audit entries: compact single-line, muted styling
- All entries: relative timestamps ("2 hours ago") with absolute on hover
- User display: avatar circle + name

**Filter bar:** Positioned at top of timeline, uses Shadcn Select/Combobox for filters, DatePicker for date range.

**Pagination:** "Load More" button at bottom — Ghost button style. Infinite scroll is NOT used (explicit pagination per AC).

**Design tokens:**
- `--glass-bg: rgba(28, 28, 38, 0.8)` for version entry cards
- `--mono-size: 13px` for field names and version numbers in change records
- Muted foreground for audit trail entries

### File Structure
```
src/services/change-history.service.ts                   — Business logic (or extend version.service.ts)
src/types/schemas/change-history.ts                      — Zod schemas + TS types
src/server/api/routers/version.ts                        — Add getChangeHistory query
src/features/schema-editor/ChangeHistoryView/
  ├── ChangeHistoryView.tsx                              — Tab view component
  ├── ChangeHistoryView.types.ts                         — Props & types
  ├── useChangeHistoryView.ts                            — Logic hook
  └── index.ts                                           — Re-export
src/components/custom/ChangeTimeline/
  ├── ChangeTimeline.tsx                                 — Timeline list component
  ├── ChangeTimeline.types.ts                            — Props & types
  └── index.ts                                           — Re-export
tests/unit/services/change-history.service.test.ts       — Unit tests
tests/e2e/change-history.spec.ts                         — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Mock Prisma client returning mixed version + audit data. Test merging, sorting, filtering, pagination logic.
- **E2E tests (Playwright):** Navigate to Change History tab, verify timeline renders, verify new changes appear after modification, test filters, test expansion of version entries.

### Dependencies & Prerequisites
- Story 4.1 complete — version history with snapshots and change records
- Story 4.2 complete — DiffViewer for click-to-diff navigation
- `audit_log` table populated by `withAudit()` across all services
- Entity editor supports view tab switching (Editor, Emission Preview, Change History)

### References
- Architecture: `entity_versions` and `audit_log` table schemas
- Architecture: Service layer pattern, Result type
- UX Spec: View switching tabs pattern (Airtable-inspired)
- UX Spec: Hex theme tokens for frosted glass cards

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
