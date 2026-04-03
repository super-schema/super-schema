# Story 2.2: Entity Browsing with Sidebar Navigation & Tile/List Views

Status: ready-for-dev

## Story

As a **data modeler**,
I want to browse and search entities organized by domain in the sidebar with tile and list view options,
So that I can quickly find and navigate to any entity in the system.

## Acceptance Criteria

**Given** the entity data model and service layer exist (Stories 2.1-2.1c complete)
**When** the entity browsing UI is implemented
**Then** the **Left Sidebar** displays a tree view of domains and their entities — domains as collapsible groups, entities as items within each domain
**And** each entity item in the sidebar shows: entity name (monospace), field count badge, and a colored dot indicating status (green=ACTIVE, amber=DRAFT, gray=DEPRECATED)
**And** a **search input** at the top of the sidebar filters entities by name across all domains in real-time (< 200ms) — matching text is highlighted
**And** clicking an entity in the sidebar navigates to the entity editor view (`/schemas/[id]`) and highlights the active entity in the sidebar
**And** the **Center Panel** shows an entity list view with a **tile/list toggle** button in the top-right
**And** **Tile view** displays EntityCard components in a responsive grid — each card shows: entity name, field count, domain name, classification summary badges (count of PII/SENSITIVE/INTERNAL/PUBLIC fields), status badge, version number, last modified date
**And** **List view** displays a DataTable with sortable columns: Name, Domain, Version, Status, Fields, Last Modified — clicking a column header sorts ascending/descending with sort indicator
**And** the tile/list toggle state persists to localStorage and restores on reload
**And** a "**+ New Entity**" button exists in the sidebar header — clicking opens a popover with: domain selector (searchable dropdown), entity name input, and "Create" primary button
**And** creating an entity via the popover navigates to the new entity's editor view
**And** an **empty state** is displayed when no entities exist: illustration, "Create your first entity" heading, "Get started by creating your first entity definition" description, and a primary "Create Entity" button
**And** when a domain has no entities, it shows an inline empty state: "No entities in this domain — click + to add one"
**And** the entity list fetches data via oRPC using TanStack Query with stale-while-revalidate caching
**And** a Playwright E2E test verifies: sidebar shows domains and entities, search filters correctly, tile/list toggle works and persists, clicking an entity navigates to editor, new entity creation flow works end-to-end, empty state displays when no entities exist

## Tasks / Subtasks

### Task 1: Left Sidebar Component [AC: tree view, entity items, search, active highlight]
- [ ] Create `src/components/layout/Sidebar/Sidebar.tsx` (or modify existing)
- [ ] Implement domain tree view using collapsible groups (Shadcn Accordion or custom tree)
- [ ] Render each domain as a collapsible header with entity count
- [ ] Render each entity item with: entity name in `font-mono text-[13px]`, field count `Badge`, status dot (green `#5bc27a` for ACTIVE, amber `#e5a93b` for DRAFT, gray `#8a8694` for DEPRECATED)
- [ ] Highlight active entity with `bg-accent` (`#3a3a48`) background
- [ ] Wire click handler to navigate to `/schemas/[id]` via Next.js router

### Task 2: Sidebar Search [AC: search input, real-time filtering, highlighted matches]
- [ ] Add search `Input` at top of sidebar with search icon and placeholder "Search entities..."
- [ ] Implement client-side filtering across all domains (< 200ms response)
- [ ] Highlight matching text using `<mark>` or span with `bg-primary/20` treatment
- [ ] When search is active, auto-expand all domains that contain matching entities
- [ ] Clear button (X icon) to reset search

### Task 3: New Entity Popover [AC: + New Entity button, popover, create flow]
- [ ] Add "+" button in sidebar header with tooltip "New Entity (Ctrl+N)"
- [ ] Implement `Popover` with:
  - Domain selector: `Combobox` (searchable dropdown) listing all domains
  - Entity name: `Input` with monospace font
  - "Create" primary `Button` (amethyst `#A477B2` fill)
- [ ] On create: call `entity.create` oRPC mutation, on success navigate to `/schemas/[newId]`
- [ ] Show validation error inline if entity name is empty or duplicate

### Task 4: EntityCard Component [AC: tile view card]
- [ ] Create `src/components/custom/EntityCard/EntityCard.tsx`
- [ ] Create `src/components/custom/EntityCard/EntityCard.types.ts`
- [ ] Create `src/components/custom/EntityCard/index.ts`
- [ ] Implement card with `bg-card` (`#1c1c26`), `border-border` (`#333340`), `rounded-[12px]`
- [ ] Card content: entity name (`heading-3`, 15px/500), field count badge, domain name label, classification summary badges (PII red count, SENSITIVE amber count, INTERNAL blue count, PUBLIC green count), status badge (colored per status), version number (`v{N}`), last modified date (`body-small`, 13px)
- [ ] Classification badge colors per UX spec:
  - PII: `bg-[rgba(229,91,91,0.15)]` text `#e55b5b`
  - SENSITIVE: `bg-[rgba(229,169,59,0.15)]` text `#e5a93b`
  - INTERNAL: `bg-[rgba(107,163,232,0.15)]` text `#6ba3e8`
  - PUBLIC: `bg-[rgba(91,194,122,0.15)]` text `#5bc27a`
- [ ] Click card navigates to `/schemas/[id]`

### Task 5: Center Panel — Tile/List Toggle [AC: toggle, persistence, responsive grid, DataTable]
- [ ] Create `src/features/schema-editor/EntityBrowser.tsx`
- [ ] Implement tile/list toggle button using Shadcn `ToggleGroup` or custom icon buttons (grid icon / list icon)
- [ ] Persist toggle state to `localStorage` key `super-schema:view-mode`
- [ ] Restore from `localStorage` on mount
- [ ] **Tile view**: responsive CSS grid of `EntityCard` components — `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` with `gap-4` (`16px`)
- [ ] **List view**: Shadcn `DataTable` with sortable columns:
  - Name (monospace), Domain, Version, Status (colored badge), Fields (count), Last Modified (relative date)
  - Click column header to sort ascending/descending with arrow indicator
  - Click row navigates to `/schemas/[id]`
- [ ] Tile/list transition: 300ms ease-out animation per UX spec

### Task 6: Empty States [AC: no entities, no entities in domain]
- [ ] Global empty state (no entities at all): centered layout with illustration placeholder, "Create your first entity" heading (`heading-1`), description text, primary "Create Entity" button
- [ ] Domain-level empty state: inline text "No entities in this domain — click + to add one" with `muted-foreground` (`#8a8694`)

### Task 7: Data Fetching [AC: oRPC + TanStack Query]
- [ ] Use `api.entity.list.useQuery()` with TanStack Query for entity list
- [ ] Use `api.domain.list.useQuery()` for domain list in sidebar
- [ ] Configure stale-while-revalidate caching (staleTime: 30s)
- [ ] Use `api.entity.create.useMutation()` for new entity creation with optimistic update

### Task 8: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/entity-browsing.spec.ts`:
  - Test sidebar shows domains and entities after seeding data
  - Test search filters entities by name and highlights matches
  - Test tile/list toggle switches view and persists to localStorage
  - Test clicking entity navigates to `/schemas/[id]`
  - Test new entity creation via popover navigates to editor
  - Test empty state displays when no entities exist

## Dev Notes

### Architecture & Patterns

**Data fetching pattern:** TanStack Query via oRPC hooks with stale-while-revalidate caching. No manual fetch calls.

**State management:**
- Server state: TanStack Query via oRPC hooks
- UI state: React context or useState for view mode toggle, persisted to localStorage
- URL state: Next.js App Router — entity = URL param

**Component pattern (per architecture.md):**
```
src/components/custom/EntityCard/
├── EntityCard.tsx        ← Component
├── EntityCard.types.ts   ← Props + types
├── useEntityCard.ts      ← Logic hook (if needed)
└── index.ts              ← Re-export
```

### UX/Design Requirements

**Layout:** Three-column IDE layout. Left Sidebar: 240-320px resizable/collapsible. Center Panel: flex: 1.

**Sidebar dimensions:** 240px at 1280-1600px, 280px at 1600-1920px, 320px at 1920px+. Resizable via drag handle.

**Color tokens:**
- Background: `#14141C` (page), `#1c1c26` (cards/sidebar)
- Foreground: `#e3e1e4` (primary text), `#8a8694` (muted/secondary text)
- Border: `#333340`
- Accent (hover): `#3a3a48`
- Primary: `#A477B2` (amethyst — buttons, active states)

**Typography:**
- Entity names: `font-mono text-[13px]` (JetBrains Mono)
- Card titles: `heading-3` (15px, weight 500)
- Body: 14px, weight 400
- Badges/captions: 11px, weight 500

**Animations:**
- Tile/list toggle: 300ms ease-out
- Field row hover: 150ms ease-in-out
- Badge appear: 200ms spring

**Status dot colors:** green `#5bc27a` (ACTIVE), amber `#e5a93b` (DRAFT), gray `#8a8694` (DEPRECATED)

**Empty states:** "Create your first entity" heading, "Get started by creating your first entity definition" description, primary "Create Entity" button.

**Border radius:** 12px default (Hex organic softness)

### File Structure

```
src/
  components/
    layout/
      Sidebar/
        Sidebar.tsx                      # MODIFIED — add domain/entity tree, search, + New Entity
    custom/
      EntityCard/
        EntityCard.tsx                   # NEW
        EntityCard.types.ts              # NEW
        index.ts                         # NEW
  features/
    schema-editor/
      EntityBrowser.tsx                  # NEW — center panel with tile/list toggle
  app/
    (dashboard)/
      schemas/
        page.tsx                         # NEW or MODIFIED — entity browser page
      schemas/[id]/
        page.tsx                         # NEW or MODIFIED — entity editor page (placeholder)

tests/
  e2e/
    entity-browsing.spec.ts              # NEW
```

### Testing Requirements

**E2E tests (Playwright):**
- `tests/e2e/entity-browsing.spec.ts` — sidebar tree, search filtering, tile/list toggle persistence, entity navigation, new entity creation, empty states

**Unit tests (optional for pure UI, but recommended):**
- EntityCard renders correct classification badge colors
- Search filtering logic returns correct results

### Dependencies & Prerequisites

**Prerequisites:** Stories 2.1, 2.1b, 2.1c complete (Prisma schema, entity/domain/field services, oRPC routers). Dashboard layout from Epic 1 (Activity Bar, Sidebar shell, Status Bar).

**Enables:** Story 2.3 (Schema Field Editor — needs entity editor view to navigate to), Story 2.9 (Command Palette — entity navigation)

### References
- [Source: epics.md - Epic 2, Story 2.2]
- [Source: architecture.md - Frontend Architecture, State Management, Component Pattern]
- [Source: ux-design-specification.md - Layout Grid, Sidebar, Tile/List Views, EntityCard, Empty States]
- [Source: ux-design-specification.md - Color System, Typography System, Spacing, Micro-Animation System]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
