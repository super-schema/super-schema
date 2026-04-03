# Story 8.3: Emitter Configuration & Type Mapping Administration

Status: ready-for-dev

## Story
As an **administrator**, I want to enable/disable emitter targets and configure type mapping policies, so that I can control which emission formats are available and how types translate.

## Acceptance Criteria

**Given** emitters and type mapping exist (Epic 3 complete)
**When** emitter administration is implemented
**Then** the **Admin Panel** includes an **Emitters tab** displaying all available emitters in a card grid: emitter name, version, target format, status (badge: Enabled/Disabled), last emission timestamp, total emission count
**And** each emitter card has an **Enable/Disable toggle** — toggling changes the emitter's availability immediately (zero-downtime, FR44); disabled emitters do not appear in the emission preview tabs or the Emit dialog
**And** clicking an emitter card opens a detail panel showing:
**And** **Emitter info**: name, version, target format, description
**And** **Type mapping policies table**: all mapping rules for this target — source type, mapped type, lossy indicator, override indicator; each row is editable by Admin
**And** an "**Add Override**" button that allows creating a new global type mapping override (same form as Story 3.7 but accessible from admin without needing a specific entity context)
**And** a "**Test Emitter**" button that runs the emitter against a sample entity (user selects from existing entities via dropdown) and displays the output with validation result — this lets admins verify the emitter works before enabling it for all users
**And** emitter enable/disable state is stored in a `emitter_config` table: `id`, `emitterName`, `enabled` (boolean), `configOverrides` (JSONB), `updatedBy`, `updatedAt`
**And** configuration changes are recorded in the audit trail
**And** changes take effect immediately — no restart required (FR44)
**And** unit tests verify: enabling/disabling emitter changes availability in emission service, type mapping admin edits are persisted, test emitter runs and returns output, config changes are audited
**And** a Playwright E2E test verifies: admin can enable/disable an emitter, disabled emitter doesn't appear in emission preview, testing emitter against a sample entity shows output

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Add `emitter_config` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `emitterName` String @unique (e.g., "bigquery", "avro", "openapi")
  - `enabled` Boolean @default(true)
  - `configOverrides` Json? (nullable JSONB — for future emitter-specific config)
  - `updatedBy` String (FK to users)
  - `updatedAt` DateTime @updatedAt
  - `createdAt` DateTime @default(now())
  - Relation: updater (User)
- [ ] Run `npx prisma migrate dev` to generate and apply migration
- [ ] Add seed data: create default emitter_config rows for each built-in emitter (bigquery, avro, openapi) with `enabled: true`

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/emitter-config.ts`:
  - `EmitterConfigSchema` Zod schema: emitterName (z.string()), enabled (z.boolean()), configOverrides (z.record(z.unknown()).optional())
  - `UpdateEmitterConfigInput` schema: emitterName (z.string()), enabled (z.boolean().optional()), configOverrides (z.record(z.unknown()).optional())
  - `TestEmitterInput` schema: emitterName (z.string()), entityId (z.string())
  - `CreateTypeMappingOverrideInput` schema: targetType (z.string()), sourceType (z.string()), mappedType (z.string()), isOverride (z.literal(true))

### Backend — Emitter Config Service
- [ ] Create `src/services/emitter-config.service.ts`
- [ ] Implement `getEmitterConfigs(ctx): Result<EmitterConfigWithStats[]>`:
  - Fetch all emitter_config rows
  - Join with emission_targets to compute: last emission timestamp, total emission count per emitter
  - Include emitter metadata (name, version, target format, description) from emitter registry
  - RBAC: require Admin role
- [ ] Implement `getEmitterConfigByName(name, ctx): Result<EmitterConfigWithDetails>`:
  - Fetch single emitter config with full details
  - Include type mapping policies for this target from `type_mapping_policies` table
  - RBAC: require Admin role
- [ ] Implement `updateEmitterConfig(input, ctx): Result<EmitterConfig>`:
  - Update enabled status and/or configOverrides
  - Validate configOverrides JSONB via Zod if provided
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log config change with before/after state
  - Changes take effect immediately — the emission service reads config on each request
- [ ] Implement `testEmitter(input, ctx): Result<TestEmitterResult>`:
  - Fetch the entity by entityId
  - Run the specified emitter against the entity using the emission service
  - Return: emitted output (string), validation result (pass/fail with details), compilation time
  - RBAC: require Admin role
  - Do NOT persist the emission — this is a test/preview only
- [ ] Implement `getEnabledEmitters(ctx): Result<string[]>`:
  - Return list of emitter names where enabled=true
  - Called by emission service to filter available emitters
  - No RBAC check needed — called internally by other services

### Backend — Type Mapping Administration
- [ ] Implement `getTypeMappingsForTarget(targetType, ctx): Result<TypeMappingPolicy[]>`:
  - Fetch all type_mapping_policies for the given target
  - Include both default and override mappings
  - RBAC: require Admin role
- [ ] Implement `createTypeMappingOverride(input, ctx): Result<TypeMappingPolicy>`:
  - Validate input via Zod (CreateTypeMappingOverrideInput)
  - Create new type_mapping_policies row with `isOverride: true`
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement `updateTypeMapping(id, input, ctx): Result<TypeMappingPolicy>`:
  - Update mapped type for an existing mapping
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement `deleteTypeMappingOverride(id, ctx): Result<void>`:
  - Only allow deletion of override mappings (isOverride=true), not system defaults
  - RBAC: require Admin role
  - Wrap in `withAudit()`

### Backend — Emission Service Integration
- [ ] Modify `src/services/emission.service.ts`:
  - Before listing available emitters for UI (preview tabs, Emit dialog), call `emitterConfigService.getEnabledEmitters()` and filter out disabled emitters
  - Ensure disabled emitters cannot be selected for emission even if requested directly (guard check)

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/admin/emitters.ts` oRPC router
- [ ] Add `emitters.getAll` query — thin wrapper calling `emitterConfigService.getEmitterConfigs()`, Admin-only via `adminProcedure`
- [ ] Add `emitters.getByName` query — thin wrapper calling `emitterConfigService.getEmitterConfigByName()`, Admin-only
- [ ] Add `emitters.updateConfig` mutation — thin wrapper calling `emitterConfigService.updateEmitterConfig()`, Admin-only
- [ ] Add `emitters.test` mutation — thin wrapper calling `emitterConfigService.testEmitter()`, Admin-only
- [ ] Add `emitters.getTypeMappings` query — thin wrapper calling `getTypeMappingsForTarget()`, Admin-only
- [ ] Add `emitters.createTypeMappingOverride` mutation — thin wrapper, Admin-only
- [ ] Add `emitters.updateTypeMapping` mutation — thin wrapper, Admin-only
- [ ] Add `emitters.deleteTypeMappingOverride` mutation — thin wrapper, Admin-only
- [ ] Wire router into `appRouter` under `admin.emitters` namespace

### Frontend — Emitters Tab UI Components
- [ ] Create `src/components/custom/admin/EmitterCardGrid.tsx`:
  - Card grid layout displaying all emitters
  - Each card shows: emitter name, version, target format, status badge (Enabled green / Disabled gray), last emission timestamp, total emission count
  - Enable/Disable toggle on each card (inline, immediate effect)
  - Card click opens emitter detail panel
- [ ] Create `src/components/custom/admin/EmitterDetailPanel.tsx`:
  - Slide-over or right panel showing emitter details
  - Emitter info section: name, version, target format, description (read-only)
  - Type mapping policies table (see below)
  - "Test Emitter" button (see below)
- [ ] Create `src/components/custom/admin/TypeMappingTable.tsx`:
  - DataTable of type mapping policies for the selected emitter target
  - Columns: source type, mapped type, lossy indicator (warning icon), override indicator (badge)
  - Inline editing: click mapped type cell to edit
  - "Add Override" button opens form: source type dropdown, mapped type input, auto-set isOverride=true
  - Delete button on override rows only (system defaults cannot be deleted)
- [ ] Create `src/components/custom/admin/TestEmitterDialog.tsx`:
  - Modal dialog with: entity selector dropdown (searchable, fetches from existing entities), "Run Test" button
  - Output display: emitted code in syntax-highlighted code block, validation result (pass/fail badge with details)
  - Loading state while emitter runs
- [ ] Create `src/hooks/useAdminEmitters.ts`:
  - oRPC query hooks for emitter configs, emitter detail, type mappings
  - oRPC mutation hooks for toggle enable/disable, test emitter, CRUD type mappings
  - Optimistic update for enable/disable toggle

### Testing
- [ ] **Unit tests** (`tests/unit/services/emitter-config.service.test.ts`):
  - getEmitterConfigs returns all configs with stats
  - updateEmitterConfig toggles enabled status
  - updateEmitterConfig records change in audit trail
  - getEnabledEmitters returns only enabled emitter names
  - testEmitter runs emitter against entity and returns output without persisting
  - testEmitter rejects non-Admin users
  - Disabled emitter is excluded from emission service available emitters
- [ ] **Unit tests** (`tests/unit/services/emitter-config.type-mapping.test.ts`):
  - getTypeMappingsForTarget returns all mappings for target
  - createTypeMappingOverride creates override mapping
  - updateTypeMapping updates mapped type
  - deleteTypeMappingOverride deletes override but rejects deletion of system defaults
  - All type mapping CRUD operations are audited
- [ ] **Integration test** (`tests/integration/emitter-admin.test.ts`):
  - Disable an emitter via oRPC → verify it no longer appears in emission service available emitters
  - Enable the emitter → verify it reappears
  - Create a type mapping override → verify it is used during emission
  - Test emitter against a sample entity → verify output is returned
- [ ] **Playwright E2E test** (`tests/e2e/admin-emitters.spec.ts`):
  - Admin navigates to Admin Panel → Emitters tab
  - Emitter cards display with correct info and status
  - Toggle an emitter to Disabled → badge changes to "Disabled"
  - Navigate to Schema Editor → disabled emitter not in emission preview tabs
  - Toggle back to Enabled → emitter reappears
  - Click emitter card → detail panel opens with type mappings
  - Test emitter → output displayed with validation result

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/emitter-config.service.ts` owns all emitter configuration and type mapping administration logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All config changes (enable/disable, type mapping edits) are logged to `audit_log` with before/after state.
- **Zero-downtime configuration (FR44)**: Emitter enable/disable state is read from the database on each request. No in-memory cache that would require restart. Changes are immediately effective.
- **RBAC**: Only Admin role can manage emitter configuration. Enforced via `adminProcedure` in oRPC middleware.
- **Test emitter**: Uses the existing emission pipeline but does not persist results. Useful for validation before enabling an emitter for all users.
- **Emitter registry**: The system knows about available emitters from the `src/emitters/` directory. The `emitter_config` table controls which are enabled — if an emitter exists in code but has no config row, it defaults to enabled (seed data creates rows for all built-in emitters).

### UX/Design Requirements
- Emitters tab is the third tab in the Admin Panel
- Card grid layout (not table) — each emitter gets a visual card
- Enable/Disable toggle is prominent on each card — immediate visual feedback
- Status badge: green "Enabled" / gray "Disabled"
- Type mapping table uses inline editing for quick changes
- Override rows have a distinct visual indicator (badge or highlight)
- Test emitter output uses syntax highlighting matching the target format (SQL for BigQuery, JSON for Avro, YAML for OpenAPI)
- Loading spinner during test emitter execution

### File Structure
```
prisma/schema.prisma                                         # Extended — emitter_config table
prisma/seed.ts                                               # Extended — seed default emitter configs
src/services/emitter-config.service.ts                       # Emitter config + type mapping admin
src/types/schemas/emitter-config.ts                          # Zod schemas — EmitterConfigSchema, TestEmitterInput
src/server/api/routers/admin/emitters.ts                     # oRPC router (Admin-only)
src/services/emission.service.ts                             # Modified — filter by enabled emitters
src/components/custom/admin/EmitterCardGrid.tsx               # Emitter cards grid
src/components/custom/admin/EmitterDetailPanel.tsx            # Emitter detail slide-over
src/components/custom/admin/TypeMappingTable.tsx              # Type mapping policies DataTable
src/components/custom/admin/TestEmitterDialog.tsx             # Test emitter modal
src/hooks/useAdminEmitters.ts                                # oRPC hooks for emitter management
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/emitter-config.service.test.ts`): 7+ test cases covering config CRUD, enable/disable filtering, test emitter
- **Unit tests** (`tests/unit/services/emitter-config.type-mapping.test.ts`): 5+ test cases covering type mapping CRUD
- **Integration test** (`tests/integration/emitter-admin.test.ts`): End-to-end enable/disable, type mapping override, test emitter
- **Playwright E2E** (`tests/e2e/admin-emitters.spec.ts`): Emitter admin workflow

### Dependencies & Prerequisites
- Epic 3 (Emission) complete — emitter plugins, emission service, type mapping policies exist
- Story 8.1 (RBAC) complete — Admin role and `adminProcedure` exist
- Story 3.7 (Type Mapping Overrides) complete — type_mapping_policies table and override logic exist
- Emitter plugins registered in `src/emitters/` directory

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — TypeSpec Integration (emitter pipeline), Module Boundaries (Admin module), FR44 (zero-downtime config)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Admin Panel, Emitter management
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 8, Story 8.3
- PRD: FR44 (emitter management, zero-downtime), FR10-FR15 (emission)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
