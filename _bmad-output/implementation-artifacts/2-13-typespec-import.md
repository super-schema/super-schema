# Story 2.13: TypeSpec Import Support

Status: review

> **Epic 12 reconciliation note (2026-10-12):** One-shot create-new-entity import via the regex parser — superseded by Epic 12 Story 12.2 (real compiler) for the parsing step. Once Epic 12 lands, import becomes closer to 'compile this text as a new entity's typespec_source' than 'parse and populate Prisma rows.'

## Story

As a **data modeler**,
I want to import TypeSpec model definitions to create entities,
So that I can bring existing TypeSpec schemas into Super Schema with full decorator fidelity.

## Acceptance Criteria

**Given** the import pipeline supports Avro, BigQuery DDL, and Protobuf
**When** a user uploads a `.tsp` file or pastes TypeSpec content
**Then** the format detector identifies it as TypeSpec
**And** the TypeSpec importer parses the model definition using the existing TypeSpec parser
**And** model name maps to entity name, model-level `@doc` maps to entity description
**And** each field is mapped with type, nullability (from `?` optional), and `@key` support
**And** `@doc` on fields maps to description, `@format` maps to format hint
**And** `@secret` maps to classification = "SENSITIVE"
**And** `@tag("classification:XXX")` maps to classification level
**And** `@minLength`, `@maxLength`, `@minValue`, `@maxValue`, `@pattern` map to validation constraints
**And** `@deprecated` or `#deprecated` maps to deprecated flag with message
**And** array types (e.g. `string[]`) are correctly mapped to array type
**And** all fields have confidence "high" since TypeSpec is an exact schema definition
**And** the ImportUploader UI accepts `.tsp` files and mentions TypeSpec in the description text

## Tasks / Subtasks

### Task 1: Add TypeSpec to ImportFormat type [x]
- [x] Add `"typespec"` to `ImportFormat` union type in `src/lib/importers/types.ts`
- [x] Add optional TypeSpec-specific fields to `ParsedField` (isKey, classification, format, constraints, deprecated)
- [x] Add optional `description` field to `ParsedEntity`

### Task 2: Update format detector [x]
- [x] Add `.tsp` extension mapping in `src/lib/importers/format-detector.ts`
- [x] Add content-based detection for TypeSpec (import "@typespec", model keyword, TypeSpec decorators)

### Task 3: Create TypeSpec importer [x]
- [x] Create `src/lib/importers/typespec.importer.ts`
- [x] Implement `parseTypeSpecSchema(content: string): Result<ParsedEntity>`
- [x] Use existing `parseTypeSpec()` from `src/lib/compiler/typespec-parser.ts`
- [x] Map decorators to classification, constraints, format, deprecated fields
- [x] Set confidence to "high" for all fields

### Task 4: Register in import service [x]
- [x] Add `"typespec"` case in `parseWithFormat` switch in `src/services/import.service.ts`
- [x] Import `parseTypeSpecSchema` from the new importer
- [x] Update error messages to mention TypeSpec

### Task 5: Update ImportUploader UI [x]
- [x] Add `.tsp` to accepted file extensions in `src/components/custom/EntityCreationWizard/ImportUploader.tsx`
- [x] Update description text to mention TypeSpec

### Task 6: Unit tests [x]
- [x] Create `tests/unit/lib/importers/typespec.importer.test.ts`
- [x] Test simple model parsing with 3 fields
- [x] Test @key, @doc, @format decorators
- [x] Test optional fields -> nullable
- [x] Test @tag("classification:PII") -> classification = "PII"
- [x] Test @secret -> classification = "SENSITIVE"
- [x] Test validation decorators -> constraints
- [x] Test all fields have confidence "high"
- [x] Test model-level @doc -> entity description
- [x] Test array type (string[])
- [x] Test format detection for .tsp files and TypeSpec content
