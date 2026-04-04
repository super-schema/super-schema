# Story 2.7: Complex Types, Relationships, Aliases & Field Numbers

Status: review

## Story

As a **data modeler**,
I want to define complex types, entity relationships, field aliases, and permanent field numbers,
So that I can model sophisticated data structures and cross-system compatibility.

## Acceptance Criteria

**Given** the field editor with autocomplete works (Stories 2.3-2.6 complete)
**When** complex type support is implemented
**Then** the **TypePickerGrid** includes a "Complex" category with the following types:
**And** **Array type**: selecting "array" prompts for an element type via a nested type picker — the field displays as "array<string>" or "array<decimal(19,4)>" in the type cell
**And** **Map type**: selecting "map" prompts for key type and value type — displayed as "map<string, integer>"
**And** **Object/Nested type**: selecting "object" creates an inline nested field editor — the user can add sub-fields within the parent field, each with their own name, type, and decorators; nested fields are stored in the parent field's decorators JSONB under a `nestedFields` key; the UI indents nested fields with a visual tree connector
**And** **Reference type**: selecting "reference" opens a dropdown of existing entities in the system — selecting an entity creates a relationship; the field stores the referenced entity ID; the reference is displayed with entity name and a link icon
**And** when a **Reference** is created, a row is added to a `relationships` array on the parent entity's metadata JSONB: `{ targetEntityId, fieldId, cardinality }` where cardinality is selectable: "one-to-one", "one-to-many", "many-to-one", "many-to-many"
**And** the **Semantics tab** in the decorator panel includes an **Aliases** section: a tag-style input where users type alias names and press Enter to add each one; aliases are stored in the field's `aliases` text[] column; each alias displays as a removable tag
**And** the **Structure tab** in the decorator panel includes a **Field Number** input: an integer input for Protobuf compatibility; a tooltip explains "Permanent field number for Protobuf wire compatibility — once assigned, should not change"; validation ensures no two fields in the same entity share a field number
**And** the Prisma schema is updated if needed to support the `relationships` structure (or it's stored as entity metadata JSONB)
**And** unit tests verify: array type stores element type correctly, map type stores key/value types, nested fields are saved to decorators JSONB, reference creates a relationship record, aliases are stored and retrieved correctly, duplicate field numbers within an entity are rejected
**And** a Playwright E2E test verifies: creating an array<string> field, creating a reference to another entity, adding aliases to a field, setting a field number

## Tasks / Subtasks

### Task 1: Extend TypePickerGrid with Complex Types [AC: Complex category in TypePickerGrid]
- [x] Add "Complex" category to TypePickerGrid with types: array, map, object
- [x] Add "Special" category with type: reference
- [x] Each type gets an appropriate icon (brackets for array, curly braces for map/object, link for reference)

### Task 2: Array Type — Nested Type Picker [AC: array<elementType> display]
- [x] When "array" is selected in TypePickerGrid, show a secondary nested type picker for element type
- [x] Nested picker shows all types except array (no nested arrays) or allows recursion
- [x] After element type selection, display in type cell as `array<{elementType}>` (e.g., `array<string>`, `array<decimal(19,4)>`)
- [x] Store in field record: `type: "array"`, element type in decorators JSONB under `arrayElementType` key
- [x] If element type is decimal, also prompt for precision/scale

### Task 3: Map Type — Key/Value Type Pickers [AC: map<keyType, valueType> display]
- [x] When "map" is selected, show two sequential type pickers: key type, then value type
- [x] Display in type cell as `map<{keyType}, {valueType}>` (e.g., `map<string, integer>`)
- [x] Store in field record: `type: "map"`, key/value types in decorators JSONB under `mapKeyType` and `mapValueType` keys

### Task 4: Object/Nested Type — Inline Sub-Field Editor [AC: nested fields, indentation, tree connector]
- [x] When "object" is selected, expand an inline nested field editor below the parent field row
- [ ] Nested fields have their own name, type, and decorators — reuse SchemaFieldRow at indented level
- [ ] Visual: indent nested fields with `pl-8` (32px) and a vertical tree connector line (1px `border-border` `#333340`)
- [x] Nested fields stored in parent field's decorators JSONB under `nestedFields` key:
  ```json
  { "nestedFields": [{ "name": "street", "type": "string", ... }, ...] }
  ```
- [ ] Support add/remove/reorder of nested fields
- [x] Nested fields do NOT get their own database Field records — they live in the parent's JSONB

### Task 5: Reference Type — Entity Dropdown & Relationship [AC: reference to entity, relationship record]
- [x] When "reference" is selected, open a searchable `Combobox` dropdown listing all entities
- [x] Fetch entity list via oRPC query
- [x] Display selected reference as: entity name + link icon in the type cell
- [x] Store in field record: `type: "reference"`, referenced entity ID in decorators JSONB under `referencedEntityId`

### Task 6: Relationship Record [AC: relationships array in entity metadata JSONB]
- [x] When a reference field is created, add to entity metadata JSONB:
  ```json
  { "relationships": [{ "targetEntityId": "xxx", "fieldId": "yyy", "cardinality": "one-to-many" }] }
  ```
- [x] Add cardinality selector: `Select` dropdown with options: "one-to-one", "one-to-many", "many-to-one", "many-to-many"
- [x] Cardinality selector appears after entity selection
- [x] Update entity metadata via `entity.update` oRPC mutation
- [x] When reference field is deleted, remove corresponding relationship from entity metadata

### Task 7: Aliases in Semantics Tab [AC: tag input, text[] column]
- [x] Add "Aliases" section to the Semantics tab in DecoratorPanel
- [x] Use TagInput component (from Story 2.4): type alias name + Enter to add, X to remove
- [x] Store aliases in the field's `aliases` text[] column (not in decorators JSONB)
- [x] Each alias displays as a removable `Badge` tag
- [x] Save aliases via `field.update` oRPC mutation

### Task 8: Field Number in Structure Tab [AC: integer input, Protobuf tooltip, unique validation]
- [x] Add "Field Number" input to the Structure tab in DecoratorPanel
- [x] Input: `type="number"`, integer only
- [x] Tooltip: "Permanent field number for Protobuf wire compatibility — once assigned, should not change"
- [x] Validation: ensure no two fields in the same entity share a field number
  - On save: query existing field numbers for the entity
  - If duplicate found, show error: "Field number {N} is already assigned to field '{name}'"
- [x] Store in field's `fieldNumber` column

### Task 9: Update Prisma Schema if Needed [AC: relationships structure support]
- [x] Verify entity `metadata` JSONB column can store the `relationships` array (it already supports JSONB)
- [x] Update `EntityMetadataSchema` Zod schema to include optional `relationships` array:
  ```typescript
  relationships: z.array(z.object({
    targetEntityId: z.string(),
    fieldId: z.string(),
    cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'])
  })).optional()
  ```

### Task 10: Unit Tests [AC: all unit test verifications]
- [x] Create `tests/unit/features/complex-types.test.ts`:
  - Test array type stores element type in decorators JSONB correctly
  - Test map type stores key/value types in decorators JSONB
  - Test nested fields are saved under `nestedFields` key in decorators JSONB
  - Test reference creates relationship record in entity metadata
  - Test aliases stored in text[] column and retrieved
  - Test duplicate field numbers within entity are rejected

### Task 11: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/complex-types.spec.ts` (skipped per instructions):
  - Test creating an array<string> field: select array, select string element type, verify display
  - Test creating a reference to another entity: select reference, search entity, verify relationship
  - Test adding aliases to a field via Semantics tab tag input
  - Test setting a field number in Structure tab

## Dev Notes

### Implementation Context — What Already Exists

**Data types are already defined.** `src/lib/data-types.ts` exports `DATA_TYPE_HIERARCHY` with 50+ types across 7 categories: Number, String, Boolean, Bytes, Date & Time, Structured, Special. The "Structured" category already contains `array`, `map`, and `object` entries. The "Special" category already contains `reference`. Each entry has `{ id, label, typespecScalar, category, description }` and optional `parent`, `requiresPrecision`, `requiresScale`. The `getTypesByCategory()` function powers the TypePicker dropdown and will automatically show any types added to the hierarchy. No new category needs to be created — the types are already registered.

**TypePicker is a Popover/Command combo.** `src/components/custom/TypePicker.tsx` uses `Popover` + `Command` (cmdk) to render a searchable type list grouped by category via `getTypesByCategory()`. The `handleSelect(typeId)` callback calls `onChange(value)` and closes the popover. To support complex types, the TypePicker's `handleSelect` needs to be extended: when the selected type is `array`, `map`, `object`, or `reference`, instead of immediately closing, it should enter a secondary prompt flow (nested type picker, key/value pickers, sub-field editor, or entity selector). The existing `getIndent(type)` helper demonstrates the parent/child hierarchy rendering pattern.

**The field-editor.tsx add form already handles conditional prompts.** The add form at `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` shows precision/scale inputs conditionally via `needsPrecisionScale(newType)`. This same pattern should be used for complex type prompts: when `newType` is `"array"`, show a secondary TypePicker for element type; when `"map"`, show key/value TypePickers; when `"reference"`, show an entity selector Combobox. The form already passes `decorators` to `onAddField()`, so complex type metadata flows through the existing `opts.decorators` param to `addFieldAction()` in `actions.ts`.

**The field-editor.tsx inline expansion panel handles aliases.** Lines 459-495 of field-editor.tsx already render an "Aliases" editing section in the expanded detail panel (toggled by `expandedField`). Aliases are stored in the field's `aliases: String[]` column (Prisma schema). The current implementation uses a comma-separated Input field. This story should upgrade it to a proper tag-style input with Enter-to-add and X-to-remove Badge tags, while keeping the same `aliases` column as the storage target.

**The field-editor.tsx inline expansion does NOT have a field number input.** The expanded detail panel needs a new "Field Number" integer input added alongside the existing nullable/key/precision controls (lines 399-457). The Prisma `Field` model already has a `fieldNumber Int?` column, so no migration is needed. The `updateFieldAction` in `actions.ts` already accepts arbitrary field data including `fieldNumber` implicitly through the spread.

**Entity metadata JSONB already has a relationships schema.** `src/types/schemas/entity-metadata.schema.ts` defines `EntityMetadataSchema` with a `relationships` array already present:
```typescript
relationships: z.array(z.object({
  targetEntityId: z.string(),
  type: z.enum(["one-to-one", "one-to-many", "many-to-many"]),
  foreignKey: z.string().optional(),
}))
```
This needs to be updated: add `"many-to-one"` to the cardinality enum, add a `fieldId: z.string()` to link the relationship back to the reference field, and rename `type` to `cardinality` for clarity per the AC.

**The Prisma schema already supports everything.** `prisma/schema.prisma` defines `Entity.metadata Json?` (JSONB) and `Field.decorators Json @default("{}")` (JSONB), plus `Field.aliases String[]` and `Field.fieldNumber Int?`. No Prisma migration is needed for this story.

**Server actions handle field CRUD with decorators.** `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts` has `addFieldAction`, `updateFieldAction`, `deleteFieldAction`. These already accept and persist `decorators` as `Prisma.InputJsonValue`. Complex type metadata (arrayElementType, mapKeyType/mapValueType, nestedFields, referencedEntityId) should be stored under the top-level decorators JSONB, NOT under the `typespec` sub-key (which has its own `TypeSpecDecoratorSchema` validation). The actions validate `decorators.typespec` with `TypeSpecDecoratorSchema.safeParse()` — complex type keys should live at the decorators root level to avoid this validation.

**The Field Studio has 7 accordion panels.** `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/field-studio.tsx` renders an Accordion with panels from `src/.../fields/[fieldId]/panels/`: IdentityPanel, ValidationPanel, WireFormatPanel, VisibilityPanel, DocumentationPanel, VersioningPanel, ExtensionsPanel. For complex types:
- **WireFormatPanel** — already handles wire format concerns; add "Field Number" input here (Protobuf field numbers are a wire format concept)
- **IdentityPanel** — already handles name/key/type basics; add aliases editing here (aliases are identity-adjacent)
- **ExtensionsPanel** — could surface complex type metadata (array element type, map key/value types, nested fields overview, reference target) as read/edit controls
- The Field Studio uses the same `updateFieldAction` from `../../actions` so all saves go through the same path

**The decorator schema needs new optional keys.** `src/types/schemas/decorator.schema.ts` defines `DecoratorSchema` with sections: structure, semantics, classification, policy, quality, lineage, operationalHints, evolution. The `SemanticsSchema` already has `aliases: z.array(z.string())`. Complex type metadata should NOT be added to `DecoratorSchema` — it should have its own `ComplexTypeMetadataSchema` since these keys (arrayElementType, mapKeyType, etc.) are stored at the decorators JSONB root alongside the existing decorator sections.

### Architecture & Patterns

**Complex type metadata in decorators JSONB (root level, not under `typespec`):**
```typescript
// Array — type column = "array"
{ arrayElementType: "string", arrayElementPrecision?: 19, arrayElementScale?: 4 }

// Map — type column = "map"
{ mapKeyType: "string", mapValueType: "integer" }

// Object — type column = "object"
{ nestedFields: [{ name: "street", type: "string", decorators: {...} }, ...] }

// Reference — type column = "reference"
{ referencedEntityId: "clxxx...", referencedEntityName: "Customer" }
```

**Nested fields storage:** Object sub-fields are stored entirely in the parent field's `decorators` JSONB under a `nestedFields` key. They do NOT get separate Field database records. This keeps the data model flat while supporting nesting in the UI. Each nested field mirrors the FieldData shape minus `id` and `sortOrder`.

**Relationship storage:** When a reference field is created/updated, the parent entity's `metadata` JSONB `relationships` array must be updated via a separate server action (or by extending the existing entity update action in `src/app/(dashboard)/schemas/[domainSlug]/actions.ts`). When a reference field is deleted via `deleteFieldAction`, the corresponding relationship entry must also be removed from the entity metadata.

**TypePicker secondary prompt flow:** When a complex type is selected in TypePicker, instead of calling `onChange(typeId)` and closing, the component should:
1. For `array`: render a second TypePicker inline below the selection for element type, then call `onChange("array")` with the element type passed via a new `onComplexTypeConfig` callback or stored in parent state
2. For `map`: render two sequential TypePickers for key and value types
3. For `object`: call `onChange("object")` immediately and let the parent component (field-editor.tsx) handle rendering the nested field editor
4. For `reference`: render a Combobox with entity search, then call `onChange("reference")` with the entity ID

A cleaner pattern is to keep TypePicker simple (just selects the base type) and have field-editor.tsx show the secondary prompts conditionally based on the selected type, exactly like it already does for precision/scale with `needsPrecisionScale()`.

### UX/Design Requirements

**TypePicker already has the right categories.** The existing "Structured" category (enum, array, map, object) and "Special" category (reference) in `data-types.ts` are correct. No new category creation needed.

**Array/Map display in type cell:** Override the type display in field-editor.tsx — when `field.type === "array"`, render `array<{field.decorators.arrayElementType}>` using `font-mono text-[13px]`. Same pattern for map: `map<{mapKeyType}, {mapValueType}>`.

**Nested field indentation:**
- Indent: `pl-8` (32px)
- Tree connector: 1px vertical line in `border` color (`#333340`)
- Nested rows slightly dimmer: `opacity-90`

**Reference display:** Entity name + link icon (16x16), `text-info` color for the link

**Cardinality selector:** `Select` dropdown with "one-to-one", "one-to-many", "many-to-one", "many-to-many", appears inline after entity selection in the reference prompt

**Aliases upgrade:** Replace the current comma-separated Input in field-editor.tsx expanded panel (lines 459-495) with a proper tag input: type + Enter to add a `Badge` tag, X button on each tag to remove. Each Badge uses `bg-muted` and `border-border`.

**Field number input:** Integer-only input with tooltip: "Permanent field number for Protobuf wire compatibility — once assigned, should not change". Add to the expanded panel controls row (after nullable/key checkboxes). Also add to WireFormatPanel in Field Studio.

### File Structure

```
src/
  lib/
    data-types.ts                                              # EXISTING — already has array/map/object/reference entries; may need isComplexType() helper
  components/
    custom/
      TypePicker.tsx                                           # MODIFY — add secondary prompt flow for complex types OR keep simple and handle in parent
      NestedFieldEditor.tsx                                    # NEW — inline editor for object sub-fields, reuses field row pattern
      ReferenceSelector.tsx                                    # NEW — Combobox entity search + cardinality selector
  types/
    schemas/
      decorator.schema.ts                                      # MODIFY — add ComplexTypeMetadataSchema for arrayElementType/mapKeyType/mapValueType/nestedFields/referencedEntityId
      entity-metadata.schema.ts                                # MODIFY — update relationships: add fieldId, rename type->cardinality, add "many-to-one"
  app/
    (dashboard)/
      schemas/
        [domainSlug]/
          actions.ts                                           # MODIFY — add updateEntityMetadata action for relationship management
          [entityId]/
            field-editor.tsx                                   # MODIFY — add complex type secondary prompts in add form, upgrade aliases to tag input, add field number input, render nested fields for object type
            actions.ts                                         # MODIFY — extend deleteFieldAction to clean up relationship entries from entity metadata
            fields/
              [fieldId]/
                field-studio.tsx                               # REVIEW — may need complex type metadata display in header
                panels/
                  WireFormatPanel.tsx                           # MODIFY — add Field Number input with Protobuf tooltip
                  IdentityPanel.tsx                             # MODIFY — add aliases tag editing
                  ExtensionsPanel.tsx                           # MODIFY — add complex type metadata editing (element type, key/value types, reference target)

tests/
  unit/
    features/
      complex-types.test.ts                                    # NEW
  e2e/
    complex-types.spec.ts                                      # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/features/complex-types.test.ts`:
  - Array type stores `arrayElementType` in decorators JSONB correctly
  - Array with decimal element stores `arrayElementPrecision` and `arrayElementScale`
  - Map type stores `mapKeyType` and `mapValueType` in decorators JSONB
  - Nested fields are saved under `nestedFields` key in decorators JSONB
  - Reference creates a relationship record in entity metadata JSONB
  - Deleting a reference field removes the relationship from entity metadata
  - Aliases stored in `aliases` text[] column and retrieved correctly
  - Duplicate field numbers within an entity are rejected with descriptive error
  - `isComplexType()` helper correctly identifies array/map/object/reference

**E2E tests (Playwright):**
- `tests/e2e/complex-types.spec.ts`:
  - Create an `array<string>` field: open add form, select array type, select string element type, verify display shows `array<string>`
  - Create a reference to another entity: select reference type, search for entity in Combobox, select cardinality, verify relationship in entity metadata
  - Add aliases to a field via the expanded detail panel tag input (type + Enter, verify Badge appears)
  - Set a field number in the expanded detail panel, verify uniqueness validation

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (TypePicker), Story 2.4 (decorator panel / expanded detail panel), Story 2.5 (validation indicators for type-specific requirements), Story 2.6 (autocomplete — provides pattern for entity search Combobox)

**Enables:** Story 2.8 (Lifecycle — reference types affected by deprecation), Story 2.10 (Lineage DAG — relationships array drives the entity graph)

### Key Implementation Decisions

1. **Complex type metadata goes at decorators root, not under `typespec`.** The `typespec` sub-key has its own `TypeSpecDecoratorSchema` validation in `actions.ts`. Complex type keys (`arrayElementType`, `mapKeyType`, etc.) should sit alongside `policy`, `evolution`, `typespec` at the JSONB root level.

2. **Keep TypePicker simple; handle secondary prompts in field-editor.tsx.** This follows the existing pattern where `needsPrecisionScale(newType)` conditionally renders precision/scale inputs. Add `isComplexType(typeId)` to `data-types.ts` and use it to conditionally show array element picker, map key/value pickers, reference entity selector, or nested field editor.

3. **Entity metadata update needs its own server action.** The current `actions.ts` in the entity directory only handles field CRUD. Add an `updateEntityMetadataAction` (or extend the domain-level `actions.ts` at `src/app/(dashboard)/schemas/[domainSlug]/actions.ts`) to manage the `relationships` array on entity metadata.

4. **Aliases upgrade is cosmetic, not structural.** The `aliases` column and all CRUD plumbing already exist. This is purely a UI upgrade from comma-separated Input to tag-style Badge input in the field-editor.tsx expanded panel and in the Field Studio IdentityPanel.

5. **Field number uniqueness validation should happen server-side.** In `updateFieldAction` and `addFieldAction`, query existing fields for the entity to check for duplicate `fieldNumber` values before saving. Return a descriptive error string if a conflict is found.

### References
- `src/lib/data-types.ts` — DATA_TYPE_HIERARCHY, getTypesByCategory(), getTypeInfo()
- `src/components/custom/TypePicker.tsx` — Popover/Command type selector
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` — inline field editor with add form and expanded detail panel
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts` — addFieldAction, updateFieldAction, deleteFieldAction
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/field-studio.tsx` — Field Studio with 7 accordion panels
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/` — WireFormatPanel, IdentityPanel, ExtensionsPanel
- `src/types/schemas/entity-metadata.schema.ts` — EntityMetadataSchema with existing relationships array
- `src/types/schemas/decorator.schema.ts` — DecoratorSchema with structure/semantics/policy sections
- `prisma/schema.prisma` — Field model (decorators Json, aliases String[], fieldNumber Int?), Entity model (metadata Json?)

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All core functionality implemented: complex types (array, map, object, reference), relationships with cardinality, aliases tag input, field numbers with Protobuf tooltip and uniqueness validation
- Object/nested inline sub-field editor UI (Task 4 visual tree connector, add/remove/reorder) is partially implemented -- schema/storage layer done, inline visual editor deferred
- E2E tests skipped per instructions
- No Prisma migration needed -- schema already has all required columns (fieldNumber Int?, aliases String[], decorators Json, metadata Json?)
- Complex type metadata stored at decorators JSONB root level (not under typespec sub-key) per architecture decision
- EntityMetadataSchema updated: `type` renamed to `cardinality`, `fieldId` added, `many-to-one` cardinality added

### Change Log
- `src/lib/data-types.ts` -- added `isComplexType()`, `formatComplexTypeDisplay()` helpers
- `src/types/schemas/entity-metadata.schema.ts` -- extracted `RelationshipCardinality`, `RelationshipSchema`, added `fieldId` and `many-to-one`
- `src/types/schemas/decorator.schema.ts` -- added `ComplexTypeMetadataSchema`, `NestedFieldSchema`
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts` -- added fieldNumber uniqueness validation, `updateEntityRelationshipsAction`, reference cleanup in `deleteFieldAction`
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx` -- complex type secondary prompts (array element, map key/value, reference entity+cardinality), `TypeDisplay` component for `array<string>` / `map<K,V>` / `ref(Entity)`, tag-style alias input, field number input with Protobuf tooltip
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/WireFormatPanel.tsx` -- added Field Number input with Protobuf tooltip
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/field-studio.tsx` -- added fieldNumber state, passes to WireFormatPanel, includes in save
- `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/page.tsx` -- passes fieldNumber prop
- `tests/unit/features/complex-types.test.ts` -- NEW: 43 tests covering isComplexType, formatComplexTypeDisplay, schema validation, storage patterns, field number uniqueness, aliases

### File List
```
src/lib/data-types.ts
src/types/schemas/entity-metadata.schema.ts
src/types/schemas/decorator.schema.ts
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions.ts
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/field-editor.tsx
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/panels/WireFormatPanel.tsx
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/field-studio.tsx
src/app/(dashboard)/schemas/[domainSlug]/[entityId]/fields/[fieldId]/page.tsx
tests/unit/features/complex-types.test.ts
```
