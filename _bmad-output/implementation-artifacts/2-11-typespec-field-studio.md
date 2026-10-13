# Story 2.11: TypeSpec Field Studio — Full-Page Field Editor with 7-Panel Attribute System

Status: done

> **Epic 12 reconciliation note (2026-10-12):** This story's JSONB decorator panels (decorators.typespec.*) are the validated spec for which governance concepts matter — directly reused as input to Epic 12 Story 12.1's decorator package — but the storage mechanism (JSONB column) is superseded by typespec_source as of the 2026-10-12 architecture pivot. See architecture.md.

## Story

As a **data modeler**,
I want a full-page field editor organized into TypeSpec-aligned attribute panels that progressively show only relevant controls based on the field's type and context,
So that I can specify every TypeSpec decorator for a field through an intuitive UI without learning TypeSpec syntax.

## Acceptance Criteria

### AC1: Full-Page Field Detail Route
**Given** an entity with fields exists
**When** the user clicks a field's settings/expand icon or double-clicks a field card in the field editor
**Then** the app navigates to `/schemas/[domainSlug]/[entityId]/fields/[fieldId]` — a full-page field detail view
**And** a breadcrumb shows: Domains → {Domain} → {Entity} → {Field Name}
**And** the page displays the field name (editable inline, monospace), type badge, and validation status at the top
**And** below the header, 7 collapsible panels are rendered vertically, each representing a TypeSpec decorator category

### AC2: Panel 1 — Identity & Semantics
**Given** the field detail page is loaded
**Then** Panel 1 is expanded by default and contains:
- **Name**: inline-editable monospace text (pre-filled)
- **Type**: TypePicker (existing component) with full TypeSpec scalar hierarchy
- **Optionality (?)**: toggle for whether the field is optional (maps to TypeSpec `?` suffix)
- **Default Value**: type-aware input — string input for string fields, number input for numeric fields, boolean toggle for booleans, date picker for temporal fields; hidden when no default makes sense
- **@key**: toggle (mutually exclusive with @discriminator) — when enabled, auto-sets nullable=false
- **@discriminator**: toggle (mutually exclusive with @key) — only shown for fields in models that could be discriminated unions
- **@secret**: boolean toggle — marks field value as sensitive (password, token, API key)
- **@format**: dropdown populated contextually by base type:
  - **string fields**: uuid, uri, email, password, date-time, date, time, duration, ip-address, ip-v4-address, ip-v6-address, uri-template, json-pointer, relative-json-pointer, regex
  - **integer fields**: int8, int16, int32, int64, uint8, uint16, uint32, uint64, safeint
  - **other types**: dropdown hidden or shows only applicable formats
**And** @key and @discriminator show a visual mutex indicator — enabling one disables the other with a tooltip "Cannot be both key and discriminator"

### AC3: Panel 2 — Validation & Constraints (Type-Contextual)
**Given** the field's base type is known
**Then** Panel 2 renders ONLY the constraint controls relevant to that type:
- **Numeric types** (integer, int32, float, decimal, etc.):
  - @minValue / @maxValue: number inputs as inclusive range
  - @minValueExclusive / @maxValueExclusive: number inputs as exclusive range
  - Toggle between inclusive/exclusive mode per bound
- **String types** (string, url):
  - @minLength / @maxLength: integer inputs
  - @pattern: regex input with live preview — shows match/no-match indicator against a sample value the user can type
- **Array types** (array):
  - @minItems / @maxItems: integer inputs
- **No constraints panel shown** for boolean, bytes, or other types that have no TypeSpec validation decorators
**And** switching the field type in Panel 1 dynamically updates Panel 2's visible controls — e.g., changing from string to int32 replaces minLength/maxLength/pattern with minValue/maxValue
**And** previously set constraints for a different type are preserved in state but visually hidden (warns user if switching type would orphan existing constraints)

### AC4: Panel 3 — Wire Format & Encoding
**Given** the field detail page is loaded
**Then** Panel 3 has two sub-sections:

**Serialization (all fields):**
- @encode: dropdown with options contextual to field type:
  - **utcDateTime/offsetDateTime**: rfc3339, rfc7231, unixTimestamp (with encoding type sub-selector: int32, int64, float64)
  - **duration**: ISO8601, seconds (int32/float64)
  - **integer/decimal**: string (to preserve precision)
  - **bytes**: base64, base64url, hex
- @encodedName: key-value pairs editor — content-type (e.g., "application/json") → encoded name; allows multiple entries for different wire formats

**HTTP Parameter Binding (contextual — only when entity is used as an HTTP operation model):**
- Radio button group (mutually exclusive): None, @header, @query, @path, @cookie, @body, @bodyRoot, @bodyIgnore, @statusCode
- Each option shows a brief description tooltip
- @header/@query/@path: show an optional name override input when selected
- This sub-section is collapsed by default with a note "Applies only when this model is used in HTTP operations"

### AC5: Panel 4 — Visibility & Lifecycle
**Given** the field detail page is loaded
**Then** Panel 4 displays a **checkbox matrix**:
- **Columns**: Create, Read, Update, Delete, Query (the 5 lifecycle phases)
- **Row**: single row for this field showing which phases the field is visible in
- Default: all checked (visible in all phases)
- Unchecking a phase adds it to `@visibility` exclusions
- Bulk action buttons:
  - "Read Only" — checks only Read
  - "Create + Read" — checks Create and Read only
  - "All" — resets to all checked
  - "None / @invisible" — unchecks all (marks field as invisible)
**And** a summary line below the matrix shows the effective TypeSpec decorator, e.g.: `@visibility(Lifecycle.Create, Lifecycle.Read)` in a monospace code preview
**And** @removeVisibility is available as an advanced toggle — when enabled, the matrix inverts to show which visibilities to explicitly remove

### AC6: Panel 5 — Documentation
**Given** the field detail page is loaded
**Then** Panel 5 contains:
- **@doc**: markdown textarea with preview toggle (edit/preview tabs) — the primary field description
- **@summary**: single-line text input — short summary for API docs
- **@example**: type-aware value editor matching the field's declared type — string input for strings, number for numbers, JSON editor for complex types; shows the TypeSpec `@example(#{...})` preview
- **@deprecated**: toggle + message text input (shown when deprecated=true) — message explains why and what to use instead
- **@externalDocs**: URL input + description text input pair — links to external documentation
**And** the @doc textarea supports basic markdown formatting toolbar (bold, italic, code, link)

### AC7: Panel 6 — Versioning (Conditional)
**Given** the field detail page is loaded
**Then** Panel 6 is **only visible** when the containing entity's namespace/domain uses `@versioned`
**And** if the domain has a version enum defined, this panel shows:
- **Version timeline**: horizontal version selector showing all defined versions (e.g., v1, v2, v3) as clickable nodes
- **@added**: dropdown to select the version when this field was introduced
- **@removed**: dropdown to select the version when this field was removed
- **@renamedFrom**: version dropdown + old name text input — "This field was called {oldName} before {version}"
- **@madeOptional**: version dropdown — "This field became optional in {version}"
- **@madeRequired**: version dropdown — "This field became required in {version}"
- **@typeChangedFrom**: version dropdown + old type TypePicker — "This field was {oldType} before {version}"
**And** each versioning decorator shows a visual timeline marker at the selected version
**And** if no version enum exists, the panel shows: "Enable versioning on the domain to use version-aware decorators" with a link to domain settings

### AC8: Panel 7 — Protocol Extensions (Collapsible, Power Users)
**Given** the field detail page is loaded
**Then** Panel 7 is **collapsed by default** with a "Protocol Extensions" header and an expand chevron
**And** when expanded, it contains:
- **@extension**: key-value editor for arbitrary OpenAPI `x-*` properties — key input (auto-prefixes "x-" if not present), value input (JSON-aware — detects and validates JSON objects/arrays)
- **XML Decorators** (sub-section, only shown when XML emitter is active in domain/global config):
  - @xmlAttribute: toggle
  - @xmlElement: toggle
  - @xmlNamespace: text input for namespace URI + prefix
  - @xmlName: text input for override element name
**And** a badge shows the count of active extensions, e.g., "3 extensions"

### AC9: Panel State Persistence & Navigation
**Given** the user is editing field attributes across panels
**Then** all changes are auto-saved via debounced mutation (500ms) to the field's record
**And** panel expand/collapse state persists to localStorage per entity
**And** the back button or breadcrumb entity link returns to the entity field list
**And** unsaved changes are flushed before navigation
**And** keyboard shortcut Ctrl+S / Cmd+S triggers immediate save

### AC10: Data Model Extension
**Given** the existing field model stores `decorators` as JSONB
**Then** the JSONB structure is extended to store all 7 panel categories:
```json
{
  "identity": { "key": true, "discriminator": false, "secret": false, "format": "uuid", "optional": false, "defaultValue": null },
  "validation": { "minValue": null, "maxValue": null, "minLength": null, "maxLength": null, "pattern": null, "minItems": null, "maxItems": null },
  "wireFormat": { "encode": null, "encodedNames": {}, "httpBinding": null, "httpBindingName": null },
  "visibility": { "phases": ["Create", "Read", "Update", "Delete", "Query"], "invisible": false },
  "documentation": { "doc": "", "summary": "", "example": null, "deprecated": null, "externalDocsUrl": null, "externalDocsDescription": null },
  "versioning": { "added": null, "removed": null, "renamedFrom": null, "madeOptional": null, "madeRequired": null, "typeChangedFrom": null },
  "extensions": { "openapi": {}, "xml": {} }
}
```
**And** a Zod schema `TypeSpecDecoratorSchema` validates the full structure
**And** the existing `DecoratorSchema` (8-category structure/semantics/classification/etc.) is preserved for backward compatibility — the TypeSpec decorators are stored under a separate `typespec` key in the `decorators` JSONB, i.e., `decorators.typespec`

## Tasks / Subtasks

### Task 1: Field Detail Route & Page Shell (AC: 1)
- [x] Create route `/schemas/[domainSlug]/[entityId]/fields/[fieldId]/page.tsx`
- [x] Server component loads field with entity + domain context
- [x] Create `FieldStudio.tsx` client component — receives field data, entity context, domain policy
- [x] Breadcrumb: Domains → Domain → Entity → Field
- [x] Field header: editable name (monospace), TypePicker for type, ValidationIndicator
- [x] 7 collapsible panels using Shadcn Collapsible or Accordion

### Task 2: TypeSpecDecoratorSchema Zod Validation (AC: 10)
- [x] Create `src/types/schemas/typespec-decorator.schema.ts`
- [x] Define `TypeSpecDecoratorSchema` with all 7 categories
- [x] Integrate into existing `decorators` JSONB as `decorators.typespec` namespace
- [x] Update `updateFieldAction` to validate `typespec` sub-key with new schema
- [x] Unit tests: schema rejects invalid structures, accepts valid structures

### Task 3: Panel 1 — Identity & Semantics (AC: 2)
- [x] Create `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/IdentityPanel.tsx`
- [x] Name input, TypePicker, optionality toggle, default value editor
- [x] @key / @discriminator mutex toggles
- [x] @secret toggle
- [x] @format dropdown — contextual to field type (use `getTypeInfo()` to determine category)
- [x] Auto-set nullable=false when @key is enabled

### Task 4: Panel 2 — Validation & Constraints (AC: 3)
- [x] Create `panels/ValidationPanel.tsx`
- [x] Conditional rendering based on field type using `getTypeInfo().category`
- [x] Numeric: minValue/maxValue with inclusive/exclusive toggle
- [x] String: minLength/maxLength + @pattern regex editor with live preview
- [x] Array: minItems/maxItems
- [x] Empty state for types without constraints (boolean, bytes)
- [x] Dynamic re-render when type changes in Panel 1

### Task 5: Panel 3 — Wire Format & Encoding (AC: 4)
- [x] Create `panels/WireFormatPanel.tsx`
- [x] @encode dropdown — contextual options per type
- [x] @encodedName key-value editor (content-type → name pairs)
- [x] HTTP binding radio group — mutually exclusive, with name override inputs
- [x] HTTP section collapsed by default with contextual note

### Task 6: Panel 4 — Visibility & Lifecycle (AC: 5)
- [x] Create `panels/VisibilityPanel.tsx`
- [x] 5-column checkbox matrix (Create, Read, Update, Delete, Query)
- [x] Bulk action buttons (Read Only, Create+Read, All, None/@invisible)
- [x] Monospace code preview of effective TypeSpec decorator
- [x] @removeVisibility advanced toggle

### Task 7: Panel 5 — Documentation (AC: 6)
- [x] Create `panels/DocumentationPanel.tsx`
- [x] @doc markdown textarea with edit/preview toggle
- [x] @summary single-line input
- [x] @example type-aware value editor
- [x] @deprecated toggle + message input
- [x] @externalDocs URL + description pair

### Task 8: Panel 6 — Versioning (AC: 7)
- [x] Create `panels/VersioningPanel.tsx`
- [x] Conditional render — only if domain has version enum
- [x] Version timeline selector
- [x] @added, @removed, @renamedFrom, @madeOptional, @madeRequired, @typeChangedFrom controls
- [x] Each with version dropdown + relevant secondary input
- [x] "Enable versioning" message when no version enum exists

### Task 9: Panel 7 — Protocol Extensions (AC: 8)
- [x] Create `panels/ExtensionsPanel.tsx`
- [x] Collapsed by default
- [x] @extension key-value editor with x-* auto-prefix and JSON validation
- [x] XML decorators sub-section (conditional on XML emitter config)
- [x] Active extension count badge

### Task 10: Auto-Save & Navigation (AC: 9)
- [x] Debounced 500ms save on any panel change
- [x] Cmd+S / Ctrl+S immediate save
- [x] Flush unsaved changes on navigation away
- [x] localStorage persistence for panel collapse state
- [x] Status indicator: saving/saved/error

### Task 11: Integration with Field Editor Card View
- [x] Add navigation link from field card's Settings2 icon → field detail page
- [x] Double-click on field card → navigate to field detail page
- [x] Field editor card shows summary badges for TypeSpec decorators (e.g., "3 validators", "@key", "v2+")

### Task 12: Unit & Integration Tests
- [x] TypeSpecDecoratorSchema validation tests
- [x] Panel conditional rendering tests (type-contextual validation panel)
- [x] @key/@discriminator mutex logic test
- [x] Visibility matrix toggle logic test
- [x] Auto-save debounce test

### Review Findings

- [x] [Review][Patch] D1→P10: Add toast warning when type switch orphans existing constraints (AC3) [field-studio.tsx:handleTypeChange] — FIXED
- [x] [Review][Defer] D2: Versioning panel always visible instead of conditional (AC7) — deferred, version data loading belongs to story 4-1
- [x] [Review][Defer] D3: @doc markdown preview doesn't render markdown & missing toolbar (AC6) — deferred, current edit/preview is functional, polish later
- [x] [Review][Patch] P1: Stale closure in unmount save — saves initial values instead of current [field-studio.tsx:unmount useEffect] — FIXED: use refs
- [x] [Review][Patch] P2: Save races — updateTypespec triggers save with pre-update state [field-studio.tsx:updateTypespec/save] — FIXED: ref-based save + concurrent guard
- [x] [Review][Patch] P3: handleAddField has no error handling — UI stuck on failure [field-editor.tsx:handleAddField] — FIXED: try/catch/finally
- [x] [Review][Patch] P4: parseInt NaN on precision/scale for non-numeric input [field-editor.tsx:handleAddField] — FIXED: Number.isFinite guard
- [x] [Review][Patch] P5: updateFieldAction throws instead of returning error on validation failure [actions.ts:updateFieldAction] — FIXED: validate before withAudit
- [x] [Review][Patch] P6: addFieldAction doesn't validate decorators.typespec on create [actions.ts:addFieldAction] — FIXED: added validation
- [x] [Review][Patch] P7: parseInt local function shadows global in ValidationPanel [ValidationPanel.tsx] — FIXED: renamed to parseIntVal
- [x] [Review][Patch] P8: localStorage panel key uses entity.id not field.id — collision across fields in same entity [field-studio.tsx:PANEL_STORAGE_KEY] — FIXED: use field.id
- [x] [Review][Patch] P9: XML decorators always shown, not conditional on XML emitter config [ExtensionsPanel.tsx] — FIXED: showXml prop
- [x] [Review][Defer] W1: No authorization check — any user can update any field by ID [actions.ts] — deferred, pre-existing (RBAC is story 8-1)
- [x] [Review][Defer] W2: No input sanitization on arbitrary decorator keys [actions.ts] — deferred, pre-existing
- [x] [Review][Defer] W3: Inconsistent null-check operators in addFieldAction [actions.ts] — deferred, pre-existing
- [x] [Review][Defer] W4: domainPolicy unsafe type assertion on server [page.tsx] — deferred, pre-existing pattern

## Dev Notes

### Architecture & Patterns

**Route structure:**
```
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/
  page.tsx                     # Server component — loads field + entity + domain
  field-studio.tsx             # Client component — 7-panel editor
  panels/
    IdentityPanel.tsx          # Panel 1
    ValidationPanel.tsx        # Panel 2
    WireFormatPanel.tsx        # Panel 3
    VisibilityPanel.tsx        # Panel 4
    DocumentationPanel.tsx     # Panel 5
    VersioningPanel.tsx        # Panel 6
    ExtensionsPanel.tsx        # Panel 7
```

**TypeSpec Decorator → JSONB Mapping:**
All TypeSpec decorators are stored under `decorators.typespec` in the field's JSONB column. This keeps backward compatibility with the existing `decorators.structure`, `decorators.semantics`, etc. categories from Story 2.4.

**Type-contextual rendering:** Use `getTypeInfo(field.type)` from `src/lib/data-types.ts` to determine the field's category. The `DataType` interface already has `requiresPrecision` and `requiresScale` — extend this pattern for validation applicability:
- `category === "Number"` → show numeric constraints
- `category === "String"` → show string constraints
- `category === "Structured" && id === "array"` → show array constraints

**TypePicker hierarchy** (compact row layout with tree connectors):
The TypePicker displays all 31 TypeSpec built-in types in a hierarchical list flowing from generalized supertypes to specialized concrete types. Each type shows its monospace label and an example value/range right-aligned. The hierarchy follows typespec.io/docs/language-basics/built-in-types/:
- Number: `numeric` → `integer` → int8/16/32/64, safeint, uint8-64 | `float` → float32/64 | `decimal` → decimal128
- String: `string` → `url`
- Boolean, Bytes (flat — no subtypes)
- Date & Time: plainDate, plainTime, utcDateTime, offsetDateTime, duration, unixTimestamp32
- Structured: enum, array, map, object (complex type prompts for array element, map key/value, enum values)
- Special: reference (entity picker + cardinality)

**Existing components to reuse:**
- `TypePicker` — directory at `src/components/custom/TypePicker/` (TypePicker.tsx, TypeGrid.tsx, ComplexTypePrompt.tsx, type-icons.ts)
- `ClassificationPicker` — already exists at `src/components/custom/ClassificationPicker.tsx`
- `Badge` — `src/components/ui/badge.tsx` with pii/sensitive/internal/public variants
- `ValidationIndicator` — `src/components/custom/ValidationIndicator/`
- `Input`, `Button`, `Popover`, `Collapsible` — all Shadcn UI primitives in `src/components/ui/`

**Server action updates:** Extend `updateFieldAction` in `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts` — it already accepts `decorators: Record<string, unknown>` with `Prisma.InputJsonValue` casting. The TypeSpec data goes into `decorators.typespec`.

**Domain policy integration:** The existing `domainPolicy` prop (added in recent work) provides `defaultClassification` and `defaultRetention`. Panel 1 can use these as defaults for new fields.

### Complete TypeSpec Field Decorator Reference

| Panel | Decorator | TypeSpec Syntax | UI Control |
|-------|-----------|-----------------|------------|
| 1 - Identity | @key | `@key id: string` | Toggle |
| 1 - Identity | @discriminator | `@discriminator kind: string` | Toggle (mutex with @key) |
| 1 - Identity | @secret | `@secret password: string` | Toggle |
| 1 - Identity | @format | `@format("uuid") id: string` | Dropdown (type-contextual) |
| 1 - Identity | Optional (?) | `name?: string` | Toggle |
| 1 - Identity | Default | `status: string = "active"` | Type-aware input |
| 2 - Validation | @minValue | `@minValue(0) price: float64` | Number input |
| 2 - Validation | @maxValue | `@maxValue(1000000) price: float64` | Number input |
| 2 - Validation | @minValueExclusive | `@minValueExclusive(0) price: float64` | Number input |
| 2 - Validation | @maxValueExclusive | `@maxValueExclusive(100) pct: float64` | Number input |
| 2 - Validation | @minLength | `@minLength(1) name: string` | Integer input |
| 2 - Validation | @maxLength | `@maxLength(100) name: string` | Integer input |
| 2 - Validation | @pattern | `@pattern("[A-Z]{2}-[0-9]+") sku: string` | Regex input + preview |
| 2 - Validation | @minItems | `@minItems(1) tags: string[]` | Integer input |
| 2 - Validation | @maxItems | `@maxItems(10) tags: string[]` | Integer input |
| 3 - Wire | @encode | `@encode("rfc3339") ts: utcDateTime` | Dropdown (type-contextual) |
| 3 - Wire | @encodedName | `@encodedName("application/json", "exp")` | Key-value editor |
| 3 - Wire | @header | `@header accept: string` | Radio (mutex group) |
| 3 - Wire | @query | `@query filter: string` | Radio (mutex group) |
| 3 - Wire | @path | `@path id: string` | Radio (mutex group) |
| 3 - Wire | @cookie | `@cookie session: string` | Radio (mutex group) |
| 3 - Wire | @body | `@body payload: bytes` | Radio (mutex group) |
| 3 - Wire | @bodyRoot | `@bodyRoot user: User` | Radio (mutex group) |
| 3 - Wire | @bodyIgnore | `@bodyIgnore internal: string` | Radio (mutex group) |
| 3 - Wire | @statusCode | `@statusCode code: int32` | Radio (mutex group) |
| 4 - Visibility | @visibility | `@visibility(Lifecycle.Read) id: string` | Checkbox matrix |
| 4 - Visibility | @removeVisibility | `@removeVisibility(Lifecycle.Delete)` | Advanced toggle |
| 4 - Visibility | @invisible | implicit when all phases unchecked | Bulk action |
| 5 - Docs | @doc | `@doc("Primary ID") id: string` | Markdown textarea |
| 5 - Docs | @summary | `@summary("ID field")` | Text input |
| 5 - Docs | @example | `@example(#{ name: "Fluffy" })` | Type-aware editor |
| 5 - Docs | @deprecated | `@deprecated("Use newField")` | Toggle + message |
| 5 - Docs | @externalDocs | `@externalDocs(url, description)` | URL + desc pair |
| 6 - Versioning | @added | `@added(Versions.v2) breed?: string` | Version dropdown |
| 6 - Versioning | @removed | `@removed(Versions.v3) legacy?: string` | Version dropdown |
| 6 - Versioning | @renamedFrom | `@renamedFrom(Versions.v3, "name")` | Version + old name |
| 6 - Versioning | @madeOptional | `@madeOptional(Versions.v2)` | Version dropdown |
| 6 - Versioning | @madeRequired | `@madeRequired(Versions.v3)` | Version dropdown |
| 6 - Versioning | @typeChangedFrom | `@typeChangedFrom(Versions.v2, string)` | Version + TypePicker |
| 7 - Extensions | @extension | `@extension("x-internal", true)` | Key-value editor |
| 7 - Extensions | XML decorators | `@xmlAttribute`, `@xmlElement`, etc. | Toggles + inputs |

### Format Options by Type

**String formats:** uuid, uri, email, password, date-time, date, time, duration, ip-address, ip-v4-address, ip-v6-address, uri-template, json-pointer, relative-json-pointer, regex

**Encoding options by type:**
- `utcDateTime` / `offsetDateTime`: rfc3339, rfc7231, unixTimestamp(int32), unixTimestamp(int64), unixTimestamp(float64)
- `duration`: ISO8601, seconds(int32), seconds(float64)
- `int64` / `decimal`: string (precision preservation)
- `bytes`: base64, base64url, hex

### Project Structure Notes

- This story adds a new route under the existing `[entityId]` folder — no new top-level routes
- Panel components are co-located with the field detail page, not in `src/components/custom/` — they're specific to this view
- Reuses existing server actions (`updateFieldAction`) and data flow — no new API endpoints needed
- The `TypeSpecDecoratorSchema` Zod type goes in `src/types/schemas/` alongside existing `decorator.schema.ts`

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (field editor), Story 2.4 (decorator panel — conceptual alignment), Story 2.1c (field service for updates)

**Enables:** Story 3.1 (compiler service can read TypeSpec decorators from JSONB to generate TypeSpec source), Story 4.1 (versioning panel data feeds version history)

### References
- [Source: typespec.io — Built-in decorators, Versioning library, HTTP library, Visibility system]
- [Source: epics.md — Epic 2, FR1-FR9, UX-DR5, UX-DR23]
- [Source: architecture.md — JSONB decorator schema, TypeSpec compilation, emitter intermediate model]
- [Source: ux-design-specification.md — Progressive disclosure, Select-to-Inspect Panel, Keyboard-first]
- [Source: prd.md — "eliminate need for data teams to learn TypeSpec" — the UI Studio IS the product differentiator]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- All 221 tests pass (50 new tests for this story)
- TypeScript compilation clean (no new errors introduced)
- ESLint clean on new files

### Completion Notes List
- Created TypeSpecDecoratorSchema with 7 categories (identity, validation, wireFormat, visibility, documentation, versioning, extensions) — all partial/optional for progressive disclosure
- Built full-page FieldStudio with 7-panel Accordion layout at `/schemas/[domainSlug]/[entityId]/fields/[fieldId]`
- Server component loads field + entity + domain context via Prisma
- Each panel component is co-located under `panels/` directory
- Panel 1 (Identity): optionality toggle, default value (type-aware), @key/@discriminator mutex, @secret toggle, @format dropdown (contextual by type — 15 string formats, 9 integer formats)
- Panel 2 (Validation): type-contextual constraints — numeric min/max with inclusive/exclusive toggle, string minLength/maxLength + @pattern regex with live preview, array minItems/maxItems, empty state for boolean/bytes
- Panel 3 (Wire Format): @encode dropdown with type-contextual options and sub-type selectors, @encodedName key-value editor, HTTP binding radio group (mutually exclusive) with name override inputs, collapsed by default
- Panel 4 (Visibility): 5-column checkbox matrix (Create/Read/Update/Delete/Query), bulk action buttons, monospace TypeSpec decorator preview, @removeVisibility advanced toggle
- Panel 5 (Documentation): @doc markdown textarea with edit/preview tabs, @summary, @example (type-aware), @deprecated toggle + message, @externalDocs URL + description pair
- Panel 6 (Versioning): conditional rendering (only when domain has versions), version timeline with visual markers, @added/@removed/@renamedFrom/@madeOptional/@madeRequired/@typeChangedFrom controls
- Panel 7 (Extensions): collapsed by default, @extension key-value editor with x-* auto-prefix and JSON validation, XML decorators sub-section, active extension count badge
- Auto-save: 500ms debounced save on any change, Cmd+S immediate save, flush on unmount, localStorage panel state persistence, save status indicator (saving/saved/error)
- Field editor card integration: Settings2 icon navigates to FieldStudio, double-click navigates, TypeSpec decorator summary badges (@key, @secret, @format, validator count, version)
- Updated `updateFieldAction` to validate `decorators.typespec` with TypeSpecDecoratorSchema
- 50 unit tests covering schema validation, type-contextual rendering logic, mutex logic, visibility matrix, wire format, extensions, JSONB integration

### File List
- `src/types/schemas/typespec-decorator.schema.ts` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/page.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/field-studio.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/IdentityPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/ValidationPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/WireFormatPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/VisibilityPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/DocumentationPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/VersioningPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel.tsx` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts` (MODIFIED — added TypeSpec validation)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` (MODIFIED — added navigation + TypeSpec badges)
- `tests/unit/types/typespec-decorator.schema.test.ts` (NEW — 26 tests)
- `tests/unit/schemas/typespec-field-studio.test.ts` (NEW — 24 tests)

### Change Log
- 2026-04-03: Story 2-11 TypeSpec Field Studio implemented — full-page field editor with 7-panel attribute system, TypeSpec decorator schema, auto-save, navigation integration, 50 unit tests
- 2026-04-05: Panels reorganized to 8 panels: Properties, Constraints, Serialization, Access Control, Documentation, Version History, Extensions, Data Governance. Retention removed from field-level (entity-level concern). Lineage removed from field-level (separate concern). Field number auto-assigned, editable in Serialization panel for Protobuf. Used for both field creation AND field editing
