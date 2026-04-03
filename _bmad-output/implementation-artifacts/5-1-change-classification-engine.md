# Story 5.1: Change Classification Engine

Status: ready-for-dev

## Story
As a **data modeler**, I want the system to automatically classify my schema changes as breaking or non-breaking, so that I know the impact of my changes before committing them.

## Acceptance Criteria

**Given** versioning and migration artifacts exist (Epic 4 complete)
**When** the change classification engine is implemented
**Then** a **classification service** (`src/services/classification.service.ts`) exports: `classifyChange(entityId, fromVersion, toVersion, ctx): Result<ChangeClassification>`
**And** `ChangeClassification` contains: `{ changeType: "non-breaking"|"breaking"|"classification-change", severity: "low"|"medium"|"high"|"critical", reasons: string[], perTarget: [{ target, changeType, details }] }`
**And** **Non-breaking changes** are classified as: adding a new optional (nullable) field, adding a new decorator/metadata, modifying description or non-structural decorators, adding an alias
**And** **Breaking changes** are classified as: removing a field, changing a field's type, making a nullable field non-nullable, renaming a field (without alias), changing an enum's values (removing a value), changing precision/scale to a less precise value
**And** **Classification changes** are flagged separately (medium severity): changing a field's classification level (e.g., INTERNAL → PII) — these may require governance review even though they don't break structure
**And** the classification considers **per-target impact**: a change might be non-breaking for BigQuery (ADD COLUMN is safe) but breaking for Avro (removing an enum value is backward-incompatible) — `perTarget` captures this
**And** on entity save (when changes exist from the last version), the classification runs automatically and the result is displayed in the **Status Bar** as a badge: green "Non-breaking" or red "Breaking (X reasons)" or amber "Classification change"
**And** the classification is also available via the `/compatibility` API endpoint (Story 3.8)
**And** unit tests verify: all documented breaking change patterns are classified correctly, all documented non-breaking patterns are classified correctly, per-target classification differs when appropriate (e.g., Avro vs BigQuery), classification change is detected separately from structural changes
**And** integration test: a complex change (add field + modify type + change classification) produces a classification with multiple reasons and per-target breakdown

## Tasks / Subtasks

### Service Layer — Classification Engine
- [ ] Create `src/services/classification.service.ts` with `classifyChange(entityId, fromVersion, toVersion, ctx): Result<ChangeClassification>`
- [ ] Retrieve diff result from `compareVersions()` (version service)
- [ ] Implement core classification algorithm that evaluates each change in the diff

### Non-Breaking Change Rules
- [ ] Adding a new optional (nullable) field → non-breaking
- [ ] Adding a new decorator/metadata → non-breaking
- [ ] Modifying description or non-structural decorators (semantics, lineage, operational hints) → non-breaking
- [ ] Adding an alias → non-breaking

### Breaking Change Rules
- [ ] Removing a field → breaking (critical severity)
- [ ] Changing a field's type → breaking (high severity)
- [ ] Making a nullable field non-nullable → breaking (high severity)
- [ ] Renaming a field without adding alias → breaking (high severity)
- [ ] Changing an enum's values (removing a value) → breaking (high severity)
- [ ] Changing precision/scale to a less precise value → breaking (medium severity)

### Classification Change Rules
- [ ] Changing a field's classification level (e.g., INTERNAL → PII, PUBLIC → SENSITIVE) → classification-change (medium severity)
- [ ] Flag separately from structural breaking/non-breaking

### Severity Computation
- [ ] Implement severity rollup: if any breaking change exists, overall severity = max of individual severities
- [ ] Non-breaking = low severity
- [ ] Classification change = medium severity
- [ ] Breaking changes: precision/scale = medium, field removal = critical, type change / nullability = high

### Per-Target Classification
- [ ] Implement per-target evaluation that considers target-specific compatibility rules:
  - BigQuery: ADD COLUMN is always safe; DROP COLUMN requires manual review; type changes may or may not be safe
  - Avro: additions of optional fields = backward compatible; removing fields or enum values = breaking; type changes depend on Avro promotion rules
  - OpenAPI: added optional property = non-breaking; removed required property = breaking; added required property = breaking
- [ ] Populate `perTarget` array with target-specific changeType and details

### Aggregate Classification
- [ ] Determine overall `changeType`: if any per-target is "breaking" → overall is "breaking"; else if any classification change → "classification-change"; else "non-breaking"
- [ ] Collect all `reasons` strings explaining why each change was classified as it was

### Zod Schemas & Types
- [ ] Define `ChangeClassification` Zod schema in `src/types/schemas/classification.ts`
- [ ] Define `PerTargetClassification` schema: `{ target: string, changeType: string, details: string }`
- [ ] Export derived TypeScript types

### oRPC Router
- [ ] Add `governance.classifyChange` query to a new `src/server/api/routers/governance.ts` or extend `version.ts` — input: entityId, fromVersion, toVersion
- [ ] Returns `ChangeClassification`

### REST API Integration
- [ ] Ensure classification result is available via the `/compatibility` API endpoint (enhancing Story 3.8)

### Status Bar Integration
- [ ] On entity save (when changes exist from last version), run classification automatically
- [ ] Display classification result in the Status Bar as a badge:
  - Green badge: "Non-breaking" — no governance required
  - Red badge: "Breaking (X reasons)" — governance approval needed
  - Amber badge: "Classification change" — governance review recommended
- [ ] Badge is clickable — clicking shows a tooltip/popover with the full list of reasons

### Testing
- [ ] Unit test: adding optional nullable field → non-breaking
- [ ] Unit test: adding decorator/metadata → non-breaking
- [ ] Unit test: modifying description → non-breaking
- [ ] Unit test: adding alias → non-breaking
- [ ] Unit test: removing a field → breaking (critical)
- [ ] Unit test: changing field type → breaking (high)
- [ ] Unit test: making nullable field non-nullable → breaking (high)
- [ ] Unit test: renaming field without alias → breaking (high)
- [ ] Unit test: removing enum value → breaking (high)
- [ ] Unit test: reducing precision/scale → breaking (medium)
- [ ] Unit test: changing classification level → classification-change (medium)
- [ ] Unit test: per-target — same change classified differently for BigQuery vs Avro
- [ ] Unit test: per-target — BigQuery ADD COLUMN = non-breaking while Avro field removal = breaking
- [ ] Unit test: classification change detected separately from structural changes
- [ ] Integration test: complex change (add field + modify type + change classification) → multiple reasons + per-target breakdown

## Dev Notes

### Architecture & Patterns

**Service pattern:** `classification.service.ts` follows the standard service layer pattern. Returns `Result<ChangeClassification>`. Never throws. Read-only operation — no `withAudit()` needed (the classification result is consumed by governance service which handles audit).

**Module boundary:** Classification service depends on:
- Version service (read-only) — to get diff between versions via `compareVersions()`
- Does NOT depend on governance service — classification is input TO governance, not the other way around
- Does NOT modify any data — pure computation on diff results

**Classification algorithm flow:**
1. Get `DiffResult` from `compareVersions()`
2. For each changed field, evaluate against rule sets (breaking, non-breaking, classification-change)
3. For each enabled target, evaluate target-specific rules
4. Aggregate: overall changeType = worst case across all targets; severity = max severity; reasons = all individual reasons
5. Return `ChangeClassification`

**Per-target rules are target-specific knowledge.** Consider organizing as a strategy pattern:
```typescript
interface TargetClassifier {
  target: string;
  classify(diff: DiffResult): PerTargetClassification;
}
```

### UX/Design Requirements

**Status Bar integration:** The Status Bar (bottom bar) shows current domain, validation error/warning count, schema version, and sync status. Classification badge is added to this bar.

**Badge design:**
- Green "Non-breaking" badge: use `var(--success)` / `--field-complete` color
- Red "Breaking (X reasons)" badge: use `var(--destructive)` / `--field-error` color
- Amber "Classification change" badge: use `var(--warning)` / `--field-suggestion` color
- Clickable: shows popover with reasons list

**Automatic classification:** Runs on every save when changes exist from the last version. Must not block the save operation — classification can be computed async and displayed when ready. Target: under 5 seconds (NFR4).

### File Structure
```
src/services/classification.service.ts                   — Core classification engine
src/services/classification/rules.ts                     — Breaking/non-breaking rule definitions
src/services/classification/target-classifiers/
  ├── bigquery.classifier.ts                             — BigQuery-specific rules
  ├── avro.classifier.ts                                 — Avro-specific rules
  └── openapi.classifier.ts                              — OpenAPI-specific rules
src/types/schemas/classification.ts                      — Zod schemas + TS types
src/server/api/routers/governance.ts                     — oRPC router (or extend version.ts)
src/components/layout/StatusBar/                         — Update with classification badge
tests/unit/services/classification.service.test.ts       — Unit tests
tests/integration/classification.integration.test.ts     — Integration test
```

### Testing Requirements
- **Unit tests (Vitest):** Test every documented breaking and non-breaking pattern individually. Test per-target divergence. Test classification-change detection. Test severity rollup.
- **Integration test (Vitest):** Complex multi-change scenario producing mixed classification with per-target breakdown.
- **NFR4:** Classification computation must complete under 5 seconds.

### Dependencies & Prerequisites
- Epic 4 complete — versioning, diff engine, migration artifacts
- Story 4.2 `compareVersions()` available in version service
- Enabled targets list available (from emission configuration)
- Status Bar component exists and is extensible
- Type mapping policies available for target-specific classification

### References
- Architecture: Service layer pattern, Result type
- Architecture: Module boundaries — classification is separate from governance
- UX Spec: Status Bar pattern (VS Code-inspired bottom bar)
- FR25: Classify schema changes by type and route to appropriate workflow
- NFR4: Diff/classification under 5 seconds

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
