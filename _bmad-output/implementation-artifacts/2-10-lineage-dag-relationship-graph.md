# Story 2.10: Lineage DAG — Interactive Entity Relationship Graph

Status: ready-for-dev

## Story

As a **data modeler**,
I want to see entity relationships as an interactive graph,
So that I can understand how entities are connected and trace data lineage visually.

## Acceptance Criteria

**Given** entities with relationships exist (Story 2.7 creates reference-type relationships)
**When** the Lineage DAG view is implemented
**Then** the **Lineage Graph** view (Activity Bar -> Lineage) displays an interactive directed acyclic graph (DAG) of all entities and their relationships using React Flow
**And** each entity is a **graph node** rendered as a card: entity name (heading), field count badge, classification summary badges (PII/SENSITIVE count), domain label, status indicator (green/amber/gray)
**And** **relationship edges** connect entities with: arrow direction indicating the reference direction (from referencing entity to referenced entity), cardinality label on the edge ("1:1", "1:N", "N:1", "N:M"), and edge color (primary accent for active, muted for deprecated entities)
**And** the graph supports **zoom** (scroll wheel), **pan** (drag background), and **fit-to-view** (button that auto-fits all nodes in the viewport)
**And** clicking a **node** opens a popover showing: entity name, description, field list (name + type + classification for each), and a "Open in Editor" button that navigates to the entity editor view
**And** the graph supports **filtering** by domain — a domain filter dropdown at the top of the view shows/hides entities by domain
**And** the graph layout uses an **automatic layout algorithm** (dagre or ELK via React Flow) that arranges nodes hierarchically based on relationship direction — entities with no incoming references at the top, downstream entities below
**And** the graph is **read-only** — relationships are created/edited in the entity editor (Story 2.7), not in the graph view
**And** when no entities with relationships exist, an empty state is displayed: "No entity relationships found. Create references between entities to see the lineage graph."
**And** the graph node positions are **not persisted** — layout is recalculated on each view (MVP simplification)
**And** performance: the graph renders smoothly with up to 100 entities and 200 edges; entities beyond that threshold show a warning: "Large graph — consider filtering by domain for better performance"
**And** unit tests verify: nodes are created for all entities with relationships, edges correctly represent relationship direction and cardinality, domain filter shows/hides correct nodes, node popover shows correct entity data
**And** a Playwright E2E test verifies: navigating to Lineage view shows graph with nodes and edges, clicking a node opens popover, "Open in Editor" navigates to entity, domain filter hides entities from unselected domains, empty state shows when no relationships exist

## Tasks / Subtasks

### Task 1: Lineage Page Route [AC: Activity Bar -> Lineage view]
- [ ] Create `src/app/(dashboard)/lineage/page.tsx`
- [ ] Register in Activity Bar navigation (icon: network/graph icon, label: "Lineage")
- [ ] Full-width layout (no right panel needed for this view)

### Task 2: Install & Configure React Flow [AC: React Flow for graph rendering]
- [ ] Install `@xyflow/react` (React Flow v12+)
- [ ] Install `@dagrejs/dagre` or `elkjs` for automatic layout
- [ ] Create `src/features/lineage/LineageGraph.tsx` — main graph component

### Task 3: Data Fetching & Transformation [AC: entities with relationships]
- [ ] Fetch all entities with relationships via oRPC query
- [ ] Transform entity data into React Flow nodes and edges:
  - Nodes: one per entity that has relationships (either as source or target)
  - Edges: one per relationship, from referencing entity to referenced entity
- [ ] Extract relationships from entity metadata JSONB `relationships` array (created in Story 2.7)

### Task 4: Custom Entity Node Component [AC: card-style node with entity info]
- [ ] Create `src/features/lineage/EntityNode.tsx` — custom React Flow node
- [ ] Node card rendering:
  - Background: `bg-card` (`#1c1c26`), `border-border` (`#333340`), `rounded-[12px]`
  - Entity name: `heading-3` (15px/500), monospace
  - Field count `Badge`
  - Classification summary badges: PII count (red), SENSITIVE count (amber)
  - Domain label: `caption` (11px), `text-muted-foreground`
  - Status indicator: colored dot (green=ACTIVE `#5bc27a`, amber=DRAFT `#e5a93b`, gray=DEPRECATED `#8a8694`)
- [ ] Node dimensions: approximately 200x120px
- [ ] Node border: `1px solid #333340`, hover: gradient border

### Task 5: Edge Rendering [AC: arrow direction, cardinality label, edge color]
- [ ] Configure React Flow edges with:
  - Arrow: directed edge (animated arrow from source to target)
  - Cardinality label on edge: "1:1", "1:N", "N:1", "N:M" — displayed as edge label
  - Edge color: `primary` (`#A477B2`) for active entity relationships
  - Edge color: `muted-foreground` (`#8a8694`) for edges involving deprecated entities
  - Edge type: smoothstep or bezier curve
- [ ] Edge label style: `caption` (11px), `bg-card` background for readability

### Task 6: Automatic Layout (Dagre/ELK) [AC: hierarchical layout algorithm]
- [ ] Implement automatic layout using dagre:
  - Direction: top-to-bottom (TB)
  - Entities with no incoming references at the top
  - Downstream entities below
  - Node spacing: horizontal 100px, vertical 80px
- [ ] Recalculate layout on every view load (not persisted)
- [ ] After layout: call `fitView()` to fit all nodes in viewport

### Task 7: Graph Interactions — Zoom, Pan, Fit-to-View [AC: zoom, pan, fit]
- [ ] Zoom: scroll wheel — built-in to React Flow
- [ ] Pan: drag background — built-in to React Flow
- [ ] Fit-to-view button: toolbar button in top-right corner
  - Icon: maximize/fit icon
  - On click: call React Flow `fitView()` with padding
- [ ] Min zoom: 0.1, Max zoom: 2.0

### Task 8: Node Click Popover [AC: popover with entity details + "Open in Editor"]
- [ ] On node click: open `Popover` anchored to the node
- [ ] Popover content:
  - Entity name: `heading-2` (18px/500)
  - Description: `body` (14px), truncated to 3 lines
  - Field list: table of fields — Name (monospace), Type, Classification badge — max 10 fields shown, "+N more" if truncated
  - "Open in Editor" primary `Button` — navigates to `/schemas/[entityId]`
- [ ] Popover style: `bg-popover` (`#22222e`), `backdrop-blur-md`, `rounded-[12px]`
- [ ] Close on click outside or Escape

### Task 9: Domain Filter [AC: dropdown to filter by domain]
- [ ] Add domain filter `Select` dropdown at the top of the lineage view
- [ ] Options: "All Domains" (default) + list of all domains
- [ ] Multi-select or single-select — selecting a domain hides entities from other domains
- [ ] Edges to/from hidden nodes are also hidden
- [ ] Re-run layout after filter change

### Task 10: Empty State [AC: no relationships empty state]
- [ ] When no entities with relationships exist, display:
  - Centered in the graph area
  - Heading: "No entity relationships found"
  - Description: "Create references between entities to see the lineage graph."
  - Style: `heading-2` + `body`, `text-muted-foreground`

### Task 11: Performance Warning [AC: > 100 entities warning]
- [ ] After fetching data, check entity count with relationships
- [ ] If > 100 entities or > 200 edges:
  - Show warning banner at top: "Large graph — consider filtering by domain for better performance"
  - Banner style: `bg-[rgba(229,169,59,0.15)]` `border-warning` `#e5a93b`

### Task 12: Lazy Loading [AC: performance, code splitting]
- [ ] Implement `React.lazy()` for the LineageGraph component
- [ ] Load React Flow and dagre only when the Lineage view is navigated to
- [ ] Show loading skeleton while graph loads

### Task 13: Unit Tests [AC: all unit test verifications]
- [ ] Create `tests/unit/features/lineage.test.ts`:
  - Test nodes are created for all entities with relationships
  - Test edges correctly represent direction (source -> target) and cardinality
  - Test domain filter: selecting domain X hides entities not in domain X
  - Test node data includes correct entity info (name, fields, classification counts)

### Task 14: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/lineage.spec.ts`:
  - Test navigating to Lineage view via Activity Bar shows graph
  - Test graph displays nodes and edges for entities with relationships
  - Test clicking a node opens popover with entity details
  - Test "Open in Editor" button navigates to `/schemas/[entityId]`
  - Test domain filter hides entities from unselected domains
  - Test empty state shows when no entities have relationships

## Dev Notes

### Architecture & Patterns

**LineageDAG component (from architecture):** Interactive relationship graph using React Flow with custom nodes and Popover inspect.

**Performance:** Lazy loading for LineageDAG per architecture.md: "lazy loading for LineageDAG/DiffViewer/EmissionPreview". Code splitting per route.

**Data source:** Relationships stored in entity metadata JSONB `relationships` array (created in Story 2.7):
```json
{ "relationships": [{ "targetEntityId": "xxx", "fieldId": "yyy", "cardinality": "one-to-many" }] }
```

**Graph is read-only:** Relationships are created/edited only in the entity editor (Story 2.7). The graph is a visualization layer only.

**Module boundary:** The Lineage module depends on Schema data (read-only). It never touches Schema CRUD.

### UX/Design Requirements

**LineageDAG (from UX spec):**
- Interactive relationship graph: React Flow + custom nodes + Popover inspect
- dbt Cloud inspiration: interactive DAG for relationships, clickable nodes with cardinality edges

**Node card design:**
- Background: `bg-card` (`#1c1c26`)
- Border: `1px solid #333340`, hover gradient border
- Border radius: 12px
- Entity name: monospace, `heading-3` (15px/500)
- Classification badges: PII red, SENSITIVE amber (per classification badge colors)
- Status dot: same colors as sidebar (green/amber/gray)

**Edge design:**
- Active: `primary` (`#A477B2`) stroke
- Deprecated: `muted-foreground` (`#8a8694`) stroke
- Cardinality label: `caption` (11px), on `bg-card` background
- Arrow direction: from referencing to referenced entity

**Layout dimensions:**
- Full-width center panel (no right panel)
- Toolbar: top-right with fit-to-view button

**Popover (inspect pattern from Figma):**
- `bg-popover` (`#22222e`), `backdrop-blur-md`
- Border radius: 12px
- Shadow: `0 4px 12px rgba(0,0,0,0.4)`

**Empty state pattern:**
- Centered text
- Heading + description
- `text-muted-foreground` for description

### File Structure

```
src/
  app/
    (dashboard)/
      lineage/
        page.tsx                         # NEW — lineage view page
  features/
    lineage/
      LineageGraph.tsx                   # NEW — main React Flow graph component
      EntityNode.tsx                     # NEW — custom node component
      useLineageData.ts                 # NEW — data fetching + transformation hook
  components/
    layout/
      ActivityBar.tsx                    # MODIFIED — add Lineage navigation item

tests/
  unit/
    features/
      lineage.test.ts                   # NEW
  e2e/
    lineage.spec.ts                     # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/features/lineage.test.ts` — node/edge generation from entity data, domain filtering logic, entity data in node

**E2E tests (Playwright):**
- `tests/e2e/lineage.spec.ts` — view navigation, graph rendering, node click popover, "Open in Editor", domain filter, empty state

### Dependencies & Prerequisites

**Prerequisites:** Story 2.7 (reference-type relationships in entity metadata). Activity Bar from Epic 1 (navigation).

**Enables:** No downstream Epic 2 dependency. Lineage view is a standalone visualization. Epic 4 (versioning) may add version-based lineage in future.

### References
- [Source: epics.md - Epic 2, Story 2.10]
- [Source: architecture.md - Frontend Architecture (lazy loading for LineageDAG, code splitting)]
- [Source: architecture.md - Module Boundaries (Lineage depends on Schema data read-only)]
- [Source: ux-design-specification.md - LineageDAG component spec, Interactive DAG (dbt Cloud pattern)]
- [Source: ux-design-specification.md - Depth & Surface System (Surface 1 for nodes, Surface 2 for popovers)]
- [Source: ux-design-specification.md - Color System (classification badges, status indicators, edge colors)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
