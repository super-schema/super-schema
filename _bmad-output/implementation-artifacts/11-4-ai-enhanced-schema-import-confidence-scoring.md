# Story 11.4: AI-Enhanced Schema Import with Confidence Scoring

Status: ready-for-dev

## Story
As a **data engineer**, I want AI-assisted field matching during schema import with confidence scores, so that ambiguous type mappings and field matches are resolved intelligently rather than manually.

## Acceptance Criteria

**Given** the schema import service (Story 9.1) and AI service (Story 11.1) exist
**When** AI-enhanced import is implemented
**Then** the import service's `importSchema()` function is enhanced: when the AI service is configured, after the deterministic parser extracts fields, the AI service is called to improve field matching and type resolution
**And** the AI service provides: improved type suggestions for ambiguous mappings (e.g., a BigQuery STRING column named "amount" → AI suggests `decimal` instead of `string`), confidence scores (0.0-1.0) for each field's type mapping, and suggested classifications based on field names and context
**And** the import review screen displays AI-enhanced confidence indicators: high confidence (> 0.8, green), medium confidence (0.5-0.8, amber), low confidence (< 0.5, red with "Review recommended" badge)
**And** for bulk import, the AI service processes each file and provides per-entity mapping suggestions with an overall quality score
**And** the AI service prompt includes: the source schema content, the target logical type system, existing entities in the target domain for naming consistency, and the classification taxonomy
**And** if the AI service is not configured, the import falls back to deterministic parsing with rule-based confidence scores (same as Story 9.1 baseline behavior) — no degradation
**And** unit tests verify: AI-enhanced import produces higher confidence scores than deterministic-only for ambiguous types, AI suggestions are correctly merged with parser output, graceful fallback when AI is not configured
**And** a Playwright E2E test (with mocked AI backend): importing an ambiguous schema → AI-enhanced confidence scores are displayed → AI type suggestions differ from deterministic defaults → accepting AI suggestions creates correct fields

## Tasks / Subtasks

### Backend — AI Import Enhancement Service
- [ ] Create `src/services/ai-import.service.ts`
- [ ] Implement `enhanceImportWithAi(parsedFields, sourceContent, domainContext, ctx): Result<EnhancedImportResult>`:
  - Input: `parsedFields` (from deterministic parser — Story 9.1), `sourceContent` (raw schema text), `domainContext` (existing entities in target domain)
  - Build LLM prompt with: source schema content, parsed fields with deterministic type mappings, target type system, classification taxonomy, domain context
  - Call AI service to analyze and enhance the field mappings
  - Parse AI response: improved type suggestions, confidence scores, classification suggestions
  - Merge AI suggestions with parser output: for each field, compare AI suggestion with deterministic mapping and assign final confidence
  - Return `EnhancedImportResult`: `{ fields: EnhancedFieldMapping[], overallQualityScore: number }`
  - `EnhancedFieldMapping`: `{ name, deterministicType, aiSuggestedType, finalType, confidence, classification, aiReasoning?, source: "deterministic" | "ai-enhanced" }`
- [ ] Implement `buildImportPrompt(sourceContent, parsedFields, domainContext): string`:
  - System prompt: "You are a schema analysis assistant. Analyze the source schema and suggest optimal type mappings for the target type system."
  - Include source schema content
  - Include deterministic parser results (field names + initial type mappings)
  - Include target type system reference
  - Include classification taxonomy (PII, SENSITIVE, INTERNAL, PUBLIC)
  - Include domain context: existing entity names and their field patterns
  - Request structured JSON output: per-field analysis with suggested type, confidence, classification, and reasoning
- [ ] Implement `mergeAiWithDeterministic(parsedFields, aiSuggestions): EnhancedFieldMapping[]`:
  - For each parsed field, find matching AI suggestion by field name
  - If AI agrees with deterministic type: confidence = max(deterministic confidence, AI confidence)
  - If AI disagrees with deterministic type: use AI type, confidence = AI confidence, mark source as "ai-enhanced"
  - If no AI suggestion for a field: keep deterministic mapping, confidence = deterministic confidence
  - Fields where AI disagrees are flagged for user review
- [ ] Implement `calculateOverallQualityScore(fields: EnhancedFieldMapping[]): number`:
  - Weighted average of all field confidence scores
  - Weight: high confidence fields (> 0.8) weight 1.0, medium (0.5-0.8) weight 0.7, low (< 0.5) weight 0.3
  - Returns 0.0-1.0 score for the overall import quality

### Backend — Import Service Enhancement
- [ ] Modify `src/services/import.service.ts` (from Story 9.1):
  - After deterministic parsing, check if AI service is configured (`aiService.isAiConfigured()`)
  - If configured: call `aiImportService.enhanceImportWithAi()` with parsed fields and source content
  - If not configured: assign rule-based confidence scores (existing Story 9.1 behavior)
  - Return enhanced field mappings with confidence scores in import result
  - Ensure the existing deterministic import path is not broken — AI enhancement is additive
- [ ] Add `withAiEnhancement` flag to import options — allows users to explicitly skip AI enhancement even when configured

### Backend — oRPC Router
- [ ] Add `import.enhanceWithAi` mutation to `src/server/api/routers/import.ts` — thin wrapper calling `aiImportService.enhanceImportWithAi()`, accepts `{ parsedFields: ParsedField[], sourceContent: string, domainId: string }`, requires Author role via `protectedProcedure`
- [ ] Modify existing `import.importSchema` mutation to include AI enhancement when available — add `withAiEnhancement?: boolean` to input schema (defaults to true)

### Backend — Zod Schemas
- [ ] Add to `src/types/schemas/import.ts` (or create `src/types/schemas/ai-import.ts`):
  - `EnhancedFieldMappingSchema` — z.object({ name: z.string(), deterministicType: z.string(), aiSuggestedType: z.string().optional(), finalType: z.string(), confidence: z.number().min(0).max(1), classification: z.enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"]).optional(), aiReasoning: z.string().optional(), source: z.enum(["deterministic", "ai-enhanced"]) })
  - `EnhancedImportResultSchema` — z.object({ fields: z.array(EnhancedFieldMappingSchema), overallQualityScore: z.number().min(0).max(1) })
  - `EnhanceImportInput` — z.object({ parsedFields: z.array(ParsedFieldSchema), sourceContent: z.string(), domainId: z.string().cuid() })
  - `ImportOptionsSchema` — extend existing with `withAiEnhancement: z.boolean().default(true)`

### Frontend (UI) — Enhanced Import Review
- [ ] Modify `src/components/custom/ImportReview/ImportReviewTable.tsx` (from Story 9.1):
  - Add confidence column showing AI-enhanced confidence indicators per field
  - Confidence badge: green (> 0.8), amber (0.5-0.8), red (< 0.5 with "Review recommended" text)
  - When AI suggests a different type than deterministic parser:
    - Show both types: deterministic (strikethrough) and AI suggestion (highlighted)
    - Tooltip with AI reasoning (if available)
    - User can toggle between deterministic and AI suggestion per field
  - Fields marked "ai-enhanced" get a small AI indicator icon
- [ ] Create `src/components/custom/ImportReview/ConfidenceIndicator.tsx`:
  - Visual confidence indicator — combines badge + bar
  - Green fill for high confidence, amber for medium, red for low
  - Tooltip shows exact confidence value (e.g., "0.87")
  - "Review recommended" text label for low confidence fields
- [ ] Create `src/components/custom/ImportReview/AiTypeToggle.tsx`:
  - Toggle component for fields where AI disagrees with deterministic parser
  - Shows: deterministic type (left, muted) / AI suggested type (right, highlighted)
  - Click to switch between the two
  - Tooltip shows AI reasoning for the suggestion
- [ ] Modify `src/components/custom/ImportReview/ImportSummary.tsx` (from Story 9.1):
  - Add overall quality score display
  - Show count of fields by confidence level: "X high confidence, Y medium, Z need review"
  - If AI is configured: "AI-Enhanced Import" badge
  - If AI is not configured: "Standard Import" badge
- [ ] Add AI toggle to import flow:
  - Checkbox/toggle: "Enhance with AI" (default: on if AI configured)
  - When toggled off, import uses deterministic-only parsing
  - When toggled on and AI not configured: disabled with tooltip "AI is not configured"

### Frontend — Hooks
- [ ] Modify `src/hooks/useImport.ts` (from Story 9.1):
  - Add `withAiEnhancement` option to import mutation
  - Track AI enhancement status: `isAiEnhancing`, `aiConfigured`
  - Handle AI enhancement failure gracefully — fall back to deterministic results
- [ ] Create `src/hooks/useAiImport.ts`:
  - Hook for AI-specific import enhancement
  - Provides: `enhanceImport` (mutation), `isEnhancing` (loading state), `aiResult` (enhanced field mappings)
  - Supports per-field type toggle (track user overrides of AI suggestions)

### Testing
- [ ] **Unit tests** (`tests/unit/services/ai-import.service.test.ts`):
  - `buildImportPrompt` includes source content, parsed fields, type system, and domain context
  - `mergeAiWithDeterministic` — AI agrees with parser: confidence increases
  - `mergeAiWithDeterministic` — AI disagrees with parser: AI type used, source marked "ai-enhanced"
  - `mergeAiWithDeterministic` — no AI suggestion for field: deterministic mapping preserved
  - `calculateOverallQualityScore` — all high confidence fields produce high score
  - `calculateOverallQualityScore` — mixed confidence fields produce medium score
  - `enhanceImportWithAi` — handles malformed AI response gracefully (returns deterministic fallback)
  - `enhanceImportWithAi` — AI suggests `decimal` for STRING field named "amount"
  - `enhanceImportWithAi` — AI suggests PII classification for field named "email"
  - AI-enhanced import produces higher confidence for ambiguous types than deterministic-only
- [ ] **Unit tests** (`tests/unit/services/import.service.test.ts` — additions):
  - Import with AI configured calls AI enhancement service
  - Import with AI not configured uses deterministic-only (no degradation)
  - Import with `withAiEnhancement: false` skips AI even when configured
  - AI enhancement failure falls back to deterministic results (error handling)
- [ ] **Integration test** (`tests/integration/ai-import.test.ts`):
  - Mock LLM endpoint with realistic schema analysis response
  - Import a BigQuery schema with ambiguous types (STRING columns named "amount", "email", "created_at")
  - Verify AI suggests: decimal for "amount", string+PII for "email", timestamp for "created_at"
  - Verify confidence scores are assigned and reasonable
  - Verify overall quality score is calculated
  - Verify deterministic fallback works when AI fails
- [ ] **E2E test** (`tests/e2e/ai-import.spec.ts`):
  - Mock AI backend via route intercept
  - Navigate to Import → upload a schema file with ambiguous types
  - Verify import review shows AI-enhanced confidence indicators
  - Verify fields where AI disagrees show both types with toggle
  - Toggle a field to use AI suggestion → verify type updates
  - Verify overall quality score is displayed
  - Toggle "Enhance with AI" off → verify deterministic-only results shown
  - Accept import → verify entity is created with correct field types

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/ai-import.service.ts` owns AI-enhanced import logic. Extends the existing import service from Story 9.1. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **Additive enhancement**: AI import enhancement is layered on top of the deterministic parser from Story 9.1. The deterministic parser runs first, then AI enhances the results. If AI fails, deterministic results are returned unchanged.
- **Zero external calls**: Uses the same local LLM backend from Story 11.1 (Ollama/vLLM). No schema data sent to external services.
- **Merge strategy**: AI suggestions are merged with deterministic parser output. When AI agrees, confidence increases. When AI disagrees, the AI suggestion is presented as an alternative that the user can accept or reject.
- **withAudit()**: Import operations that create entities are already audited (Story 9.1). AI enhancement metadata (confidence scores, AI vs deterministic source) is included in the audit log.
- **Fallback guarantee**: The import path never breaks due to AI. If AI is not configured, not available, or returns an error, the deterministic import works exactly as in Story 9.1.
- **RBAC**: Author role required for import operations (consistent with Story 9.1).
- **Bulk import**: For bulk import, AI enhancement runs per-file. Each file gets its own AI analysis and quality score. The bulk import summary shows per-entity quality scores.

### UX/Design Requirements
- Confidence indicators are prominent but not overwhelming — color-coded badges consistent with the app theme
- Fields where AI disagrees with the parser are visually highlighted — the user's attention is drawn to these fields
- AI type toggle is intuitive — click to switch between deterministic and AI suggestion, with clear visual distinction
- "Review recommended" label on low-confidence fields guides users to review ambiguous mappings
- Overall quality score gives a quick at-a-glance assessment of import quality
- "Enhance with AI" toggle is clearly labeled and defaults to on (when AI configured)
- AI reasoning tooltips provide transparency — users can understand why AI suggested a different type

### File Structure
```
src/services/ai-import.service.ts                              # AI import enhancement logic
src/services/import.service.ts                                 # Modified — integrate AI enhancement
src/services/ai.service.ts                                     # Used — LLM client from Story 11.1
src/types/schemas/ai-import.ts                                 # Zod schemas — EnhancedFieldMapping, inputs
src/server/api/routers/import.ts                               # Modified — add AI enhancement mutation, update import
src/components/custom/ImportReview/ImportReviewTable.tsx        # Modified — confidence column, AI indicators
src/components/custom/ImportReview/ConfidenceIndicator.tsx      # Confidence badge + bar
src/components/custom/ImportReview/AiTypeToggle.tsx             # Toggle between deterministic and AI type
src/components/custom/ImportReview/ImportSummary.tsx            # Modified — quality score, AI badge
src/hooks/useImport.ts                                         # Modified — AI enhancement option
src/hooks/useAiImport.ts                                       # AI-specific import hook
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/ai-import.service.test.ts`): Prompt construction, merge strategy (agree/disagree/missing), quality score calculation, error handling, ambiguous type resolution
- **Unit tests** (`tests/unit/services/import.service.test.ts`): AI integration flag, fallback behavior, withAiEnhancement option
- **Integration test** (`tests/integration/ai-import.test.ts`): Full flow with mocked LLM — import ambiguous schema, verify AI-enhanced mappings
- **E2E test** (`tests/e2e/ai-import.spec.ts`): UI flow with mocked AI — import, review confidence indicators, toggle AI types, accept import

### Dependencies & Prerequisites
- Story 9.1 (Schema Import) complete — import service, parsers, and import review UI exist
- Story 11.1 (Natural Language Entity Creation) complete — AI service with LLM client abstraction exists
- Import review screen components exist from Story 9.1 for modification
- Environment variables: `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL` configured (from Story 11.1)
- Shadcn Badge, Tooltip, Toggle components available

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, AI Service Architecture, Import Pipeline
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Import Review Screen, Confidence Indicators
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.4
- Story 9.1: `_bmad-output/implementation-artifacts/9-1-schema-import-bulk-import.md` — Import service and review UI
- Story 11.1: `_bmad-output/implementation-artifacts/11-1-natural-language-entity-creation.md` — AI service foundation

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
