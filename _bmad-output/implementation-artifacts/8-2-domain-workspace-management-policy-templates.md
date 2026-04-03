# Story 8.2: Domain Workspace Management & Policy Templates

Status: ready-for-dev

## Story
As an **administrator**, I want to create domain workspaces with policy templates that entities inherit, so that teams have consistent default policies without manual configuration per entity.

## Acceptance Criteria

**Given** RBAC and the domain data model exist (Stories 2.1, 8.1 complete)
**When** domain workspace management is implemented
**Then** the **Admin Panel** includes a **Domains tab** displaying all domains in a DataTable: name, description, entity count, policy template status (badge: "Configured" or "No template"), created date
**And** clicking a domain opens a detail panel with:
**And** **Domain info** section: editable name, editable description
**And** **Policy template** section: a structured form for defining default policies that entities in this domain inherit:
**And** Default classification level (dropdown: PII, SENSITIVE, INTERNAL, PUBLIC, none)
**And** Default retention period (dropdown matching Policy tab options)
**And** Default quality rules (list of rule templates that can be added/removed — same UI as the field-level quality rules editor)
**And** Naming conventions (text input — e.g., "snake_case fields, PascalCase entities")
**And** The policy template is stored in `domains.policyTemplate` JSONB, validated by a Zod schema
**And** a **"+ Create Domain"** button opens a creation form: name (required, unique), description, and initial policy template (optional — can be configured later)
**And** when an entity is created in a domain with a policy template, the template values are **auto-populated** into each new field's decorators as defaults — the field shows an "↳ Inherited from {Domain}" badge next to inherited values
**And** inheritance is **flattened** per FR45c: the inherited values are written directly into the field's decorator JSONB at creation time — consumers reading the field see the full policy without needing to look up the domain; if a user edits an inherited value, the inheritance indicator is removed and the value becomes field-owned
**And** changing a domain's policy template does NOT retroactively update existing entities — it only affects new entities and new fields created after the change; a confirmation dialog warns: "Template changes apply to future entities only. Existing entities are not affected."
**And** unit tests verify: domain creation with policy template, entity creation inherits template values, editing inherited value removes inheritance, template change doesn't affect existing entities, domain name uniqueness
**And** a Playwright E2E test verifies: creating a domain with policy template, creating an entity in that domain → fields show inherited values, editing an inherited value removes the badge

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Ensure `domains` table has `policyTemplate` Json? field in `prisma/schema.prisma` (add if not already present):
  - `policyTemplate` Json? (nullable JSONB — null means no template configured)
- [ ] Add `inheritedFrom` tracking to `fields.decorators` JSONB — extend the decorator schema to include an `_inherited` metadata object tracking which values came from domain template
- [ ] Run `npx prisma migrate dev` if schema changes are needed

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/domain-policy.ts`:
  - `PolicyTemplateSchema` Zod schema:
    - `classification` z.enum(['PII', 'SENSITIVE', 'INTERNAL', 'PUBLIC']).optional()
    - `retention` z.string().optional() (matches retention period options)
    - `qualityRules` z.array(QualityRuleSchema).optional()
    - `namingConventions` z.string().optional()
  - `CreateDomainInput` schema: name (z.string().min(1)), description (z.string().optional()), policyTemplate (PolicyTemplateSchema.optional())
  - `UpdateDomainInput` schema: id (z.string()), name (z.string().optional()), description (z.string().optional()), policyTemplate (PolicyTemplateSchema.optional())

### Backend — Domain Management Service
- [ ] Create `src/services/domain.service.ts` (or extend existing domain service)
- [ ] Implement `createDomain(input, ctx): Result<Domain>`:
  - Validate input via Zod (CreateDomainInput)
  - Enforce unique domain name (case-insensitive check)
  - Validate policyTemplate JSONB via PolicyTemplateSchema if provided
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log domain creation
- [ ] Implement `updateDomain(id, input, ctx): Result<Domain>`:
  - Validate input via Zod (UpdateDomainInput)
  - If name changed, enforce uniqueness
  - Validate policyTemplate JSONB via PolicyTemplateSchema if provided
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log domain update
  - Note: template changes do NOT retroactively update existing entities
- [ ] Implement `getDomains(ctx): Result<DomainWithStats[]>`:
  - Fetch all domains with entity count (aggregation query)
  - Include policy template status ("Configured" if policyTemplate is not null)
  - RBAC: require Admin role for full admin view
- [ ] Implement `getDomainById(id, ctx): Result<Domain>`:
  - Fetch single domain with full details
- [ ] Implement `deleteDomain(id, ctx): Result<void>`:
  - Prevent deletion if domain has entities — return error "Cannot delete domain with {count} entities. Reassign or delete entities first."
  - RBAC: require Admin role
  - Wrap in `withAudit()`

### Backend — Policy Template Inheritance Logic
- [ ] Implement `applyPolicyTemplate(domainId, fieldDecorators, ctx): DecoratorSet` in domain service:
  - Fetch domain's policyTemplate
  - If template exists, merge template values into field decorators as defaults
  - Set `_inherited` metadata object tracking which decorator keys came from domain template: `{ domainId, domainName, keys: ['classification', 'retention', ...] }`
  - Only apply template values where field decorator does not already have a value (template = defaults, not overrides)
- [ ] Integrate with schema service — when a new field is created in an entity belonging to a domain with a policy template:
  - Call `applyPolicyTemplate()` to populate decorator defaults
  - Store flattened decorators directly in field (FR45c — no runtime lookup needed)
- [ ] Implement `removeInheritance(fieldId, decoratorKey, ctx)`:
  - When a user edits an inherited value, remove that key from `_inherited.keys`
  - If `_inherited.keys` is empty, remove `_inherited` metadata entirely
  - The edited value becomes field-owned

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/admin/domains.ts` oRPC router
- [ ] Add `domains.getAll` query — thin wrapper calling `domainService.getDomains()`, Admin-only via `adminProcedure`
- [ ] Add `domains.getById` query — thin wrapper calling `domainService.getDomainById()`, Admin-only
- [ ] Add `domains.create` mutation — thin wrapper calling `domainService.createDomain()`, Admin-only
- [ ] Add `domains.update` mutation — thin wrapper calling `domainService.updateDomain()`, Admin-only
- [ ] Add `domains.delete` mutation — thin wrapper calling `domainService.deleteDomain()`, Admin-only
- [ ] Wire router into `appRouter` under `admin.domains` namespace

### Frontend — Domains Tab UI Components
- [ ] Create `src/components/custom/admin/DomainDataTable.tsx`:
  - DataTable with columns: name, description, entity count, policy template status badge ("Configured" green / "No template" gray), created date
  - Row click opens domain detail panel
  - Search/filter by domain name
  - "+ Create Domain" button in table header
- [ ] Create `src/components/custom/admin/DomainDetailPanel.tsx`:
  - Slide-over or right panel showing domain details
  - Domain info section: editable name, editable description with save button
  - Policy template section (see PolicyTemplateEditor below)
  - Delete domain button with confirmation dialog
- [ ] Create `src/components/custom/admin/DomainCreateDialog.tsx`:
  - Modal dialog with form: name (required), description (optional), initial policy template (optional — expandable section)
  - Name uniqueness validation (client-side check on blur)
- [ ] Create `src/components/custom/admin/PolicyTemplateEditor.tsx`:
  - Structured form matching policy template schema:
    - Classification dropdown (PII, SENSITIVE, INTERNAL, PUBLIC, None)
    - Retention period dropdown (matching existing Policy tab options)
    - Quality rules list editor (add/remove rules — reuse existing quality rule editor component)
    - Naming conventions text input
  - Save button with confirmation dialog: "Template changes apply to future entities only. Existing entities are not affected."
- [ ] Create `src/components/custom/admin/InheritedBadge.tsx`:
  - Small badge component: "↳ Inherited from {DomainName}"
  - Displayed next to field decorator values that came from domain policy template
  - Disappears when user edits the inherited value
- [ ] Create `src/hooks/useAdminDomains.ts`:
  - oRPC query hooks for domain list, domain detail
  - oRPC mutation hooks for create, update, delete domain
  - Invalidation on mutations

### Frontend — Schema Editor Integration
- [ ] Modify field editor components to detect `_inherited` metadata in decorator JSONB
- [ ] Display `InheritedBadge` next to classification, retention, quality rules when `_inherited.keys` includes those decorator keys
- [ ] On field decorator edit: if editing an inherited value, call `removeInheritance()` to clear the inheritance indicator for that key

### Testing
- [ ] **Unit tests** (`tests/unit/services/domain.service.test.ts`):
  - createDomain stores domain with policyTemplate JSONB
  - createDomain rejects duplicate domain name (case-insensitive)
  - createDomain rejects non-Admin users
  - updateDomain updates name, description, policyTemplate
  - updateDomain template change does NOT affect existing entities
  - getDomains returns domains with entity counts and template status
  - deleteDomain blocked when entities exist in domain
  - applyPolicyTemplate merges template values into field decorators
  - applyPolicyTemplate sets _inherited metadata correctly
  - applyPolicyTemplate does not override existing field values
  - removeInheritance clears _inherited key
  - Zod validation rejects invalid policyTemplate JSONB
- [ ] **Integration test** (`tests/integration/domain-policy.test.ts`):
  - Create domain with policy template via oRPC
  - Create entity in that domain → verify new fields have inherited decorator values
  - Edit an inherited field value → verify _inherited metadata is updated
  - Change domain template → verify existing entity fields are NOT changed
  - Create new entity after template change → verify new template values applied
- [ ] **Playwright E2E test** (`tests/e2e/admin-domains.spec.ts`):
  - Admin navigates to Admin Panel → Domains tab
  - Click "+ Create Domain" → fill form with policy template → save
  - Domain appears in table with "Configured" badge
  - Click domain → detail panel opens with policy template editor
  - Navigate to Schema Editor → create entity in the new domain
  - New field shows "↳ Inherited from {DomainName}" badge on classification
  - Edit the inherited classification → badge disappears

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/domain.service.ts` owns all domain workspace and policy template logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All domain CRUD operations are logged to `audit_log`.
- **Flattened inheritance (FR45c)**: Policy template values are written directly into field decorators at creation time. No runtime domain lookup needed. The `_inherited` metadata is purely for UI display (showing the badge). Consumers reading field data see the full decorator without knowing about inheritance.
- **RBAC**: Only Admin role can manage domains. Enforced via `adminProcedure` in oRPC middleware.
- **Zod validation on JSONB**: Both `policyTemplate` and field `decorators` are validated via Zod schemas on every write.

### UX/Design Requirements
- Domains tab is the second tab in the Admin Panel
- Policy template status shows as green "Configured" badge or gray "No template" badge
- Template editor uses familiar form patterns matching the field-level Policy tab
- Confirmation dialog on template changes with clear warning about future-only effect
- "↳ Inherited from {DomainName}" badge is small, subtle, appears inline next to the decorator value
- Badge disappears immediately on edit (optimistic UI)

### File Structure
```
prisma/schema.prisma                                        # Extended — policyTemplate field on domains
src/services/domain.service.ts                              # Domain CRUD + policy template inheritance
src/types/schemas/domain-policy.ts                          # Zod schemas — PolicyTemplateSchema, CreateDomainInput
src/server/api/routers/admin/domains.ts                     # oRPC router (Admin-only)
src/components/custom/admin/DomainDataTable.tsx              # Domains tab DataTable
src/components/custom/admin/DomainDetailPanel.tsx            # Domain detail slide-over
src/components/custom/admin/DomainCreateDialog.tsx           # Create domain modal
src/components/custom/admin/PolicyTemplateEditor.tsx         # Policy template form editor
src/components/custom/admin/InheritedBadge.tsx               # "Inherited from" badge component
src/hooks/useAdminDomains.ts                                # oRPC hooks for domain management
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/domain.service.test.ts`): 12+ test cases covering CRUD, template application, inheritance tracking
- **Integration test** (`tests/integration/domain-policy.test.ts`): End-to-end template inheritance through entity/field creation
- **Playwright E2E** (`tests/e2e/admin-domains.spec.ts`): Domain creation with template, entity inherits values, edit clears badge

### Dependencies & Prerequisites
- Story 2.1 (Domain model) complete — domains table exists
- Story 8.1 (RBAC) complete — Admin role and `adminProcedure` exist
- Schema service (Epic 2) complete — entity/field creation flow exists for inheritance integration
- Field decorator Zod schemas exist (`src/types/schemas/`)

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Data Architecture (domains table, JSONB decorators), Module Boundaries (Admin module), FR45c (flattened inheritance)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Admin Panel, Domain management
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 8, Story 8.2
- PRD: FR44 (domain workspaces), FR45a-c (policy templates, inheritance)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
