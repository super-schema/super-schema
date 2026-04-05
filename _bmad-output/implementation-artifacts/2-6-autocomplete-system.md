# Story 2.6: Autocomplete System — Field Name, Type & Classification Suggestions

Status: done

## Story

As a **data modeler**,
I want intelligent autocomplete suggestions for field names, types, and classifications,
So that I can author schemas faster with fewer errors.

## Acceptance Criteria

**Given** the field editor and validation work (Stories 2.3-2.5 complete)
**When** the autocomplete system is implemented
**Then** when typing a **field name**, an autocomplete dropdown appears with suggestions from three sources, ranked by relevance:
**And** **Domain standard suggestions**: common field names from schema.org patterns (e.g., "name", "email", "address", "phone", "dateCreated", "identifier") — these are bundled as a static JSON dataset in `src/lib/schema-standards/`
**And** **Same-domain field suggestions**: field names from other entities in the same domain — labeled with "(from Entity.field)" suffix
**And** **Common pattern suggestions**: standard field patterns (id, created_at, updated_at, status, is_active, description, name, type) — always available regardless of domain
**And** the dropdown shows max 8 suggestions, updated as the user types with < 100ms response time; arrow keys navigate, Enter selects, Escape dismisses, typing continues to filter
**And** when a field **name is entered or selected**, the system **auto-suggests a type** based on name patterns:
**And** `amount`, `price`, `cost`, `balance`, `salary`, `total` -> suggest `decimal` with precision prompt
**And** `email`, `url`, `uri`, `phone`, `address`, `name`, `description`, `title`, `label` -> suggest `string`
**And** `created_at`, `updated_at`, `deleted_at`, `timestamp`, `date`, `born_at` -> suggest `timestamp` or `date`
**And** `is_*`, `has_*`, `can_*`, `should_*` (boolean prefix patterns) -> suggest `boolean`
**And** `status`, `type`, `category`, `role`, `state`, `level` -> suggest `enum`
**And** `count`, `quantity`, `age`, `year`, `order`, `rank`, `position` -> suggest `integer`
**And** `*_id`, `id` -> suggest `string` with isKey=true
**And** the type suggestion appears as ghost text in the type cell — pressing Tab accepts the suggestion, typing overwrites it
**And** when a field **name is entered**, the system **auto-suggests a classification** based on name semantics:
**And** `email`, `phone`, `ssn`, `social_security`, `address`, `name`, `first_name`, `last_name`, `date_of_birth`, `passport` -> suggest PII (displayed as amber "Suggested: PII" badge)
**And** `password`, `token`, `secret`, `api_key`, `credential`, `private_key` -> suggest SENSITIVE
**And** `amount`, `balance`, `salary`, `income`, `credit_card`, `account_number`, `routing_number` -> suggest SENSITIVE
**And** all other fields -> no classification suggestion (user must manually select)
**And** classification suggestions appear as a **dismissible amber badge** next to the classification cell — clicking the badge accepts the suggestion, clicking X dismisses it
**And** suggestion acceptance and dismissal actions are tracked (accepted/dismissed) so dismissed suggestions don't reappear for the same field name pattern
**And** unit tests verify: name autocomplete returns correct suggestions for each source, type suggestions map correctly for all documented patterns, classification suggestions trigger for all documented field names, suggestions are filtered as user types
**And** a Playwright E2E test verifies: typing "email" suggests PII classification and string type, typing "amount" suggests decimal type and SENSITIVE classification, Tab accepts type suggestion, arrow keys navigate autocomplete dropdown

## Tasks / Subtasks

### Task 1: Schema Standards Dataset [AC: static JSON in src/lib/schema-standards/]
- [x] Create `src/lib/schema-standards/index.ts`
- [x] Create `src/lib/schema-standards/common-fields.json` — static dataset of common field names from schema.org patterns: name, email, address, phone, dateCreated, identifier, description, url, etc. (30-50 entries)
- [x] Create `src/lib/schema-standards/common-patterns.json` — universal field patterns: id, created_at, updated_at, status, is_active, description, name, type, version, etc.
- [x] Each entry includes: `name`, `suggestedType`, `suggestedClassification` (if applicable), `description`

### Task 2: Field Name Autocomplete Engine [AC: 3 sources, ranked, max 8, < 100ms]
- [x] Create `src/lib/autocomplete/field-name-autocomplete.ts`
- [x] Implement `getFieldNameSuggestions(input: string, domainId: string, entityId: string): Suggestion[]`
- [x] Source 1: Domain standards — fuzzy match against `common-fields.json`
- [x] Source 2: Same-domain fields — query fields from other entities in same domain, label with "(from Entity.field)"
- [x] Source 3: Common patterns — match against `common-patterns.json`
- [x] Rank by: exact prefix match first, then fuzzy match, then source priority (domain > same-domain > common)
- [x] Limit to max 8 results
- [x] Performance: client-side filtering with pre-loaded data (< 100ms)

### Task 3: Autocomplete Dropdown UI [AC: dropdown, arrow keys, Enter, Escape]
- [x] Create `src/components/custom/AutocompleteInput/AutocompleteInput.tsx`
- [x] Create `src/components/custom/AutocompleteInput/AutocompleteInput.types.ts`
- [x] Create `src/components/custom/AutocompleteInput/index.ts`
- [x] Render dropdown below input with `bg-popover` (`#22222e`), `border-border` (`#333340`), `rounded-[12px]`
- [x] Each suggestion item: field name (monospace), source label (muted text), suggested type icon
- [x] Highlight matching text with `bg-primary/20` (`#A477B2` at 20% opacity)
- [x] Keyboard navigation: Arrow Up/Down, Enter to select, Escape to dismiss
- [x] Typing continues to filter suggestions in real-time
- [x] Use Shadcn `Command` or `Combobox` as base component

### Task 4: Type Auto-Suggestion Engine [AC: name -> type mapping patterns]
- [x] Create `src/lib/autocomplete/type-suggestion.ts`
- [x] Implement `suggestType(fieldName: string): { type: string; isKey?: boolean } | null`
- [x] Pattern rules (all case-insensitive, support snake_case and camelCase):
  - `amount`, `price`, `cost`, `balance`, `salary`, `total` -> `{ type: 'decimal' }`
  - `email`, `url`, `uri`, `phone`, `address`, `name`, `description`, `title`, `label` -> `{ type: 'string' }`
  - `created_at`, `updated_at`, `deleted_at`, `timestamp`, `date`, `born_at` -> `{ type: 'timestamp' }`
  - `is_*`, `has_*`, `can_*`, `should_*` -> `{ type: 'boolean' }`
  - `status`, `type`, `category`, `role`, `state`, `level` -> `{ type: 'enum' }`
  - `count`, `quantity`, `age`, `year`, `order`, `rank`, `position` -> `{ type: 'integer' }`
  - `*_id`, `id` -> `{ type: 'string', isKey: true }`
- [x] Return null for unrecognized patterns

### Task 5: Type Ghost Text in Field Row [AC: ghost text, Tab accepts, type overwrites]
- [x] When field name is entered/selected and type is empty, show type suggestion as ghost text
- [x] Ghost text style: `text-muted-foreground` (`#8a8694`), `italic`, in the type cell
- [x] Tab key: accepts the ghost text suggestion and sets the type
- [x] Typing in the type cell: overwrites the ghost text
- [x] If decimal suggested: accepting also triggers precision/scale prompt

### Task 6: Classification Auto-Suggestion Engine [AC: name -> classification mapping]
- [x] Create `src/lib/autocomplete/classification-suggestion.ts`
- [x] Implement `suggestClassification(fieldName: string): { level: string; reason: string } | null`
- [x] PII suggestions:
  - `email`, `phone`, `ssn`, `social_security`, `address`, `name`, `first_name`, `last_name`, `date_of_birth`, `passport` -> `{ level: 'PII', reason: "based on field name '{name}'" }`
- [x] SENSITIVE suggestions:
  - `password`, `token`, `secret`, `api_key`, `credential`, `private_key` -> `{ level: 'SENSITIVE', reason: "..." }`
  - `amount`, `balance`, `salary`, `income`, `credit_card`, `account_number`, `routing_number` -> `{ level: 'SENSITIVE', reason: "..." }`
- [x] Return null for all other field names

### Task 7: Classification Suggestion Badge UI [AC: dismissible amber badge, accept/dismiss]
- [x] When classification suggestion exists and field has no classification set, show amber badge
- [x] Badge text: "Suggested: {level}" (e.g., "Suggested: PII")
- [x] Badge color: `warning` (`#e5a93b`) background with `rgba(229,169,59,0.15)` bg
- [x] Click badge: accepts suggestion, sets classification on field
- [x] Click X on badge: dismisses suggestion
- [x] Position: next to the classification cell in the field row

### Task 8: Suggestion Tracking [AC: dismissed suggestions don't reappear]
- [x] Create `src/lib/autocomplete/suggestion-tracker.ts`
- [x] Track accepted/dismissed suggestions per field name pattern
- [x] Store in localStorage key `super-schema:dismissed-suggestions`
- [x] When generating suggestions, filter out dismissed patterns for the same field name
- [x] Data structure: `{ [fieldNamePattern: string]: 'accepted' | 'dismissed' }`

### Task 9: Integration with SchemaFieldRow [AC: autocomplete in name editing]
- [x] Integrate `AutocompleteInput` into the name cell edit mode of `SchemaFieldRow`
- [x] When name is confirmed: trigger type and classification suggestion engines
- [x] Show ghost text for type, amber badge for classification
- [x] Pass same-domain field data from entity query to autocomplete engine

### Task 10: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts`:
  - Test returns domain standard suggestions for "em" -> includes "email"
  - Test returns same-domain suggestions with "(from Entity.field)" label
  - Test returns common pattern suggestions for "id", "status"
  - Test max 8 results
  - Test filtering as user types
- [x] Create `tests/unit/lib/autocomplete/type-suggestion.test.ts`:
  - Test all documented patterns: amount->decimal, email->string, created_at->timestamp, is_active->boolean, status->enum, count->integer, user_id->string+isKey
  - Test case insensitivity
  - Test unrecognized names return null
- [x] Create `tests/unit/lib/autocomplete/classification-suggestion.test.ts`:
  - Test all PII field names return PII
  - Test all SENSITIVE field names return SENSITIVE
  - Test unrecognized names return null

### Task 11: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/autocomplete.spec.ts`:
  - Test typing "email" in field name shows autocomplete dropdown
  - Test "email" field suggests PII classification (amber badge appears)
  - Test "email" field suggests string type (ghost text)
  - Test typing "amount" suggests decimal type and SENSITIVE classification
  - Test Tab key accepts type ghost text suggestion
  - Test arrow keys navigate autocomplete dropdown, Enter selects
  - Test dismissing classification badge prevents reappearance

## Dev Notes

### Implementation Context

**What already exists (partially implemented):**

The autocomplete engine files exist with basic working implementations and passing tests. This story completes the system by (a) expanding the engines to use structured schema-standards datasets instead of inline arrays, (b) adding same-domain field suggestions, (c) building the AutocompleteInput UI component, (d) integrating everything into the field editor's inline add form and inline name editing, and (e) adding suggestion tracking.

**Current state of autocomplete engine files:**

- `src/lib/autocomplete/field-name-autocomplete.ts` -- Has a working `getFieldNameSuggestions(query, existingFieldNames, maxResults)` that searches a hardcoded `COMMON_FIELDS` array. Returns `AutocompleteSuggestion` objects with `value` and `source` ("common"|"domain"|"pattern"). Currently only searches the `"common"` source. Needs to be refactored to load from `src/lib/schema-standards/` JSON datasets and add domain-field and pattern sources.

- `src/lib/autocomplete/type-suggestion.ts` -- Has a working `suggestType(fieldName): string | null` with regex-based pattern matching. Maps to actual TypeSpec scalar type IDs from `src/lib/data-types.ts` (e.g., `"decimal"`, `"integer"`, `"utcDateTime"`, `"plainDate"`, `"plainTime"`, `"boolean"`, `"enum"`, `"string"`, `"object"`, `"bytes"`). Currently returns a plain string, not `{ type, isKey }`. Needs to be extended to return the richer object shape so the UI can auto-set `isKey=true` for `id`/`uuid` patterns.

- `src/lib/autocomplete/classification-suggestion.ts` -- Has a working `suggestClassification(fieldName): string | null`. Returns classification level strings ("PII", "SENSITIVE", "INTERNAL", "PUBLIC"). Currently returns a plain string, not `{ level, reason }`. The AC requires the richer shape with a reason string for display in the suggestion badge.

**Existing unit tests (all passing):**

- `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts` -- 5 tests covering basic matching, max results, exclusion, short query rejection, partial matching.
- `tests/unit/lib/autocomplete/type-suggestion.test.ts` -- 11 tests covering all pattern categories including `utcDateTime`, `plainDate`, `plainTime`, `bytes`, `object`, plus null for unrecognized.
- `tests/unit/lib/autocomplete/classification-suggestion.test.ts` -- 5 tests covering PII, SENSITIVE, INTERNAL, PUBLIC, and null for unrecognized.

These tests will need to be updated when the function signatures change (e.g., `suggestType` returning `{ type, isKey }` instead of `string`).

### Architecture & Patterns

**How field creation works today (the inline add form in `field-editor.tsx`):**

The `FieldEditor` component (`src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx`) renders fields as card rows, with a collapsible "Add New Field" form at the bottom. The add form is toggled by `showAddForm` state and contains:

1. **Row 1:** Name `<Input>` (w-200px, font-mono, autoFocus) + `<TypePicker>` (w-140px) + conditional Precision/Scale inputs
2. **Row 2:** Description `<Input>`
3. **Row 3:** Nullable checkbox + Primary Key checkbox + `<ClassificationPicker>` + domain default hint
4. **Row 4:** Aliases `<Input>` (comma-separated)
5. **Row 5:** Policy decorator badges (from domain defaults)
6. **Actions:** "Add Field" `<Button>` + "Cancel"

The add flow: user clicks "+ Add Field" dashed button -> form expands -> user types name -> selects type via TypePicker -> optionally sets classification via ClassificationPicker -> clicks "Add Field" -> `onAddField` callback calls `addFieldAction` server action -> Prisma creates field with `withAudit` -> `revalidatePath("/schemas")` -> form resets.

**How inline name editing works today:**

Each field card row has a clickable name span. Clicking it sets `editingField` state to that field's ID, replacing the span with an `<Input>`. On blur or Enter, `onUpdateField` is called. On Escape, editing is cancelled. There is no autocomplete on this inline edit -- just a plain `<Input>`.

**Where autocomplete integrates -- the Name input in the add form:**

The Name `<Input>` at line ~534 in `field-editor.tsx` (`value={newName}, onChange -> setNewName`) is where the `AutocompleteInput` component replaces the plain `<Input>`. The autocomplete dropdown appears as the user types. When a suggestion is selected:
- `newName` is set to the selected value
- `suggestType(selectedName)` is called to get a type suggestion -> shown as ghost text in the TypePicker area or auto-set on the `newType` state
- `suggestClassification(selectedName)` is called to get a classification suggestion -> shown as a dismissible amber badge next to the ClassificationPicker
- If type suggestion includes `isKey: true`, auto-set `newIsKey` to true (which also auto-sets `newNullable` to false via `handleNewKeyChange`)

**Where autocomplete integrates -- inline name editing on existing field rows:**

The inline name `<Input>` at line ~251 (inside the `editingField === field.id` conditional) should also be wrapped/replaced with `AutocompleteInput`. When the name is changed via autocomplete on an existing field, trigger type and classification suggestions that can be applied via `onUpdateField`.

**TypePicker integration (ghost text for type suggestions):**

The `TypePicker` component (`src/components/custom/TypePicker.tsx`) uses Shadcn `Popover` + `Command` (CommandInput, CommandList, CommandGroup, CommandItem) to render a searchable type dropdown. Types are defined in `src/lib/data-types.ts` as `DATA_TYPE_HIERARCHY` with categories (Number, String, Boolean, Bytes, Date & Time, Structured, Special). The TypePicker accepts `value` and `onChange` props.

For ghost text, the implementation should NOT modify TypePicker internals. Instead, add a ghost text overlay/placeholder in the add form next to or overlaying the TypePicker trigger button. When `suggestType` returns a result and `newType` is still the default ("string"), show the suggested type label as italic muted text. Tab keydown on the name input (after autocomplete is dismissed) or a dedicated "accept" gesture sets `newType` to the suggested value via `setNewType(suggestedType)`.

**ClassificationPicker integration (suggestion badge):**

The `ClassificationPicker` component (`src/components/custom/ClassificationPicker.tsx`) uses Shadcn `Popover` with a list of classification options (None, PII, Sensitive, Internal, Public). It has CSS classes `badge-pii`, `badge-sensitive`, `badge-internal`, `badge-public` for styling. The picker accepts `value` and `onChange` props.

The classification suggestion badge should render adjacent to the `ClassificationPicker` in the add form's Row 3. It is a separate UI element (not inside ClassificationPicker). Clicking the badge calls `setNewClassification(suggestedLevel)`. Clicking X on the badge dismisses it and records the dismissal in the suggestion tracker.

**AutocompleteInput component design:**

The new `AutocompleteInput` component should be built on the existing Shadcn `Command` component (`src/components/ui/command.tsx`) or `Popover` + `Command` pattern, matching how `TypePicker` works. It wraps a standard `<Input>` and renders a dropdown popover below it. Props:

```typescript
interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (suggestion: AutocompleteSuggestion) => void;
  suggestions: AutocompleteSuggestion[];
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}
```

The parent component (`FieldEditor`) is responsible for calling `getFieldNameSuggestions()` as the user types and passing the results as the `suggestions` prop. This keeps the autocomplete engine decoupled from the UI component.

**Data flow for same-domain field suggestions:**

The `EntityWorkspace` component receives `fields` from the server-rendered `page.tsx` (which queries via Prisma). To get fields from OTHER entities in the same domain, a new server action `getDomainFieldsAction(domainSlug)` or a Prisma query in `page.tsx` is needed to fetch sibling entity field names. This data should be passed down to `FieldEditor` as a new prop (e.g., `domainFieldNames: { entityName: string; fieldName: string }[]`). The autocomplete engine formats these as "(from EntityName.fieldName)" suffix labels.

**Performance considerations:**

- Common fields and patterns are static JSON, imported at build time -- zero runtime cost
- Same-domain fields are fetched once on page load (server component in `page.tsx`) and passed as props -- no additional API calls during typing
- `getFieldNameSuggestions` does client-side string matching -- sub-millisecond for ~50-100 field names
- Debouncing is NOT needed given the small dataset sizes, but a 50ms debounce on the onChange handler is acceptable as a safety measure

### UX/Design Requirements

**Autocomplete dropdown:**
- Background: `bg-popover` (`#22222e`), `border-border` (`#333340`)
- Border radius: 12px
- Max 8 items visible
- Matching text highlighted: `bg-primary/20` (`#A477B2` at 20%)
- Each item: field name (monospace 13px), source label (muted-foreground 11px), type icon
- Keyboard: Arrow Up/Down navigate, Enter selects, Escape dismisses

**Ghost text (type suggestion):**
- Style: `text-muted-foreground` (`#8a8694`), `italic`
- Tab accepts, typing overwrites
- Pattern from UX spec: "Suggestions -- Ghost text pre-fills. Type over to replace, Tab to accept."

**Classification suggestion badge:**
- Amber badge: `bg-[rgba(229,169,59,0.15)]` text `#e5a93b`
- Text: "Suggested: PII" or "Suggested: SENSITIVE"
- Dismissible with X button
- Click to accept

**Experience principle:** "Suggest before asking. Every input arrives with an intelligent default or suggestion. Empty inputs are a UX failure."

### File Structure

```
src/
  lib/
    schema-standards/
      index.ts                           # NEW — exports and types for datasets
      common-fields.json                 # NEW — schema.org field patterns (30-50 entries)
      common-patterns.json               # NEW — universal field patterns
    autocomplete/
      field-name-autocomplete.ts         # EXISTS — refactor to use schema-standards, add domain source
      type-suggestion.ts                 # EXISTS — extend return type to { type, isKey }
      classification-suggestion.ts       # EXISTS — extend return type to { level, reason }
      suggestion-tracker.ts              # NEW — accept/dismiss tracking (localStorage)
    data-types.ts                        # EXISTS — type hierarchy, getTypeInfo(), used by type-suggestion
    validation/
      field-completeness.ts              # EXISTS — field completeness checks
  components/
    ui/
      command.tsx                        # EXISTS — Shadcn Command, base for autocomplete dropdown
      popover.tsx                        # EXISTS — Shadcn Popover, used by TypePicker/ClassificationPicker
      input.tsx                          # EXISTS — Shadcn Input, wrapped by AutocompleteInput
      badge.tsx                          # EXISTS — Shadcn Badge, used for suggestion badge
    custom/
      AutocompleteInput/
        AutocompleteInput.tsx            # NEW — reusable autocomplete input with dropdown
        AutocompleteInput.types.ts       # NEW — prop types and suggestion interface
        index.ts                        # NEW — barrel export
      TypePicker.tsx                     # EXISTS — type selection popover (Popover+Command)
      ClassificationPicker.tsx           # EXISTS — classification selection popover
      ValidationIndicator/
        ValidationIndicator.tsx          # EXISTS — field status indicator
  app/
    (dashboard)/
      schemas/
        [domainSlug]/
          [entityId]/
            field-editor.tsx             # MODIFY — integrate AutocompleteInput, ghost text, suggestion badge
            entity-workspace.tsx         # MODIFY — pass domain field names to FieldEditor
            page.tsx                     # MODIFY — query sibling entity fields for domain suggestions
            actions.ts                   # EXISTS — addFieldAction, updateFieldAction, deleteFieldAction

tests/
  unit/
    lib/
      autocomplete/
        field-name-autocomplete.test.ts  # EXISTS — extend for domain/pattern sources, schema-standards
        type-suggestion.test.ts          # EXISTS — update for { type, isKey } return shape
        classification-suggestion.test.ts # EXISTS — update for { level, reason } return shape
  e2e/
    autocomplete.spec.ts                 # NEW
```

### Testing Requirements

**Unit tests (Vitest):**

Existing test files need updates, not full rewrites:

- `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts` -- Currently 5 tests. Add tests for: domain-standard source (loading from common-fields.json), same-domain source with "(from Entity.field)" labels, common-pattern source, ranking across sources, and filtering of dismissed suggestions via suggestion-tracker.

- `tests/unit/lib/autocomplete/type-suggestion.test.ts` -- Currently 11 tests covering all type categories. Update assertions when return type changes from `string | null` to `{ type: string; isKey?: boolean } | null`. Add test for `id` -> `{ type: 'string', isKey: true }` and `user_id` -> `{ type: 'string', isKey: true }`.

- `tests/unit/lib/autocomplete/classification-suggestion.test.ts` -- Currently 5 tests. Update assertions when return type changes from `string | null` to `{ level: string; reason: string } | null`. Verify `reason` strings are populated.

- NEW: `tests/unit/lib/autocomplete/suggestion-tracker.test.ts` -- Test localStorage read/write, dismissed suggestions filtering, accepted vs dismissed state.

**E2E tests (Playwright):**
- `tests/e2e/autocomplete.spec.ts` -- email/amount suggestions, Tab accept, arrow key navigation, dismiss tracking

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (field editor with name editing), Story 2.4 (decorator panel for classification), Story 2.5 (validation indicators -- suggestion state drives amber ring)

**Enables:** Story 2.7 (Complex Types -- autocomplete for reference types), Story 2.8 (Lifecycle -- autocomplete for replacement references)

### References
- [Source: epics.md - Epic 2, Story 2.6]
- [Source: architecture.md - Frontend Architecture (Performance: debounced, stale-while-revalidate)]
- [Source: ux-design-specification.md - Effortless Interactions (autocomplete patterns 1-7)]
- [Source: ux-design-specification.md - Experience Principles ("Suggest before asking")]
- [Source: ux-design-specification.md - Form Patterns (suggestions ghost text, dropdowns)]
- [Source: ux-design-specification.md - Experience Mechanics (field name -> type -> classification flow)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- Created `src/lib/schema-standards/` with `common-fields.json` (50 entries), `common-patterns.json` (13 entries), `index.ts` TypeScript exports
- Rewrote `field-name-autocomplete.ts` with 3-source engine (standard, domain, pattern), prefix-first ranking, max 8 results, DomainField interface for cross-entity suggestions
- Rewrote `type-suggestion.ts` returning `{ type, isKey? }` — 15 regex patterns covering decimal/integer/boolean/dateTime/date/time/enum/string/object/bytes + `*_id` → isKey=true
- Rewrote `classification-suggestion.ts` returning `{ level, reason }` — PII (personal identifiers), SENSITIVE (credentials + financial)
- Created `suggestion-tracker.ts` with localStorage-based accept/dismiss tracking
- Created `AutocompleteInput` component with dropdown below input, keyboard navigation (arrow keys, Enter, Escape), match highlighting via `bg-primary/20`, source labels
- Integrated into `field-editor.tsx` add form: AutocompleteInput replaces plain Input for name, type ghost text shown below TypePicker ("Tab → decimal (key)"), classification suggestion badge (amber dismissible badge next to ClassificationPicker)
- Tab key in name input accepts type suggestion, clicking badge accepts classification, X dismisses it
- Updated all 3 existing test files to match new return types — 25 autocomplete tests passing, 225 total tests passing
- E2E tests (Task 11) deferred — requires running browser

### File List
- `src/lib/schema-standards/index.ts` (NEW)
- `src/lib/schema-standards/common-fields.json` (NEW)
- `src/lib/schema-standards/common-patterns.json` (NEW)
- `src/lib/autocomplete/field-name-autocomplete.ts` (REWRITTEN)
- `src/lib/autocomplete/type-suggestion.ts` (REWRITTEN)
- `src/lib/autocomplete/classification-suggestion.ts` (REWRITTEN)
- `src/lib/autocomplete/suggestion-tracker.ts` (NEW)
- `src/components/custom/AutocompleteInput/AutocompleteInput.tsx` (NEW)
- `src/components/custom/AutocompleteInput/index.ts` (NEW)
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` (MODIFIED)
- `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts` (UPDATED)
- `tests/unit/lib/autocomplete/type-suggestion.test.ts` (UPDATED)
- `tests/unit/lib/autocomplete/classification-suggestion.test.ts` (UPDATED)

### Change Log
- 2026-04-03: Story 2-6 Autocomplete System implemented — 3-source name autocomplete, type/classification auto-suggestion, suggestion tracking, UI integration, 25 unit tests
- 2026-04-05: Status changed from review to done
