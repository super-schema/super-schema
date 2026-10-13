# Story 2.12: Bidirectional TypeSpec Editing

Status: review

> **Epic 12 reconciliation note (2026-10-12):** The regex-based typespec-parser.ts this story depends on is superseded by Epic 12 Story 12.2's real @typespec/compiler integration. The diff/apply UX pattern in TypeSpecPreview.tsx (parse pasted text, diff against DB rows) is conceptually reusable for Epic 12 Story 12.5, but under the new architecture there are no DB rows to diff against — the whole document is replaced and recompiled, not diffed-and-patched.

## Story

As a **data modeler**,
I want to paste TypeSpec source and have it create/update entity fields,
So that I can import existing TypeSpec definitions or make bulk changes via code.

## Acceptance Criteria

### AC1: TypeSpec Parser Service
**Given** a valid TypeSpec source string containing a `model Name { ... }` block
**When** the parser is invoked
**Then** it extracts the model name, model-level @doc, and all field declarations
**And** each field's name, type (mapped to our type system), optionality (?), and decorators are captured
**And** supported decorators include: @key, @doc, @format, @secret, @minLength, @maxLength, @minValue, @maxValue, @pattern, @deprecated, @encode, @tag, @summary, @minItems, @maxItems, @visibility, @minValueExclusive, @maxValueExclusive
**And** array types (`string[]`) are parsed as type "array" with element type
**And** unknown decorators are ignored gracefully
**And** malformed/unparseable input returns null

### AC2: TypeSpec Editor Mode
**Given** the TypeSpec Preview panel in the right panel
**When** the user clicks the "Edit" toggle button
**Then** the read-only syntax-highlighted view switches to a monospace textarea
**And** the current TypeSpec source is pre-populated in the textarea
**And** a "Paste TypeSpec" button allows pasting from clipboard
**And** a "Preview Changes" button parses the TypeSpec and shows a diff summary
**And** Cmd+Enter triggers preview/apply

### AC3: Diff Preview & Confirmation
**Given** the user has edited TypeSpec in the editor
**When** they click "Preview Changes"
**Then** a summary is shown: fields to add (green), update (amber), remove (red)
**And** each category lists the affected field names
**And** if fields would be removed, a confirmation dialog appears before deletion
**And** the user can choose "Apply Without Removing" to skip deletions

### AC4: Server Action
**Given** the user confirms the apply action
**When** applyTypeSpecAction is called with the parsed fields
**Then** new fields are created via prisma.field.create
**And** changed fields are updated via prisma.field.update
**And** fields are only deleted when explicitly confirmed by the user
**And** the action returns counts of added, updated, and removed fields
**And** the page refreshes to show the updated fields

### AC5: Roundtrip Integrity
**Given** an entity with fields
**When** TypeSpec is generated (entity -> TypeSpec) and then parsed back (TypeSpec -> entity)
**Then** the parsed fields match the original entity fields (names, types, optionality, key status, decorators)

## Tasks / Subtasks

### Task 1: TypeSpec Parser Service [AC1]
- [x] Create `src/lib/compiler/typespec-parser.ts`
- [x] Implement `parseTypeSpec(source: string): ParsedTypeSpecModel | null`
- [x] Implement `mapTypeSpecType(typeExpr: string)` for TypeSpec scalar -> type ID mapping
- [x] Implement `computeFieldDiff(parsed, existing)` for diff computation
- [x] Handle model block extraction via regex
- [x] Parse field declarations: `name: type;` and `name?: type;`
- [x] Parse all supported decorators (@key, @doc, @format, @secret, @minLength, @maxLength, @minValue, @maxValue, @pattern, @deprecated, @encode, @tag, @summary, @minItems, @maxItems, @visibility, @minValueExclusive, @maxValueExclusive)
- [x] Parse array types (`string[]`)
- [x] Gracefully ignore unknown decorators
- [x] Return null for unparseable input

### Task 2: TypeSpec Editor Mode in Preview Panel [AC2, AC3]
- [x] Update `src/components/custom/TypeSpecPreview/TypeSpecPreview.tsx`
- [x] Add Edit/Preview toggle button
- [x] Implement edit mode with monospace textarea
- [x] Pre-populate textarea with current TypeSpec source
- [x] Add "Paste TypeSpec" button
- [x] Add "Preview Changes" button that parses and computes diff
- [x] Show diff summary with color-coded add/update/remove counts
- [x] Add confirmation dialog for field removal
- [x] Support "Apply Without Removing" option
- [x] Support Cmd+Enter keyboard shortcut
- [x] Show parse errors and apply errors

### Task 3: Server Action [AC4]
- [x] Add `applyTypeSpecAction` to entity actions.ts
- [x] Implement field creation for new fields
- [x] Implement field update for changed fields
- [x] Implement field deletion only when explicitly confirmed
- [x] Build decorators JSONB from parsed TypeSpec decorators
- [x] Extract classification from @tag decorator
- [x] Return add/update/remove counts

### Task 4: Wire Up to Entity Workspace [AC4]
- [x] Update `RightPanelRouter` to pass existingFields and onApplied callback
- [x] Update `EntityWorkspace` to provide field summaries to RightPanelRouter
- [x] Trigger page refresh on successful apply

### Task 5: Unit Tests [AC1, AC5]
- [x] Create `tests/unit/lib/compiler/typespec-parser.test.ts`
- [x] Test parsing simple model with fields
- [x] Test optional fields
- [x] Test @key decorator
- [x] Test @doc decorator (model-level and field-level)
- [x] Test @format, @secret, @minLength, @maxLength, @pattern decorators
- [x] Test array type parsing
- [x] Test type mapping for all TypeSpec scalars
- [x] Test malformed input returns null
- [x] Test empty model
- [x] Test multiple decorators on one field
- [x] Test #deprecated directive
- [x] Test @encode, @tag, @summary, @minItems, @maxItems decorators
- [x] Test @minValueExclusive, @maxValueExclusive decorators
- [x] Test @visibility decorator
- [x] Test unknown decorators are ignored
- [x] Test computeFieldDiff: add, update, remove, no changes

### Task 6: Roundtrip Tests [AC5]
- [x] Create `tests/unit/lib/compiler/typespec-roundtrip.test.ts`
- [x] Test: generate TypeSpec from entity -> parse back -> fields match
- [x] Test roundtrip with basic fields (string, int32, optional, key)
- [x] Test roundtrip with validation decorators
- [x] Test roundtrip with array-type fields
- [x] Test roundtrip with @secret and @encode decorators

## Dev Agent Record

### Implementation Notes
- Parser is regex-based (MVP), processing TypeSpec line-by-line within the model block
- Type mapping uses the existing `DATA_TYPE_HIERARCHY` from `src/lib/data-types.ts` for consistency
- The `computeFieldDiff` function compares by field name to identify adds, updates, and removes
- Field removal requires explicit user confirmation (safety first) with a separate confirmation dialog
- The server action `applyTypeSpecAction` accepts an optional `fieldsToRemove` array, only deleting when the user explicitly confirms
- Decorators are mapped to the existing JSONB structure (typespec.identity, typespec.validation, typespec.wireFormat, typespec.documentation, typespec.visibility)
- Classification is extracted from `@tag("classification:...")` to match the generator's output format
- The textarea supports Cmd+Enter to trigger preview/apply workflow
- On successful apply, the page reloads to pick up the new field data from the database
