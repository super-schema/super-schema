# Story 11.1: Natural Language Entity Creation

Status: ready-for-dev

## Story
As a **data modeler**, I want to create entity schemas by describing them in natural language, so that I can quickly scaffold schemas without manually adding each field.

## Acceptance Criteria

**Given** entity authoring works (Epic 2 complete)
**When** natural language entity creation is implemented
**Then** the "New Entity" creation flow includes an **"AI Assist"** toggle/tab — switching to it shows a textarea with placeholder: "Describe your entity... e.g., 'A customer entity for a fintech with PII financial fields, account information, and contact details'"
**And** an **AI service** (`src/services/ai.service.ts`) exports: `generateEntityFromDescription(description, domainContext, ctx): Result<EntitySuggestion>` where `EntitySuggestion = { entityName, description, fields: FieldSuggestion[] }` and `FieldSuggestion = { name, type, classification, description, confidence }`
**And** the AI service integrates with a **configurable LLM backend** — the architecture supports: local/self-hosted LLM (Ollama, vLLM) via `AI_PROVIDER` and `AI_BASE_URL` environment variables, with a fallback to disabled if not configured
**And** the LLM prompt includes: the user's description, the domain context (domain name, existing entities in domain for consistency), the available type system (string, integer, decimal, boolean, enum, array, map, reference, date, timestamp), and the classification options (PII, SENSITIVE, INTERNAL, PUBLIC)
**And** the generated suggestion is displayed in a **review interface** (same as the import review screen from Story 9.1): proposed entity name, description, and a field list where each field shows: name, suggested type, suggested classification, confidence indicator, and is fully editable
**And** the user can **accept all**, **accept individual fields**, **edit any field**, **add more fields**, or **remove unwanted fields** before confirming creation
**And** clicking "Create Entity" creates the entity with all accepted/edited fields — standard entity creation flow from that point
**And** if the AI backend is not configured (`AI_PROVIDER` not set), the "AI Assist" tab shows: "AI assistance is not configured. Contact your administrator to set up a local LLM." — the feature degrades gracefully
**And** the AI service does NOT send any schema data to external services — all communication is with the configured local/self-hosted LLM endpoint (FR: zero external calls at runtime)
**And** unit tests verify: AI service constructs correct prompt, suggestion parsing handles well-formed and malformed LLM responses, graceful degradation when AI is not configured, field confidence scoring works
**And** a Playwright E2E test (with mocked AI backend): entering a description → AI generates suggestions → review screen shows fields → editing and confirming creates the entity correctly

## Tasks / Subtasks

### Backend — AI Service
- [ ] Create `src/services/ai.service.ts`
- [ ] Implement AI client abstraction with configurable backend:
  - Read `AI_PROVIDER` env var (e.g., "ollama", "vllm") and `AI_BASE_URL` env var (e.g., "http://localhost:11434")
  - Create `AiClient` interface: `{ complete(prompt: string, options?: AiOptions): Promise<Result<string>> }`
  - Implement `OllamaClient` — HTTP POST to `{AI_BASE_URL}/api/generate` with model from `AI_MODEL` env var
  - Implement `VllmClient` — HTTP POST to `{AI_BASE_URL}/v1/completions` with OpenAI-compatible API
  - Factory function `createAiClient(): AiClient | null` — returns null if `AI_PROVIDER` is not set
- [ ] Implement `isAiConfigured(): boolean` — checks if `AI_PROVIDER` and `AI_BASE_URL` are set
- [ ] Implement `generateEntityFromDescription(description, domainContext, ctx): Result<EntitySuggestion>`:
  - Build LLM prompt with: user description, domain context (domain name, existing entity names), available type system, classification options
  - Prompt format: structured system prompt requesting JSON output matching `EntitySuggestion` schema
  - Call AI client with prompt
  - Parse LLM response as JSON — handle malformed responses gracefully (return error Result)
  - Validate parsed response against `EntitySuggestionSchema` (Zod)
  - Assign confidence scores to each field based on LLM output
  - Return `Result<EntitySuggestion>`
- [ ] Implement prompt builder `buildEntityPrompt(description, domainContext): string`:
  - System prompt: "You are a data modeling assistant. Generate entity schemas in JSON format."
  - Include type system reference: string, integer, decimal, boolean, enum, array, map, reference, date, timestamp
  - Include classification options: PII, SENSITIVE, INTERNAL, PUBLIC
  - Include domain context: domain name, list of existing entity names for naming consistency
  - Include user description
  - Request structured JSON output with entity name, description, and fields array
- [ ] Implement response parser `parseEntitySuggestion(raw: string): Result<EntitySuggestion>`:
  - Extract JSON from LLM response (handle markdown code blocks, leading/trailing text)
  - Parse JSON
  - Validate against Zod schema
  - Normalize field types to supported type system
  - Clamp confidence scores to 0.0-1.0 range
  - Return parsed suggestion or descriptive error

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/ai.ts` oRPC router
- [ ] Add `ai.generateEntity` mutation — thin wrapper calling `aiService.generateEntityFromDescription()`, accepts `{ description: string, domainId: string }`, requires Author role via `protectedProcedure`
- [ ] Add `ai.checkStatus` query — thin wrapper calling `aiService.isAiConfigured()`, returns `{ configured: boolean, provider?: string }`, requires Viewer role via `protectedProcedure`
- [ ] Wire router into `appRouter`

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/ai.ts`:
  - `FieldSuggestionSchema` — z.object({ name: z.string(), type: z.string(), classification: z.enum(["PII", "SENSITIVE", "INTERNAL", "PUBLIC"]).optional(), description: z.string().optional(), confidence: z.number().min(0).max(1) })
  - `EntitySuggestionSchema` — z.object({ entityName: z.string(), description: z.string().optional(), fields: z.array(FieldSuggestionSchema) })
  - `GenerateEntityInput` — z.object({ description: z.string().min(10).max(2000), domainId: z.string().cuid() })
  - `AiStatusResponse` — z.object({ configured: z.boolean(), provider: z.string().optional() })

### Frontend (UI) — AI Assist Tab
- [ ] Create `src/components/custom/AiAssist/AiEntityGenerator.tsx`:
  - Textarea input for natural language description
  - Placeholder text: "Describe your entity... e.g., 'A customer entity for a fintech with PII financial fields, account information, and contact details'"
  - "Generate" button — calls `ai.generateEntity` mutation
  - Loading state with spinner: "Generating entity schema..."
  - Error state for AI failures with retry button
- [ ] Create `src/components/custom/AiAssist/AiSuggestionReview.tsx`:
  - Review interface matching import review screen pattern (Story 9.1)
  - Displays: proposed entity name (editable), description (editable), field list
  - Each field row: name (editable), type dropdown, classification dropdown, confidence badge, description
  - Confidence badge: green (> 0.8), amber (0.5-0.8), red (< 0.5)
  - "Accept All" button — accepts all fields
  - Per-field "Accept" / "Remove" buttons
  - "Add Field" button — adds an empty field row for manual entry
  - "Create Entity" button — creates entity with accepted/edited fields
- [ ] Create `src/components/custom/AiAssist/AiNotConfigured.tsx`:
  - Informational panel: "AI assistance is not configured. Contact your administrator to set up a local LLM."
  - Shown when `ai.checkStatus` returns `configured: false`
- [ ] Create `src/components/custom/AiAssist/ConfidenceBadge.tsx`:
  - Compact badge showing confidence level
  - Color-coded: green (> 0.8), amber (0.5-0.8), red (< 0.5)
  - Tooltip with exact confidence value
- [ ] Create `src/components/custom/AiAssist/index.ts`:
  - Re-exports for all AI Assist components
- [ ] Modify entity creation flow to include "AI Assist" toggle/tab:
  - Add tab to new entity dialog/page alongside manual creation
  - Tab conditionally shown (always visible, but content varies based on AI configuration)

### Frontend — Hooks
- [ ] Create `src/hooks/useAiAssist.ts`:
  - Hook wrapping oRPC queries/mutations for AI operations
  - Provides: `generateEntity` (mutation), `aiStatus` (query), `isGenerating` (loading state), `suggestion` (current suggestion state)
  - Local state management for editing suggestions before creation

### Testing
- [ ] **Unit tests** (`tests/unit/services/ai.service.test.ts`):
  - `buildEntityPrompt` includes description, domain context, type system, and classification options
  - `parseEntitySuggestion` handles well-formed JSON response
  - `parseEntitySuggestion` handles malformed JSON (returns error Result)
  - `parseEntitySuggestion` handles LLM response wrapped in markdown code blocks
  - `parseEntitySuggestion` normalizes unknown types to "string" fallback
  - `parseEntitySuggestion` clamps confidence scores to 0.0-1.0
  - `generateEntityFromDescription` returns error Result when AI is not configured
  - `isAiConfigured` returns false when env vars are not set
  - `isAiConfigured` returns true when AI_PROVIDER and AI_BASE_URL are set
  - AI client factory returns correct client type based on AI_PROVIDER
- [ ] **Integration test** (`tests/integration/ai-entity-generation.test.ts`):
  - Mock LLM endpoint returns valid JSON
  - `generateEntityFromDescription` with mocked backend produces valid EntitySuggestion
  - Domain context is correctly included in prompt
  - Malformed LLM response returns descriptive error
- [ ] **E2E test** (`tests/e2e/ai-entity-creation.spec.ts`):
  - Mock AI backend via route intercept
  - Navigate to "New Entity" → switch to "AI Assist" tab
  - Enter description → click "Generate"
  - Verify suggestion review screen shows generated fields
  - Edit a field name and type
  - Remove a field
  - Click "Create Entity" → verify entity is created with correct fields
  - Test AI not configured state — verify informational message shown

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/ai.service.ts` owns all AI interaction logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **Zero external calls**: The AI service communicates ONLY with a configured local/self-hosted LLM (Ollama or vLLM). No data is sent to external cloud AI services. This is a hard architectural constraint.
- **Configurable backend**: AI provider is configured via environment variables (`AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`). The service gracefully degrades when not configured — the feature is disabled, not broken.
- **Client abstraction**: The `AiClient` interface allows swapping LLM backends without changing business logic. Ollama and vLLM are supported initially.
- **Prompt engineering**: Prompts are structured with a system prompt + user description. The system prompt includes the full type system and classification taxonomy to constrain LLM output. JSON output is requested explicitly.
- **Response parsing**: LLM responses are parsed defensively — handling markdown code blocks, leading/trailing text, malformed JSON. Zod validation ensures type safety.
- **RBAC**: Author role required for entity generation (creates entities). Viewer role sufficient for checking AI status.
- **Reuses import review pattern**: The suggestion review UI mirrors the import review screen from Story 9.1 — consistent UX for field-level review and editing.

### UX/Design Requirements
- "AI Assist" tab in the new entity creation flow — sits alongside the manual creation tab
- Textarea is large enough for multi-sentence descriptions (min 3 rows, resizable)
- Generation loading state uses a spinner with descriptive text — avoid progress bars (LLM response time is unpredictable)
- Confidence badges use the same color scheme as the import review screen (green/amber/red)
- "Not Configured" state is informational, not an error — uses an info panel (Shadcn Alert with info variant)
- Field editing in review mode uses inline editing (click to edit) — not a separate form

### File Structure
```
src/services/ai.service.ts                                    # AI client abstraction + entity generation logic
src/types/schemas/ai.ts                                       # Zod schemas — EntitySuggestion, FieldSuggestion, inputs
src/server/api/routers/ai.ts                                  # oRPC router (Author+ for generate, Viewer+ for status)
src/components/custom/AiAssist/AiEntityGenerator.tsx           # Description input + generate button
src/components/custom/AiAssist/AiSuggestionReview.tsx          # Review interface for generated fields
src/components/custom/AiAssist/AiNotConfigured.tsx             # Info panel when AI is not configured
src/components/custom/AiAssist/ConfidenceBadge.tsx             # Color-coded confidence indicator
src/components/custom/AiAssist/index.ts                        # Re-exports
src/hooks/useAiAssist.ts                                       # React hook for AI generation + status
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/ai.service.test.ts`): Prompt construction, response parsing (well-formed, malformed, code blocks), graceful degradation, confidence scoring, client factory
- **Integration test** (`tests/integration/ai-entity-generation.test.ts`): Full flow with mocked LLM endpoint — generate, parse, validate
- **E2E test** (`tests/e2e/ai-entity-creation.spec.ts`): UI flow with mocked AI backend — description input, generation, review, edit, create entity

### Dependencies & Prerequisites
- Epic 2 (Entity Authoring) complete — entity creation flow exists
- Story 9.1 (Schema Import) complete — import review screen pattern exists for reuse
- Environment variables: `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL` must be documented in `.env.example`
- Local LLM backend (Ollama or vLLM) must be running for development/testing — not required for CI (mock)
- Shadcn Textarea, Alert, Badge, Dialog components available

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, AI Service Architecture
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Entity Creation Flow, AI Assist tab
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.1
- Story 9.1: `_bmad-output/implementation-artifacts/9-1-schema-import-bulk-import.md` — Import review screen pattern

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
