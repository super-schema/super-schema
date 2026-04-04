# Story 11.3: AI-Assisted Field Suggestions from Domain Context

Status: review

## Story
As a **data modeler**, I want the system to suggest fields, types, and decorators based on entity name and domain context, so that I get intelligent recommendations as I build out my schemas.

## Acceptance Criteria

**Given** entity authoring and the AI service exist (Stories 2.3, 11.1 complete)
**When** domain-context field suggestions are implemented
**Then** when a user creates a new entity and enters the **entity name**, the system generates field suggestions combining two sources:
**And** **Standard library match**: if the entity name matches or closely matches a standard template (e.g., "Customer" matches schema.org Person/Customer), suggest fields from that standard (no AI needed — rule-based)
**And** **AI-generated suggestions**: if AI is configured, the AI service generates field suggestions based on: entity name, domain context (other entities in the domain, common field patterns), and any description the user provided
**And** suggestions are displayed in a **suggestion panel** below the entity name input: "Suggested fields for '{entityName}':" with a list of suggested fields — each showing name, type, classification, and source (Standard/AI/Pattern)
**And** the user can **accept individual fields** (click "+" to add to entity), **accept all** (button at top), or **dismiss** (click X on the panel)
**And** accepted fields are added to the entity's field list with all suggested metadata pre-filled — the user can then edit as normal
**And** the suggestion panel appears **once** on entity creation (not on every visit) — a "Show Suggestions" button allows re-triggering
**And** suggestions are **ranked** by confidence: standard library matches first (highest confidence), then AI suggestions (medium confidence), then pattern-based suggestions (lower confidence)
**And** if AI is not configured, only standard library and pattern-based suggestions are shown — the feature works without AI, just with fewer suggestions
**And** the field autocomplete (Story 2.6) is enhanced: when adding a field to an entity that has pending suggestions, the autocomplete dropdown shows "Suggested" fields at the top (separated by a header) before standard autocomplete results
**And** unit tests verify: entity name matching against standards works (exact and fuzzy), AI suggestions are ranked by confidence, accepting a suggestion adds the field correctly, dismissing hides the panel, suggestions work without AI configured
**And** a Playwright E2E test verifies: creating entity "Customer" → suggestion panel shows fields from schema.org → accepting individual fields adds them → dismissing hides panel

## Tasks / Subtasks

### Backend — Field Suggestion Service
- [x] Create `src/services/field-suggestion.service.ts`
- [x] Implement `getFieldSuggestions(entityName, domainId, description?, ctx): Result<RankedFieldSuggestion[]>`:
  - Orchestrates all suggestion sources and merges results
  - Step 1: Query standards library — call `standardsService.suggestFieldsFromStandard(entityName, [])` to get standard field matches
  - Step 2: Query AI service (if configured) — call `aiService.generateFieldSuggestions(entityName, domainContext, description)` to get AI-generated suggestions
  - Step 3: Generate pattern-based suggestions — common fields based on entity name patterns (e.g., any entity gets id, createdAt, updatedAt; entities with "User" get email, name)
  - Merge and deduplicate: if same field name appears in multiple sources, keep highest-confidence version
  - Rank by confidence: standard library (0.9), AI suggestions (use AI confidence), pattern-based (0.5-0.7)
  - Tag each suggestion with source: "standard", "ai", "pattern"
  - Return sorted by confidence descending
  - RBAC: require Author role
- [x] Implement `generateFieldSuggestions(entityName, domainContext, description?, ctx): Result<FieldSuggestion[]>` in `src/services/ai.service.ts`:
  - Build prompt with: entity name, domain context (existing entities and their fields), optional description
  - Prompt requests field suggestions (not full entity) — name, type, classification, confidence
  - Parse and validate LLM response
  - Return field suggestions with AI-assigned confidence scores
- [x] Implement `getPatternBasedSuggestions(entityName): FieldSuggestion[]`:
  - Rule-based suggestions from common patterns:
    - Universal: `id` (string), `createdAt` (timestamp), `updatedAt` (timestamp)
    - Contains "User"/"Customer"/"Person": `email` (string, PII), `firstName` (string, PII), `lastName` (string, PII), `phone` (string, PII)
    - Contains "Order"/"Transaction": `amount` (decimal), `currency` (string), `status` (enum), `date` (timestamp)
    - Contains "Product"/"Item": `name` (string), `description` (string), `price` (decimal), `sku` (string)
    - Contains "Address": `street` (string, PII), `city` (string), `state` (string), `postalCode` (string, PII), `country` (string)
  - Confidence: 0.7 for strong pattern matches, 0.5 for weak matches
  - Source: "pattern"

### Backend — oRPC Router
- [ ] Add `ai.suggestFields` query to `src/server/api/routers/ai.ts` — thin wrapper calling `fieldSuggestionService.getFieldSuggestions()`, accepts `{ entityName: string, domainId: string, description?: string }`, requires Author role via `protectedProcedure`
- [ ] Wire into existing `ai` router

### Backend — Zod Schemas
- [x] Add to `src/types/schemas/ai.ts`:
  - `RankedFieldSuggestionSchema` — extends FieldSuggestionSchema with `source: z.enum(["standard", "ai", "pattern"])` and `rank: z.number()`
  - `SuggestFieldsInput` — z.object({ entityName: z.string().min(1), domainId: z.string().cuid(), description: z.string().optional() })

### Frontend (UI) — Suggestion Panel
- [ ] Create `src/components/custom/FieldSuggestions/SuggestionPanel.tsx`:
  - Panel displayed below entity name input on entity creation
  - Header: "Suggested fields for '{entityName}':" with "Accept All" button and dismiss "X" button
  - List of suggested fields, each row showing:
    - Field name
    - Type badge
    - Classification badge (if present)
    - Source badge: "Standard" (blue), "AI" (purple), "Pattern" (gray)
    - Confidence indicator (small dot or bar: green/amber/red)
    - "+" button to accept individual field
  - Grouped by source with section headers: "From Standards", "AI Suggestions", "Common Patterns"
  - Accepted fields are visually removed from the suggestion list (or marked with checkmark)
  - "Show Suggestions" button — visible after panel is dismissed, allows re-triggering
  - Panel state: shown once on entity name entry, hidden after dismiss, re-showable
- [ ] Create `src/components/custom/FieldSuggestions/SuggestionSourceBadge.tsx`:
  - Color-coded badge for suggestion source
  - "Standard" — blue
  - "AI" — purple
  - "Pattern" — gray
  - Compact, fits inline with field name
- [ ] Create `src/components/custom/FieldSuggestions/index.ts`:
  - Re-exports for SuggestionPanel and SuggestionSourceBadge
- [ ] Enhance entity creation form:
  - On entity name blur/debounce (500ms), trigger `ai.suggestFields` query
  - Show SuggestionPanel with results
  - "Accept" action adds field to entity field list with pre-filled metadata
  - "Accept All" adds all remaining suggestions
  - Dismiss hides panel, sets flag in local state
- [ ] Enhance field autocomplete (Story 2.6 integration):
  - When adding a field to an entity with pending suggestions, inject "Suggested" section at top of autocomplete dropdown
  - Section header: "Suggested Fields"
  - Suggested fields shown with source badge
  - Selecting a suggested field from autocomplete also removes it from the suggestion panel

### Frontend — Hooks
- [ ] Create `src/hooks/useFieldSuggestions.ts`:
  - Hook wrapping oRPC query for field suggestions
  - Provides: `suggestions` (query result), `acceptField(fieldName)`, `acceptAll()`, `dismiss()`, `showSuggestions()`, `isLoading`, `isDismissed`
  - Local state management: tracks accepted fields, dismissed state
  - Debounced trigger on entity name change (500ms)

### Testing
- [x] **Unit tests** (`tests/unit/services/field-suggestion.service.test.ts`):
  - Standard library match: "Customer" entity returns schema.org Person/Customer fields
  - Standard library match: case-insensitive matching works
  - Standard library match: fuzzy matching (e.g., "Customers" matches "Customer")
  - AI suggestions are included when AI is configured
  - AI suggestions are excluded when AI is not configured (graceful degradation)
  - Pattern-based suggestions: "User" entity gets email, firstName, lastName
  - Pattern-based suggestions: "Order" entity gets amount, currency, status
  - Deduplication: same field from multiple sources keeps highest-confidence version
  - Ranking: standard suggestions ranked above AI, AI above pattern
  - All suggestions have valid types from supported type system
- [x] **Unit tests** (`tests/unit/services/ai.service.test.ts` — additions):
  - `generateFieldSuggestions` builds correct prompt with entity name and domain context
  - `generateFieldSuggestions` parses field-level suggestions correctly
  - `generateFieldSuggestions` handles empty/malformed responses
- [x] **Unit tests** (`tests/unit/services/field-suggestion.service.test.ts` — pattern tests):
  - `getPatternBasedSuggestions` returns universal fields for any entity name
  - `getPatternBasedSuggestions` returns person-related fields for "User", "Customer", "Person"
  - `getPatternBasedSuggestions` returns financial fields for "Order", "Transaction"
  - `getPatternBasedSuggestions` returns product fields for "Product", "Item"
- [ ] **E2E test** (`tests/e2e/field-suggestions.spec.ts`):
  - Navigate to "New Entity" → enter entity name "Customer"
  - Verify suggestion panel appears with fields from schema.org
  - Accept individual field → verify it appears in entity field list
  - Accept all → verify remaining fields are added
  - Dismiss panel → verify it hides
  - Click "Show Suggestions" → verify panel reappears
  - Create entity "Order" → verify financial pattern suggestions appear
  - Test without AI configured → verify only standard and pattern suggestions shown

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/field-suggestion.service.ts` orchestrates all suggestion sources. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **Multi-source orchestration**: The field suggestion service combines three independent sources — standards library (rule-based), AI service (LLM-based), and pattern matching (heuristic-based). Each source is queried independently and results are merged.
- **Zero external calls**: AI suggestions use the same local LLM backend from Story 11.1. Standards and pattern suggestions are fully local. No external calls at runtime.
- **Graceful degradation**: When AI is not configured, the service returns only standard library and pattern-based suggestions. The feature works with reduced capability, not broken.
- **Deduplication strategy**: When the same field name appears from multiple sources, the highest-confidence version is kept. Source is preserved for UI display.
- **Ranking**: Standard library fields (confidence 0.9) > AI suggestions (variable confidence from LLM) > Pattern-based (0.5-0.7). This ensures well-established standards are prioritized.
- **Debounced trigger**: Suggestions are generated on entity name change with 500ms debounce to avoid excessive API calls during typing.
- **One-shot panel**: The suggestion panel shows once on entity creation (triggered by entity name entry). It can be dismissed and re-shown, but does not appear on subsequent visits to the entity.
- **RBAC**: Author role required for field suggestions (used during entity creation/editing).

### UX/Design Requirements
- Suggestion panel is non-intrusive — appears below entity name input, can be dismissed with one click
- Panel does not block entity creation workflow — user can ignore it entirely
- Accepted fields smoothly animate into the entity field list
- Source badges are compact and color-coded for quick visual scanning
- Confidence indicators are subtle (small dots) — not prominent enough to distract
- "Accept All" is prominent but not the default action — encourages review
- Autocomplete integration is seamless — suggested fields appear at the top with a section header
- Loading state: skeleton rows while suggestions are being fetched

### File Structure
```
src/services/field-suggestion.service.ts                        # Multi-source suggestion orchestration
src/services/ai.service.ts                                      # Modified — add generateFieldSuggestions
src/types/schemas/ai.ts                                         # Modified — add RankedFieldSuggestion, SuggestFieldsInput
src/server/api/routers/ai.ts                                    # Modified — add suggestFields query
src/components/custom/FieldSuggestions/SuggestionPanel.tsx       # Suggestion panel UI
src/components/custom/FieldSuggestions/SuggestionSourceBadge.tsx # Source indicator badge
src/components/custom/FieldSuggestions/index.ts                  # Re-exports
src/hooks/useFieldSuggestions.ts                                 # React hook for suggestions + state
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/field-suggestion.service.test.ts`): Multi-source orchestration, deduplication, ranking, pattern matching, graceful degradation
- **Unit tests** (`tests/unit/services/ai.service.test.ts`): Field-level suggestion prompt and parsing (additions to Story 11.1 tests)
- **E2E test** (`tests/e2e/field-suggestions.spec.ts`): Suggestion panel workflow — appear, accept, dismiss, re-show, autocomplete integration

### Dependencies & Prerequisites
- Story 11.1 (Natural Language Entity Creation) complete — AI service with LLM client abstraction exists
- Story 11.2 (Schema Standard Reference Library) complete — standards library and suggestFieldsFromStandard function exist
- Story 2.6 (Autocomplete) complete — autocomplete infrastructure exists for enhancement
- Epic 2 (Entity Authoring) complete — entity creation flow exists
- Shadcn Badge, Card, Button, Command components available

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, AI Service Architecture
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Entity Creation Flow, Field Suggestions
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.3
- Story 11.1: `_bmad-output/implementation-artifacts/11-1-natural-language-entity-creation.md` — AI service foundation
- Story 11.2: `_bmad-output/implementation-artifacts/11-2-schema-standard-reference-library.md` — Standards library

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
