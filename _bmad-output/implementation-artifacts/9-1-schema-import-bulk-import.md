# Story 9.1: Schema Import & Bulk Import

Status: review

## Story
As a **data engineer**, I want to import existing Avro, BigQuery DDL, and Protobuf schemas into Super Schema, so that I can register my production schemas without recreating them manually.

## Acceptance Criteria

**Given** entities and the emission pipeline exist (Epics 2-3 complete)
**When** schema import is implemented
**Then** the sidebar header includes an **"Import"** button (next to "+ New Entity") that opens an import dialog
**And** the import dialog supports three import modes:
**And** **Single file import**: drag-and-drop or file picker for one schema file — the system detects the format (Avro JSON, BigQuery DDL, Protobuf .proto) by file extension and content analysis
**And** **Bulk import**: drag-and-drop a folder or multiple files — the system processes each file and creates entities for each detected schema
**And** **Paste import**: a textarea where users can paste schema content directly — format auto-detected from content
**And** an **import service** (`src/services/import.service.ts`) exports: `importSchema(content, format, options, ctx): Result<ImportResult>` and `bulkImport(files, options, ctx): Result<BulkImportResult>`
**And** **Avro import parser** (`src/lib/importers/avro.importer.ts`): parses Avro JSON → creates entity with name from `name` field, fields from `fields` array, types mapped from Avro types to logical types (reverse of Avro emitter mapping), nullable detected from union types
**And** **BigQuery DDL import parser** (`src/lib/importers/bigquery.importer.ts`): parses CREATE TABLE DDL → extracts table name, column names/types, NULL/NOT NULL constraints, OPTIONS for descriptions — maps BigQuery types to logical types
**And** **Protobuf import parser** (`src/lib/importers/protobuf.importer.ts`): parses .proto file → extracts message name, field names/types/numbers, maps Protobuf types to logical types, preserves field numbers
**And** after parsing, the import shows a **review screen**: proposed entity with all parsed fields displayed in a preview table — entity name (editable), domain selector, and per-field: name, detected type, confidence indicator (green=high, amber=medium, red=low for ambiguous type mappings)
**And** the user can **edit any field** in the review screen before confirming import — adjusting types, adding classifications, or removing unwanted fields
**And** clicking "**Confirm Import**" creates the entity and all fields in the database
**And** for **bulk import**, a progress bar shows import progress ("Processing 5 of 23 files...") and a summary at the end: "Imported X entities, Y fields, Z warnings"
**And** import errors (unparseable files, unknown types) are displayed inline with "Skip" and "Manual Fix" options — the import continues for valid files
**And** imported entities are linked to their source format in entity metadata: `{ importedFrom: { format, originalContent, importedAt } }` — this enables drift detection (Story 9.2)
**And** unit tests verify: Avro parser extracts fields and types correctly, BigQuery parser handles CREATE TABLE with OPTIONS, Protobuf parser preserves field numbers, ambiguous type mappings show low confidence, bulk import handles mixed formats
**And** a Playwright E2E test verifies: single file import (Avro JSON) → review screen shows parsed entity → confirm creates entity with correct fields → entity appears in sidebar

## Tasks / Subtasks

### Database — Prisma Schema
- [x] Extend `entities` table metadata JSONB to support `importedFrom` field: `{ format: string, originalContent: string, importedAt: DateTime }` — validated by Zod schema
- [x] Add `importedFrom` to the existing `EntityMetadataSchema` Zod validator in `src/types/schemas/entity.ts`
- [x] Run `npx prisma migrate dev` if any schema changes are needed (metadata is JSONB, so likely no migration required — only Zod schema update)

### Backend — Importer Parsers
- [x] Create `src/lib/importers/types.ts`:
  - Define `ParsedField` type: `{ name: string, type: LogicalType, nullable: boolean, description?: string, fieldNumber?: number, confidence: 'high' | 'medium' | 'low', originalType: string }`
  - Define `ParsedEntity` type: `{ name: string, fields: ParsedField[], sourceFormat: string, originalContent: string }`
  - Define `ImportFormat` enum: `'avro' | 'bigquery-ddl' | 'protobuf'`
  - Define `ImportConfidence` type for type mapping confidence levels
- [x] Create `src/lib/importers/avro.importer.ts`:
  - Implement `parseAvroSchema(content: string): Result<ParsedEntity>` — parses Avro JSON schema
  - Extract entity name from top-level `name` field (strip namespace if present)
  - Map `fields` array: extract name, type, doc (as description)
  - Map Avro types to logical types (reverse of Avro emitter): `string` → `STRING`, `int`/`long` → `INTEGER`, `float`/`double` → `DECIMAL`, `boolean` → `BOOLEAN`, `bytes` → `BINARY`, `null` → handled via unions
  - Detect nullable from union types: `["null", "string"]` → nullable STRING
  - Set confidence: direct mappings = high, union types with multiple non-null = medium, `bytes`/complex = low
  - Handle nested records (flatten with dot notation or flag as low confidence)
  - Handle logical types: `date`, `timestamp-millis` → `TIMESTAMP`, `decimal` → `DECIMAL` with precision/scale
- [x] Create `src/lib/importers/bigquery.importer.ts`:
  - Implement `parseBigQueryDDL(content: string): Result<ParsedEntity>` — parses CREATE TABLE statement
  - Extract table name from `CREATE TABLE [project.]dataset.table_name`
  - Parse column definitions: name, type, `NOT NULL` constraint, `OPTIONS(description="...")` for descriptions
  - Map BigQuery types to logical types: `STRING` → `STRING`, `INT64` → `INTEGER`, `FLOAT64` → `DECIMAL`, `BOOL` → `BOOLEAN`, `BYTES` → `BINARY`, `TIMESTAMP`/`DATETIME`/`DATE` → `TIMESTAMP`/`DATE`, `NUMERIC`/`BIGNUMERIC` → `DECIMAL`, `STRUCT` → low confidence, `ARRAY` → low confidence
  - Set confidence: direct mappings = high, `STRUCT`/`ARRAY`/`GEOGRAPHY` = low
  - Handle multi-statement DDL (take first CREATE TABLE)
- [x] Create `src/lib/importers/protobuf.importer.ts`:
  - Implement `parseProtobufSchema(content: string): Result<ParsedEntity>` — parses .proto file
  - Extract message name from `message MessageName { ... }`
  - Parse field definitions: type, name, field number, `optional` keyword
  - Map Protobuf types to logical types: `string` → `STRING`, `int32`/`int64`/`sint32`/`sint64`/`uint32`/`uint64` → `INTEGER`, `float`/`double` → `DECIMAL`, `bool` → `BOOLEAN`, `bytes` → `BINARY`, `google.protobuf.Timestamp` → `TIMESTAMP`
  - Preserve field numbers in `ParsedField.fieldNumber`
  - Set confidence: scalar types = high, `map`/`oneof`/nested messages = low
  - Handle `syntax = "proto3"` detection (proto3 fields are implicitly optional)
- [x] Create `src/lib/importers/format-detector.ts`:
  - Implement `detectFormat(content: string, filename?: string): ImportFormat | null`
  - Detection by file extension: `.avsc`/`.avro` → avro, `.sql`/`.ddl` → bigquery-ddl, `.proto` → protobuf
  - Detection by content analysis: JSON with `"type": "record"` → avro, `CREATE TABLE` → bigquery-ddl, `syntax = "proto` or `message` keyword → protobuf
  - Return `null` if format cannot be determined

### Backend — Import Service
- [x] Create `src/services/import.service.ts`
- [x] Implement `importSchema(content, format, options, ctx): Result<ImportResult>`:
  - If format is `null`, call `detectFormat()` to auto-detect
  - Route to appropriate parser based on format
  - Return `ImportResult`: `{ parsedEntity: ParsedEntity, warnings: string[] }`
  - Does NOT create the entity — returns parsed data for review screen
  - Wrap in `withAudit()` for traceability
- [x] Implement `confirmImport(parsedEntity, domainId, ctx): Result<Entity>`:
  - Takes reviewed/edited `ParsedEntity` from the review screen
  - Creates entity in the database via Prisma with all fields
  - Sets entity metadata `importedFrom: { format, originalContent, importedAt: new Date() }`
  - Validates all fields via Zod before write
  - Wraps entity+fields creation in Prisma transaction
  - Returns the created entity
  - Wrap in `withAudit()`
- [x] Implement `bulkImport(files, options, ctx): Result<BulkImportResult>`:
  - Processes array of `{ content: string, filename: string }` items
  - For each file: detect format → parse → collect results
  - Return `BulkImportResult`: `{ parsed: ParsedEntity[], errors: { filename: string, error: string }[], warnings: string[] }`
  - Does NOT create entities — returns parsed data for bulk review
- [x] Implement `confirmBulkImport(parsedEntities, domainId, ctx): Result<BulkConfirmResult>`:
  - Creates all entities in the database (one Prisma transaction per entity)
  - Returns `BulkConfirmResult`: `{ created: Entity[], failed: { entityName: string, error: string }[] }`
  - Wrap in `withAudit()` — one audit entry per entity created

### Backend — oRPC Router
- [x] Create `src/server/api/routers/import.ts` oRPC router
- [x] Add `import.parseSchema` mutation — thin wrapper calling `importService.importSchema()`, accepts `{ content: string, format?: ImportFormat }`, requires Author role
- [x] Add `import.confirmImport` mutation — thin wrapper calling `importService.confirmImport()`, accepts `{ parsedEntity: ParsedEntity, domainId: string }`, requires Author role
- [x] Add `import.parseBulk` mutation — thin wrapper calling `importService.bulkImport()`, accepts `{ files: { content: string, filename: string }[] }`, requires Author role
- [x] Add `import.confirmBulkImport` mutation — thin wrapper calling `importService.confirmBulkImport()`, accepts `{ parsedEntities: ParsedEntity[], domainId: string }`, requires Author role
- [x] Wire router into `appRouter`

### Backend — Zod Schemas
- [x] Create `src/types/schemas/import.ts`:
  - `ImportFormatSchema` — z.enum(['avro', 'bigquery-ddl', 'protobuf'])
  - `ParsedFieldSchema` — Zod schema for ParsedField type
  - `ParsedEntitySchema` — Zod schema for ParsedEntity type
  - `ImportSchemaInput` — z.object({ content: z.string(), format: ImportFormatSchema.optional() })
  - `ConfirmImportInput` — z.object({ parsedEntity: ParsedEntitySchema, domainId: z.string().cuid() })
  - `BulkImportInput` — z.object({ files: z.array(z.object({ content: z.string(), filename: z.string() })) })
  - `ConfirmBulkImportInput` — z.object({ parsedEntities: z.array(ParsedEntitySchema), domainId: z.string().cuid() })

### Frontend — UI Components
- [x] Create `src/components/custom/ImportDialog/ImportDialog.tsx`:
  - Modal dialog opened by "Import" button in sidebar header
  - Three tabs: "Single File", "Bulk Import", "Paste"
  - Single File tab: drag-and-drop zone + file picker (accept `.avsc`, `.avro`, `.json`, `.sql`, `.ddl`, `.proto`)
  - Bulk Import tab: drag-and-drop zone for multiple files + folder selector
  - Paste tab: textarea with format auto-detection indicator
  - On file/paste submit: call `import.parseSchema` or `import.parseBulk` mutation
  - Show loading spinner during parsing
  - On success: transition to review screen
- [x] Create `src/components/custom/ImportDialog/ImportReviewScreen.tsx`:
  - Display parsed entity in a preview table
  - Editable entity name field at top
  - Domain selector dropdown
  - Per-field row: name (editable), detected type (dropdown selector), nullable (checkbox), description (editable), confidence badge (green/amber/red dot with tooltip)
  - "Remove Field" button per row
  - "Confirm Import" button — calls `import.confirmImport` mutation
  - "Cancel" button — returns to import dialog
- [x] Create `src/components/custom/ImportDialog/BulkImportReviewScreen.tsx`:
  - List of all parsed entities with expandable details
  - Per-entity: name (editable), field count, warning count, error status
  - Inline error display with "Skip" button to exclude problem files
  - Domain selector (applies to all entities)
  - Progress bar during confirmation ("Creating 5 of 23 entities...")
  - Summary on completion: "Imported X entities, Y fields, Z warnings"
  - "Confirm All" button — calls `import.confirmBulkImport` mutation
- [x] Create `src/components/custom/ImportDialog/ConfidenceBadge.tsx`:
  - Visual indicator: green dot (high confidence), amber dot (medium), red dot (low)
  - Tooltip explaining confidence reason (e.g., "Direct type mapping" or "Ambiguous: STRUCT has no logical equivalent")
- [x] Add "Import" button to sidebar header component (`src/components/layout/Sidebar.tsx` or equivalent):
  - Position next to existing "+ New Entity" button
  - Upload icon
  - Opens ImportDialog on click
- [x] Create `src/hooks/useImport.ts`:
  - Hook wrapping oRPC mutations for import flow
  - Manages import state: idle → parsing → reviewing → confirming → complete
  - Provides: `parseFile`, `parsePaste`, `parseBulk`, `confirmImport`, `confirmBulkImport`, `reset`
  - Handles file reading via FileReader API

### Testing
- [x] **Unit tests** (`tests/unit/lib/importers/avro.importer.test.ts`):
  - Parses valid Avro schema with primitive types (string, int, long, float, double, boolean, bytes)
  - Parses Avro schema with nullable union types (`["null", "string"]`)
  - Parses Avro schema with logical types (date, timestamp-millis, decimal)
  - Extracts entity name from Avro `name` field (strips namespace)
  - Returns high confidence for direct type mappings
  - Returns low confidence for complex/nested types
  - Returns error Result for invalid JSON
- [x] **Unit tests** (`tests/unit/lib/importers/bigquery.importer.test.ts`):
  - Parses CREATE TABLE with all standard BigQuery column types
  - Parses NOT NULL constraints correctly
  - Parses OPTIONS(description="...") for field descriptions
  - Handles project.dataset.table name format
  - Returns high confidence for direct type mappings
  - Returns low confidence for STRUCT, ARRAY, GEOGRAPHY
  - Returns error Result for unparseable DDL
- [x] **Unit tests** (`tests/unit/lib/importers/protobuf.importer.test.ts`):
  - Parses .proto file with scalar types
  - Preserves field numbers in ParsedField
  - Handles proto3 syntax (implicit optional)
  - Handles `optional` keyword in proto3
  - Maps well-known types (google.protobuf.Timestamp)
  - Returns low confidence for map, oneof, nested messages
  - Returns error Result for invalid proto syntax
- [x] **Unit tests** (`tests/unit/lib/importers/format-detector.test.ts`):
  - Detects Avro by `.avsc` extension
  - Detects BigQuery DDL by `.sql` extension
  - Detects Protobuf by `.proto` extension
  - Detects Avro by content (`"type": "record"`)
  - Detects BigQuery DDL by content (`CREATE TABLE`)
  - Detects Protobuf by content (`syntax = "proto3"`)
  - Returns null for unrecognizable content
- [x] **Unit tests** (`tests/unit/services/import.service.test.ts`):
  - importSchema routes to correct parser based on format
  - importSchema auto-detects format when not specified
  - confirmImport creates entity with correct fields in database
  - confirmImport stores importedFrom metadata on entity
  - bulkImport processes multiple files and collects results
  - bulkImport continues on parse errors, collects error list
  - confirmBulkImport creates all entities in database
  - RBAC: non-Author users are rejected
- [x] **E2E test** (`tests/e2e/schema-import.spec.ts`):
  - Open import dialog via sidebar "Import" button
  - Upload a single Avro JSON file
  - Review screen shows parsed entity with correct fields
  - Edit entity name and confirm import
  - Entity appears in sidebar with correct name
  - Entity fields match expected types from Avro schema

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/import.service.ts` owns all import business logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw — return error Results for parse failures, validation errors, etc.
- **withAudit()**: All entity-creating operations (confirmImport, confirmBulkImport) are logged to `audit_log`.
- **Importer plugin pattern**: Each importer (`src/lib/importers/*.importer.ts`) is a standalone parser with a consistent signature: `parse(content: string): Result<ParsedEntity>`. New formats can be added by creating a new importer file and registering it in the format detector.
- **RBAC**: Author role (or higher) required for import operations. Enforced in oRPC middleware via `protectedProcedure`.
- **JSONB metadata**: The `importedFrom` field is stored in the entity's existing `metadata` JSONB column. Validated by Zod on every write. No schema migration needed — just extend the Zod validator.
- **Confidence scoring**: Type mapping confidence is determined per-field during parsing. Direct 1:1 mappings are high confidence. Ambiguous or lossy mappings (STRUCT, ARRAY, complex unions) are medium or low. The review screen lets users fix low-confidence mappings before import.

### UX/Design Requirements
- Import dialog follows existing modal patterns (Shadcn Dialog component)
- Drag-and-drop zone uses standard file drop area with visual feedback (border highlight on drag over)
- Review screen table uses the same DataTable component pattern as other tables in the app
- Confidence badges are small colored dots (green/amber/red) with tooltips — consistent with drift status indicators in Story 9.2
- Bulk import progress uses the Shadcn Progress component
- Error states show inline with red text and action buttons (Skip/Manual Fix)

### File Structure
```
src/lib/importers/types.ts                           # Shared types — ParsedField, ParsedEntity, ImportFormat
src/lib/importers/avro.importer.ts                    # Avro JSON parser
src/lib/importers/bigquery.importer.ts                # BigQuery DDL parser
src/lib/importers/protobuf.importer.ts                # Protobuf .proto parser
src/lib/importers/format-detector.ts                  # Format auto-detection by extension + content
src/services/import.service.ts                        # Import orchestration — parse, confirm, bulk
src/types/schemas/import.ts                           # Zod schemas — ImportSchemaInput, ParsedFieldSchema, etc.
src/server/api/routers/import.ts                      # oRPC router (Author+)
src/components/custom/ImportDialog/ImportDialog.tsx    # Import dialog with tabs
src/components/custom/ImportDialog/ImportReviewScreen.tsx  # Single import review table
src/components/custom/ImportDialog/BulkImportReviewScreen.tsx  # Bulk import review + progress
src/components/custom/ImportDialog/ConfidenceBadge.tsx # Confidence indicator component
src/components/custom/ImportDialog/index.ts            # Re-exports
src/hooks/useImport.ts                                # React hook for import flow state
src/types/schemas/entity.ts                           # Modified — extend EntityMetadataSchema with importedFrom
```

### Testing Requirements
- **Unit tests** (`tests/unit/lib/importers/avro.importer.test.ts`): Avro parser correctness — primitive types, unions, logical types, error handling
- **Unit tests** (`tests/unit/lib/importers/bigquery.importer.test.ts`): BigQuery DDL parser — column types, constraints, OPTIONS, error handling
- **Unit tests** (`tests/unit/lib/importers/protobuf.importer.test.ts`): Protobuf parser — scalar types, field numbers, proto3 syntax, error handling
- **Unit tests** (`tests/unit/lib/importers/format-detector.test.ts`): Format detection by extension and content analysis
- **Unit tests** (`tests/unit/services/import.service.test.ts`): Import service orchestration — routing, auto-detection, entity creation, bulk processing, RBAC
- **E2E test** (`tests/e2e/schema-import.spec.ts`): Full import flow — dialog → file upload → review → confirm → entity created

### Dependencies & Prerequisites
- Epic 2 (Entity Management) complete — entity CRUD operations exist
- Epic 3 (Emission Pipeline) complete — emission targets and emitters exist (reverse mappings used by importers)
- Entity metadata JSONB schema (`src/types/schemas/entity.ts`) exists and is extensible
- Sidebar component exists with "+ New Entity" button placement
- Shadcn Dialog, DataTable, Progress, Tabs components available

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, JSONB validation, Project Structure
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Sidebar layout, modal patterns
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 9, Story 9.1
- PRD: FR21-FR23 (Schema Registration & Import)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
