# Story 11.2: Schema Standard Reference Library

Status: ready-for-dev

## Story
As a **data modeler**, I want to reference industry schema standards (schema.org, HL7/FHIR, financial standards) when creating entities, so that my schemas align with established conventions and I don't miss standard fields.

## Acceptance Criteria

**Given** entity authoring with autocomplete works (Epic 2 complete)
**When** the schema standard reference library is implemented
**Then** a **standards library** exists in `src/lib/schema-standards/` containing bundled JSON datasets for:
**And** **schema.org**: common entity templates (Person, Organization, Product, Event, Place, CreativeWork, etc.) with fields, types, and descriptions mapped to Super Schema's type system
**And** **Financial schemas**: common financial entity templates (Transaction, Account, Payment, Invoice, Currency) with fields including precision/scale for monetary values and appropriate PII/SENSITIVE classifications
**And** **Healthcare HL7/FHIR**: common healthcare entity templates (Patient, Practitioner, Observation, Condition, Medication) with appropriate PII classifications and compliance metadata
**And** each standard template contains: `{ standardName, entityName, description, fields: [{ name, type, classification, description, qualityRules? }], source, version }`
**And** the **entity creation flow** includes a **"From Standard"** option — a searchable dropdown showing all available standard templates grouped by source (schema.org, Financial, Healthcare)
**And** selecting a standard template **pre-populates** the entity with all standard fields — each field is marked with a "From {standardName}" badge and is fully editable
**And** the **autocomplete system** (Story 2.6) is enhanced to include standard fields: when creating a field on a "Customer" entity, the autocomplete suggests fields from schema.org's Person/Customer standard that haven't been added yet
**And** a **"Review Against Standard"** button in the entity header allows comparing an existing entity against a selected standard — the result shows: matching fields (green), missing fields from the standard (amber, with "Add" button), extra fields not in the standard (neutral, no action needed)
**And** the standard library is **bundled** (not fetched at runtime) — fully offline-compatible, updated only with application releases
**And** the standards data is extensible — administrators can add custom standard templates via a JSON file in a configurable directory (deferred to future — for now, only bundled standards)
**And** unit tests verify: standard templates are valid JSON with correct structure, entity creation from standard populates all fields correctly, review against standard identifies matching/missing/extra fields, autocomplete includes standard suggestions
**And** a Playwright E2E test verifies: creating entity from schema.org Person standard → fields are pre-populated → editing a standard field removes the badge → review against standard shows matching/missing fields

## Tasks / Subtasks

### Backend — Schema Standards Library
- [ ] Create `src/lib/schema-standards/` directory structure
- [ ] Create `src/lib/schema-standards/types.ts`:
  - `StandardField` type: `{ name, type, classification?, description?, qualityRules?: { rule, params }[] }`
  - `StandardTemplate` type: `{ standardName, entityName, description, fields: StandardField[], source, version }`
  - `StandardSource` enum: `"schema.org" | "financial" | "healthcare-fhir"`
- [ ] Create `src/lib/schema-standards/schema-org.json`:
  - Person: name, email, telephone, birthDate, address, familyName, givenName, etc. with PII classifications
  - Organization: name, url, email, telephone, address, legalName, foundingDate, etc.
  - Product: name, description, sku, price, brand, category, etc.
  - Event: name, startDate, endDate, location, organizer, description, etc.
  - Place: name, address, geo (latitude, longitude), telephone, etc.
  - CreativeWork: name, author, datePublished, description, url, etc.
  - Map all types to Super Schema type system (string, integer, decimal, date, timestamp, etc.)
- [ ] Create `src/lib/schema-standards/financial.json`:
  - Transaction: transactionId, amount (decimal), currency, timestamp, status, description, merchantName, etc.
  - Account: accountId, accountNumber (PII), accountType, balance (decimal), currency, ownerId (reference), openDate, status, etc.
  - Payment: paymentId, amount (decimal), currency, payerId (reference), payeeId (reference), method, status, processedAt, etc.
  - Invoice: invoiceNumber, issueDate, dueDate, totalAmount (decimal), currency, lineItems (array), status, etc.
  - Currency: code, name, symbol, decimalPlaces (integer), etc.
  - Include appropriate PII/SENSITIVE classifications for financial fields
- [ ] Create `src/lib/schema-standards/healthcare-fhir.json`:
  - Patient: identifier (PII), name (PII), birthDate (PII), gender, address (PII), telecom (PII), maritalStatus, etc.
  - Practitioner: identifier, name, qualification, telecom, address, speciality, etc.
  - Observation: identifier, status, code, subject (reference), effectiveDateTime, value, interpretation, etc.
  - Condition: identifier, clinicalStatus, verificationStatus, code, subject (reference), onsetDateTime, etc.
  - Medication: identifier, code, form, amount, ingredient, manufacturer, etc.
  - Include PII classifications aligned with HIPAA requirements
- [ ] Create `src/lib/schema-standards/index.ts`:
  - Import and export all standard datasets
  - `getAllStandards(): StandardTemplate[]` — returns all bundled standards
  - `getStandardsBySource(source: StandardSource): StandardTemplate[]` — filters by source
  - `findStandardByName(entityName: string): StandardTemplate | undefined` — case-insensitive lookup
  - `searchStandards(query: string): StandardTemplate[]` — fuzzy search across entity names and descriptions

### Backend — Standards Service
- [ ] Create `src/services/standards.service.ts`
- [ ] Implement `getStandardTemplates(filters?, ctx): Result<StandardTemplate[]>`:
  - Load all bundled standards
  - Apply optional filters: source, search query
  - Return sorted by source group, then entity name
  - RBAC: require Viewer role
- [ ] Implement `getStandardTemplate(standardName, entityName, ctx): Result<StandardTemplate>`:
  - Look up specific standard template
  - Return error if not found
  - RBAC: require Viewer role
- [ ] Implement `reviewAgainstStandard(entityId, standardName, entityName, ctx): Result<StandardReview>`:
  - Fetch entity fields from database
  - Fetch standard template fields
  - Compare field-by-field: matching fields (name + type match), missing fields (in standard but not entity), extra fields (in entity but not standard)
  - Return `StandardReview`: `{ matching: FieldComparison[], missing: StandardField[], extra: EntityField[], matchPercentage: number }`
  - RBAC: require Viewer role
- [ ] Implement `suggestFieldsFromStandard(entityName, existingFieldNames, ctx): Result<StandardField[]>`:
  - Find matching standard template for entity name (exact and fuzzy match)
  - Filter out fields that already exist on the entity
  - Return remaining standard fields as suggestions
  - Used by autocomplete enhancement
  - RBAC: require Viewer role

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/standards.ts` oRPC router
- [ ] Add `standards.list` query — thin wrapper calling `standardsService.getStandardTemplates()`, accepts `{ source?: string, query?: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `standards.get` query — thin wrapper calling `standardsService.getStandardTemplate()`, accepts `{ standardName: string, entityName: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `standards.review` query — thin wrapper calling `standardsService.reviewAgainstStandard()`, accepts `{ entityId: string, standardName: string, entityName: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `standards.suggestFields` query — thin wrapper calling `standardsService.suggestFieldsFromStandard()`, accepts `{ entityName: string, existingFieldNames: string[] }`, requires Viewer role via `protectedProcedure`
- [ ] Wire router into `appRouter`

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/standards.ts`:
  - `StandardFieldSchema` — z.object matching StandardField type
  - `StandardTemplateSchema` — z.object matching StandardTemplate type
  - `GetStandardsInput` — z.object({ source: z.enum(["schema.org", "financial", "healthcare-fhir"]).optional(), query: z.string().optional() })
  - `GetStandardInput` — z.object({ standardName: z.string(), entityName: z.string() })
  - `ReviewAgainstStandardInput` — z.object({ entityId: z.string().cuid(), standardName: z.string(), entityName: z.string() })
  - `SuggestFieldsInput` — z.object({ entityName: z.string(), existingFieldNames: z.array(z.string()) })
  - `StandardReviewSchema` — z.object for review result (matching, missing, extra, matchPercentage)

### Frontend (UI) — From Standard Option
- [ ] Create `src/components/custom/StandardsLibrary/StandardPicker.tsx`:
  - Searchable dropdown/combobox showing all standard templates
  - Grouped by source: "schema.org", "Financial", "Healthcare (FHIR)"
  - Each item shows: entity name, source badge, short description
  - Search filters across entity names and descriptions
  - On select: calls callback with selected `StandardTemplate`
- [ ] Create `src/components/custom/StandardsLibrary/StandardFieldBadge.tsx`:
  - Small badge: "From {standardName}" (e.g., "From schema.org")
  - Shown on fields populated from a standard template
  - Removed when the user edits the field (field is no longer "from standard")
- [ ] Create `src/components/custom/StandardsLibrary/StandardReviewPanel.tsx`:
  - Panel showing comparison of entity against a selected standard
  - Standard selector at the top (uses StandardPicker)
  - Three sections:
    - Matching fields (green): field name, type — shows entity fields that match the standard
    - Missing fields (amber): field name, type, "Add" button — standard fields not in the entity
    - Extra fields (neutral/gray): field name, type — entity fields not in the standard
  - Match percentage displayed prominently
  - "Add All Missing" button — adds all missing standard fields to the entity
- [ ] Create `src/components/custom/StandardsLibrary/index.ts`:
  - Re-exports for all StandardsLibrary components
- [ ] Modify entity creation flow to include "From Standard" option:
  - Add to new entity dialog alongside manual and AI Assist tabs
  - Selecting a standard pre-populates entity name, description, and all fields
  - Each pre-populated field gets a StandardFieldBadge
- [ ] Enhance autocomplete (Story 2.6 integration):
  - When adding a field, query `standards.suggestFields` with entity name and existing field names
  - Show "Suggested from {standard}" header in autocomplete dropdown above standard field suggestions
  - Standard suggestions shown below any AI suggestions but above generic autocomplete

### Frontend — Hooks
- [ ] Create `src/hooks/useStandards.ts`:
  - Hook wrapping oRPC queries for standards operations
  - Provides: `standards` (list query), `standardReview` (review query), `suggestedFields` (suggestion query), `isLoading`
  - Caches standard templates (they are static bundled data)

### Testing
- [ ] **Unit tests** (`tests/unit/lib/schema-standards.test.ts`):
  - All JSON standard files are valid and parse correctly
  - Each standard template has required fields: standardName, entityName, description, fields, source, version
  - Each field in every template has valid type (from supported type system)
  - `getAllStandards()` returns all templates from all sources
  - `getStandardsBySource()` filters correctly
  - `findStandardByName()` finds exact and case-insensitive matches
  - `searchStandards()` returns relevant results for partial queries
- [ ] **Unit tests** (`tests/unit/services/standards.service.test.ts`):
  - `reviewAgainstStandard` correctly identifies matching fields
  - `reviewAgainstStandard` correctly identifies missing fields
  - `reviewAgainstStandard` correctly identifies extra fields
  - `reviewAgainstStandard` calculates match percentage correctly
  - `suggestFieldsFromStandard` excludes fields that already exist
  - `suggestFieldsFromStandard` returns empty array when no standard matches
- [ ] **E2E test** (`tests/e2e/standards-library.spec.ts`):
  - Navigate to "New Entity" → select "From Standard"
  - Search for "Person" → select schema.org Person template
  - Verify fields are pre-populated with standard fields and badges
  - Edit a field name → verify badge is removed
  - Create entity → verify all fields are saved correctly
  - Open existing entity → click "Review Against Standard"
  - Select a standard → verify matching/missing/extra fields shown
  - Click "Add" on a missing field → verify field is added to entity

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/standards.service.ts` owns all standards comparison logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **Bundled data**: Standards are static JSON files bundled with the application. No runtime fetching, no external calls. Fully offline-compatible.
- **No database**: Standards library data lives in `src/lib/schema-standards/` as JSON files — no database tables needed. The standards are read-only reference data.
- **Fuzzy matching**: Entity name matching against standards uses case-insensitive comparison and simple substring matching for MVP. Levenshtein or more advanced fuzzy matching deferred.
- **Autocomplete integration**: Standards suggestions feed into the existing autocomplete system (Story 2.6) as an additional suggestion source, ranked below AI suggestions but above generic pattern-based suggestions.
- **RBAC**: All standards operations require Viewer role — standards are read-only reference data.
- **Extensibility path**: The architecture supports future custom standards via a configurable directory, but MVP only includes bundled standards.

### UX/Design Requirements
- "From Standard" option in entity creation uses a combobox/searchable dropdown — not a separate page
- Standard templates are grouped by source with clear visual separation
- StandardFieldBadge is subtle (small, muted color) — does not dominate the field row
- Badge is removed on edit — visual indicator that the field has diverged from the standard
- Review Against Standard panel appears in the Right Panel or as a slide-over — not a modal
- Matching/missing/extra sections use green/amber/gray color coding consistent with the app theme
- Match percentage is shown as a progress-bar-style indicator or percentage text
- "Add" button on missing fields is inline — one click to add a standard field

### File Structure
```
src/lib/schema-standards/types.ts                              # TypeScript types for standards
src/lib/schema-standards/schema-org.json                       # schema.org entity templates
src/lib/schema-standards/financial.json                        # Financial entity templates
src/lib/schema-standards/healthcare-fhir.json                  # HL7/FHIR entity templates
src/lib/schema-standards/index.ts                              # Standards library API
src/services/standards.service.ts                              # Standards comparison + suggestion logic
src/types/schemas/standards.ts                                 # Zod schemas — inputs and response types
src/server/api/routers/standards.ts                            # oRPC router (Viewer+ for all)
src/components/custom/StandardsLibrary/StandardPicker.tsx       # Searchable standard template selector
src/components/custom/StandardsLibrary/StandardFieldBadge.tsx   # "From {standard}" badge
src/components/custom/StandardsLibrary/StandardReviewPanel.tsx  # Review entity against standard
src/components/custom/StandardsLibrary/index.ts                 # Re-exports
src/hooks/useStandards.ts                                       # React hook for standards queries
```

### Testing Requirements
- **Unit tests** (`tests/unit/lib/schema-standards.test.ts`): JSON validation, lookup functions, search
- **Unit tests** (`tests/unit/services/standards.service.test.ts`): Review logic — matching, missing, extra field detection, match percentage
- **E2E test** (`tests/e2e/standards-library.spec.ts`): Create from standard, edit standard fields, review against standard

### Dependencies & Prerequisites
- Epic 2 (Entity Authoring) complete — entity creation flow and field autocomplete exist
- Story 2.6 (Autocomplete) complete — autocomplete infrastructure exists for enhancement
- Shadcn Combobox/Command, Badge, Alert components available
- No database changes required — standards are bundled JSON files

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, Standards Library
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Entity Creation Flow, Standards integration
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.2
- Story 2.6: Autocomplete infrastructure for field suggestions

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
