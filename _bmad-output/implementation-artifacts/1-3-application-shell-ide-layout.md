# Story 1.3: Application Shell & IDE Layout

Status: done

## Story

As a **data modeler**,
I want the IDE-style application shell with Activity Bar, Sidebar, Center Panel, Right Panel, Top Bar, and Status Bar,
so that I have a professional workspace layout for schema management.

## Acceptance Criteria

**Given** the design system is implemented (Story 1.2 complete)
**When** an authenticated user navigates to the application
**Then** the layout renders with the following structure:
**And** a **Top Bar** (48px height) is displayed with: logo/app name on the left, a search input placeholder (Cmd+K visual only — command palette functionality deferred to Epic 2), a notification bell icon with badge placeholder, and a user avatar with dropdown menu (profile, logout)
**And** an **Activity Bar** (48px width, icon-only left rail) is displayed with navigation icons for: Schema Editor (default active), Lineage Graph, Governance Dashboard, Compliance, Admin — clicking each icon changes the active route and shows a gradient left border on the active item
**And** a **Left Sidebar** (240px default, resizable 240-320px, collapsible) is displayed with a placeholder tree view labeled "Domains & Entities" and a search input
**And** a **Center Panel** (flex: 1) is displayed as the main content area with an empty state message: "Create your first entity" with a call-to-action button
**And** a **Right Panel** (320px default, resizable 320-480px, collapsible) is displayed with placeholder content labeled "Detail Panel"
**And** a **Status Bar** (24px height) is displayed at the bottom with placeholder segments: domain indicator, validation count, schema version, sync status
**And** panels are resizable via drag handles and collapsible via double-click on the drag handle
**And** panel widths persist to `localStorage` and restore on page reload
**And** at viewport widths below 1280px, the Sidebar and Right Panel auto-collapse and a warning is shown
**And** at 1280-1600px, standard widths apply (sidebar 240px, right panel 320px)
**And** at 1600-1920px, comfortable widths apply (sidebar 280px, right panel 400px)
**And** at viewports above 1920px, spacious widths apply (sidebar 320px, right panel 480px) with max-width on center panel
**And** a Playwright E2E test verifies: the layout renders with all 6 sections visible at 1440px width, Activity Bar navigation switches the active route, sidebar collapses and expands, panel widths persist after reload
**And** a Playwright E2E test verifies: at 1200px width, sidebar and right panel auto-collapse

## Tasks / Subtasks

- [x] **Create the dashboard layout wrapper (`src/app/(dashboard)/layout.tsx`)**
  - Implement the overall IDE grid layout using CSS Grid or Flexbox:
    - Top Bar: full width, 48px height, fixed at top
    - Below top bar: Activity Bar (48px fixed) | Left Sidebar (resizable) | Center Panel (flex: 1) | Right Panel (resizable)
    - Status Bar: full width, 24px height, fixed at bottom
  - Apply `surface-glass` treatment to Top Bar
  - Apply `surface-1` treatment to Activity Bar and Left Sidebar
  - Apply `surface-base` to Center Panel
  - Apply `surface-glass` to Right Panel

- [x] **Build TopBar component (`src/components/layout/TopBar.tsx`)**
  - Height: 48px, full width, frosted glass background (`--glass-bg`, `--glass-blur`)
  - Left section: App logo/name "Super Schema" using `heading-3` (15px, weight 500) with `primary` color (#A477B2)
  - Center section: Search input placeholder with "Search or press Cmd+K..." ghost text, `muted` background (#2a2a36), `border` (#333340), 12px border-radius -- visual only, no functionality yet
  - Right section: Notification bell icon (Lucide `Bell`) with a badge count placeholder (number "0" in a small circle using `primary` bg), user avatar placeholder (Lucide `User` icon) with DropdownMenu containing "Profile" and "Sign Out" items
  - Bottom border: 1px solid `border` (#333340)

- [x] **Build ActivityBar component (`src/components/layout/ActivityBar.tsx`)**
  - Width: 48px, full height (below TopBar, above StatusBar), icon-only vertical rail
  - Background: `surface-1` (#1c1c26)
  - Navigation items (top-aligned, vertical stack):
    1. Schema Editor icon (Lucide `Database` or `FileCode`) -- default active
    2. Lineage Graph icon (Lucide `GitBranch` or `Network`)
    3. Governance Dashboard icon (Lucide `Shield` or `ShieldCheck`)
    4. Compliance icon (Lucide `ClipboardCheck`)
    5. Admin icon (Lucide `Settings`)
  - Each icon: 20px size, `muted-foreground` (#8a8694) default, `foreground` (#e3e1e4) on hover, `primary` (#A477B2) when active
  - Active indicator: 3px gradient left border (`--gradient-border`: linear-gradient(135deg, #A477B2, #F5C0C0)) on the active item
  - Clicking an icon navigates to the corresponding route:
    - Schema Editor: `/(dashboard)/schemas`
    - Lineage: `/(dashboard)/lineage`
    - Governance: `/(dashboard)/governance`
    - Compliance: `/(dashboard)/compliance`
    - Admin: `/(dashboard)/admin`
  - Use Next.js `usePathname()` to determine active item
  - Tooltip on hover showing the section name (using Shadcn Tooltip)

- [x] **Build LeftSidebar component (`src/components/layout/LeftSidebar.tsx`)**
  - Default width: 240px, resizable range: 240-320px, collapsible to 0px
  - Background: `surface-1` (#1c1c26)
  - Top section: Search input for filtering domains/entities, `muted` bg (#2a2a36), 12px border-radius
  - Content: Placeholder tree view with heading "Domains & Entities" using `heading-3` typography
  - Right edge: Drag handle for resizing (4px wide hit area, `border` color on hover)
  - Double-click on drag handle collapses/expands the sidebar
  - Right border: 1px solid `border` (#333340)

- [x] **Build CenterPanel component (`src/components/layout/CenterPanel.tsx`)**
  - Flex: 1 (fills remaining horizontal space)
  - Background: `surface-base` (#14141C)
  - Padding: `space-6` (24px)
  - Empty state (UX-DR31): Centered content with:
    - Heading: "Create your first entity" using `heading-1` (22px, weight 600), `foreground` color
    - Subtext: "Start defining your data schemas" using `body` (14px), `muted-foreground` color
    - CTA button: "New Entity" using Shadcn Button with `primary` variant (#A477B2 bg), 12px border-radius

- [x] **Build RightPanel component (`src/components/layout/RightPanel.tsx`)**
  - Default width: 320px, resizable range: 320-480px, collapsible to 0px
  - Background: `surface-glass` (rgba(28,28,38,0.8), backdrop-blur 12px)
  - Header: "Detail Panel" using `heading-3` typography, with close/collapse button
  - Content: Placeholder text explaining this will show decorator tabs, emission preview, etc.
  - Left edge: Drag handle for resizing (4px wide hit area)
  - Left border: 1px solid `border` (#333340)

- [x] **Build StatusBar component (`src/components/layout/StatusBar.tsx`)**
  - Height: 24px, full width, fixed at bottom
  - Background: `surface-1` (#1c1c26)
  - Top border: 1px solid `border` (#333340)
  - Segments (left to right, separated by 1px `border` dividers):
    1. Domain indicator: "No domain selected" using `caption` (11px), `muted-foreground`
    2. Validation count: "0 errors, 0 warnings" using `caption`, `muted-foreground` (green/amber icons when counts > 0)
    3. Schema version: "v0" using `mono-small` (12px), `muted-foreground`
    4. Sync status: "Synced" or "Not connected" using `caption`, `muted-foreground`
  - All segments are placeholders -- real data wired in later stories

- [x] **Implement panel resize functionality**
  - Create `src/hooks/useResizablePanel.ts` custom hook:
    - Accept `minWidth`, `maxWidth`, `defaultWidth`, `panelId` (for localStorage key)
    - Track width in state, handle mousedown/mousemove/mouseup on drag handle
    - Support collapse: double-click on handle toggles between 0 and last width
    - Persist width to `localStorage` under key `panel-width-{panelId}`
    - Restore width from `localStorage` on mount
  - Apply to LeftSidebar (panelId: `left-sidebar`) and RightPanel (panelId: `right-panel`)

- [x] **Implement responsive panel behavior (UX-DR33)**
  - Create `src/hooks/useResponsiveLayout.ts` custom hook:
    - Listen to `window.innerWidth` with resize observer/listener
    - Below 1280px: auto-collapse both Sidebar and Right Panel, show warning toast/banner
    - 1280-1600px (standard): sidebar 240px, right panel 320px
    - 1600-1920px (comfortable): sidebar 280px, right panel 400px
    - Above 1920px (spacious): sidebar 320px, right panel 480px, max-width on center panel
  - Override user-saved widths when viewport changes breakpoint
  - Integrate with `useResizablePanel` hook

- [x] **Create placeholder route pages**
  - Create `src/app/(dashboard)/schemas/page.tsx` -- renders CenterPanel with entity empty state
  - Create `src/app/(dashboard)/lineage/page.tsx` -- placeholder "Lineage Graph" heading
  - Create `src/app/(dashboard)/governance/page.tsx` -- placeholder "Governance Dashboard" heading
  - Create `src/app/(dashboard)/compliance/page.tsx` -- placeholder "Compliance" heading
  - Create `src/app/(dashboard)/admin/page.tsx` -- placeholder "Admin" heading
  - Default route `/(dashboard)` redirects to `/(dashboard)/schemas`

- [x] **Write Playwright E2E tests**
  - Create `tests/e2e/layout.spec.ts`:
    - Test 1 (1440px width): Verify all 6 sections render (TopBar, ActivityBar, LeftSidebar, CenterPanel, RightPanel, StatusBar)
    - Test 2: Click each Activity Bar icon and verify route changes (URL path updates)
    - Test 3: Collapse sidebar, verify it hides; expand, verify it shows
    - Test 4: Resize sidebar, reload page, verify width persists from localStorage
    - Test 5 (1200px width): Verify sidebar and right panel auto-collapse, warning is visible

## Dev Notes

### Architecture & Patterns
- **Next.js App Router**: The dashboard layout is a layout component at `src/app/(dashboard)/layout.tsx` wrapping all authenticated pages. Route groups `(dashboard)` and `(auth)` separate authenticated vs public pages.
- **Component pattern**: Each layout component follows the project pattern:
  ```
  src/components/layout/TopBar/
  ├── TopBar.tsx
  ├── TopBar.types.ts
  ├── useTopBar.ts (if needed)
  └── index.ts
  ```
  Alternatively, simpler layout components can be single files in `src/components/layout/`.
- **Naming**: PascalCase for component files, camelCase for hooks.
- **Icons**: Use Lucide React icons (installed with Shadcn/ui) -- consistent icon set throughout the app.
- **State management**: Panel widths and collapse state are UI state, persisted to localStorage. Use React context if multiple components need to read/write panel state.

### UX/Design Requirements

**Layout Dimensions (UX-DR3, UX-DR4):**
| Section | Dimensions |
|---------|------------|
| Top Bar | 48px height, full width |
| Activity Bar | 48px width, icon-only left rail |
| Left Sidebar | 240-320px width, resizable, collapsible |
| Center Panel | flex: 1 |
| Right Panel | 320-480px width, resizable, collapsible |
| Status Bar | 24px height, full width |

**Activity Bar Icons (UX-DR3):**
- Schema Editor (default active), Lineage Graph, Governance Dashboard, Compliance, Admin
- Active indicator: 3px gradient left border using `linear-gradient(135deg, #A477B2, #F5C0C0)`
- Icon size: 20px
- Default color: `#8a8694` (muted-foreground)
- Hover color: `#e3e1e4` (foreground)
- Active color: `#A477B2` (primary)

**Top Bar (UX-DR4):**
- Logo + Cmd+K search placeholder + notification bell + user avatar/menu
- Frosted glass treatment: `rgba(28,28,38,0.8)` bg, `backdrop-filter: blur(12px)`

**Empty State (UX-DR31):**
- "Create your first entity" + CTA button
- Centered in the Center Panel

**Responsive Breakpoints (UX-DR33):**
| Viewport | Sidebar | Right Panel | Behavior |
|----------|---------|-------------|----------|
| < 1280px | Auto-collapse | Auto-collapse | Warning shown |
| 1280-1600px | 240px | 320px | Standard |
| 1600-1920px | 280px | 400px | Comfortable |
| > 1920px | 320px | 480px | Spacious, max-width center |

**Panel Interactions:**
- Drag-to-resize with visible drag handle on hover
- Double-click drag handle to collapse/expand
- Widths saved to localStorage, restored on reload
- Animations: panel expand/collapse uses 200ms ease-out (UX-DR29)

**Surface Assignments:**
- Top Bar: Glass layer (`rgba(28,28,38,0.8)`, blur 12px)
- Activity Bar: Surface 1 (`#1c1c26`)
- Left Sidebar: Surface 1 (`#1c1c26`)
- Center Panel: Base (`#14141C`)
- Right Panel: Glass layer
- Status Bar: Surface 1 (`#1c1c26`)

### File Structure
Files this story creates:

```
src/
├── app/
│   └── (dashboard)/
│       ├── layout.tsx                 # IDE grid layout wrapper
│       ├── page.tsx                   # Redirect to /schemas
│       ├── schemas/
│       │   └── page.tsx               # Schema editor placeholder
│       ├── lineage/
│       │   └── page.tsx               # Lineage placeholder
│       ├── governance/
│       │   └── page.tsx               # Governance placeholder
│       ├── compliance/
│       │   └── page.tsx               # Compliance placeholder
│       └── admin/
│           └── page.tsx               # Admin placeholder
├── components/layout/
│   ├── TopBar.tsx                     # Top bar with logo, search, bell, user menu
│   ├── ActivityBar.tsx                # 48px icon-only left rail with navigation
│   ├── LeftSidebar.tsx                # Resizable/collapsible sidebar
│   ├── CenterPanel.tsx                # Main content area with empty state
│   ├── RightPanel.tsx                 # Resizable/collapsible detail panel
│   └── StatusBar.tsx                  # Bottom status strip
├── hooks/
│   ├── useResizablePanel.ts           # Drag resize + collapse + localStorage
│   └── useResponsiveLayout.ts         # Viewport breakpoint detection
tests/
└── e2e/
    └── layout.spec.ts                 # E2E tests for layout rendering + interactions
```

### Testing Requirements
- **E2E test 1** (`tests/e2e/layout.spec.ts`): At 1440px viewport, all 6 layout sections are visible and contain expected content
- **E2E test 2**: Activity Bar navigation icons switch the active route (URL changes)
- **E2E test 3**: Sidebar collapse/expand works via double-click on drag handle
- **E2E test 4**: Panel width persists after page reload (localStorage)
- **E2E test 5**: At 1200px viewport, sidebar and right panel auto-collapse with warning visible

### Dependencies & Prerequisites
- **Prerequisites**: Story 1.2 (Design System Foundation) must be complete -- this story uses all color tokens, surface layers, typography, spacing, and Shadcn/ui components
- **Enables**: Story 1.4 (Local User Authentication) -- auth pages and protected routes build on this layout
- **Enables**: All Epic 2+ UI stories use this shell as the workspace container

### References
- [Source: epics.md - Epic 1, Story 1.3]
- [Source: ux-design-specification.md - Spacing & Layout Foundation (layout grid diagram)]
- [Source: ux-design-specification.md - Design Direction Decision (panel dimensions)]
- [Source: ux-design-specification.md - UX-DR3 (IDE layout)]
- [Source: ux-design-specification.md - UX-DR4 (Top Bar)]
- [Source: ux-design-specification.md - UX-DR31 (Empty states)]
- [Source: ux-design-specification.md - UX-DR33 (Responsive panel behavior)]
- [Source: ux-design-specification.md - Depth & Surface System]
- [Source: architecture.md - Frontend Architecture (code organization)]
- [Source: architecture.md - Project Structure]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)
### Completion Notes List
- Dashboard layout with 6-section IDE grid: TopBar, ActivityBar, LeftSidebar, CenterPanel, RightPanel, StatusBar
- TopBar: frosted glass, logo, search placeholder, notification bell, user dropdown
- ActivityBar: 5 nav items with gradient active indicator, tooltips, route navigation
- LeftSidebar: resizable 240-320px, collapsible, search filter, tree view placeholder
- CenterPanel: flex-1, empty state with "Create your first entity" CTA
- RightPanel: resizable 320-480px, collapsible, frosted glass, detail panel placeholder
- StatusBar: domain, validation, version, sync status placeholders
- useResizablePanel hook: drag resize, double-click collapse, localStorage persistence
- useResponsiveLayout hook: 4 breakpoints (compact/standard/comfortable/spacious), auto-collapse
- 5 placeholder route pages: schemas, lineage, governance, compliance, admin
- Dashboard root redirects to /schemas
- 5 E2E tests: layout rendering, nav routing, sidebar collapse, localStorage persistence, responsive auto-collapse
- All 46 unit tests + 6 E2E tests pass, build succeeds

### File List
- src/app/(dashboard)/layout.tsx (new)
- src/app/(dashboard)/page.tsx (new - redirect)
- src/app/(dashboard)/schemas/page.tsx (new)
- src/app/(dashboard)/lineage/page.tsx (new)
- src/app/(dashboard)/governance/page.tsx (new)
- src/app/(dashboard)/compliance/page.tsx (new)
- src/app/(dashboard)/admin/page.tsx (new)
- src/components/layout/TopBar.tsx (new)
- src/components/layout/ActivityBar.tsx (new)
- src/components/layout/LeftSidebar.tsx (new)
- src/components/layout/CenterPanel.tsx (new)
- src/components/layout/RightPanel.tsx (new)
- src/components/layout/StatusBar.tsx (new)
- src/hooks/useResizablePanel.ts (new)
- src/hooks/useResponsiveLayout.ts (new)
- tests/e2e/layout.spec.ts (new)

### Change Log
- 2026-04-03: Story 1.3 implemented - Full IDE-style application shell with 6 layout sections, resizable panels, responsive behavior, and 5 E2E tests
