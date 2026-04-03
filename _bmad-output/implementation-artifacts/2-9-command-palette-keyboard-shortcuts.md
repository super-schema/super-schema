# Story 2.9: Command Palette & Global Keyboard Shortcuts

Status: ready-for-dev

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
- [ ] Create `src/components/custom/CommandPalette/CommandPalette.tsx`
- [ ] Create `src/components/custom/CommandPalette/CommandPalette.types.ts`
- [ ] Create `src/components/custom/CommandPalette/index.ts`
- [ ] Use Shadcn `<Command>` component as base
- [ ] Centered overlay with frosted glass:
  - Overlay: `bg-overlay` (`rgba(0,0,0,0.6)`), `backdrop-blur-sm` (`blur(4px)`)
  - Dialog: `bg-[rgba(28,28,38,0.8)]` (`--glass-bg`), `backdrop-blur-[12px]`, `rounded-[12px]`
  - Width: 640px, max-height: 400px
  - Shadow: `0 4px 12px rgba(0,0,0,0.4)` (Surface 2 depth)

### Task 2: Command Palette Sections [AC: Recent, Entities, Fields, Actions]
- [ ] **Recent** section (`<CommandGroup heading="Recent">`):
  - Last 5 accessed entities, stored in localStorage key `super-schema:recent-entities`
  - Each item: entity name (monospace) + domain label
  - Track entity access on navigation to `/schemas/[id]`
- [ ] **Entities** section (`<CommandGroup heading="Entities">`):
  - All entities, fetched via oRPC query
  - Each item: entity name (monospace) + domain label + field count badge + status dot
- [ ] **Fields** section (`<CommandGroup heading="Fields">`):
  - All fields across all entities
  - Each item: "EntityName -> FieldName" format (monospace) + type label
- [ ] **Actions** section (`<CommandGroup heading="Actions">`):
  - New Entity — icon + label + shortcut hint "Cmd+N"
  - Save — icon + label + shortcut hint "Cmd+S"
  - Emit — icon + label + shortcut hint "Cmd+E"
  - Show Diff — icon + label
  - Export — icon + label

### Task 3: Search Filtering [AC: simultaneous filtering, highlighted matches]
- [ ] Shadcn `<CommandInput>` handles search
- [ ] Filter all sections simultaneously as user types
- [ ] Highlight matching text with `text-primary` (`#A477B2`) or `bg-primary/20`
- [ ] Empty results: "No results found" message

### Task 4: Navigation & Selection [AC: arrow keys, Enter, Escape, entity/field/action selection]
- [ ] Arrow Up/Down: navigate through all results across sections (built-in to Shadcn Command)
- [ ] Enter: select highlighted item
  - Entity: navigate to `/schemas/[entityId]`
  - Field: navigate to `/schemas/[entityId]` and auto-select the field (trigger field click to open decorator panel)
  - Action: trigger the action (open new entity popover, save, emit, etc.)
- [ ] Escape: close the palette

### Task 5: Cmd+K Trigger [AC: Cmd+K / Ctrl+K opens palette]
- [ ] Create `src/hooks/useCommandPalette.ts`
- [ ] Register global keyboard listener for `Cmd+K` (Mac) / `Ctrl+K` (Windows/Linux)
- [ ] Prevent default browser behavior (Cmd+K = browser search bar in some browsers)
- [ ] Toggle palette open/closed
- [ ] Mount the CommandPalette in the root layout or dashboard layout

### Task 6: Global Keyboard Shortcuts [AC: all shortcuts]
- [ ] Create `src/hooks/useKeyboardShortcuts.ts`
- [ ] Register listeners (only active when no `<input>`, `<textarea>`, or `[contenteditable]` is focused):
  - `Cmd+N` / `Ctrl+N`: open new entity creation popover — `preventDefault()` to block browser new window
  - `Cmd+S` / `Ctrl+S`: save current entity — `preventDefault()` to block browser save dialog
  - `Cmd+E` / `Ctrl+E`: trigger emission for current entity (if fields complete)
  - `/` (slash): when field grid is focused, add new field row with TypePickerGrid open
  - `Tab`: in field grid, move focus to next editable cell
  - `Enter`: when field row is focused (not editing), open decorator panel
  - `Escape`: close any open panel/popover/palette (close in order: palette > popover > detail panel)

### Task 7: Slash Command for Field Creation [AC: "/" inserts new field with type picker]
- [ ] When "/" is pressed and field grid is focused (not in edit mode):
  - Insert new empty field row at the bottom
  - Immediately open TypePickerGrid on the new row
  - User selects type first, then names the field
  - Notion-style pattern: "/" opens the type picker as a command

### Task 8: Shortcut Hints in Tooltips [AC: tooltips on action buttons]
- [ ] Update all action buttons with shortcut hints in tooltips:
  - Save button: `Tooltip` "Save (Cmd+S)" or "Save (Ctrl+S)" based on platform
  - Emit button: `Tooltip` "Emit (Cmd+E)"
  - New Entity button: `Tooltip` "New Entity (Cmd+N)"
  - Other action buttons: include keyboard shortcut if applicable
- [ ] Detect platform (Mac vs. Windows/Linux) to show correct modifier key (Cmd vs. Ctrl)
- [ ] Shortcut text style: `mono-small` (12px), `text-muted-foreground`

### Task 9: Recent Entity Tracking [AC: last 5 accessed entities]
- [ ] Track entity access in localStorage: `super-schema:recent-entities`
- [ ] Data structure: `string[]` of entity IDs, max 5, most recent first
- [ ] Update on navigation to `/schemas/[id]` — add to front, deduplicate, trim to 5
- [ ] Command palette reads from localStorage on open

### Task 10: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/command-palette.spec.ts`:
  - Test Cmd+K opens command palette overlay
  - Test typing filters results across all sections
  - Test selecting an entity navigates to `/schemas/[id]`
  - Test Ctrl+S saves entity (verify save mutation called or status bar shows "Saved")
  - Test Escape closes the palette
  - Test "/" key adds new field with type picker open
  - Test arrow keys navigate results, Enter selects

## Dev Notes

### Architecture & Patterns

**Command palette data:** Search index built from entity/field/action data on mount. Uses TanStack Query cached data — no separate API call needed.

**Keyboard shortcut registration:** Global event listeners in a custom hook. Conditionally active based on focus state (not active when inputs are focused). Use `useEffect` for registration/cleanup.

**Platform detection:** Use `navigator.platform` or `navigator.userAgentData.platform` to detect Mac vs. Windows/Linux for shortcut display.

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
    <CommandGroup heading="Actions">...</CommandGroup>
    <CommandEmpty>No results found</CommandEmpty>
  </CommandList>
</Command>
```

**Tooltip shortcut display:**
- Monospace font for shortcut text (`mono-small`, 12px)
- Color: `text-muted-foreground` (`#8a8694`)
- Format: "Action Name (Cmd+Key)" or "Action Name (Ctrl+Key)"
- Tooltip background: `bg-popover` (`#22222e`)

**Navigation patterns (from UX spec):**
- Command palette: Cmd+K. Sections: Recent, Entities, Fields, Actions. Arrow + Enter.
- Activity Bar: Click = route. Active = gradient left border.

**Keyboard-first principle:** "Every action keyboard-accessible. Tab moves through fields, Enter opens detail panel, Escape closes it."

### File Structure

```
src/
  components/
    custom/
      CommandPalette/
        CommandPalette.tsx               # NEW — command palette overlay
        CommandPalette.types.ts          # NEW
        index.ts                         # NEW
  hooks/
    useCommandPalette.ts                 # NEW — Cmd+K listener, palette state
    useKeyboardShortcuts.ts              # NEW — global keyboard shortcuts
  app/
    (dashboard)/
      layout.tsx                         # MODIFIED — mount CommandPalette + keyboard shortcuts

tests/
  e2e/
    command-palette.spec.ts              # NEW
```

### Testing Requirements

**E2E tests (Playwright):**
- `tests/e2e/command-palette.spec.ts` — Cmd+K open, search filtering, entity navigation, Ctrl+S save, Escape close, "/" field creation

**Unit tests (recommended):**
- `useKeyboardShortcuts` hook — shortcut registration, platform detection
- Recent entity tracking — localStorage read/write, max 5, deduplication

### Dependencies & Prerequisites

**Prerequisites:** Stories 2.2-2.8 complete (entity browsing, field editor, decorator panel, lifecycle — all features that shortcuts interact with)

**Enables:** General productivity improvement. No downstream story dependency.

### References
- [Source: epics.md - Epic 2, Story 2.9]
- [Source: architecture.md - Frontend Architecture (URL state via App Router)]
- [Source: ux-design-specification.md - Command Palette (VS Code + Notion pattern)]
- [Source: ux-design-specification.md - Navigation Patterns, Keyboard Shortcuts]
- [Source: ux-design-specification.md - Experience Principles ("Keyboard-first for power users")]
- [Source: ux-design-specification.md - Depth & Surface System (Glass, Overlay layers)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
