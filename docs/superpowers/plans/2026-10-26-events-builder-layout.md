# Events Builder Layout — More Room to Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the event Design tab's list sections (Messages first) a much bigger working area: a horizontal item tab strip with a pinned `+`, a vertical pane rail inside each item, a compact outline, and a handful of flow fixes.

**Architecture:** Layout follows the width of the pane, not the viewport (Tailwind v4 container queries), because the app shell's sidebar and live-code panel take 240–1100px before the builder starts. Level 1 (event sections) is the existing vertical outline, now collapsible to an icon rail. Level 2 (items) becomes `ItemTabs`. Level 3 (parts of one item) becomes `PaneRail`, which replaces the `FormCard` accordion. All edits still go through `draft.update(fn)`; no document or server change.

**Tech Stack:** Next.js 16 / React 19, Tailwind v4 (`@container`, `@xl:`), Vitest + Testing Library (jsdom), Playwright, `cmdk` + `components/ui/command.tsx`, `sonner`, lucide-react.

**Spec:** The design review in this session. Measured from code at a 1440px viewport with default panels (sidebar 240, code panel 400): the Messages form gets ~270px. Targets: ≥500px with the code panel open. The decisions are under *Design Decisions* below.

## Global Constraints

- Every existing `data-testid` listed here keeps its name on the element that now plays the same role: `message-row-<key>`, `channel-row-…`, `operation-row-…`, `server-row-…`, `message-add`, `message-empty-add`, `message-card-<pane>-toggle|-body|-count`, `operation-card-…` (same three), `message-remove`, `outline-<section>`, `outline-count-<section>`, `outline-problems-<section>`, `builder-save`, `builder-discard`, `builder-status`, `event-delete`, `event-publish`, `event-code-toggle`.
- Styling uses the repo tokens only: `space-*`, `text-body-small`, `text-caption`, `text-heading-3`, `bg-muted`, `border-border`, `text-muted-foreground`, `bg-destructive`. No new dependency.
- New files start with the `"use client";` line (when they hold hooks/JSX) and a `// src/…` path comment plus a short purpose comment, like the files around them.
- Browser APIs that jsdom lacks (`ResizeObserver`, `scrollIntoView`) are called through a guard: `typeof ResizeObserver !== "undefined"`, `el.scrollIntoView?.(…)`.
- Persisted UI preferences use `localStorage` inside try/catch and render correctly without it.
- Work on a branch `feat/events-builder-layout` cut from `main`. `main` has unrelated uncommitted files: stage with explicit paths, never `git add -A`. Commit messages are `type(scope): …` with **no `Co-Authored-By` trailer** (project rule).
- Run before each commit: the touched test files with `npx vitest run <paths>`, `npx tsc --noEmit`, `npx eslint <touched files>`. Before calling the plan done: `npx vitest run tests/unit/components/events` in full, `npm run dev` and look at the page, then the events e2e specs under Node 20.

## Design Decisions

| Area | Decision |
|---|---|
| Responsive basis | `@container` on the builder's content column and on each item form; classes use `@xl:` / `@3xl:`, never `md:`, inside the builder. |
| Outline | Icon-only below `@3xl` of the builder root, full labels above. A toggle button overrides: `data-outline="open" | "compact"` on the root (absent = auto). Choice saved in `localStorage` key `events-builder-outline`. |
| Item strip | One shared `ItemTabs`: scrollable tabs, edge fade + ‹ › buttons when overflowing, `⌄` search list when more than 6 items, `+` pinned right. Subtitle (payload entity) moves to the tab's `title`. |
| Pane rail | One pane shown at a time (inactive panes unmounted). Rail is vertical from `@xl` (576px) of the item form, a horizontal pill strip below. Default pane `payload`. A pane that newly holds a problem selects itself once. |
| Sent on channels | Stays a pane (`channels`) and gains a one-line chip summary under the tab strip; a chip selects the pane. |
| Payload pane | Headers and Message key are `+ Add …` links until set (or while they hold a problem). Format select sits inline with the payload picker. Read-only field preview from the pin's JSON Schema (`usePinJsonSchemaState`, seconds-long server render, so lazy + "Loading fields…"). |
| Remove | No `window.confirm` for messages: remove, then a toast with **Undo** that restores the exact pre-removal document and is dismissed by the next edit. |
| Shortcuts | `Mod+S` saves, `Mod+J` opens the jump palette. `Mod+K` is the app's global palette (`useCommandPalette`) and stays untouched. Both listen only while the Design tab is visible. |
| Deviation from the review | The review proposed moving Save/Discard into the page header. `EventBuilder` is tested and used without the page, so the bar stays in `EventBuilder`; `Mod+S` and the problem count in the bar cover the intent. |

## File Structure

- Modify `src/features/events/builder/EventBuilder.tsx` — container, compact outline, shortcuts, jump palette hook-up, `active` prop.
- Create `src/features/events/builder/sections/tab-nav.ts` — pure `nextTabIndex`, `scrollEdges`.
- Create `src/features/events/builder/sections/ItemTabs.tsx` — the strip.
- Create `src/features/events/builder/sections/PaneRail.tsx` — `usePaneState` + `PaneRail`.
- Create `src/features/events/builder/sections/OptionalPin.tsx` — `+ Add …` wrapper around `PinField` content.
- Create `src/features/events/builder/sections/schema-fields.ts` + `PayloadPreview.tsx`.
- Create `src/features/events/builder/sections/message-actions.ts` — `duplicateMessage`.
- Create `src/features/events/builder/jump.ts` + `JumpPalette.tsx`.
- Modify `MessagesSection.tsx`, `ChannelsSection.tsx`, `OperationsSection.tsx`, `ServersSection.tsx`, `AdvancedSection.tsx`, `PropertiesSection.tsx`, `EventPage.tsx`.
- Delete `FormCard.tsx` and `tests/unit/components/events/form-card.test.tsx` in Task 6, after both sections use `PaneRail`.

## Review Focus

1. **40+ messages, very long keys.** The strip scrolls, the active tab is scrolled into view, the `⌄` list finds any message by typing part of its key, and nothing overflows the page horizontally. Test: `ItemTabs` with 45 items.
2. **A problem on a pane that is not showing.** The pane selects itself once, the strip tab and the outline node show the problem marker, and the user can still switch away. Test: `usePaneState`, and a Messages test with an invalid `/messages/0/headers`.
3. **Narrowest realistic pane (code panel at its 800px max).** Outline compact, rail becomes pills, no horizontal page scroll, nothing unreachable. Test: class assertions on the container variants plus a manual check at 1280px with the panel at 800px.
4. **A key renamed on blur while its tab is active.** The selected tab follows the new key and focus is not lost. Test: type a name, blur, expect `message-row-<new key>` has `aria-current`.
5. **Undo after remove when something changed since.** Undo must never overwrite a later edit: the toast is dismissed by the next document change, and Undo after Remove-twice restores only the last removal. Test in Task 9.
6. **Two items with the same or an empty key** (a broken document). Tabs are keyed by index, an empty key shows `(no key)`, and arrow keys still reach every tab. Test in Task 3.

---

## Phase A — Space (ship first)

### Task 1: Container-query layout and compact outline

**Files:**
- Modify: `src/features/events/builder/EventBuilder.tsx:74-107`
- Modify the list-section grids: `MessagesSection.tsx:162`, `ChannelsSection.tsx:180`, `OperationsSection.tsx:187`, `ServersSection.tsx:143`, `AdvancedSection.tsx:93`, `PropertiesSection.tsx:112` (`md:grid-cols-[14rem_1fr]` → container variants; the strip in Task 4 replaces these for four of them, so here only make them container-based).
- Test: `tests/unit/components/events/builder-shell.test.tsx`

**Interfaces:**
- Produces: `EventBuilder` accepts `active?: boolean` (default `true`; used by Tasks 8, 10) and renders `data-outline` on its root. A button `data-testid="outline-toggle"` (`aria-pressed` = compact) switches between `open` and `compact` and writes `localStorage["events-builder-outline"]`.
- Produces: outline nodes keep `data-testid="outline-<section>"`; each gets `title={label}` and a section icon (`Info`, `Server`, `Network`, `MessageSquare`, `Workflow`, `Tags`, `Settings2`); the label span gets the class that hides it in compact mode while staying in the DOM.

- [ ] **Step 1: Write failing tests** in `builder-shell.test.tsx`: `outline-toggle` flips `data-outline` between `compact` and `open` and persists; the value is restored on re-render; with `localStorage` throwing the builder still renders; each `outline-<section>` has a `title` equal to its label; the content column carries the `@container` class.
- [ ] **Step 2: Run** `npx vitest run tests/unit/components/events/builder-shell.test.tsx` — expect the new tests to fail.
- [ ] **Step 3: Implement.** Root: `@container` plus `data-outline`; grid `@3xl:grid-cols-[13rem_minmax(0,1fr)]` when not compact, `grid-cols-[3rem_minmax(0,1fr)]` when compact or auto-below-`@3xl` (use `data-[outline=compact]:` / `data-[outline=open]:` variants so the explicit choice wins over the container query). Keep the horizontal scrolling outline for the narrowest case that exists today. The six section grids switch to `@container` parent + `@3xl:` columns.
- [ ] **Step 4: Run** the same test file and `npx tsc --noEmit` — expect pass.
- [ ] **Step 5: Commit** `feat(events): the builder lays out by the width of its pane and the outline can collapse to icons`

### Task 2: Optional pins as `+ Add` links; format inline

**Files:**
- Create: `src/features/events/builder/sections/OptionalPin.tsx`
- Modify: `MessagesSection.tsx:305-327` (Payload card body), `RepresentationSelect.tsx`
- Test: `tests/unit/components/events/builder-messages.test.tsx`

**Interfaces:**
- Produces: `OptionalPin({ id, label, addLabel, value, error, children }: { id: string; label: string; addLabel: string; value: EntityPin | null; error?: string; children: ReactNode })` — renders `children` (the `PinField`) when `value !== null`, when `error` is set, or after the user pressed its `+` link; otherwise renders a ghost button `data-testid="${id}-add"` with text `+ ${addLabel}`.
- Existing `PinField` and the `headers-*`, `key-pin-*` test ids are unchanged inside.

- [ ] **Step 1: Write failing tests:** a message with no headers/key shows `headers-add` and `key-pin-add` and no `headers-picker`/`key-pin-picker`; clicking `headers-add` shows the picker; a message with `headers` set shows the picker at once; an error at `/keyPin` shows the picker without clicking; `message-representation` and the payload picker are in the same flex row container (`data-testid="payload-row"`).
- [ ] **Step 2: Run** the file — new tests fail.
- [ ] **Step 3: Implement** `OptionalPin`, wrap Headers and Message key with it, put `RepresentationSelect` beside the payload `PinField` in a wrapping flex row `payload-row`; its label text stays `Payload representation`.
- [ ] **Step 4: Update the existing tests** in `builder-messages.test.tsx`, `message-example-validation.test.tsx`, `properties-cards.test.tsx` that reach `headers`/`keyPin` pickers: click `headers-add` / `key-pin-add` first (one shared helper `showOptionalPins()` at the top of each file).
- [ ] **Step 5: Run** `npx vitest run tests/unit/components/events` — all pass.
- [ ] **Step 6: Commit** `feat(events): headers and message key stay a link until set; the format select sits with the payload`

## Phase B — Item strip

### Task 3: `ItemTabs` and its pure helpers

**Files:**
- Create: `src/features/events/builder/sections/tab-nav.ts`, `ItemTabs.tsx`
- Test: `tests/unit/features/events/tab-nav.test.ts`, `tests/unit/components/events/item-tabs.test.tsx`

**Interfaces:**
- Produces in `tab-nav.ts`:
  - `nextTabIndex(current: number, count: number, key: string): number | null` — `ArrowRight`/`ArrowLeft` wrap, `Home`/`End`, any other key `null`, `count === 0` `null`.
  - `scrollEdges(m: { scrollLeft: number; clientWidth: number; scrollWidth: number }): { start: boolean; end: boolean }` — `start` is true when content is hidden on the left, `end` on the right, 1px tolerance.
- Produces in `ItemTabs.tsx`:
  `ItemTabs({ label, prefix, items, activeIndex, onSelect, onAdd, addLabel, addTestId, addDisabled, addTitle }: { label: string; prefix: string; items: Array<{ key: string; label?: string; subtitle: string; broken: boolean }>; activeIndex: number; onSelect: (key: string) => void; onAdd?: () => void; addLabel?: string; addTestId?: string; addDisabled?: boolean; addTitle?: string })`.
  Markup: `role="tablist"` (`aria-label={label}`), each tab `role="tab"` + `aria-selected` + `aria-current` (when active) + `data-testid="${prefix}-row-${key}"` + `title` = `${label} — ${subtitle}` + roving `tabIndex`; `broken` adds a red dot and an sr-only "has problems". The `+` is `data-testid={addTestId}`, `aria-label={addLabel}`, outside the scrolling element. `⌄` (`data-testid="${prefix}-tabs-list"`) opens a `Popover` + `Command` search list and appears when `items.length > 6`.

- [ ] **Step 1: Write failing tests.** `tab-nav`: `nextTabIndex(0,3,"ArrowLeft") === 2`, `(2,3,"ArrowRight") === 0`, `Home` → 0, `End` → count-1, `("x")` → null, count 0 → null; `scrollEdges({scrollLeft:0,clientWidth:100,scrollWidth:300})` → `{start:false,end:true}`, scrolled to the end → `{start:true,end:false}`, fits → both false, 0.5px rounding counts as fits. `ItemTabs`: clicking a tab calls `onSelect(key)`; arrow keys move focus and select; the empty-key item renders `(no key)` and is reachable; two items with equal keys both render; `+` calls `onAdd`, is disabled with `addDisabled`; with 45 items `⌄` exists and filtering the list by text narrows it, choosing one calls `onSelect`; with 3 items `⌄` is absent.
- [ ] **Step 2: Run** both files — fail (modules missing).
- [ ] **Step 3: Implement** `tab-nav.ts`. Then `ItemTabs.tsx`: scroll element with hidden scrollbar; edge arrows shown from `scrollEdges` updated on scroll and, when `ResizeObserver` exists, on resize; active tab `scrollIntoView?.({ inline: "nearest", block: "nearest" })` on `activeIndex` change.
- [ ] **Step 4: Run** both files and `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `feat(events): a scrollable item tab strip with a pinned add button and a search list`

### Task 4: Messages, Channels, Operations, Servers use `ItemTabs`

**Files:**
- Modify: `MessagesSection.tsx:143-175`, `ChannelsSection.tsx:~170-195`, `OperationsSection.tsx:~175-205`, `ServersSection.tsx:~132-155`; `graph-parts.tsx` (`ItemList` stays only for sections that still use it — `AdvancedSection`, `PropertiesSection` if they import it; otherwise delete it).
- Test: `builder-messages.test.tsx`, `builder-channels.test.tsx`, `builder-operations.test.tsx`, `builder-advanced.test.tsx` (the `server-row-*` ones).

**Interfaces:**
- Consumes: `ItemTabs` from Task 3. Each section passes `prefix` (`message`/`channel`/`operation`/`server`), the same `items` it gave `ItemList` today, `onAdd` = its existing add function, `addTestId` = `message-add` / the section's existing add id, `addDisabled`/`addTitle` for Operations with no channel (its current "Add a channel first" rule).
- The section `<header>` becomes one row: `h2` (`text-heading-3`) + `InfoTip` carrying the old description (id `<section>-help`). The header "Add …" button is removed; the empty state keeps its own add button (`message-empty-add` etc.).

- [ ] **Step 1: Write failing tests** per section: the tab strip (`role="tablist"`) replaces the list, `message-add` is inside it and still adds and selects the new message, the active tab has `aria-current`, the description text is in the `InfoTip` tooltip, no `Add message` button in the header when messages exist. Operations: with no channels `operation-add` is disabled and the old hint is its `title`.
- [ ] **Step 2: Run** the four files — new tests fail.
- [ ] **Step 3: Implement** in the order Messages → Channels → Operations → Servers; the form beside the strip becomes full width (drop the `14rem` column; the strip is above the form). Keep `max-w-2xl` only on single-column forms that benefit.
- [ ] **Step 4: Run** `npx vitest run tests/unit/components/events` plus `npx tsc --noEmit` and fix the tests that read the removed `ItemList` subtitle text (it is now the tab `title`).
- [ ] **Step 5: Commit** `feat(events): messages, channels, operations and servers are picked from a tab strip`

## Phase C — Pane rail

### Task 5: `PaneRail` in Messages, with the sent-on summary

**Files:**
- Create: `src/features/events/builder/sections/PaneRail.tsx`
- Modify: `MessagesSection.tsx` (card definitions `:73-75`, `:289-364`, form wrapper `:303`)
- Test: `tests/unit/components/events/pane-rail.test.tsx`; update `builder-messages.test.tsx`, `message-example-validation.test.tsx`, `properties-cards.test.tsx`

**Interfaces:**
- Produces: `usePaneState(defaultPane: string, errored: ReadonlySet<string>): { active: string; select: (id: string) => void }` — `active` is the user's choice, else the default; when a pane id appears in `errored` that was not there on the previous render, it becomes active once.
- Produces: `PaneRail({ idPrefix, panes, active, onSelect, children }: { idPrefix: string; panes: Array<{ id: string; title: string; count?: number; broken?: boolean }>; active: string; onSelect: (id: string) => void; children: ReactNode })`. Rail `role="tablist"` `aria-orientation="vertical"`; item `role="tab"` `aria-selected` `data-testid="${idPrefix}-${id}-toggle"`, count badge `data-testid="${idPrefix}-${id}-count"` when `count > 0` (sr-only "N set"), red dot when `broken`; body `role="tabpanel"` `data-testid="${idPrefix}-${active}-body"`. Layout: wrapper `@container`, inner `flex flex-col @xl:grid @xl:grid-cols-[9rem_minmax(0,1fr)]`; below `@xl` the rail is a horizontally scrolling pill row. Arrow keys follow `nextTabIndex`.
- Messages: `idPrefix="message-card"`; panes `payload, properties, details, channels, examples, bindings, docs, correlation, more` with today's titles and counts; default `payload`. Under the strip, a summary line `data-testid="message-sent-on"`: chips for each channel the message is on (each a button that selects `channels`), or the text "Not sent on any channel" plus a `Choose channels` button.

- [ ] **Step 1: Write failing tests.** `usePaneState`: default is active; `select` changes it; an errored pane that appears becomes active once, and choosing another pane afterwards sticks while the error stays; two panes erroring at once → the first in `panes` order. `PaneRail`: only the active body is rendered; the count badge appears only for `count > 0`; arrow keys move selection; roles/aria are as above. Messages: `message-sent-on` lists the right channels and a chip selects the channels pane; examples validation (`message-example-validation.test.tsx`) still works after choosing the `examples` pane.
- [ ] **Step 2: Run** the new file — fails.
- [ ] **Step 3: Implement** `PaneRail.tsx`; in `MessagesSection` replace the `card(...)` calls with panes and render the active pane body only. `examplesShown` becomes `pane.active === "examples" && examples.length > 0`.
- [ ] **Step 4: Update the existing tests.** In `builder-messages.test.tsx` replace the `isOpen`/`openCard`/`openAllCards` helpers (lines ~40–50) with `selectPane(card)`; tests that read fields from two panes in one go select each pane in turn; the `h3` heading-count test (`:549`) becomes a rail-items test; the two "examples body is closed" assertions (`:559`, `:564`) assert another pane is active. Same for the other two files.
- [ ] **Step 5: Run** `npx vitest run tests/unit/components/events` — all pass.
- [ ] **Step 6: Commit** `feat(events): a message's parts are a vertical rail and one part shows at a time`

### Task 6: Operations on `PaneRail`; retire `FormCard`

**Files:**
- Modify: `OperationsSection.tsx:~100-142`, `:~330-445`
- Delete: `FormCard.tsx`, `tests/unit/components/events/form-card.test.tsx`
- Test: `builder-operations.test.tsx`

**Interfaces:**
- Consumes: `PaneRail`, `usePaneState` (Task 5). `idPrefix="operation-card"`; panes `basics, reply (only when the action has one), properties, details, bindings, docs, security`; default pane `basics`; `cardDefaults(active)` is removed (its "Reply is open when the operation has one" rule becomes: Reply is the default pane only when a new operation has none — drop it, the rail shows all panes).

- [ ] **Step 1: Update `builder-operations.test.tsx`** to the pane semantics (same `selectPane` helper as Task 5) and add one failing test: an operation with a problem at `/operations/0/reply` selects the `reply` pane.
- [ ] **Step 2: Run** it — fails.
- [ ] **Step 3: Implement**, then delete `FormCard.tsx` and its test after `rg "FormCard|useCardState" src tests` shows no remaining use; move any still-relevant assertion from `form-card.test.tsx` into `pane-rail.test.tsx`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/components/events` and `npx tsc --noEmit` — pass.
- [ ] **Step 5: Commit** `refactor(events): operations use the pane rail and the accordion card is gone`

### Task 7: Payload field preview

**Files:**
- Create: `sections/schema-fields.ts`, `sections/PayloadPreview.tsx`
- Modify: `MessagesSection.tsx` (Payload pane)
- Test: `tests/unit/features/events/schema-fields.test.ts`, `tests/unit/components/events/payload-preview.test.tsx`

**Interfaces:**
- Produces: `summarizeSchemaFields(schema: Record<string, unknown> | null, limit = 8): { rows: Array<{ name: string; type: string; required: boolean }>; more: number }` — reads top-level `properties` (also through `allOf` members and one level of `$ref` into `$defs`/`definitions`), `type` arrays joined with `" | "`, `format` appended as `string (date-time)`, `required` from the schema; `null`, no `properties`, or a cyclic `$ref` → `{ rows: [], more: 0 }`; `more` = number of properties beyond `limit`.
- Produces: `PayloadPreview({ productId, pin, entity, enabled }: { productId: string; pin: EntityPin | null; entity: EntityOption | undefined; enabled: boolean })` — uses `usePinJsonSchemaState(productId, pin, enabled)`; renders `data-testid="payload-preview"`: "Loading fields…" while loading, the rows (name · type · required marker) with "+N more", or "No field preview" when empty; an "Open entity" link to `entity.href` when present.

- [ ] **Step 1: Write failing tests** for the cases above (plain properties, `allOf`, `$ref`, cyclic `$ref`, null, type array, over-limit `more`) and for the component states (loading, rows, empty, link present/absent, nothing asked while `enabled` is false — assert the action mock is not called).
- [ ] **Step 2: Run** both files — fail.
- [ ] **Step 3: Implement** both; `enabled` is true only while the Payload pane is active and the payload has an entity. Mock `pinJsonSchemaAction` through `externalRefActions` the way `message-example-validation.test.tsx` does.
- [ ] **Step 4: Run** both files and the Messages test file — pass.
- [ ] **Step 5: Commit** `feat(events): the payload pane previews the fields of the chosen entity`

## Phase D — Chrome and flow

### Task 8: Compact chrome, autofocus on add, `Mod+S`

**Files:**
- Modify: `EventPage.tsx:232-310` (spacing `space-y-space-6` → `space-y-space-4`; pass `active={tab === "design"}` to `EventBuilder`), `EventBuilder.tsx` (shortcut), `MessagesSection.tsx` / `ChannelsSection.tsx` / `OperationsSection.tsx` / `ServersSection.tsx` (focus on add)
- Test: `builder-shell.test.tsx`, `builder-messages.test.tsx`, `event-page.test.tsx`

**Interfaces:**
- Consumes: `EventBuilder`'s `active` prop (Task 1).
- Produces: in `EventBuilder`, `Mod+S` calls `draft.save()` and `preventDefault()` only when `active` and the draft is dirty and not saving; the bar shows `data-testid="builder-problems"` ("3 problems") when `draft.problems.length > 0`, and clicking it selects the first problem's section and item (`locateProblem`).
- Adding a message focuses the Payload entity select; adding a channel/operation/server focuses its first field (the section's existing first input id).

- [ ] **Step 1: Write failing tests:** `Mod+S` saves a dirty draft, does nothing when clean or when `active={false}`, and prevents the browser default only when it saves; `builder-problems` is absent with no problems and shows the count with some, and its click moves `probe.section` / `probe.item`; after `message-add`, `document.activeElement` is the `Payload entity` select (await `settle()`).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** First check `rg "useKeyboardShortcuts" src/app/\(dashboard\)/schemas` to confirm no handler on the event route also binds `Mod+S`.
- [ ] **Step 4: Run** the three files — pass.
- [ ] **Step 5: Commit** `feat(events): Mod+S saves, a click on the problem count jumps to it, and a new item starts focused`

### Task 9: Duplicate and undoable remove (messages)

**Files:**
- Create: `sections/message-actions.ts`
- Modify: `MessagesSection.tsx:265-282` and the form footer `:372-376`
- Test: `tests/unit/features/events/message-actions.test.ts`, `builder-messages.test.tsx`

**Interfaces:**
- Produces: `duplicateMessage(doc: EventDocument, key: string): { doc: EventDocument; key: string } | null` — appends a copy of the message with `newKey(doc, "message")`, same payload/headers/keyPin/`traitKeys`/fields, **not** added to any channel; `null` when `key` is not a local message.
- Produces in the form footer: `message-duplicate` (ghost icon button, selects the copy) next to `message-remove`.
- Remove: no `window.confirm`. Previous document `prev` and the document after the removal `after` are kept; `toast("Message removed", { action: { label: "Undo" }, duration: 8000 })`; Undo calls `update(() => prev)` only if the draft's document is still `after`; any other document change dismisses the toast (`toast.dismiss(id)` in an effect on `draft.doc`).

- [ ] **Step 1: Write failing tests.** `duplicateMessage`: copy has a new key and equal content, is on no channel, original untouched, unknown key → null. Component: Duplicate adds and selects a second message; Remove no longer calls `window.confirm` (spy not called) and strips the key from channels/operations as today; Undo restores messages, channel `messageKeys` and operation `messageKeys` exactly (deep-equal to the original document); an edit after Remove dismisses the toast and a stale Undo never runs; removing twice then Undo restores only the second. Mock `sonner`'s `toast` as a spy with `dismiss`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Update** the old confirm tests in `builder-messages.test.tsx` (`:876-890`) to the new behaviour.
- [ ] **Step 5: Run** `npx vitest run tests/unit/components/events` — pass.
- [ ] **Step 6: Commit** `feat(events): a message can be duplicated, and removing one can be undone`

### Task 10: Jump palette (`Mod+J`)

**Files:**
- Create: `src/features/events/builder/jump.ts`, `JumpPalette.tsx`
- Modify: `EventBuilder.tsx` (button + shortcut + render)
- Test: `tests/unit/features/events/jump.test.ts`, `tests/unit/components/events/jump-palette.test.tsx`

**Interfaces:**
- Produces: `jumpEntries(outline: OutlineNode[]): Array<{ section: BuilderSection; item: string | null; label: string; group: string; problems: number }>` — one entry per section (`item: null`, `group: "Sections"`) then one per item (`group` = the section label), in outline order.
- Produces: `JumpPalette({ open, onOpenChange, entries, onJump }: { open: boolean; onOpenChange: (open: boolean) => void; entries: JumpEntry[]; onJump: (e: JumpEntry) => void })` over `CommandDialog`; an entry with `problems > 0` shows a red dot.
- `EventBuilder`: a `Jump to…` button in the outline (`data-testid="jump-open"`, hidden label in compact mode, shows `⌘J`), `Mod+J` (only while `active`) toggles it; `onJump` runs `onSectionChange(section); onItemChange(item)` and closes. `Mod+K` is not handled here.

- [ ] **Step 1: Write failing tests.** `jumpEntries` with the sample document (sections first, then channels/messages/operations items; external refs included as the outline lists them; empty sections contribute only the section entry). Palette: opens from the button and `Mod+J`, typing filters, choosing moves `probe.section`/`probe.item`, Escape closes, `Mod+J` does nothing when `active={false}`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the two files — pass.
- [ ] **Step 5: Commit** `feat(events): Mod+J jumps to any section, message, channel or operation`

### Task 11: Event actions menu

**Files:**
- Modify: `EventPage.tsx:271-290`
- Test: `tests/unit/components/events/event-page.test.tsx`, `tests/e2e/events-builder.spec.ts` (if it clicks `event-delete`)

**Interfaces:**
- Produces: the header shows Publish and Code, then a `⋯` trigger `data-testid="event-actions"` (`aria-label="More actions"`) over `DropdownMenu`; its only item is `event-delete` (destructive style, same `remove()` flow and `window.confirm`).

- [ ] **Step 1: Write failing tests:** `event-delete` is not in the DOM until `event-actions` opens; choosing it runs the existing delete flow (confirm → action → `router.push(listHref)`); the error text `event-delete-error` still shows on failure.
- [ ] **Step 2: Run** `event-page.test.tsx` — fails.
- [ ] **Step 3: Implement**; if opening the menu in jsdom needs pointer events, use `fireEvent.pointerDown` + `click` in a helper.
- [ ] **Step 4: Update** other tests and e2e steps that clicked `event-delete` directly (open the menu first).
- [ ] **Step 5: Run** `npx vitest run tests/unit/components/events` — pass.
- [ ] **Step 6: Commit** `feat(events): Delete moves into a more-actions menu away from Publish`

### Task 12: Verify in the real app

- [ ] **Step 1:** `npx vitest run tests/unit/components/events tests/unit/features/events`, `npx tsc --noEmit`, `npm run lint` — all clean.
- [ ] **Step 2:** `npm run dev`, open an event with ≥ 8 messages: check the pane at 1280, 1440 and 1920px with the code panel at default and at 800px; measure the form width (target ≥ 500px at 1440 with the panel open), strip overflow, rail→pills, outline compact/auto, `Mod+S`, `Mod+J`, Undo, duplicate.
- [ ] **Step 3:** Under Node 20, `npx playwright test tests/e2e/events-builder.spec.ts tests/e2e/events-example-validation.spec.ts tests/e2e/events-external-refs.spec.ts tests/e2e/events-leave-guard.spec.ts tests/e2e/a11y.spec.ts` (fix any step that clicked an accordion toggle or `event-delete`).
- [ ] **Step 4:** Report measured widths and anything not verified.
