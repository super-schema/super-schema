# Story 2.6: Autocomplete System — Field Name, Type & Classification Suggestions

Status: ready-for-dev

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
- [ ] Create `src/lib/schema-standards/index.ts`
- [ ] Create `src/lib/schema-standards/common-fields.json` — static dataset of common field names from schema.org patterns: name, email, address, phone, dateCreated, identifier, description, url, etc. (30-50 entries)
- [ ] Create `src/lib/schema-standards/common-patterns.json` — universal field patterns: id, created_at, updated_at, status, is_active, description, name, type, version, etc.
- [ ] Each entry includes: `name`, `suggestedType`, `suggestedClassification` (if applicable), `description`

### Task 2: Field Name Autocomplete Engine [AC: 3 sources, ranked, max 8, < 100ms]
- [ ] Create `src/lib/autocomplete/field-name-autocomplete.ts`
- [ ] Implement `getFieldNameSuggestions(input: string, domainId: string, entityId: string): Suggestion[]`
- [ ] Source 1: Domain standards — fuzzy match against `common-fields.json`
- [ ] Source 2: Same-domain fields — query fields from other entities in same domain, label with "(from Entity.field)"
- [ ] Source 3: Common patterns — match against `common-patterns.json`
- [ ] Rank by: exact prefix match first, then fuzzy match, then source priority (domain > same-domain > common)
- [ ] Limit to max 8 results
- [ ] Performance: client-side filtering with pre-loaded data (< 100ms)

### Task 3: Autocomplete Dropdown UI [AC: dropdown, arrow keys, Enter, Escape]
- [ ] Create `src/components/custom/AutocompleteInput/AutocompleteInput.tsx`
- [ ] Create `src/components/custom/AutocompleteInput/AutocompleteInput.types.ts`
- [ ] Create `src/components/custom/AutocompleteInput/index.ts`
- [ ] Render dropdown below input with `bg-popover` (`#22222e`), `border-border` (`#333340`), `rounded-[12px]`
- [ ] Each suggestion item: field name (monospace), source label (muted text), suggested type icon
- [ ] Highlight matching text with `bg-primary/20` (`#A477B2` at 20% opacity)
- [ ] Keyboard navigation: Arrow Up/Down, Enter to select, Escape to dismiss
- [ ] Typing continues to filter suggestions in real-time
- [ ] Use Shadcn `Command` or `Combobox` as base component

### Task 4: Type Auto-Suggestion Engine [AC: name -> type mapping patterns]
- [ ] Create `src/lib/autocomplete/type-suggestion.ts`
- [ ] Implement `suggestType(fieldName: string): { type: string; isKey?: boolean } | null`
- [ ] Pattern rules (all case-insensitive, support snake_case and camelCase):
  - `amount`, `price`, `cost`, `balance`, `salary`, `total` -> `{ type: 'decimal' }`
  - `email`, `url`, `uri`, `phone`, `address`, `name`, `description`, `title`, `label` -> `{ type: 'string' }`
  - `created_at`, `updated_at`, `deleted_at`, `timestamp`, `date`, `born_at` -> `{ type: 'timestamp' }`
  - `is_*`, `has_*`, `can_*`, `should_*` -> `{ type: 'boolean' }`
  - `status`, `type`, `category`, `role`, `state`, `level` -> `{ type: 'enum' }`
  - `count`, `quantity`, `age`, `year`, `order`, `rank`, `position` -> `{ type: 'integer' }`
  - `*_id`, `id` -> `{ type: 'string', isKey: true }`
- [ ] Return null for unrecognized patterns

### Task 5: Type Ghost Text in Field Row [AC: ghost text, Tab accepts, type overwrites]
- [ ] When field name is entered/selected and type is empty, show type suggestion as ghost text
- [ ] Ghost text style: `text-muted-foreground` (`#8a8694`), `italic`, in the type cell
- [ ] Tab key: accepts the ghost text suggestion and sets the type
- [ ] Typing in the type cell: overwrites the ghost text
- [ ] If decimal suggested: accepting also triggers precision/scale prompt

### Task 6: Classification Auto-Suggestion Engine [AC: name -> classification mapping]
- [ ] Create `src/lib/autocomplete/classification-suggestion.ts`
- [ ] Implement `suggestClassification(fieldName: string): { level: string; reason: string } | null`
- [ ] PII suggestions:
  - `email`, `phone`, `ssn`, `social_security`, `address`, `name`, `first_name`, `last_name`, `date_of_birth`, `passport` -> `{ level: 'PII', reason: "based on field name '{name}'" }`
- [ ] SENSITIVE suggestions:
  - `password`, `token`, `secret`, `api_key`, `credential`, `private_key` -> `{ level: 'SENSITIVE', reason: "..." }`
  - `amount`, `balance`, `salary`, `income`, `credit_card`, `account_number`, `routing_number` -> `{ level: 'SENSITIVE', reason: "..." }`
- [ ] Return null for all other field names

### Task 7: Classification Suggestion Badge UI [AC: dismissible amber badge, accept/dismiss]
- [ ] When classification suggestion exists and field has no classification set, show amber badge
- [ ] Badge text: "Suggested: {level}" (e.g., "Suggested: PII")
- [ ] Badge color: `warning` (`#e5a93b`) background with `rgba(229,169,59,0.15)` bg
- [ ] Click badge: accepts suggestion, sets classification on field
- [ ] Click X on badge: dismisses suggestion
- [ ] Position: next to the classification cell in the field row

### Task 8: Suggestion Tracking [AC: dismissed suggestions don't reappear]
- [ ] Create `src/lib/autocomplete/suggestion-tracker.ts`
- [ ] Track accepted/dismissed suggestions per field name pattern
- [ ] Store in localStorage key `super-schema:dismissed-suggestions`
- [ ] When generating suggestions, filter out dismissed patterns for the same field name
- [ ] Data structure: `{ [fieldNamePattern: string]: 'accepted' | 'dismissed' }`

### Task 9: Integration with SchemaFieldRow [AC: autocomplete in name editing]
- [ ] Integrate `AutocompleteInput` into the name cell edit mode of `SchemaFieldRow`
- [ ] When name is confirmed: trigger type and classification suggestion engines
- [ ] Show ghost text for type, amber badge for classification
- [ ] Pass same-domain field data from entity query to autocomplete engine

### Task 10: Unit Tests [AC: all unit test verifications]
- [ ] Create `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts`:
  - Test returns domain standard suggestions for "em" -> includes "email"
  - Test returns same-domain suggestions with "(from Entity.field)" label
  - Test returns common pattern suggestions for "id", "status"
  - Test max 8 results
  - Test filtering as user types
- [ ] Create `tests/unit/lib/autocomplete/type-suggestion.test.ts`:
  - Test all documented patterns: amount->decimal, email->string, created_at->timestamp, is_active->boolean, status->enum, count->integer, user_id->string+isKey
  - Test case insensitivity
  - Test unrecognized names return null
- [ ] Create `tests/unit/lib/autocomplete/classification-suggestion.test.ts`:
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

### Architecture & Patterns

**Autocomplete is the defining UX pattern** (per UX spec). Every input should offer intelligent suggestions. The system should feel like it already knows what you're trying to define.

**Performance requirement:** < 100ms response time for autocomplete. Use client-side filtering with pre-loaded static datasets. Same-domain fields fetched with entity data via TanStack Query (already cached).

**Static datasets bundled in codebase:** `src/lib/schema-standards/` contains JSON files. No runtime API calls for standard suggestions.

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
- Pattern from UX spec: "Suggestions — Ghost text pre-fills. Type over to replace, Tab to accept."

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
      index.ts                           # NEW — exports datasets
      common-fields.json                 # NEW — schema.org field patterns
      common-patterns.json               # NEW — universal field patterns
    autocomplete/
      field-name-autocomplete.ts         # NEW — 3-source suggestion engine
      type-suggestion.ts                 # NEW — name -> type mapping
      classification-suggestion.ts       # NEW — name -> classification mapping
      suggestion-tracker.ts              # NEW — accept/dismiss tracking
  components/
    custom/
      AutocompleteInput/
        AutocompleteInput.tsx            # NEW — reusable autocomplete component
        AutocompleteInput.types.ts       # NEW
        index.ts                         # NEW
      SchemaFieldRow/
        SchemaFieldRow.tsx               # MODIFIED — integrate autocomplete, ghost text, suggestion badges

tests/
  unit/
    lib/
      autocomplete/
        field-name-autocomplete.test.ts  # NEW
        type-suggestion.test.ts          # NEW
        classification-suggestion.test.ts # NEW
  e2e/
    autocomplete.spec.ts                 # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/lib/autocomplete/field-name-autocomplete.test.ts` — 3 sources, ranking, max 8, filtering
- `tests/unit/lib/autocomplete/type-suggestion.test.ts` — all pattern mappings, case insensitivity
- `tests/unit/lib/autocomplete/classification-suggestion.test.ts` — PII, SENSITIVE, null for others

**E2E tests (Playwright):**
- `tests/e2e/autocomplete.spec.ts` — email/amount suggestions, Tab accept, arrow key navigation, dismiss tracking

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (field editor with name editing), Story 2.4 (decorator panel for classification), Story 2.5 (validation indicators — suggestion state drives amber ring)

**Enables:** Story 2.7 (Complex Types — autocomplete for reference types), Story 2.8 (Lifecycle — autocomplete for replacement references)

### References
- [Source: epics.md - Epic 2, Story 2.6]
- [Source: architecture.md - Frontend Architecture (Performance: debounced, stale-while-revalidate)]
- [Source: ux-design-specification.md - Effortless Interactions (autocomplete patterns 1-7)]
- [Source: ux-design-specification.md - Experience Principles ("Suggest before asking")]
- [Source: ux-design-specification.md - Form Patterns (suggestions ghost text, dropdowns)]
- [Source: ux-design-specification.md - Experience Mechanics (field name -> type -> classification flow)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
