# Events self-contained — Phase B1 (vertical slice + cutover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can create an Event from the product's New menu, see it in a flat Events list, open it, build an AsyncAPI document visually (metadata, servers, channels, messages with a payload entity, operations), save it, and preview the AsyncAPI output — replacing the old Event Spec / Message / Channel menu entries and pages.

**Architecture:** New server actions and loaders sit on the Phase A services (`event.service.ts`, `event-emit.service.ts`). A client builder (`src/features/events/builder/`) edits an `EventDocument` held in a hook with client-side validation by the same `parseEventDocument`; problems map by JSON pointer onto outline nodes and fields. The Event page (`events/[eventId]`) hosts the builder and a Preview tab (existing sandboxed AsyncAPI iframe). The cutover swaps the menu, Events tab, sidebar leaf and old routes in one commit with their paired tests.

**Tech Stack:** Next.js (App Router, server actions), React, Tailwind (design tokens `space-*`, `text-body-small`, …), base-ui/shadcn components in `src/components/ui`, Vitest + Testing Library, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-15-events-self-contained-design.md` (§3 IA, §4 document, §7 builder). Backend interfaces: `docs/superpowers/plans/2026-10-15-events-self-contained-phase-a-backend.md` and the merged code under `src/lib/events/document/` and `src/services/events/event*.ts`.

## Global Constraints

- **Slice scope (explicit):** Design tab sections Metadata, Servers, Channels, Messages, Operations; Preview tab. **Not in this slice:** Traits and Advanced sections, Publish/Versions/Used-by/Source tabs, external references, the cmdk entity combobox, chip/tokenized/segmented/markdown/CodeMirror components, binding forms, legacy-draft data migration. Slice 2 adds them. The slice uses the existing `EntityPinPicker` (native selects) for payload pins and native `<select>`s elsewhere; keep each control behind a small local component so slice 2 can swap it.
- All mutations go through server actions using `runMutation(ctx => withOwnedTarget(owner, () => service(...)), "label")` (`src/lib/action-context.ts`), exactly like `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions.ts` (it revalidates `/schemas`; `staleTimes.dynamic = 30` makes this mandatory). Reads use `getActionContext` + `toActionResult`. Clients show `actionErrorText(...)` / `GENERIC_ACTION_ERROR`, never raw `DB_ERROR` text.
- URLs only via `assetHref()` (`src/lib/navigation/asset-href.ts`); `tests/unit/lib/no-handbuilt-schema-links.test.ts` fails on hand-built `/schemas/...` links.
- Tokens/conventions: spacing `space-1/2/3/4/6/8/10` only (no `space-5`), type `text-display|heading-1..3|body|body-small|caption`, pages use `animate-auth-fade-up`, `HideEmptyRightPanel`, `EventBreadcrumb`; every input has an `aria-label`/label and a `data-testid`; errors are linked with `aria-describedby`; toasts via `sonner` (`toast.success`).
- After create: `invalidateDomainsTree()` then `router.push(assetHref(...))`. After save: `toast.success("Draft saved")` and `router.refresh()`.
- Tenant safety: loaders resolve the product route with `resolveProductRoute` and read events with `tenantId` in the `where`; an event of another product/tenant is `null` (page → `notFound()`), exactly like `loadEventSpecPage`.
- Old code stays in the tree until Phase C; Task B5 only unhooks it from the menu, Events tab, sidebar and old routes (routes become redirects) and rewrites the tests that pinned the old UI. `src/features/events/{messages,channels,event-specs/EventSpecEditor.tsx}` and the old services are NOT deleted in this phase.
- Baseline: `npx vitest run event channel trait message --reporter=dot` was 106 files / 1159 tests green; the only known failures repo-wide are the 4 `db-emitter-parity` tests (broken `@typespec/db`). `npx tsc --noEmit` has exactly 2 pre-existing errors in `tests/unit/lib/events/catalog-mapping.test.ts`; add none.
- Git in isolated worktrees: call `/usr/bin/git ...` (absolute path) because the RTK hook breaks plain `git` there; one plain command per call. Gortex MCP is down; Read/Grep/Glob/Bash fallback is user-approved (ledger R68). Commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Unsaved work:** navigating away (breadcrumb, tab switch, sidebar) with a dirty draft must warn; a failed save must keep every edit and show the pointer problems next to their fields; Save on an incomplete draft (no operations, unpinned payload) succeeds.
2. **Key hygiene in the UI:** editing a title must not silently rewrite an existing key; renaming a key goes through `renameKey`; deleting a channel/message/server removes (or warns about) every reference to it so the draft never becomes unparsable.
3. **Operations vs channel:** the message checklist of an operation lists only that channel's messages; changing an operation's channel drops messages not on the new channel (and says so); a channel with no messages blocks nothing.
4. **Empty and legacy data:** a product with zero events shows an empty state with the primary action; a stored legacy (v1) event spec does not crash the list or the page (it is simply not listed; opening its old URL redirects to the list with a notice).
5. **Cross-tenant/product access:** `/events/<id of another product's event>` and unknown ids render not-found, never data; the actions refuse a non-owner (FORBIDDEN) without leaking names.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/navigation/asset-href.ts` | add `event` asset kind (+ `item`, `section`, `tab` params) and `normalizeEventTab` / `normalizeBuilderSection` |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts` | server actions over the event services |
| `src/features/events/event-page/load-event-page.ts`, `load-events-list.ts` | tenant-scoped loaders (page, list) |
| `src/features/events/builder/outline.ts`, `problems.ts`, `use-event-draft.ts`, `EventBuilder.tsx`, `sections/*.tsx`, `controls.tsx` | builder |
| `src/features/events/event-page/EventPage.tsx`, `EventPreview.tsx`, `use-event-preview.ts` | page shell, tabs, preview |
| `src/features/events/workspace/EventsList.tsx`, `NewEventDialog.tsx` | flat list + create dialog (replace `EventsTab.tsx` usage) |
| `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/events/[eventId]/{page,loading}.tsx` | route |
| cutover files | `CreateDropdown.tsx`, `domain-workspace.tsx`, `LeftSidebar.tsx`, old route stubs |

---

### Task B1: Foundations — `assetHref` event kind, server actions, loaders

**Files:**
- Modify: `src/lib/navigation/asset-href.ts`
- Create: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts`, `src/features/events/event-page/load-event-page.ts`, `src/features/events/event-page/load-events-list.ts`
- Test: `tests/unit/lib/navigation/asset-href-event.test.ts`, `tests/unit/app/event-actions.test.ts`, `tests/integration/services/events/load-event-page.test.ts`, `tests/integration/services/events/load-events-list.test.ts`

**Interfaces:**
- Consumes: A6 `createEvent`, `updateEventDocument`, `renameEvent`, `deleteEvent`, `getEvent`, `EventDetail`, `EVENT_SELECT`, `toEventDetail`; `resolveProductRoute`, `productCrumbs`, `loadEntityOptions` (`src/features/events/load-options.ts`), `EntityOption`; `runMutation`, `withOwnedTarget`, `getActionContext`, `toActionResult`.
- Produces:
```ts
// asset-href.ts (additions; keep every existing kind working)
export const EVENT_TABS = ["design", "preview"] as const;            // slice 2 appends "source" | "versions" | "used-by"
export type EventTab = (typeof EVENT_TABS)[number];
export const BUILDER_SECTIONS = ["metadata", "servers", "channels", "messages", "operations"] as const; // slice 2 appends "traits" | "advanced"
export type BuilderSection = (typeof BUILDER_SECTIONS)[number];
export function normalizeEventTab(value: string | null | undefined): EventTab;          // "design" fallback; aliases editor→design, document→preview, diagnostics→preview
export function normalizeBuilderSection(value: string | null | undefined): BuilderSection; // "metadata" fallback
// AssetRef gains: { kind: "event"; id: string; domainSlug: string; productSlug: string }
// assetHref(ref, { tab?: EventTab; section?: BuilderSection; item?: string; version?: string }) → `${product}/events/${id}?tab=…&section=…&item=…` (omit params that are default/undefined)
// and the existing { kind: "events", … } list ref keeps pointing at the product page's Events tab WITHOUT a `section` param.

// event-actions.ts ("use server")
export async function createEventAction(productId: string, input: { name: string; description?: string }): Promise<ActionResult<EventDetail>>;
export async function updateEventDocumentAction(eventId: string, productId: string, document: unknown): Promise<ActionResult<EventDetail>>;
export async function renameEventAction(eventId: string, productId: string, name: string): Promise<ActionResult<EventDetail>>;
export async function deleteEventAction(eventId: string, productId: string): Promise<ActionResult<{ id: string }>>;

// load-event-page.ts
export interface EventPageData {
  event: EventDetail; productId: string; domainSlug: string; productSlug: string;
  entityOptions: EntityOption[]; crumbs: Crumb[]; listHref: string;
  initialTab: EventTab; initialSection: BuilderSection; initialItem: string | null;
}
export function loadEventPage(params: { domainSlug: string; productSlug: string; eventId: string; tab?: string; section?: string; item?: string }): Promise<EventPageData | null>;
// load-events-list.ts
export interface EventListItem { id: string; name: string; specType: string; versionLabel: string | null; hasUnpublishedChanges: boolean; channels: number; messages: number; operations: number; href: string }
export function loadEventsList(args: { tenantId: string; productId: string; domainSlug: string; productSlug: string }): Promise<EventListItem[]>;
```
Read first: `src/lib/navigation/asset-href.ts` (whole file), `event-spec-actions.ts` (pattern), `src/features/events/event-specs/load-event-spec-page.ts`, `src/features/events/workspace/load-events-tab-data.ts`, `src/features/events/crumbs.ts`, `src/features/events/route-scope.ts`.

Behavior: `loadEventsList` returns only events whose stored `document` parses as v2 (`parseEventDocument`); legacy v1 rows are skipped silently; counts come from the parsed document; sorted by name. `loadEventPage` returns `null` for an unknown id, an event of another tenant, or an event whose `productId` differs from the route's product; a stored v1 document yields `null` (and `console.error` once, like `loadEventSpecPage`).

- [ ] **Step 1: Write the failing tests.** `asset-href-event.test.ts`: `assetHref({kind:"event",…})` produces `/schemas/d/p/events/id`; with `{tab:"preview",section:"channels",item:"orders"}` produces `?tab=preview&section=channels&item=orders`; defaults omitted; `normalizeEventTab("editor")==="design"`, `("document")==="preview"`, `("diagnostics")==="preview"`, `("bogus")==="design"`, `(null)==="design"`; `normalizeBuilderSection` falls back to `"metadata"`; existing kinds untouched (`assetHref({kind:"events",…})` unchanged). `event-actions.test.ts`: follow the mocking pattern of `tests/unit/app/event-spec-route.test.tsx` / the existing `event-spec-actions` tests — each action calls the service with the right owner target and returns the service Result; a throwing service becomes a generic action error. `load-event-page.test.ts` and `load-events-list.test.ts` (integration, helpers from `tests/integration/services/events/helpers.ts`): own-product event loads with options and crumbs; other product's event → `null`; other tenant → `null`; unknown id → `null`; v1 document → `null`; list skips v1 rows, counts match the document, empty product → `[]`.
- [ ] **Step 2: Run them red** — `npx vitest run tests/unit/lib/navigation/asset-href-event.test.ts tests/unit/app/event-actions.test.ts tests/integration/services/events/load-event-page.test.ts tests/integration/services/events/load-events-list.test.ts` → FAIL (missing exports/modules).
- [ ] **Step 3: Implement** asset-href additions, the four actions (copy `event-spec-actions.ts` structure; `owner = { level: "PRODUCT", productId }`), and both loaders.
- [ ] **Step 4: Run green + old tests** — the four new files plus `npx vitest run tests/unit/lib tests/unit/app --reporter=dot` (all green) and `npx tsc --noEmit` (no new errors).
- [ ] **Step 5: Commit** — `feat(events): event asset href, server actions and loaders`.

---

### Task B2: Builder state, validation mapping and shell

**Files:**
- Create: `src/features/events/builder/outline.ts`, `problems.ts`, `use-event-draft.ts`, `EventBuilder.tsx`, `controls.tsx`, `sections/MetadataSection.tsx`, `sections/ServersSection.tsx`
- Test: `tests/unit/features/events/builder/outline.test.ts`, `problems.test.ts`, `use-event-draft.test.tsx`, `tests/unit/components/events/builder-shell.test.tsx`

**Interfaces:**
- Consumes: `EventDocument` and parts, `parseEventDocument`, `renameKey`, `slugKey`, `uniqueKey` (A2); `BuilderSection`, `BUILDER_SECTIONS` (B1 adds them to `asset-href.ts`, but B1 runs in parallel with you: create `src/features/events/builder/sections.ts` exporting the same `BUILDER_SECTIONS = ["metadata","servers","channels","messages","operations"] as const` and `BuilderSection` type, import from it, and do NOT edit `asset-href.ts`; the controller later turns that file into a re-export); `Button`, `Input`, `Textarea`, `Badge` from `@/components/ui`.
- Produces (exact — B3/B4 import these):
```ts
// problems.ts
export interface ProblemLocation { section: BuilderSection | null; item: string | null } // item = local key when the pointer points inside a keyed item
export function locateProblem(doc: EventDocument, pointer: string): ProblemLocation;
export function problemsByField(problems: DocumentProblem[], prefix: string): DocumentProblem[]; // exact or deeper pointers under prefix
// outline.ts
export interface OutlineNode { section: BuilderSection; label: string; count: number | null; problems: number; items: Array<{ key: string; label: string; problems: number }> }
export function buildOutline(doc: EventDocument, problems: DocumentProblem[]): OutlineNode[];
// use-event-draft.ts
export interface DraftState {
  doc: EventDocument; setDoc: (next: EventDocument) => void;
  update: (fn: (d: EventDocument) => EventDocument) => void;
  problems: DocumentProblem[];                       // client-side parse problems, recomputed on every change
  serverProblems: DocumentProblem[];                 // from the last failed save (cleared on edit)
  dirty: boolean; saving: boolean; error: string | null;
  save: () => Promise<boolean>;                      // calls args.saveDocument(event.id, productId, doc); true on success; on success resets dirty and calls onSaved(detail)
  discard: () => void;
}
export type SaveDocument = (eventId: string, productId: string, document: unknown) => Promise<ActionResult<EventDetail>>; // B4 passes updateEventDocumentAction; B2 never imports the actions module
export function useEventDraft(args: { event: EventDetail; productId: string; saveDocument: SaveDocument; onSaved?: (detail: EventDetail) => void }): DraftState;
// EventBuilder.tsx
export interface BuilderOptions { entityOptions: EntityOption[] }
export interface SectionProps {
  draft: DraftState; options: BuilderOptions;
  selectedItem: string | null; onSelectItem: (key: string | null) => void;
}
export const SECTION_COMPONENTS: Partial<Record<BuilderSection, React.ComponentType<SectionProps>>>; // B2 registers metadata + servers; B3 adds channels, messages, operations
export function EventBuilder(props: { draft: DraftState; options: BuilderOptions; section: BuilderSection; onSectionChange: (s: BuilderSection) => void; item: string | null; onItemChange: (k: string | null) => void }): JSX.Element;
// controls.tsx — thin wrappers every section uses (swappable in slice 2)
export function Field(props: { label: string; htmlFor: string; error?: string; hint?: string; children: React.ReactNode }): JSX.Element;
export const selectClass: string;
export function KeyInput(props: { id: string; label: string; value: string; taken: string[]; onCommit: (next: string) => void; error?: string }): JSX.Element; // local text state; commits (blur/Enter) only when valid and not taken; shows the rule text otherwise
```
Behavior:
- `locateProblem`: `/servers/<i>/…` → `{ section: "servers", item: <servers[i].key> }`; `/channels/<i>/…` → channels; `/messages/<i>/…` → messages; `/operations/<i>/…` → operations; `/info/…`, `/defaultContentType` → metadata; anything unknown → `{ section: null, item: null }`.
- `buildOutline`: one node per `BUILDER_SECTIONS`; `count` = number of items for list sections (servers/channels/messages/operations), `null` for metadata; `problems` = number of problems located in that section; items carry key + problem count. Labels: Metadata, Servers, Channels, Messages, Operations.
- `useEventDraft`: initial `doc` = `event.document`; `problems` from `parseEventDocument(doc)` (empty when ok); `dirty` = JSON-compare with the last saved doc; `save` calls `saveDocument(event.id, productId, doc)`, sets `serverProblems` from `details.problems` on failure and keeps all edits; `discard` resets to the last saved doc; also registers a `beforeunload` guard while dirty. Import `ActionResult` and `actionErrorText` from where the existing events components import them (e.g. `EventSpecEditor.tsx`); import `EventDetail` with `import type` from `@/services/events/event.service`.
- `EventBuilder`: left outline (buttons with `data-testid="outline-<section>"`, a red problem count `Badge`), middle form = `SECTION_COMPONENTS[section]` or a "Coming in the next slice" placeholder, sticky Save/Discard bar (`data-testid="builder-save"`, `builder-discard`; Save disabled when `!dirty || saving`), top-level error alert (`role="alert"`). Keyboard: outline buttons are real buttons with `aria-current` on the active section.
- `MetadataSection`: Name is on the page header (not here); fields: Title (`info.title`, required), Description (textarea), Default content type (`defaultContentType`), each with `Field`, inline error from `problemsByField`. `ServersSection`: list of servers (select to edit, "Add server"), per server: Key (`KeyInput`, auto-slug from protocol+host on creation via `slugKey`/`uniqueKey`), Protocol, Host, Pathname, Description; "Remove server" removes it and the key from every `channels[].serverKeys`; deleting asks via `window.confirm` when channels reference it.

- [ ] **Step 1: Write the failing tests.** Pure: `problems.test.ts` (each pointer family → section/item; unknown pointer; `problemsByField` prefix semantics: `/info/title` matches itself, not `/info/titles`), `outline.test.ts` (counts, problem counts per section from a document with two broken channels, labels, items). Hook: `use-event-draft.test.tsx` with `renderHook`, passing a `vi.fn()` as `saveDocument` — dirty toggles on edit/revert, problems update on invalid edit (empty title → `/info/title`), save success clears dirty and calls `onSaved`, save failure keeps edits and exposes `serverProblems` + `error`, `discard` restores, `save` is single-flight (second call while saving returns false). Component: `builder-shell.test.tsx` — outline renders five nodes with counts, clicking switches the section, problem badge shows on Servers when a server host is empty, Metadata edit marks dirty and enables Save, Save calls the action, server add/remove (with confirm) updates `serverKeys` references, `KeyInput` rejects a taken key and a key with a space and shows the rule, placeholder for sections without a component.
- [ ] **Step 2: Run red** — `npx vitest run tests/unit/features/events/builder tests/unit/components/events/builder-shell.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the modules above (follow existing component conventions: `"use client"`, `data-testid`, `aria-label`).
- [ ] **Step 4: Run green** + `npx tsc --noEmit` (no new errors).
- [ ] **Step 5: Commit** — `feat(events): event builder state, outline and shell with metadata and servers sections`.

---

### Task B3: Builder sections — Channels, Messages, Operations

**Files:**
- Create: `src/features/events/builder/sections/ChannelsSection.tsx`, `MessagesSection.tsx`, `OperationsSection.tsx`
- Modify: `src/features/events/builder/EventBuilder.tsx` (register the three in `SECTION_COMPONENTS` only)
- Test: `tests/unit/components/events/builder-channels.test.tsx`, `builder-messages.test.tsx`, `builder-operations.test.tsx`

**Interfaces:**
- Consumes: B2 (`SectionProps`, `DraftState`, `Field`, `KeyInput`, `selectClass`, `problemsByField`), `EntityPinPicker` (`src/features/events/shared/EntityPinPicker.tsx`: props `id, label, entities, value, onChange, optional, hint, loadVersions` — read its file and `src/features/events/pin-actions.ts` for `loadVersions`), `renameKey`, `slugKey`, `uniqueKey`, `DocChannel`, `DocMessage`, `DocOperation`.
- Produces: the three section components (default exports not required; named `ChannelsSection`, `MessagesSection`, `OperationsSection`), each `React.ComponentType<SectionProps>`.

Behavior (all edits go through `draft.update(fn)`; keys through `renameKey`):
- **Channels:** list + "Add channel" (key from `slugKey("channel")` made unique). Card "Where it lives": Address (text, `{param}` allowed), Protocol (text with `<datalist>` of `KNOWN_PROTOCOLS` from `src/features/events/workspace/create-form.tsx`), Servers (checkboxes over `doc.servers`). When the address contains `{name}` expressions the form shows a Parameters row per name (add/remove synced with the address; keeps existing definitions) so the document is never invalid for a missing parameter. Card "What it carries": Format (`avro|json-schema|protobuf` select; JSON Schema shows Dialect select `draft-07|2020-12`; switching away clears `formatDialect`), Allowed messages (checkboxes over `doc.messages`; unchecking a message that an operation on this channel uses is blocked with an inline message naming the operation). Title/summary/description optional. Remove channel: confirm if operations use it; removes those operations' channel reference by deleting those operations after confirmation (never leaves a dangling `channelKey`).
- **Messages:** list + "Add message" (key unique from `slugKey(title||"message")`). Fields: Key (`KeyInput` → `renameKey`), Title, Summary, Description, Content type (text), **Payload** via `EntityPinPicker` (required, `id="payload"`), Headers and Key pins via `EntityPinPicker optional`; "Sent on channels" checkboxes mirror `channels[].messageKeys`. Saving with an unpinned payload is allowed (draft); the picker's own "newer version" hint stays. Remove message: removes it from every channel `messageKeys` and operation `messageKeys`/`reply.messageKeys` after confirm when used.
- **Operations:** list + "Add operation" (needs ≥1 channel; otherwise shows "Add a channel first" with a button that switches the section). Fields: Key, Action as two radio cards (`send` "This service publishes" / `receive` "This service consumes"), Channel (select over `doc.channels` only), Messages (checklist limited to **that channel's** `messageKeys`; changing channel drops messages not on the new channel and shows a one-line notice), Summary, Description; optional Reply (toggle; reply channel select + reply messages limited to that channel). Remove operation.
- Every control shows `problemsByField(draft.problems.concat(draft.serverProblems), "/channels/<i>/…")` errors under its field.

- [ ] **Step 1: Write the failing tests** (jsdom, Testing Library, same style as `tests/unit/components/events/event-spec-editor.test.tsx`; render each section with a small `useEventDraft`-backed harness or a stub `DraftState` whose `update` applies the function to a local doc). Cases — Channels: add → unique keys (`channel`, `channel-2`); rename key rewrites operation references; address `orders.{tenantId}` auto-adds a `tenantId` parameter row and the document parses; format switch clears dialect; message checkbox toggles `messageKeys`; unchecking a message used by an operation is refused with the operation named; removing a channel with operations confirms then removes them; server checkboxes. Messages: add; payload picker change updates `payload` (entityId + entityVersionId), unpinned allowed; headers/key optional pins; rename key propagates to channels/operations; remove propagates; channel checkboxes mirror `messageKeys`. Operations: "Add a channel first" state; action radio cards; message checklist limited to the channel; channel change drops foreign messages with notice; reply toggle and limits; remove; pointer errors render under the right field (e.g. `/operations/0/messageKeys/0`).
- [ ] **Step 2: Run red** — `npx vitest run tests/unit/components/events/builder-channels.test.tsx tests/unit/components/events/builder-messages.test.tsx tests/unit/components/events/builder-operations.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the three sections and register them.
- [ ] **Step 4: Run green** (these + B2's builder tests) and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(events): builder channels, messages and operations sections`.

---

### Task B4: Event page, routes and Preview tab

**Files:**
- Create: `src/features/events/event-page/EventPage.tsx`, `EventPreview.tsx`, `use-event-preview.ts`, `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/events/[eventId]/page.tsx`, `loading.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions.ts` (add `previewEventDocumentAction`, `emitEventDraftAction`)
- Test: `tests/unit/components/events/event-page.test.tsx`, `tests/unit/app/event-route.test.tsx`, `tests/unit/app/event-preview-actions.test.ts`

**Interfaces:**
- Consumes: B1 (`loadEventPage`, `EventPageData`, `normalizeEventTab`, `assetHref`, actions), B2 (`useEventDraft`, `EventBuilder`), B3 sections via `SECTION_COMPONENTS`, A7 (`emitEventDocumentPreview`, `emitEventDraft` from `src/services/events/event-emit.service.ts` — **must be merged before this task starts**), existing `AsyncApiPreview`, `DiagnosticsList`, `EventBreadcrumb`, `HideEmptyRightPanel`, `src/features/events/event-specs/{use-event-spec-emission.ts,EventSpecPage.tsx}` (read them: keep-mounted editor pattern and the sandboxed iframe contract).
- Produces:
```ts
// event-actions.ts additions
export async function previewEventDocumentAction(eventId: string, productId: string, document: unknown): Promise<ActionResult<EmitOutput>>;
export async function emitEventDraftAction(eventId: string, productId: string): Promise<ActionResult<EmitOutput>>;
// EventPage.tsx
export function EventPage(props: { data: EventPageData }): JSX.Element;
// use-event-preview.ts
export function useEventPreview(args: { eventId: string; productId: string; doc: EventDocument; enabled: boolean }): { output: EmitOutput | null; loading: boolean; error: string | null; refresh: () => void };
```
Behavior: `page.tsx` (server component) awaits params/searchParams, calls `loadEventPage`, `notFound()` on null, renders `<EventPage data>`. `EventPage` builds the draft with `useEventDraft({ event, productId, saveDocument: updateEventDocumentAction, onSaved: () => router.refresh() })` (toast "Draft saved" on success) and renders: breadcrumb, header with the event name (inline rename via `renameEventAction`; toast + `router.refresh()`), spec badge (`AsyncAPI 3.0`), "Draft" badge, Delete button (confirm → `deleteEventAction` → `invalidateDomainsTree()` → `router.push(listHref)`; IN_USE error shown inline), tabs `Design | Preview` (roving-tabindex tabs like `EventSpecPage`; `?tab=` kept in sync via `router.replace(assetHref(...))` without scroll; the builder stays mounted while Preview shows so edits are not lost). Design = `EventBuilder` with `section`/`item` state synced to `?section=&item=`. Preview = `EventPreview`: debounced (600 ms) `useEventPreview` of the **current unsaved doc** through `previewEventDocumentAction`, renders `AsyncApiPreview` plus `DiagnosticsList` (diagnostics from `EmitOutput`); shows "Fix the problems in Design first" when the client parse has problems (no action call); manual Refresh button; `loading`/error states. Leaving with a dirty draft warns (`beforeunload` from the hook plus an in-app guard on tab links is NOT required in this slice — only `beforeunload`).

- [ ] **Step 1: Write the failing tests.** `event-preview-actions.test.ts`: both actions delegate with the product owner and return the service Result (mock the emit service). `event-route.test.tsx`: unknown id → `notFound`, found → renders (mock `loadEventPage`, follow `tests/unit/app/event-spec-route.test.tsx`). `event-page.test.tsx`: header name + badges; tabs switch and keep the builder mounted (edit in Design, go to Preview and back, edit is still there); Preview calls the action once after the debounce with the unsaved doc (fake timers), not at all when the draft has client problems; rename success/failure; delete confirm → router push; IN_USE delete error shown; `?tab=editor` alias lands on Design.
- [ ] **Step 2: Run red** — `npx vitest run tests/unit/components/events/event-page.test.tsx tests/unit/app/event-route.test.tsx tests/unit/app/event-preview-actions.test.ts` → FAIL.
- [ ] **Step 3: Implement** the actions, page, preview hook/component and route files.
- [ ] **Step 4: Run green** + `npx tsc --noEmit`; manually verify nothing else imports a removed symbol.
- [ ] **Step 5: Commit** — `feat(events): event page with design and preview tabs`.

---

### Task B5: Cutover — menu, Events list, sidebar, redirects, tests

**Files:**
- Create: `src/features/events/workspace/EventsList.tsx`, `NewEventDialog.tsx`
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/components/CreateDropdown.tsx`, `.../domain-workspace.tsx`, `.../[productSlug]/page.tsx` (load list data), `src/components/layout/LeftSidebar.tsx`, `src/lib/navigation/asset-href.ts` (only if the Events leaf href needs it), old routes `.../[productSlug]/{specs/[specId],messages/[messageId],channels/[channelId],traits/[traitId]}/page.tsx`
- Rewrite/delete tests: `tests/unit/components/create-dropdown-events.test.tsx`, `domain-workspace-tabs.test.tsx` (menu + events-section parts), `left-sidebar-events.test.tsx`, `tests/unit/components/events/events-tab.test.tsx`, `tests/unit/app/{event-spec-route,message-route,channel-trait-pages}` (product-level parts), `tests/unit/lib/navigation/asset-href-events.test.ts`, `tests/e2e/events-flow.spec.ts`
- Test: new `tests/unit/components/events/events-list.test.tsx`, `new-event-dialog.test.tsx`, `tests/unit/app/event-redirects.test.tsx`, `tests/e2e/events-builder.spec.ts`

**Interfaces:**
- Consumes: B1–B4, `createEventAction`, `loadEventsList`/`EventListItem`, `assetHref`, `invalidateDomainsTree`, `Dialog` (`@/components/ui/dialog`), `CreateDropdown`.
- Produces: `CreateDropdown` props become `{ onNewEntity; onNewCustomDataType; onNewApi?; onNewEvent?; onNewTrait? }` (**remove** `onNewEventSpec`, `onNewMessage`, `onNewChannel`; `onNewTrait` stays for Tenant/Domain library levels only — the product workspace no longer passes it); `EventsList({ productId, domainSlug, productSlug, items, createIntent?, onCreateIntentConsumed? })`; `NewEventDialog({ productId, open, onOpenChange, onCreated })`.

Behavior: the product "New" menu entries are New Entity · New Custom Data Type · New API · **New Event** (description "AsyncAPI event specification"). `New Event` opens `NewEventDialog` (name, description, spec format radio cards with AsyncAPI 3.0 selected and only option) → `createEventAction` → `invalidateDomainsTree()` → `router.push(assetHref({kind:"event",…}))`. The product page's Events tab renders `EventsList`: rows (name, `AsyncAPI 3.0` badge, version label or "Unpublished", "Draft" badge, counts, link via `item.href`), empty state ("No events yet" + "New Event" button), `data-testid="events-tab"` kept. `domain-workspace.tsx` drops the `eventsSection`/`eventsCreateIntent` state and the product `TraitsTab` mount (the Tenant/Domain trait tabs keep `TraitsTab`). `LeftSidebar`: one Events leaf per product (not Event Specs/Messages/Channels) linking the Events tab; the product Traits leaf is removed; add `events` to `NON_ENTITY_SEGMENTS`. Old routes: `/specs/[specId]` → `redirect(assetHref({kind:"event",id:specId,…}))` (same id) — a stored v1 spec lands on the event page, which 404s for it, acceptable and documented; `/messages/*`, `/channels/*`, product `/traits/*` → `redirect(assetHref({kind:"events",…}))` (the list). All redirects use `assetHref`.

- [ ] **Step 1: Write the failing tests** — `new-event-dialog.test.tsx` (name required; submit calls the action with trimmed values; error shown inline; success calls `onCreated` with the id; single-flight), `events-list.test.tsx` (rows, badges, counts, empty state, create button), `event-redirects.test.tsx` (each old route redirects to the exact `assetHref` string), rewritten `create-dropdown-events.test.tsx` (exact product menu = New Entity, New Custom Data Type, New API, New Event; tenant/domain levels unchanged; `onNewTrait` renders only when passed), rewritten sidebar and `domain-workspace-tabs` parts, `events-builder.spec.ts` (Playwright, modeled on `tests/e2e/events-flow.spec.ts` and its `helpers/`: create a product via helpers, open it, New → New Event, name it, add a server, a channel with address `orders.{tenantId}`, a message with a payload entity (created through helpers/db), an operation, Save, open Preview and see the iframe; reload and see the saved draft; the list shows the event).
- [ ] **Step 2: Run red** — `npx vitest run tests/unit/components/events/events-list.test.tsx tests/unit/components/events/new-event-dialog.test.tsx tests/unit/app/event-redirects.test.tsx tests/unit/components/create-dropdown-events.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the cutover changes. Remove the rewritten/obsolete old tests listed above only where the behavior they pinned is gone (menu entries, sections, product traits, old routes); keep tests of code that still exists (Tenant/Domain Traits, old services).
- [ ] **Step 4: Run** `npx vitest run event channel trait message domain-workspace left-sidebar create-dropdown no-handbuilt --reporter=dot` (green except the 4 known baseline failures if included), `npx tsc --noEmit` (no new errors), `npm run lint` on changed files; then, if the environment allows (Postgres + seeded admin; see `tests/e2e/helpers`), `npx playwright test tests/e2e/events-builder.spec.ts tests/e2e/navigation.spec.ts` and report the result honestly — if Playwright cannot run here, say so and list the manual steps instead.
- [ ] **Step 5: Commit** — `feat(events): New Event menu entry, flat Events list and redirects; retire the event spec/message/channel menu`.

---

## Slice exit check (what the user tests)

- [ ] `npm run db:deploy` already applied (A1); start the app from the worktree (`npm run dev`).
- [ ] Product page → New → **New Event** → name → lands on the Event page; Design builder: Metadata, Servers, Channels, Messages, Operations; Save draft; reload keeps it; Preview tab shows the AsyncAPI document; Delete works; the Events tab lists it; the old Event Spec/Message/Channel menu entries are gone; old URLs redirect.
- [ ] Known and documented gaps: legacy v1 draft event specs (dev DB has one, `checkout-events`) are not listed until the legacy-data migration (Phase C); no Publish/Versions/Source/Used-by tabs, Traits section or external references yet (slice 2); controls are the plain slice controls, not the final best-component set (slice 2).
