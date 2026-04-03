# Story 4.2: Structured Field-Level Diff Viewer

Status: ready-for-dev

## Story
As a **data modeler**, I want to compare any two versions of an entity with a structured field-level diff, so that I can see exactly what changed between versions at a glance.

## Acceptance Criteria

**Given** version history exists (Story 4.1 complete)
**When** the diff viewer is implemented
**Then** the version history panel includes a **"Compare"** button — clicking it enters comparison mode where the user selects two versions (dropdowns: "Version A" and "Version B")
**And** after selecting two versions, the **DiffViewer** component renders in the Center Panel (replacing the field grid temporarily):
**And** the DiffViewer displays a structured table with columns: Field Name, Change Type (badge), Version A Value, Version B Value
**And** **Added fields** (in B but not A) are highlighted with a green background and "Added" badge
**And** **Removed fields** (in A but not B) are highlighted with a red background and "Removed" badge
**And** **Modified fields** (in both but changed) are highlighted with an amber background and "Modified" badge — the specific changed properties are listed (e.g., "type: string → integer, classification: PUBLIC → PII")
**And** **Unchanged fields** are displayed in muted color without highlighting
**And** a **summary bar** above the diff table shows: "X added, Y removed, Z modified, W unchanged" with a count for each change type
**And** the diff viewer supports **property-level expansion** — clicking a modified field row expands it to show all changed decorator properties in a nested before/after format
**And** a **"Close Diff"** button returns to the normal field grid editor
**And** the diff can also be accessed from the version history panel by clicking a **"View Diff"** button on any version — this automatically compares that version with the immediately preceding version
**And** the `version.service.ts` exports a `compareVersions(entityId, versionA, versionB, ctx): Result<DiffResult>` function that computes the field-level diff between two version snapshots
**And** unit tests verify: diff correctly identifies added, removed, and modified fields; property-level changes are captured for modified fields; comparing identical versions returns empty diff; comparing non-adjacent versions works correctly
**And** a Playwright E2E test verifies: entering comparison mode, selecting two versions, diff displays with correct highlighting, expanding a modified field shows property changes, closing diff returns to editor

## Tasks / Subtasks

### Service Layer — Diff Engine
- [ ] Add `compareVersions(entityId, versionA, versionB, ctx): Result<DiffResult>` to `src/services/version.service.ts`
- [ ] Implement field-level diff algorithm: index fields by name from both snapshots, classify as added/removed/modified/unchanged
- [ ] For modified fields, compute property-level changes: iterate all field properties + all decorator categories, record before/after for each changed property
- [ ] Define `DiffResult` type: `{ summary: { added: number, removed: number, modified: number, unchanged: number }, fields: DiffField[] }`
- [ ] Define `DiffField` type: `{ fieldName: string, changeType: "added"|"removed"|"modified"|"unchanged", versionA?: FieldSnapshot, versionB?: FieldSnapshot, changedProperties?: PropertyChange[] }`
- [ ] Define `PropertyChange` type: `{ property: string, category: string, before: any, after: any }`

### Zod Schemas & Types
- [ ] Add `DiffResult`, `DiffField`, `PropertyChange` Zod schemas to `src/types/schemas/version.ts`
- [ ] Export derived TypeScript types

### oRPC Router
- [ ] Add `version.compareVersions` query to `src/server/api/routers/version.ts` — input: entityId, versionA (number), versionB (number)

### DiffViewer Component
- [ ] Create `src/components/custom/DiffViewer/DiffViewer.tsx` — structured table with Field Name, Change Type badge, Version A Value, Version B Value columns
- [ ] Create `src/components/custom/DiffViewer/DiffViewer.types.ts` — props: `DiffResult`, `onClose` callback
- [ ] Create `src/components/custom/DiffViewer/useDiffViewer.ts` — logic hook for expansion state, sorting
- [ ] Create `src/components/custom/DiffViewer/index.ts` — re-export
- [ ] Implement color-coded row highlighting: green for added, red for removed, amber for modified, muted for unchanged
- [ ] Implement change type badges: "Added" (green), "Removed" (red), "Modified" (amber) using Shadcn Badge component
- [ ] Implement summary bar above table: "X added, Y removed, Z modified, W unchanged" with counts
- [ ] Implement property-level expansion: clicking a modified field row expands to show nested before/after for each changed decorator property
- [ ] Implement "Close Diff" button that returns to normal field grid editor

### Comparison Mode in Version History Panel
- [ ] Add "Compare" button to version history panel — clicking enters comparison mode
- [ ] Render two dropdowns: "Version A" and "Version B" populated with all available versions
- [ ] On selecting both versions, call `compareVersions` and render DiffViewer in Center Panel (replacing field grid)
- [ ] Add "View Diff" button on each version entry — auto-compares with the immediately preceding version

### Center Panel Integration
- [ ] Implement state management to swap between field grid editor and DiffViewer in the Center Panel
- [ ] Ensure "Close Diff" restores the field grid editor state without data loss

### Testing
- [ ] Unit test: diff correctly identifies added fields (in B but not A)
- [ ] Unit test: diff correctly identifies removed fields (in A but not B)
- [ ] Unit test: diff correctly identifies modified fields with property-level changes
- [ ] Unit test: property-level changes capture decorator changes (e.g., classification: PUBLIC → PII)
- [ ] Unit test: comparing identical versions returns empty diff (0 added, 0 removed, 0 modified)
- [ ] Unit test: comparing non-adjacent versions (e.g., v1 vs v5) works correctly
- [ ] Playwright E2E: enter comparison mode → select two versions → diff displays with correct highlighting → expand modified field → see property changes → close diff → back to editor

## Dev Notes

### Architecture & Patterns

**Service pattern:** `compareVersions()` is a pure function on two JSONB snapshots. It fetches the two version records from `entity_versions`, extracts their `snapshot` JSONB, and runs the diff algorithm. Returns `Result<DiffResult>` — never throws.

**Diff algorithm:**
1. Parse both snapshots into field maps (keyed by field name)
2. Fields in B but not A → "added"
3. Fields in A but not B → "removed"
4. Fields in both → deep compare all properties (type, precision, scale, nullable, is_key, description, aliases, all 8 decorator categories). Any difference → "modified" with `changedProperties` listing each change
5. Fields in both with no differences → "unchanged"

**Module boundary:** DiffViewer component is purely presentational — it receives `DiffResult` data and renders it. No direct DB access from the component. All data flows through oRPC → service.

### UX/Design Requirements

**DiffViewer component spec (from UX design):**
- Custom table + color-coded rows + before/after columns
- Structured field-level comparison layout
- Renders in Center Panel (replaces field grid temporarily)

**Color scheme:**
- Added: green background — use `--field-complete` / `var(--success)`
- Removed: red background — use `--field-error` / `var(--destructive)`
- Modified: amber background — use `--field-suggestion` / `var(--warning)`
- Unchanged: muted color, no highlighting

**Badges:** Use Shadcn Badge component with variant matching change type colors

**Summary bar:** Positioned above diff table, shows counts for each change type with corresponding color indicators

**Property expansion:** Clicking a modified field row expands inline to show a nested table of changed properties in before → after format. Use monospace font for values.

**Buttons:**
- "Compare" — Secondary button style (muted bg, border)
- "Close Diff" — Ghost button style (no bg, text-only)
- "View Diff" per version — Icon-only button (24x24)

### File Structure
```
src/services/version.service.ts                  — Add compareVersions()
src/types/schemas/version.ts                     — Add DiffResult, DiffField, PropertyChange schemas
src/server/api/routers/version.ts                — Add compareVersions query
src/components/custom/DiffViewer/
  ├── DiffViewer.tsx                             — Main diff table component
  ├── DiffViewer.types.ts                        — Props & types
  ├── useDiffViewer.ts                           — Expansion state, sorting logic
  └── index.ts                                   — Re-export
src/components/custom/VersionHistoryPanel/       — Update with Compare mode
tests/unit/services/version.service.test.ts      — Add diff unit tests
tests/e2e/diff-viewer.spec.ts                   — Playwright E2E
```

### Testing Requirements
- **Unit tests (Vitest):** Test diff algorithm exhaustively — added, removed, modified, unchanged, identical versions, non-adjacent versions, property-level decorator changes across all 8 categories.
- **E2E tests (Playwright):** Full comparison flow from version history through diff viewing to returning to editor.
- **NFR4:** Schema diff and change record generation must complete under 5 seconds.

### Dependencies & Prerequisites
- Story 4.1 complete — version history service with snapshots and change records
- Shadcn Badge component available
- Center Panel supports view swapping (field grid ↔ DiffViewer)
- `entity_versions` table populated with snapshot JSONB data

### References
- UX Spec: DiffViewer component — "Custom table + color-coded rows + before/after columns"
- UX Spec: Button patterns — Secondary for Compare, Ghost for Close Diff
- Architecture: Result type, service layer pattern
- NFR4: Diff generation under 5 seconds

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
