# Story 3.6: Emission Pipeline, Preview Panel & Live Updates

Status: ready-for-dev

## Story
As a **data modeler**,
I want to see emitted output for all targets side-by-side with live updates as I edit,
So that I can immediately verify how my logical schema translates to each platform.

## Acceptance Criteria

**Given** all three emitters work (Stories 3.3-3.5 complete)
**When** the emission pipeline and preview panel are implemented
**Then** a Prisma migration creates the `entity_versions` table: `id` (cuid), `entityId` (FK to entities), `versionNumber` (int), `snapshot` (JSONB — complete entity + fields + decorators frozen at this version), `changeRecord` (JSONB, nullable), `migrationArtifacts` (JSONB, nullable), `createdBy` (FK to users), `createdAt`
**And** a Prisma migration creates the `emission_targets` table: `id` (cuid), `entityId` (FK to entities), `targetType` (string — bigquery/avro/openapi), `emittedOutput` (text — the generated schema), `validationStatus` (enum: VALID/INVALID/WARNING), `validationDetails` (JSONB — errors/warnings), `lastEmittedAt` (datetime), `versionId` (FK to entity_versions, nullable for preview)
**And** the **emission service** (`src/services/emission.service.ts`) orchestrates the full pipeline: entity + fields from DB → TypeSpec generator → compile → for each enabled target: resolve mappings → emit → validate → store result
**And** the **Right Panel** includes an "Emission Preview" view (switchable from decorator view via tabs at panel top) — the **EmissionPreviewPanel** component
**And** the EmissionPreviewPanel shows **tabs for each enabled target** (BigQuery, Avro, OpenAPI) — each tab displays:
**And** syntax-highlighted code using Shiki or Prism: SQL highlighting for BigQuery DDL, JSON for Avro, YAML for OpenAPI
**And** a **validation indicator** in the tab header: green checkmark for VALID, amber warning icon for WARNING (lossy mappings), red X for INVALID
**And** a **copy button** (hover-reveal) that copies the emitted output to clipboard with a "Copied!" toast
**And** line numbers displayed in the code viewer
**And** **Live preview updates** — as the user edits fields in the center panel, the emission preview updates automatically, debounced at 1 second after last edit; a subtle flash animation highlights lines that changed
**And** an **"Emit" button** in the entity header (primary button, Ctrl+E shortcut) commits the emission — this writes the emitted output to `emission_targets` and creates an `entity_version` snapshot; the button shows "Emitting..." spinner during the operation
**And** the Emit button is **disabled** when fields are incomplete (tooltip: "X fields need required metadata") or when there are compilation errors
**And** if emission produces **warnings** (lossy mappings), a summary is shown below the tabs: "2 warnings: decimal→float64 lossy mapping in 'amount', 'price'" — clickable to highlight the affected lines
**And** if emission produces **errors** (validation failures), the error tab shows in red with error details and `suggestedFix` if available
**And** unit tests verify: emission pipeline runs all three emitters, results are stored in emission_targets, live preview debounces at 1s, validation status is correctly set
**And** a Playwright E2E test verifies: creating an entity with 3 fields → emission preview shows all three target tabs with syntax-highlighted output → validation indicators are green → clicking copy copies to clipboard → clicking Emit commits and shows success toast

## Tasks / Subtasks

### 1. Create Prisma Migrations
- [ ] Add `entity_versions` model to `prisma/schema.prisma`:
  - `id` — String @id @default(cuid())
  - `entityId` — String (FK to entities)
  - `versionNumber` — Int
  - `snapshot` — Json (complete entity + fields + decorators)
  - `changeRecord` — Json? (nullable)
  - `migrationArtifacts` — Json? (nullable)
  - `createdBy` — String (FK to users)
  - `createdAt` — DateTime @default(now())
- [ ] Add `emission_targets` model to `prisma/schema.prisma`:
  - `id` — String @id @default(cuid())
  - `entityId` — String (FK to entities)
  - `targetType` — String (bigquery/avro/openapi)
  - `emittedOutput` — String (the generated schema text)
  - `validationStatus` — Enum (VALID, INVALID, WARNING)
  - `validationDetails` — Json (errors/warnings)
  - `lastEmittedAt` — DateTime
  - `versionId` — String? (FK to entity_versions, nullable for preview)
- [ ] Define `ValidationStatus` enum in Prisma: `VALID`, `INVALID`, `WARNING`
- [ ] Add relations between models
- [ ] Run `npx prisma migrate dev`

### 2. Implement Emission Service
- [ ] Create `src/services/emission.service.ts`
- [ ] Implement `previewEmission(entityId: string, ctx: ServiceContext): Promise<Result<EmissionPreviewResult>>`
  - [ ] Load entity + fields + decorators from DB
  - [ ] Run TypeSpec generator to produce .tsp source
  - [ ] Compile via ICompilerService.compile()
  - [ ] For each enabled target (bigquery, avro, openapi):
    - [ ] Resolve mappings via getMappingsForTarget()
    - [ ] Call emitter.emit(model, policies)
    - [ ] Call emitter.validate(output)
    - [ ] Collect results (output, warnings, validation status)
  - [ ] Return all target results without persisting (preview only)
- [ ] Implement `commitEmission(entityId: string, ctx: ServiceContext): Promise<Result<CommitEmissionResult>>`
  - [ ] Run full preview pipeline
  - [ ] Create `entity_version` snapshot (freeze entity + fields + decorators as JSONB)
  - [ ] For each target: write/upsert `emission_targets` record with output, validation status, and version reference
  - [ ] Wrap in `withAudit()` for audit trail
  - [ ] Return committed version and per-target results
- [ ] Define `EmissionPreviewResult` and `CommitEmissionResult` types

### 3. Create oRPC Router for Emission
- [ ] Create `src/server/api/routers/emission.ts`
- [ ] Add `emission.preview` query: calls `previewEmission()` — thin wrapper
- [ ] Add `emission.commit` mutation: calls `commitEmission()` — thin wrapper
- [ ] Wire into the main oRPC router

### 4. Build EmissionPreviewPanel Component
- [ ] Create `src/components/custom/EmissionPreviewPanel/` directory
- [ ] Create `EmissionPreviewPanel.tsx` — main component
- [ ] Create `EmissionPreviewPanel.types.ts` — props and types
- [ ] Create `useEmissionPreview.ts` — logic hook for data fetching and debouncing
- [ ] Create `index.ts` — barrel export

### 5. Implement Tab Navigation
- [ ] Use Shadcn `Tabs` component with Hex-style pill tabs
- [ ] Create one tab per enabled target: "BigQuery", "Avro", "OpenAPI"
- [ ] Each tab header includes a `ValidationIndicator`:
  - [ ] Green checkmark for VALID status
  - [ ] Amber warning icon for WARNING status (lossy mappings present)
  - [ ] Red X for INVALID status

### 6. Implement Syntax-Highlighted Code Viewer
- [ ] Install Shiki (or Prism) for syntax highlighting
- [ ] Configure language grammars:
  - [ ] SQL for BigQuery DDL
  - [ ] JSON for Avro
  - [ ] YAML for OpenAPI
- [ ] Display line numbers in the gutter
- [ ] Apply dark theme matching Hex-inspired design tokens
- [ ] Make code viewer scrollable for long output

### 7. Implement Copy Button
- [ ] Add hover-reveal copy button (top-right of code viewer)
- [ ] On click: copy emitted output to clipboard via `navigator.clipboard.writeText()`
- [ ] Show "Copied!" toast (Shadcn Toast, 3s auto-dismiss)
- [ ] Icon-only button (copy icon), 24x24, muted-fg, hover accent bg

### 8. Implement Live Preview Updates
- [ ] In `useEmissionPreview.ts`:
  - [ ] Watch for field changes in the entity editor form (react-hook-form watch)
  - [ ] Debounce at 1 second after last edit
  - [ ] Call `emission.preview` oRPC query with current entity state
  - [ ] Update preview panel with new results
- [ ] Implement change highlighting:
  - [ ] Compare previous and current output line-by-line
  - [ ] Apply subtle flash animation (400ms ease-out) on changed lines
  - [ ] Respect `prefers-reduced-motion`

### 9. Implement Emit Button
- [ ] Add "Emit" primary button to entity header bar
- [ ] Keyboard shortcut: Ctrl+E (Cmd+E on Mac)
- [ ] Button states:
  - [ ] Default: "Emit" with emission icon
  - [ ] During operation: "Emitting..." with spinner
  - [ ] Disabled: when fields incomplete or compilation errors (tooltip explains why)
- [ ] On click: call `emission.commit` oRPC mutation
- [ ] On success: show toast "Emitted to 3 targets — all valid" (or warning count)
- [ ] On error: show error toast with details

### 10. Implement Warning & Error Display
- [ ] Below tabs, show warning summary when warnings exist:
  - [ ] Format: "2 warnings: decimal→float64 lossy mapping in 'amount', 'price'"
  - [ ] Clicking a warning highlights the affected lines in the code viewer
- [ ] When validation errors exist:
  - [ ] Tab header shows red X indicator
  - [ ] Error details display in the tab body below the code
  - [ ] Include `suggestedFix` if available

### 11. Integrate with Right Panel
- [ ] Add "Emission Preview" as a switchable view in the Right Panel
- [ ] Add tab at top of right panel to toggle between "Decorators" and "Emission Preview"
- [ ] Right Panel dimensions: 320-480px, frosted glass background
- [ ] Collapsible via panel collapse button

### 12. Write Unit Tests
- [ ] Create `tests/unit/services/emission.service.test.ts`
  - [ ] Test: previewEmission runs all three emitters and returns results
  - [ ] Test: commitEmission creates entity_version snapshot
  - [ ] Test: commitEmission writes to emission_targets for each target
  - [ ] Test: validation status is correctly set (VALID/INVALID/WARNING)
  - [ ] Test: warnings are collected from lossy mappings
  - [ ] Test: errors are collected from validation failures
- [ ] Create `tests/unit/components/EmissionPreviewPanel.test.tsx`
  - [ ] Test: renders tabs for all three targets
  - [ ] Test: validation indicators show correct status
  - [ ] Test: copy button copies to clipboard
  - [ ] Test: live preview debounces at 1s

### 13. Write E2E Test
- [ ] Create `tests/e2e/emission-preview.spec.ts` (Playwright)
  - [ ] Test: create entity with 3 fields
  - [ ] Test: emission preview shows all three target tabs
  - [ ] Test: each tab has syntax-highlighted output
  - [ ] Test: validation indicators are green
  - [ ] Test: clicking copy copies to clipboard
  - [ ] Test: clicking Emit commits and shows success toast

## Dev Notes

### Architecture & Patterns

**Emission service** (`src/services/emission.service.ts`) orchestrates the full pipeline. It is the single entry point for both preview and committed emissions. oRPC and REST wrappers call the service.

**Compilation pipeline flow:**
```
Entity + Fields from DB
  → TypeSpec Generator (DB model → .tsp in memory)
  → ICompilerService.compile(tspSource) → SuperSchemaModel
  → For each enabled target:
    → getMappingsForTarget(targetFormat)
    → emitter.emit(model, policies) → EmitterResult
    → emitter.validate(output) → ValidationResult
    → Collect: { target, output, validationStatus, warnings, errors }
  → Return EmissionPreviewResult
```

**Key interfaces:**

```typescript
interface ICompilerService {
  compile(source: string): Promise<CompilationResult>;
  emit(model: SuperSchemaModel, target: string, policies: MappingPolicy[]): Promise<EmitterResult>;
  validate(output: string, targetFormat: string): Promise<ValidationResult>;
}

interface SuperSchemaModel {
  entity: { name: string; domain: string; version: number; metadata: EntityMetadata };
  fields: Array<{ name: string; type: LogicalType; decorators: DecoratorSet }>;
  relationships: Array<{ target: string; cardinality: string }>;
}

interface Emitter {
  name: string;
  version: string;
  targetFormat: string;
  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult;
  validate(output: string): ValidationResult;
}
```

**Result type pattern:** All service functions return `Result<T, E>`, never throw.

### UX/Design Requirements

**EmissionPreviewPanel** — a custom component in the Right Panel (frosted glass, 320-480px):

- **Composition:** Tabs + Shiki code viewer + ValidationIndicator + copy Button + diff toggle
- **State management:** Derived state — recomputed on schema change (debounced 1s). Cached per target.
- **Tabs:** Hex-style pill tabs with active gradient. One tab per target (BigQuery, Avro, OpenAPI).
- **Validation indicators:** Animated ring (green/amber/red) with tooltip. Green checkmark for VALID, amber warning for WARNING, red X for INVALID.
- **Code viewer:** Shiki or Prism syntax highlighting. SQL for BigQuery, JSON for Avro, YAML for OpenAPI. Line numbers. Dark theme matching Hex tokens. Monospace 13px.
- **Copy button:** Hover-reveal, icon-only, 24x24, muted-fg, hover accent bg. Copies to clipboard. "Copied!" toast (3s auto-dismiss).
- **Live preview:** Updates within 1s of field change (debounced). Flash animation (400ms ease-out) highlights changed lines. Respects `prefers-reduced-motion`.
- **Emit button:** Primary button (amethyst fill, white text) in entity header. Ctrl+E shortcut. "Emitting..." spinner during operation. Disabled when incomplete.
- **Warning summary:** Below tabs. Clickable to highlight affected lines. Format: "2 warnings: decimal→float64 lossy mapping in 'amount', 'price'".
- **Error display:** Red tab indicator. Error details + suggestedFix below code viewer.

**Micro-animations:**
- Emission preview update: 400ms ease-out (flash highlight on changed lines)
- Tab switch: 150ms ease-in-out
- Validation ring appear: 300ms spring
- Toast slide-in: 250ms spring

**Feedback patterns:**
- Emission success toast: "Emitted to 3 targets — all valid"
- Save success toast: "Entity v4 saved" — 3s auto-dismiss

### File Structure

```
prisma/
├── schema.prisma                  # Updated: entity_versions + emission_targets models
├── migrations/                    # New migration
src/
├── services/
│   └── emission.service.ts        # Emission pipeline orchestration
├── server/api/routers/
│   └── emission.ts                # oRPC thin wrapper
├── components/custom/EmissionPreviewPanel/
│   ├── EmissionPreviewPanel.tsx   # Main component
│   ├── EmissionPreviewPanel.types.ts # Props & types
│   ├── useEmissionPreview.ts      # Logic hook (debounce, data fetch)
│   └── index.ts                   # Barrel export
├── components/layout/
│   └── RightPanel.tsx             # Updated: add Emission Preview tab
tests/
├── unit/
│   ├── services/
│   │   └── emission.service.test.ts
│   └── components/
│       └── EmissionPreviewPanel.test.tsx
├── e2e/
│   └── emission-preview.spec.ts   # Playwright
```

### Testing Requirements

- **Unit tests (Vitest):** Emission service pipeline, entity_version creation, emission_targets persistence, validation status, warning/error collection, component rendering, debounce behavior
- **E2E tests (Playwright):** Full user journey — create entity → preview tabs → syntax highlighting → validation indicators → copy → emit → success toast
- **Component tests:** Tab rendering, validation indicators, copy button, debounce timing

### Dependencies & Prerequisites

- Stories 3.1-3.5 complete (compiler service, mapping engine, all three emitters)
- Prisma schema infrastructure
- oRPC router infrastructure
- Right Panel layout component
- Shadcn components: Tabs, Button, Toast, Tooltip
- Shiki or Prism for syntax highlighting
- react-hook-form integration for field change watching
- `withAudit()` wrapper
- `ValidationIndicator` component (may be shared with schema editor)

### References

- Architecture document: "TypeSpec Integration" section — compilation pipeline
- Architecture document: "Frontend Architecture" section — state management, code organization, performance (debounced emission preview 1s, lazy loading for EmissionPreview)
- UX Design Specification: EmissionPreviewPanel component spec, micro-animation system, feedback patterns, right panel layout (320-480px frosted glass)
- UX Design Specification: "Emission preview always current — updates within 1s of field change (debounced)"

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
