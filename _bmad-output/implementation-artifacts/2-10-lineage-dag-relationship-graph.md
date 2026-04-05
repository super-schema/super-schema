# Story 2.10: Lineage DAG — Interactive Entity Relationship Graph

Status: done

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
- [x] Create `src/app/(dashboard)/lineage/page.tsx`
- [x] Register in Activity Bar navigation (icon: network/graph icon, label: "Lineage")
- [x] Full-width layout (no right panel needed for this view)

### Task 2: Install & Configure React Flow [AC: React Flow for graph rendering]
- [x] Install `@xyflow/react` (React Flow v12+)
- [x] Install `@dagrejs/dagre` or `elkjs` for automatic layout
- [x] Create `src/features/lineage/LineageGraph.tsx` — main graph component

### Task 3: Data Fetching & Transformation [AC: entities with relationships]
- [x] Fetch all entities with relationships via Prisma (server component)
- [x] Transform entity data into React Flow nodes and edges:
  - Nodes: one per entity that has relationships (either as source or target)
  - Edges: one per relationship, from referencing entity to referenced entity
- [x] Extract relationships from entity metadata JSONB `relationships` array (created in Story 2.7)

### Task 4: Custom Entity Node Component [AC: card-style node with entity info]
- [x] Create `src/features/lineage/EntityNode.tsx` — custom React Flow node
- [x] Node card rendering:
  - Background: `bg-card` (`#1c1c26`), `border-border` (`#333340`), `rounded-[12px]`
  - Entity name: `heading-3` (15px/500), monospace
  - Field count `Badge`
  - Classification summary badges: PII count (red), SENSITIVE count (amber)
  - Domain label: `caption` (11px), `text-muted-foreground`
  - Status indicator: colored dot (green=ACTIVE `#5bc27a`, amber=DRAFT `#e5a93b`, gray=DEPRECATED `#8a8694`)
- [x] Node dimensions: approximately 200x120px
- [x] Node border: `1px solid #333340`, hover: gradient border

### Task 5: Edge Rendering [AC: arrow direction, cardinality label, edge color]
- [x] Configure React Flow edges with:
  - Arrow: directed edge (animated arrow from source to target)
  - Cardinality label on edge: "1:1", "1:N", "N:1", "N:M" — displayed as edge label
  - Edge color: `primary` (`#A477B2`) for active entity relationships
  - Edge color: `muted-foreground` (`#8a8694`) for edges involving deprecated entities
  - Edge type: smoothstep or bezier curve
- [x] Edge label style: `caption` (11px), `bg-card` background for readability

### Task 6: Automatic Layout (Dagre/ELK) [AC: hierarchical layout algorithm]
- [x] Implement automatic layout using dagre:
  - Direction: top-to-bottom (TB)
  - Entities with no incoming references at the top
  - Downstream entities below
  - Node spacing: horizontal 100px, vertical 80px
- [x] Recalculate layout on every view load (not persisted)
- [x] After layout: call `fitView()` to fit all nodes in viewport

### Task 7: Graph Interactions — Zoom, Pan, Fit-to-View [AC: zoom, pan, fit]
- [x] Zoom: scroll wheel — built-in to React Flow
- [x] Pan: drag background — built-in to React Flow
- [x] Fit-to-view button: toolbar button in top-right corner
  - Icon: maximize/fit icon
  - On click: call React Flow `fitView()` with padding
- [x] Min zoom: 0.1, Max zoom: 2.0

### Task 8: Node Click Popover [AC: popover with entity details + "Open in Editor"]
- [x] On node click: open `Popover` anchored to the node
- [x] Popover content:
  - Entity name: `heading-2` (18px/500)
  - Description: `body` (14px), truncated to 3 lines
  - Field list: table of fields — Name (monospace), Type, Classification badge — max 10 fields shown, "+N more" if truncated
  - "Open in Editor" primary `Button` — navigates to `/schemas/[domainSlug]/[entityId]`
- [x] Popover style: `bg-popover` (`#22222e`), `backdrop-blur-md`, `rounded-[12px]`
- [x] Close on click outside or Escape

### Task 9: Domain Filter [AC: dropdown to filter by domain]
- [x] Add domain filter `Select` dropdown at the top of the lineage view
- [x] Options: "All Domains" (default) + list of all domains
- [x] Multi-select or single-select — selecting a domain hides entities from other domains
- [x] Edges to/from hidden nodes are also hidden
- [x] Re-run layout after filter change

### Task 10: Empty State [AC: no relationships empty state]
- [x] When no entities with relationships exist, display:
  - Centered in the graph area
  - Heading: "No entity relationships found"
  - Description: "Create references between entities to see the lineage graph."
  - Style: `heading-2` + `body`, `text-muted-foreground`

### Task 11: Performance Warning [AC: > 100 entities warning]
- [x] After fetching data, check entity count with relationships
- [x] If > 100 entities or > 200 edges:
  - Show warning banner at top: "Large graph — consider filtering by domain for better performance"
  - Banner style: `bg-[rgba(229,169,59,0.15)]` `border-warning` `#e5a93b`

### Task 12: Lazy Loading [AC: performance, code splitting]
- [x] Implement `next/dynamic` for the LineageGraph component (ssr: false)
- [x] Load React Flow and dagre only when the Lineage view is navigated to
- [x] Show loading skeleton while graph loads

### Task 13: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/features/lineage.test.ts`:
  - Test nodes are created for all entities with relationships
  - Test edges correctly represent direction (source -> target) and cardinality
  - Test domain filter: selecting domain X hides entities not in domain X
  - Test node data includes correct entity info (name, fields, classification counts)

### Task 14: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Skipped per instructions (E2E tests excluded from scope)

## Dev Notes

### Implementation Context — What Already Exists

The lineage route and shell components are partially scaffolded. Key existing pieces:

**Route page (server component):** `src/app/(dashboard)/lineage/page.tsx` already exists and fetches all entities with their domains and field counts via Prisma. It reads `metadata.relationships` from the entity JSONB column and passes a serialized `entityData` array (id, name, domainName, domainSlug, status, fieldCount, relationships) as props to the client-side `LineageGraph` component. Data fetching is server-side only — there are no oRPC or client-side queries involved.

**LineageGraph shell:** `src/features/lineage/LineageGraph.tsx` is a `"use client"` component that already imports from `@xyflow/react`, renders `<ReactFlow>` with `<Background>` and `<Controls>`, converts entity data to React Flow nodes and edges via `useMemo`, and shows an empty state when no entities exist. However, it uses a naive grid layout (`(i % 4) * 280`) rather than dagre. Edges are created from `entity.relationships` with `animated: true` and hardcoded `stroke: "#A477B2"`.

**EntityNode shell:** `src/features/lineage/EntityNode.tsx` is a custom React Flow node with `Handle` components (target left, source right), a status dot, entity name in monospace, a field count `Badge`, and domain name label. It uses `surface-glass` styling and `rounded-xl border-border`.

**ActivityBar:** `src/components/layout/ActivityBar.tsx` already includes a Lineage nav item (`{ icon: GitBranch, label: "Lineage Graph", href: "/lineage" }`). The ActivityBar is defined but not yet rendered in the dashboard layout — it needs to be wired into `src/app/(dashboard)/layout.tsx` or confirmed as already present.

**Dashboard layout:** `src/app/(dashboard)/layout.tsx` renders `TopBar`, `LeftSidebar` (resizable), center `<main>`, `RightPanel` (resizable), `StatusBar`, and `CommandPalette`. The Lineage view should render in the center `<main>` area. The right panel can remain collapsed/hidden for this view.

**React Flow is installed:** `@xyflow/react` v12.10.2 is in `package.json`. **dagre is NOT installed** — `@dagrejs/dagre` must be added.

### Architecture & Patterns

**Data source — entity metadata JSONB:** Relationships are stored in the entity `metadata` JSONB column, validated by `EntityMetadataSchema` in `src/types/schemas/entity-metadata.schema.ts`. The schema defines:
```typescript
relationships: z.array(
  z.object({
    targetEntityId: z.string(),
    type: z.enum(["one-to-one", "one-to-many", "many-to-many"]),
    foreignKey: z.string().optional(),
  })
)
```
The `type` field maps to cardinality labels on edges: `"one-to-one"` -> `"1:1"`, `"one-to-many"` -> `"1:N"`, `"many-to-many"` -> `"N:M"`. Story 2.7 must be implemented first so that relationships actually exist in entity metadata.

**Server-side data fetching:** The lineage `page.tsx` is an async server component. Entity data (including relationships from metadata JSONB) is fetched via Prisma `entity.findMany` with `include: { domain: true, _count: { select: { fields: true } } }`. The serialized data is passed as props to the client `LineageGraph` component. No client-side data fetching hooks are needed.

**Graph is read-only:** Relationships are created/edited only in the entity editor (Story 2.7). The graph is a visualization layer only.

**Module boundary:** The Lineage module depends on Schema data (read-only). It never touches Schema CRUD.

### dagre Layout Integration

Install `@dagrejs/dagre` and use it to compute hierarchical node positions before passing to React Flow:

```typescript
import Dagre from "@dagrejs/dagre";

function getLayoutedElements(nodes: Node[], edges: Edge[]) {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 100, ranksep: 80 });

  nodes.forEach((node) => g.setNode(node.id, { width: 200, height: 120 }));
  edges.forEach((edge) => g.setEdge(edge.source, edge.target));

  Dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return { ...node, position: { x: pos.x - 100, y: pos.y - 60 } };
  });

  return { nodes: layoutedNodes, edges };
}
```

Replace the current naive grid layout in `LineageGraph.tsx` with this dagre-based layout. Call `fitView()` after layout is applied.

### Lazy Loading with Next.js Dynamic Imports

The current `page.tsx` imports `LineageGraph` directly. Replace with `next/dynamic` to code-split React Flow and dagre:

```typescript
import dynamic from "next/dynamic";

const LineageGraph = dynamic(
  () => import("@/features/lineage/LineageGraph").then((m) => ({ default: m.LineageGraph })),
  {
    ssr: false, // React Flow requires browser APIs
    loading: () => <LineageGraphSkeleton />,
  }
);
```

This ensures `@xyflow/react` and `@dagrejs/dagre` bundles are only loaded when the user navigates to the Lineage view. The `ssr: false` flag is critical because React Flow uses DOM measurement APIs not available during SSR.

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
      layout.tsx                           # EXISTS — dashboard shell (TopBar, LeftSidebar, main, RightPanel, StatusBar)
      lineage/
        page.tsx                           # EXISTS — server component, fetches entities via Prisma, passes to LineageGraph
  features/
    lineage/
      LineageGraph.tsx                     # EXISTS (shell) — MODIFY: add dagre layout, domain filter, popover, fit-to-view toolbar, perf warning
      EntityNode.tsx                       # EXISTS (shell) — MODIFY: add classification badges, refine styling per AC
      useLineageLayout.ts                 # NEW — dagre layout computation helper (extracted for testability)
  components/
    layout/
      ActivityBar.tsx                      # EXISTS — already has Lineage nav item (GitBranch icon, href="/lineage")
  types/
    schemas/
      entity-metadata.schema.ts            # EXISTS — defines EntityMetadata with relationships array (targetEntityId, type, foreignKey)

tests/
  unit/
    features/
      lineage.test.ts                     # NEW — node/edge generation, dagre layout, domain filtering, cardinality mapping
  e2e/
    lineage.spec.ts                       # NEW — navigation, graph rendering, node popover, "Open in Editor", domain filter, empty state
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/features/lineage.test.ts` — node/edge generation from entity data, dagre layout produces valid positions, domain filtering logic, cardinality label mapping, entity data in node

**E2E tests (Playwright):**
- `tests/e2e/lineage.spec.ts` — view navigation via Activity Bar, graph rendering with nodes and edges, node click popover with entity details, "Open in Editor" navigates to `/schemas/[domainSlug]/[entityId]`, domain filter hides entities from unselected domains, empty state shows when no relationships exist

### Dependencies & Prerequisites

**npm dependencies to install:**
- `@dagrejs/dagre` — automatic hierarchical graph layout (dagre algorithm)
- `@xyflow/react` — already installed (v12.10.2)

**Story prerequisites:**
- **Story 2.7** (entity relationships): Must be implemented first. The `metadata.relationships` array in entity JSONB is the data source for all graph edges. Without 2.7, there will be no relationship data to visualize.
- **Activity Bar from Epic 1**: Already implemented. Lineage nav item exists in `ActivityBar.tsx` with `GitBranch` icon and `/lineage` href.

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
Claude Opus 4.6 (1M context)

### Completion Notes List
- Installed `@dagrejs/dagre` and `@types/dagre` for automatic hierarchical graph layout
- Extracted layout logic into `src/features/lineage/useLineageLayout.ts` for testability: `buildNodesAndEdges`, `applyDagreLayout`, `filterByDomain`, `getUniqueDomains`, `cardinalityLabel`
- Updated `src/features/lineage/LineageGraph.tsx`: dagre TB layout, domain filter dropdown, fit-to-view button, performance warning banner, empty state, MiniMap, ReactFlowProvider wrapper
- Updated `src/features/lineage/EntityNode.tsx`: classification badges (PII/SENSITIVE), node click popover with entity details + field table + "Open in Editor" button, status dot with correct colors, Handle positions changed to Top/Bottom for TB layout
- Updated `src/app/(dashboard)/lineage/page.tsx`: `next/dynamic` import with `ssr: false` for code splitting, loading skeleton, enriched entity data with fields/piiCount/sensitiveCount/description
- Created `tests/unit/features/lineage.test.ts` with 22 tests covering cardinality mapping, node/edge generation, dagre layout positions, domain filtering, unique domain extraction
- Pre-existing test failure in `entity-metadata.schema.test.ts` (Zod v4 `.partial()` on arrays) is unrelated

### Change Log
- `package.json` — added `@dagrejs/dagre`, `@types/dagre`
- `src/features/lineage/useLineageLayout.ts` — NEW: layout utilities (dagre, node/edge builder, domain filter)
- `src/features/lineage/LineageGraph.tsx` — MODIFIED: full implementation with dagre layout, toolbar, domain filter, empty state, perf warning
- `src/features/lineage/EntityNode.tsx` — MODIFIED: classification badges, popover with entity details, "Open in Editor"
- `src/app/(dashboard)/lineage/page.tsx` — MODIFIED: dynamic import, enriched data fetching
- `tests/unit/features/lineage.test.ts` — NEW: 22 unit tests for layout utilities
- 2026-04-05: Status changed from review to done
