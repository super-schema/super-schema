# Story 2.7: Complex Types, Relationships, Aliases & Field Numbers

Status: ready-for-dev

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
- [ ] Add "Complex" category to TypePickerGrid with types: array, map, object
- [ ] Add "Special" category with type: reference
- [ ] Each type gets an appropriate icon (brackets for array, curly braces for map/object, link for reference)

### Task 2: Array Type — Nested Type Picker [AC: array<elementType> display]
- [ ] When "array" is selected in TypePickerGrid, show a secondary nested type picker for element type
- [ ] Nested picker shows all types except array (no nested arrays) or allows recursion
- [ ] After element type selection, display in type cell as `array<{elementType}>` (e.g., `array<string>`, `array<decimal(19,4)>`)
- [ ] Store in field record: `type: "array"`, element type in decorators JSONB under `arrayElementType` key
- [ ] If element type is decimal, also prompt for precision/scale

### Task 3: Map Type — Key/Value Type Pickers [AC: map<keyType, valueType> display]
- [ ] When "map" is selected, show two sequential type pickers: key type, then value type
- [ ] Display in type cell as `map<{keyType}, {valueType}>` (e.g., `map<string, integer>`)
- [ ] Store in field record: `type: "map"`, key/value types in decorators JSONB under `mapKeyType` and `mapValueType` keys

### Task 4: Object/Nested Type — Inline Sub-Field Editor [AC: nested fields, indentation, tree connector]
- [ ] When "object" is selected, expand an inline nested field editor below the parent field row
- [ ] Nested fields have their own name, type, and decorators — reuse SchemaFieldRow at indented level
- [ ] Visual: indent nested fields with `pl-8` (32px) and a vertical tree connector line (1px `border-border` `#333340`)
- [ ] Nested fields stored in parent field's decorators JSONB under `nestedFields` key:
  ```json
  { "nestedFields": [{ "name": "street", "type": "string", ... }, ...] }
  ```
- [ ] Support add/remove/reorder of nested fields
- [ ] Nested fields do NOT get their own database Field records — they live in the parent's JSONB

### Task 5: Reference Type — Entity Dropdown & Relationship [AC: reference to entity, relationship record]
- [ ] When "reference" is selected, open a searchable `Combobox` dropdown listing all entities
- [ ] Fetch entity list via oRPC query
- [ ] Display selected reference as: entity name + link icon in the type cell
- [ ] Store in field record: `type: "reference"`, referenced entity ID in decorators JSONB under `referencedEntityId`

### Task 6: Relationship Record [AC: relationships array in entity metadata JSONB]
- [ ] When a reference field is created, add to entity metadata JSONB:
  ```json
  { "relationships": [{ "targetEntityId": "xxx", "fieldId": "yyy", "cardinality": "one-to-many" }] }
  ```
- [ ] Add cardinality selector: `Select` dropdown with options: "one-to-one", "one-to-many", "many-to-one", "many-to-many"
- [ ] Cardinality selector appears after entity selection
- [ ] Update entity metadata via `entity.update` oRPC mutation
- [ ] When reference field is deleted, remove corresponding relationship from entity metadata

### Task 7: Aliases in Semantics Tab [AC: tag input, text[] column]
- [ ] Add "Aliases" section to the Semantics tab in DecoratorPanel
- [ ] Use TagInput component (from Story 2.4): type alias name + Enter to add, X to remove
- [ ] Store aliases in the field's `aliases` text[] column (not in decorators JSONB)
- [ ] Each alias displays as a removable `Badge` tag
- [ ] Save aliases via `field.update` oRPC mutation

### Task 8: Field Number in Structure Tab [AC: integer input, Protobuf tooltip, unique validation]
- [ ] Add "Field Number" input to the Structure tab in DecoratorPanel
- [ ] Input: `type="number"`, integer only
- [ ] Tooltip: "Permanent field number for Protobuf wire compatibility — once assigned, should not change"
- [ ] Validation: ensure no two fields in the same entity share a field number
  - On save: query existing field numbers for the entity
  - If duplicate found, show error: "Field number {N} is already assigned to field '{name}'"
- [ ] Store in field's `fieldNumber` column

### Task 9: Update Prisma Schema if Needed [AC: relationships structure support]
- [ ] Verify entity `metadata` JSONB column can store the `relationships` array (it already supports JSONB)
- [ ] Update `EntityMetadataSchema` Zod schema to include optional `relationships` array:
  ```typescript
  relationships: z.array(z.object({
    targetEntityId: z.string(),
    fieldId: z.string(),
    cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'])
  })).optional()
  ```

### Task 10: Unit Tests [AC: all unit test verifications]
- [ ] Create `tests/unit/features/complex-types.test.ts`:
  - Test array type stores element type in decorators JSONB correctly
  - Test map type stores key/value types in decorators JSONB
  - Test nested fields are saved under `nestedFields` key in decorators JSONB
  - Test reference creates relationship record in entity metadata
  - Test aliases stored in text[] column and retrieved
  - Test duplicate field numbers within entity are rejected

### Task 11: Playwright E2E Tests [AC: all E2E verifications]
- [ ] Create `tests/e2e/complex-types.spec.ts`:
  - Test creating an array<string> field: select array, select string element type, verify display
  - Test creating a reference to another entity: select reference, search entity, verify relationship
  - Test adding aliases to a field via Semantics tab tag input
  - Test setting a field number in Structure tab

## Dev Notes

### Architecture & Patterns

**Nested fields storage:** Object/nested fields are stored entirely in the parent field's `decorators` JSONB under a `nestedFields` key. They do NOT get separate Field database records. This keeps the data model flat while supporting nesting in the UI.

**Relationship storage:** Relationships are stored in the entity's `metadata` JSONB under a `relationships` array. This uses the existing JSONB column and avoids a new database table for MVP.

**Complex type metadata in decorators JSONB:**
```typescript
// Array
{ arrayElementType: "string" }

// Map
{ mapKeyType: "string", mapValueType: "integer" }

// Nested/Object
{ nestedFields: [{ name: "street", type: "string", decorators: {...} }] }

// Reference
{ referencedEntityId: "clxxx..." }
```

**Zod validation:** Update DecoratorSchema to accept these new optional keys, or create a separate `ComplexTypeMetadataSchema`.

### UX/Design Requirements

**TypePickerGrid categories (updated):**
- **Primitives**: string, integer, decimal, boolean, float (existing)
- **Temporal**: date, time, datetime, timestamp (existing)
- **Complex**: enum, array, map, object (enum existing, others NEW)
- **Special**: reference (NEW)

**Array/Map display in type cell:** `font-mono text-[13px]`, formatted as `array<string>` or `map<string, integer>`

**Nested field indentation:**
- Indent: `pl-8` (32px)
- Tree connector: 1px vertical line in `border` color (`#333340`)
- Nested rows slightly dimmer: `opacity-90`

**Reference display:** Entity name + link icon (16x16), `text-info` (`#6ba3e8`) color for link

**Cardinality selector:** `Select` dropdown, appears inline after entity selection

**Aliases tags:** `Badge` components, removable with X, `bg-muted` (`#2a2a36`), `border-border`

### File Structure

```
src/
  components/
    custom/
      TypePickerGrid/
        TypePickerGrid.tsx               # MODIFIED — add Complex and Special categories
  features/
    schema-editor/
      tabs/
        StructureTab.tsx                 # MODIFIED — add Field Number input
        SemanticsTab.tsx                 # MODIFIED — add Aliases section
      NestedFieldEditor.tsx              # NEW — inline editor for object sub-fields
      ReferenceSelector.tsx              # NEW — entity dropdown for reference type
  types/
    schemas/
      entity-metadata.schema.ts          # MODIFIED — add relationships array

tests/
  unit/
    features/
      complex-types.test.ts              # NEW
  e2e/
    complex-types.spec.ts                # NEW
```

### Testing Requirements

**Unit tests (Vitest):**
- `tests/unit/features/complex-types.test.ts` — array/map/object/reference storage, aliases, field number uniqueness

**E2E tests (Playwright):**
- `tests/e2e/complex-types.spec.ts` — array<string> creation, reference to entity, aliases, field number

### Dependencies & Prerequisites

**Prerequisites:** Story 2.3 (TypePickerGrid), Story 2.4 (Decorator panel Structure/Semantics tabs), Story 2.5 (validation for type-specific requirements), Story 2.6 (autocomplete for reference entity search)

**Enables:** Story 2.8 (Lifecycle — reference types affected by deprecation), Story 2.10 (Lineage DAG — relationships drive the graph)

### References
- [Source: epics.md - Epic 2, Story 2.7]
- [Source: architecture.md - Data Architecture (fields table, entity metadata JSONB)]
- [Source: architecture.md - SuperSchemaModel interface (relationships array)]
- [Source: ux-design-specification.md - TypePickerGrid categories, Type system depth]
- [Source: ux-design-specification.md - Form Patterns (tag multi-select, dropdowns)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
