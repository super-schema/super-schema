# Story 2.9: Command Palette & Global Keyboard Shortcuts

Status: done

## Story

As a **data modeler**,
I want a command palette (Cmd+K) and keyboard shortcuts for all common actions,
So that I can navigate and operate the tool efficiently without reaching for the mouse.

## Acceptance Criteria

**Given** entity browsing and editing work (Stories 2.2-2.8 complete)
**When** the command palette and keyboard shortcuts are implemented
**Then** pressing **Cmd+K** (Mac) or **Ctrl+K** (Windows/Linux) opens the **Command Palette** — a centered overlay using the Shadcn Command component with frosted glass background
**And** the command palette has four sections, each with a header label: **Recent** (last 5 accessed entities), **Entities** (all entities searchable by name), **Fields** (all fields searchable by name, showing "Entity -> Field" format), **Actions** (New Entity, Save, Emit, Show Diff, Export)
**And** typing in the search input filters all sections simultaneously — matching text is highlighted with the primary accent color
**And** arrow keys (Up/Down) navigate through results, Enter selects the highlighted item, Escape closes the palette
**And** selecting an **Entity** navigates to its editor view; selecting a **Field** navigates to its entity and auto-selects the field (opening the decorator panel); selecting an **Action** triggers the corresponding action
**And** the command palette is implemented using Shadcn's `<Command>` component with `<CommandGroup>` for sections and `<CommandItem>` for results
**And** **Global keyboard shortcuts** are active when no input is focused:
**And** `Ctrl+N` / `Cmd+N` — opens the new entity creation popover (same as sidebar + button)
**And** `Ctrl+S` / `Cmd+S` — saves the current entity (prevents browser default save dialog)
**And** `Ctrl+E` / `Cmd+E` — triggers emission for the current entity (disabled if fields incomplete)
**And** `/` (slash) — when the field grid is focused but no cell is in edit mode, inserts a new field row with the TypePickerGrid open (Notion-style slash command)
**And** `Tab` — when in the field grid, moves focus to the next editable cell; when in autocomplete, cycles through suggestions
**And** `Enter` — when a field row is focused, opens the decorator detail panel for that field; when in autocomplete, accepts the selected suggestion
**And** `Escape` — closes any open panel, popover, or palette; if detail panel is open, closes it; if command palette is open, closes it
**And** keyboard shortcuts are displayed in **tooltips** on all action buttons — e.g., the Save button tooltip shows "Save (Cmd+S)"
**And** a Playwright E2E test verifies: Cmd+K opens palette, typing filters results, selecting an entity navigates to it, Ctrl+S saves, Escape closes palette, / adds a new field with type picker

## Tasks / Subtasks

### Task 1: Command Palette Component [AC: centered overlay, frosted glass, Shadcn Command]
- [x] Create `src/components/custom/CommandPalette/CommandPalette.tsx`
- [x] Create `src/components/custom/CommandPalette/CommandPalette.types.ts`
- [x] Create `src/components/custom/CommandPalette/index.ts`
- [x] Use Shadcn `<Command>` component as base
- [x] Centered overlay with frosted glass:
  - Overlay: `bg-overlay` (`rgba(0,0,0,0.6)`), `backdrop-blur-sm` (`blur(4px)`)
  - Dialog: `bg-[rgba(28,28,38,0.8)]` (`--glass-bg`), `backdrop-blur-[12px]`, `rounded-[12px]`
  - Width: 640px, max-height: 400px
  - Shadow: `0 4px 12px rgba(0,0,0,0.4)` (Surface 2 depth)

### Task 2: Command Palette Sections [AC: Recent, Entities, Fields, Actions]
- [x] **Recent** section (`<CommandGroup heading="Recent">`):
  - Last 5 accessed entities, stored in localStorage key `super-schema:recent-entities`
  - Each item: entity name (monospace) + domain label
  - Track entity access on navigation to `/schemas/[id]`
- [x] **Entities** section (`<CommandGroup heading="Entities">`):
  - All entities, fetched via `/api/domains-tree` endpoint
  - Each item: entity name (monospace) + domain label + status dot
- [x] **Fields** section (`<CommandGroup heading="Fields">`):
  - All fields across all entities, fetched via `/api/command-palette-fields`
  - Each item: "EntityName -> FieldName" format (monospace) + type label
- [x] **Actions** section (`<CommandGroup heading="Actions">`):
  - New Entity — icon + label + shortcut hint "Cmd+N"
  - Save — icon + label + shortcut hint "Cmd+S"
  - Emit — icon + label + shortcut hint "Cmd+E"
  - Show Diff — icon + label
  - Export — icon + label

### Task 3: Search Filtering [AC: simultaneous filtering, highlighted matches]
- [x] Shadcn `<CommandInput>` handles search
- [x] Filter all sections simultaneously as user types (built-in cmdk behavior)
- [x] Matching via cmdk's built-in fuzzy search with value prop on each item
- [x] Empty results: "No results found" message

### Task 4: Navigation & Selection [AC: arrow keys, Enter, Escape, entity/field/action selection]
- [x] Arrow Up/Down: navigate through all results across sections (built-in to Shadcn Command with `loop` prop)
- [x] Enter: select highlighted item
  - Entity: navigate to `/schemas/[domainSlug]/[entityId]`
  - Field: navigate to `/schemas/[domainSlug]/[entityId]/fields/[fieldId]`
  - Action: trigger the action (open new entity popover, save, emit, etc.)
- [x] Escape: close the palette

### Task 5: Cmd+K Trigger [AC: Cmd+K / Ctrl+K opens palette]
- [x] Create `src/hooks/useCommandPalette.ts`
- [x] Register global keyboard listener for `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux)
- [x] Prevent default browser behavior (Cmd+K = browser search bar in some browsers)
- [x] Toggle palette open/closed
- [x] Mount the CommandPalette in the dashboard layout via CommandPaletteContext

### Task 6: Global Keyboard Shortcuts [AC: all shortcuts]
- [x] Create `src/hooks/useKeyboardShortcuts.ts`
- [x] Register listeners (only active when no `<input>`, `<textarea>`, or `[contenteditable]` is focused for / key):
  - `Cmd+N` / `Ctrl+N`: open new entity creation form — `preventDefault()` to block browser new window
  - `Cmd+S` / `Ctrl+S`: flash "All changes saved" in StatusBar — `preventDefault()` to block browser save dialog
  - `Cmd+E` / `Ctrl+E`: dispatch emit event — `preventDefault()`
  - `/` (slash): dispatch slash-command event to open add field form
  - `Escape`: close any open panel/popover/palette (palette handles its own escape via capture phase)

### Task 7: Slash Command for Field Creation [AC: "/" inserts new field with type picker]
- [x] When "/" is pressed and no input is focused:
  - Dispatches `super-schema:slash-command` custom event
  - FieldEditor listens and calls `setShowAddForm(true)` to open the add field form
  - Form auto-focuses the Name input on open

### Task 8: Shortcut Hints in Tooltips [AC: tooltips on action buttons]
- [x] Update New Entity button with shortcut hint: title="New Entity (Cmd+N)" / "New Entity (Ctrl+N)"
- [x] TopBar search bar shows keyboard shortcut badge (Cmd+K / Ctrl+K)
- [x] Command palette Actions section uses `<CommandShortcut>` for inline hints
- [x] Detect platform (Mac vs. Windows/Linux) via `src/lib/platform.ts` utility

### Task 9: Recent Entity Tracking [AC: last 5 accessed entities]
- [x] Track entity access in localStorage: `super-schema:recent-entities` and `super-schema:recent-entity-entries`
- [x] Data structure: `string[]` of entity IDs + `RecentEntityEntry[]` with full metadata, max 5, most recent first
- [x] Update on navigation to `/schemas/[domainSlug]/[entityId]` via `useEffect` in `entity-workspace.tsx`
- [x] Command palette reads from localStorage on open

### Task 10: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Skipped per instructions (E2E tests not in scope for this implementation)

## Implementation Context

### Existing Command Palette Shell

A working shell already exists at `src/components/custom/CommandPalette/CommandPalette.tsx`. It currently:
- Imports Shadcn `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` from `src/components/ui/command.tsx`
- Handles Cmd+K / Ctrl+K toggle and Escape to close via a `useEffect` keydown listener inline (no separate hook yet)
- Receives `entities` prop (optional array of `{ id, name, domainName, domainSlug }`)
- Renders "Recent" section (reads from `localStorage` key `super-schema:recent-entities`) and "Entities" section
- Navigates via `router.push(\`/schemas/\${domainSlug}/\${entityId}\`)` and tracks recent on select
- Has a single "Go to Domains" action in the Actions section
- Is already mounted in `src/app/(dashboard)/layout.tsx` as `<CommandPalette />` at the bottom of the layout tree (after `<StatusBar />`)
- Currently receives **no props** at the mount site — entity data is not yet piped in

**What needs to change:** The component needs to accept entity + field data (or fetch it), add the Fields section, expand the Actions section (New Entity, Save, Emit, Show Diff, Export with shortcut hints via `<CommandShortcut>`), and add match highlighting. The Cmd+K listener should be extracted into `useCommandPalette` hook. The inline Escape handler should be consolidated with the global shortcuts hook.

### Dashboard Layout Mount Point

`src/app/(dashboard)/layout.tsx` is a `"use client"` component wrapped in `<SessionProvider>`. Structure:
```
<SessionProvider>
  <div className="flex flex-col h-screen overflow-hidden">
    <TopBar />
    <div className="flex flex-1 overflow-hidden">
      <LeftSidebar ... />
      <main ...>{children}</main>
      <RightPanel ... />
    </div>
    <StatusBar />
    <CommandPalette />   <-- already mounted here
  </div>
</SessionProvider>
```

The `useKeyboardShortcuts` hook should also be called from this layout so shortcuts are globally active across all dashboard routes. The hook should receive callback refs for actions like save, emit, and new-entity so it can delegate to the correct page-level handler.

### TopBar Search Trigger

`src/components/layout/TopBar.tsx` has a static search placeholder div ("Search or press Cmd+K..."). This should be made clickable to open the command palette as an alternative trigger. Consider exposing palette open state via context or a lightweight Zustand store so TopBar can call `openPalette()`.

### Field Editor — Slash Command Integration

`src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` uses a **collapsible add form** pattern (not a DataTable with inline rows). Key state:
- `showAddForm` boolean — toggled by clicking the "+" dashed button at the bottom
- `setShowAddForm(true)` opens the form; `resetAddForm()` closes it
- The form auto-focuses the Name `<Input>` on open

The "/" slash command should:
1. Call `setShowAddForm(true)` to open the collapsible add form
2. The form already auto-focuses the Name input, so no extra focus logic is needed
3. This is simpler than the AC description of "inserting a new field row with TypePickerGrid open" — adapt the slash command to match the actual UI pattern (open the add form, let user type name then pick type)
4. The FieldEditor needs to expose a ref or callback (e.g., `onSlashCommand`) that the keyboard shortcuts hook can invoke. Consider using `React.forwardRef` + `useImperativeHandle` or a context-based approach.

Important: The "/" shortcut must only fire when no `<input>`, `<textarea>`, or `[contenteditable]` element is focused. The FieldEditor already has many inline-editing inputs (name, description, aliases), so the focus check is critical.

### Entity Save — Cmd+S Integration

The current entity editing flow uses **server actions with `revalidatePath`** (see `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts`). Individual field changes are saved immediately via `updateFieldAction` on blur — there is **no pending unsaved state** and no explicit "Save" button in the current UI.

Options for Cmd+S:
1. If there is no dirty state, Cmd+S can be a no-op that shows a "Already saved" toast or status bar flash
2. If a future explicit save model is added, Cmd+S would trigger it
3. At minimum, `preventDefault()` must block the browser's native Save dialog
4. Consider adding a brief "Saved" indicator in the `StatusBar` component (`src/components/layout/StatusBar.tsx`) to give visual feedback

### Entity Navigation — Route Structure

Navigation follows the Next.js App Router pattern:
- Domain list: `/schemas`
- Domain detail: `/schemas/[domainSlug]` — rendered by `domain-workspace.tsx`
- Entity detail: `/schemas/[domainSlug]/[entityId]` — rendered by `entity-workspace.tsx`
- Field studio: `/schemas/[domainSlug]/[entityId]/fields/[fieldId]`

The `[domainSlug]` is derived from the domain name via `toSlug()` from `src/lib/domain-utils.ts`. Entity navigation in the command palette must include both `domainSlug` and `entityId` to construct the correct URL (the existing shell already does this correctly).

### New Entity — Cmd+N Integration

Entity creation is handled in `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` via a `showCreate` boolean that renders an inline form. The "New Entity" button in the header calls `setShowCreate(true)`. The LeftSidebar also has a per-domain "+" button (currently a TODO stub).

For Cmd+N:
- If the user is on a domain page, toggle `showCreate` in the DomainWorkspace
- If the user is on an entity page or elsewhere, navigate to the current domain page and open the create form (or show a domain picker first)
- Consider a simpler approach: Cmd+N navigates to `/schemas` or opens the command palette filtered to the "New Entity" action

### Recent Entity Tracking

The existing `CommandPalette.tsx` already implements recent tracking:
- Reads from `localStorage` key `super-schema:recent-entities` (JSON array of entity IDs)
- On entity select: prepends ID, deduplicates, trims to 5, writes back
- The tracking currently only happens on command palette selection, not on general navigation

To match the AC ("track entity access on navigation to `/schemas/[id]`"), add tracking in `entity-workspace.tsx` or the entity page component. Since `page.tsx` is a server component, the tracking `useEffect` should go in `entity-workspace.tsx` (client component):
```tsx
useEffect(() => {
  const key = "super-schema:recent-entities";
  const recent = JSON.parse(localStorage.getItem(key) || "[]")
    .filter((id: string) => id !== entity.id);
  recent.unshift(entity.id);
  localStorage.setItem(key, JSON.stringify(recent.slice(0, 5)));
}, [entity.id]);
```

### Shadcn Command Component Details

`src/components/ui/command.tsx` exports: `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator`. Built on `cmdk` library.

Key components for this story:
- `CommandShortcut` — renders shortcut hint text (e.g., "Cmd+K") with `ml-auto text-xs tracking-widest text-muted-foreground`. Use this in Action items.
- `CommandDialog` — wraps `Command` in a Shadcn `Dialog`. The existing shell uses a custom overlay instead; consider migrating to `CommandDialog` for consistency, or keep the custom overlay for the frosted glass effect.
- `CommandItem` includes a built-in `CheckIcon` for checked state — not needed for this use case.

### Platform Detection

Use a utility function (e.g., `src/lib/platform.ts`):
```ts
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.platform?.startsWith("Mac") ||
    navigator.userAgent?.includes("Mac");
}
export function modKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}
```

### Hooks Directory

`src/hooks/` currently contains `useResizablePanel.ts` and `useResponsiveLayout.ts`. Both new hooks (`useCommandPalette.ts`, `useKeyboardShortcuts.ts`) follow the same colocation pattern.

## Dev Notes

### UX/Design Requirements

**Command Palette (from UX spec — VS Code + Notion pattern):**
- Centered overlay, frosted glass background
- Overlay: `rgba(0,0,0,0.6)` with `blur(4px)`
- Dialog: `rgba(28,28,38,0.8)` with `blur(12px)`, `rounded-[12px]`
- Width: 640px, max-height: 400px
- Shadow: `0 4px 12px rgba(0,0,0,0.4)`
- Sections: Recent, Entities, Fields, Actions — each with `CommandGroup` header
- Search filter: highlight matches with `primary` accent color (`#A477B2`)
- Keyboard: Arrow Up/Down, Enter select, Escape close

**Shadcn Command component structure:**
```tsx
<Command>
  <CommandInput placeholder="Search entities, fields, actions..." />
  <CommandList>
    <CommandGroup heading="Recent">
      <CommandItem>...</CommandItem>
    </CommandGroup>
    <CommandGroup heading="Entities">...</CommandGroup>
    <CommandGroup heading="Fields">...</CommandGroup>
    <CommandGroup heading="Actions">
      <CommandItem>
        <Plus /> New Entity
        <CommandShortcut>Cmd+N</CommandShortcut>
      </CommandItem>
    </CommandGroup>
    <CommandEmpty>No results found</CommandEmpty>
  </CommandList>
</Command>
```

**Tooltip shortcut display:**
- Monospace font for shortcut text (`mono-small`, 12px)
- Color: `text-muted-foreground` (`#8a8694`)
- Format: "Action Name (Cmd+Key)" or "Action Name (Ctrl+Key)"
- Tooltip background: `bg-popover` (`#22222e`)

**Keyboard-first principle:** "Every action keyboard-accessible. Tab moves through fields, Enter opens detail panel, Escape closes it."

### File Structure

```
src/
  components/
    custom/
      CommandPalette/
        CommandPalette.tsx               # EXISTS — rewrite with full sections, data fetching, match highlighting
        CommandPalette.types.ts          # NEW — typed props for entity/field/action items
        index.ts                         # NEW — barrel export
    layout/
      TopBar.tsx                         # MODIFIED — make search bar clickable to open palette
      StatusBar.tsx                      # MODIFIED — add "Saved" flash indicator for Cmd+S feedback
  ui/
    command.tsx                          # EXISTS — Shadcn Command (cmdk-based), no changes needed
  hooks/
    useCommandPalette.ts                 # NEW — extracted Cmd+K listener, palette open state, optional context provider
    useKeyboardShortcuts.ts              # NEW — global keyboard shortcuts (Cmd+S, Cmd+N, Cmd+E, /, Escape)
    usePlatform.ts                       # NEW — isMac() / modKey() utility hook
  lib/
    platform.ts                          # NEW — non-hook platform detection utility (for server-safe usage)
  app/
    (dashboard)/
      layout.tsx                         # MODIFIED — call useKeyboardShortcuts(), pipe entity data to CommandPalette
      schemas/
        [domainSlug]/
          domain-workspace.tsx           # MODIFIED — expose create form toggle for Cmd+N shortcut
          [entityId]/
            entity-workspace.tsx         # MODIFIED — add recent entity tracking useEffect
            field-editor.tsx             # MODIFIED — expose showAddForm toggle for "/" shortcut

tests/
  e2e/
    command-palette.spec.ts              # NEW
  unit/
    hooks/
      useKeyboardShortcuts.test.ts       # NEW
```

### Testing Requirements

**E2E tests (Playwright):**
- `tests/e2e/command-palette.spec.ts` — Cmd+K open, search filtering, entity navigation, Ctrl+S save, Escape close, "/" field creation

**Unit tests (recommended):**
- `useKeyboardShortcuts` hook — shortcut registration, platform detection, focus-state gating
- `useCommandPalette` hook — open/close toggle, Cmd+K binding
- Recent entity tracking — localStorage read/write, max 5, deduplication

### Dependencies & Prerequisites

**Prerequisites:** Stories 2.2-2.8 complete (entity browsing, field editor, decorator panel, lifecycle — all features that shortcuts interact with)

**Enables:** General productivity improvement. No downstream story dependency.

### Key Decisions for Implementation

1. **State sharing for palette open:** The TopBar needs to open the palette, but the palette is mounted in `layout.tsx`. Use either React Context or a lightweight Zustand store. Context is simpler for a single boolean.

2. **Shortcut action delegation:** `useKeyboardShortcuts` runs in `layout.tsx` but actions like "toggle add form" live in child components. Use a ref-based callback registry, React Context with dispatch, or custom events (`document.dispatchEvent(new CustomEvent('shortcut:slash'))`) that child components listen for.

3. **Entity/field data for palette:** The CommandPalette currently accepts an `entities` prop but gets none. Options: (a) fetch via an API route from the palette itself on open, (b) use the sidebar's `/api/domains-tree` endpoint which already returns domain+entity data, (c) add a dedicated `/api/command-palette-data` endpoint that includes fields. Option (b) is simplest to start with.

4. **Cmd+S semantics:** Since field edits auto-save on blur, Cmd+S is primarily about preventing browser default. Add a brief "All changes saved" flash in the StatusBar for user confidence.

### References
- [Source: epics.md - Epic 2, Story 2.9]
- [Source: architecture.md - Frontend Architecture (URL state via App Router)]
- [Source: ux-design-specification.md - Command Palette (VS Code + Notion pattern)]
- [Source: ux-design-specification.md - Navigation Patterns, Keyboard Shortcuts]
- [Source: ux-design-specification.md - Experience Principles ("Keyboard-first for power users")]
- [Source: ux-design-specification.md - Depth & Surface System (Glass, Overlay layers)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- Rewrote CommandPalette.tsx with four sections (Recent, Entities, Fields, Actions), frosted glass overlay, and Shadcn Command components
- Created CommandPalette.types.ts and index.ts barrel export
- Created useCommandPalette.ts hook with Cmd+K listener, open/close state, and React Context for cross-component access
- Created useKeyboardShortcuts.ts hook with Cmd+S, Cmd+N, Cmd+E, /, and Escape handlers with input focus gating
- Created platform.ts utility for Mac/Windows modifier key detection
- Created recent-entities.ts utility for localStorage-based recent entity tracking (max 5, deduplication, full entry metadata)
- Created /api/command-palette-fields API route for field data in palette
- Updated dashboard layout.tsx to mount both hooks and pass CommandPaletteContext
- Updated TopBar.tsx to make search bar clickable to open command palette, with keyboard shortcut badge
- Updated StatusBar.tsx to show "All changes saved" flash on Cmd+S via custom event
- Updated entity-workspace.tsx to track recent entity access on navigation
- Updated domain-workspace.tsx to listen for Cmd+N custom event and open create form
- Updated field-editor.tsx to listen for slash command custom event and open add field form
- Added shortcut tooltip to New Entity button with platform-aware modifier key
- Uses custom DOM events for cross-component communication (layout -> child components)
- E2E tests skipped per instructions
- All 278 unit tests pass (including 16 new tests for keyboard shortcuts and recent entity tracking)

### Change Log
| File | Action | Description |
|------|--------|-------------|
| `src/lib/platform.ts` | Created | Platform detection utility (isMac, modKey, modSymbol) |
| `src/lib/recent-entities.ts` | Created | localStorage-based recent entity tracking |
| `src/hooks/useCommandPalette.ts` | Created | Cmd+K listener hook with React Context |
| `src/hooks/useKeyboardShortcuts.ts` | Created | Global keyboard shortcuts hook |
| `src/components/custom/CommandPalette/CommandPalette.tsx` | Rewritten | Full command palette with 4 sections, data fetching, frosted glass |
| `src/components/custom/CommandPalette/CommandPalette.types.ts` | Created | TypeScript interfaces for palette props |
| `src/components/custom/CommandPalette/index.ts` | Created | Barrel export |
| `src/app/api/command-palette-fields/route.ts` | Created | API route for field data |
| `src/app/(dashboard)/layout.tsx` | Modified | Mount hooks, context provider, palette actions |
| `src/components/layout/TopBar.tsx` | Modified | Clickable search bar to open palette |
| `src/components/layout/StatusBar.tsx` | Modified | "All changes saved" flash on Cmd+S |
| `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/entity-workspace.tsx` | Modified | Recent entity tracking on navigation |
| `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` | Modified | Cmd+N event listener for create form |
| `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` | Modified | Slash command event listener for add form |
| `tests/unit/hooks/useKeyboardShortcuts.test.ts` | Created | 8 unit tests for keyboard shortcut logic |
| `tests/unit/hooks/recent-entities.test.ts` | Created | 8 unit tests for recent entity tracking |

- 2026-04-05: Status changed from review to done
