# Story 10.1: Git Export Service & Configuration

Status: ready-for-dev

## Story
As a **data engineer**, I want schema definitions and emitted output automatically exported to a Git repository, so that my schemas are version-controlled, diffable, and consumable by downstream pipelines.

## Acceptance Criteria

**Given** entities can be versioned and emitted (Epics 2-4 complete)
**When** the Git export service is implemented
**Then** the Prisma schema includes a `git_config` table: `id` (cuid), `repositoryUrl` (string), `branch` (string, default "main"), `basePath` (string, default "schemas/"), `authMethod` (enum: SSH_KEY, PERSONAL_ACCESS_TOKEN, GITHUB_APP), `authCredential` (string — encrypted), `enabled` (boolean, default false), `lastSyncAt` (datetime, nullable), `lastSyncStatus` (enum: SUCCESS, FAILED, PENDING), `createdBy` (FK to users), `createdAt`, `updatedAt`
**And** a **Git export service** (`src/services/git.service.ts`) exports: `configureRepository(input, ctx): Result<GitConfig>`, `exportEntity(entityId, ctx): Result<GitExportResult>`, `exportAll(ctx): Result<GitExportResult>`, `testConnection(configId, ctx): Result<{ connected: boolean, error?: string }>`
**And** the export service writes files to the configured Git repository following the Architecture document's file structure:
**And** `{basePath}/{domain}/{entity}.superschema.json` — the logical entity definition (entity metadata + all fields with decorators as JSON)
**And** `{basePath}/{domain}/{entity}.bq.sql` — emitted BigQuery DDL (if BigQuery emitter is enabled)
**And** `{basePath}/{domain}/{entity}.avro.json` — emitted Avro schema (if Avro emitter is enabled)
**And** `{basePath}/{domain}/{entity}.openapi.yaml` — emitted OpenAPI schema (if OpenAPI emitter is enabled)
**And** each export creates a **Git commit** with message: "Update {entityName} v{version} — {changeSummary}" and the author set to the user who triggered the emission
**And** export is triggered **automatically on Emit** (when Git is configured and enabled) — after successful emission, the exported files are committed and pushed
**And** export is also available **manually** via a "Push to Git" button in the entity header (secondary button) and via the API (`POST /api/v1/schemas/:id/git-export`)
**And** the **Admin Panel** includes a **Git tab** for repository configuration: repository URL input, branch input, base path input, auth method selector (SSH key textarea / PAT input / GitHub App config), and a "Test Connection" button that verifies Git access
**And** if Git push fails (network error, auth failure, conflict), the error is logged and shown as a toast: "Git push failed: {reason}. Emission was saved locally." — the emission itself is NOT rolled back
**And** the `git_config.lastSyncAt` and `lastSyncStatus` track the last export attempt
**And** unit tests verify: export generates correct file paths and content, commit message includes entity name and version, export failure doesn't roll back emission, file structure matches architecture spec
**And** integration test (using a temporary Git repo): configure repository → emit entity → verify files are committed to the repo with correct structure

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Create `git_config` table in `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `repositoryUrl` String — the remote Git repository URL (HTTPS or SSH)
  - `branch` String @default("main") — target branch for direct pushes
  - `basePath` String @default("schemas/") — root path inside the repo for exported files
  - `authMethod` Enum(SSH_KEY, PERSONAL_ACCESS_TOKEN, GITHUB_APP) — authentication method
  - `authCredential` String — encrypted credential (SSH private key, PAT, or GitHub App JSON config)
  - `enabled` Boolean @default(false) — whether auto-export on emit is active
  - `lastSyncAt` DateTime? — timestamp of last export attempt
  - `lastSyncStatus` Enum(SUCCESS, FAILED, PENDING) — result of last export
  - `createdBy` String (FK to users) — user who configured the repository
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
- [ ] Create `GitAuthMethod` enum: `SSH_KEY`, `PERSONAL_ACCESS_TOKEN`, `GITHUB_APP`
- [ ] Create `GitSyncStatus` enum: `SUCCESS`, `FAILED`, `PENDING`
- [ ] Add relation: `git_config.createdBy` → `users.id`
- [ ] Run `npx prisma migrate dev` to generate and apply migration

### Backend — Service (`src/services/git.service.ts`)
- [ ] Create `src/services/git.service.ts`
- [ ] Implement `configureRepository(input, ctx): Result<GitConfig>`:
  - Input: `{ repositoryUrl: string, branch?: string, basePath?: string, authMethod: GitAuthMethod, authCredential: string }`
  - Encrypt the `authCredential` before storing (use application encryption utility)
  - Upsert `git_config` record (only one Git config per instance for MVP)
  - Set `enabled: false` initially — user must explicitly enable after testing connection
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement `testConnection(configId, ctx): Result<{ connected: boolean, error?: string }>`:
  - Fetch `git_config` by ID, decrypt credential
  - Attempt to connect to the repository (git ls-remote or equivalent)
  - Return connection status and any error message
  - RBAC: require Admin role
- [ ] Implement `exportEntity(entityId, ctx): Result<GitExportResult>`:
  - Fetch active `git_config` (must be enabled)
  - Fetch entity with current version, domain, and all emitted outputs
  - Generate file content for each export target:
    - `{basePath}/{domain}/{entity}.superschema.json` — full entity definition as JSON
    - `{basePath}/{domain}/{entity}.bq.sql` — BigQuery DDL (if emitted)
    - `{basePath}/{domain}/{entity}.avro.json` — Avro schema (if emitted)
    - `{basePath}/{domain}/{entity}.openapi.yaml` — OpenAPI schema (if emitted)
  - Clone or fetch the repo to a temp directory, checkout the configured branch
  - Write files, stage, commit with message: `"Update {entityName} v{version} — {changeSummary}"`
  - Set commit author to the user who triggered the export (name + email from ctx)
  - Push to remote
  - Update `git_config.lastSyncAt` and `lastSyncStatus`
  - On failure: log error, update `lastSyncStatus: FAILED`, return error result (do NOT roll back emission)
  - RBAC: require Author role on the entity's domain
  - Wrap in `withAudit()`
- [ ] Implement `exportAll(ctx): Result<GitExportResult>`:
  - Iterate all entities with emitted outputs
  - Generate files for each entity following the same structure
  - Create a single commit with all changes: `"Bulk export — {count} entities"`
  - Push to remote
  - Update `git_config.lastSyncAt` and `lastSyncStatus`
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement `enableExport(configId, ctx): Result<GitConfig>`:
  - Set `git_config.enabled = true`
  - Only allow if `testConnection` was successful (check `lastSyncStatus` or re-test)
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement `disableExport(configId, ctx): Result<GitConfig>`:
  - Set `git_config.enabled = false`
  - RBAC: require Admin role
  - Wrap in `withAudit()`
- [ ] Implement helper `buildExportFilePath(basePath, domain, entityName, format): string`:
  - Returns the correct file path based on format (e.g., `.bq.sql`, `.avro.json`, `.openapi.yaml`, `.superschema.json`)
- [ ] Implement helper `buildCommitMessage(entityName, version, changeSummary): string`:
  - Returns formatted commit message: `"Update {entityName} v{version} — {changeSummary}"`

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/git.ts` oRPC router
- [ ] Add `git.configure` mutation — thin wrapper calling `gitService.configureRepository()`, accepts `ConfigureRepositoryInput`, requires Admin role via `protectedProcedure`
- [ ] Add `git.testConnection` mutation — thin wrapper calling `gitService.testConnection()`, accepts `{ configId: string }`, requires Admin role via `protectedProcedure`
- [ ] Add `git.exportEntity` mutation — thin wrapper calling `gitService.exportEntity()`, accepts `{ entityId: string }`, requires Author role via `protectedProcedure`
- [ ] Add `git.exportAll` mutation — thin wrapper calling `gitService.exportAll()`, requires Admin role via `protectedProcedure`
- [ ] Add `git.enable` mutation — thin wrapper calling `gitService.enableExport()`, accepts `{ configId: string }`, requires Admin role via `protectedProcedure`
- [ ] Add `git.disable` mutation — thin wrapper calling `gitService.disableExport()`, accepts `{ configId: string }`, requires Admin role via `protectedProcedure`
- [ ] Add `git.getConfig` query — fetches current `git_config` record (redact `authCredential`), requires Admin role via `protectedProcedure`
- [ ] Wire router into `appRouter`

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/git.ts`:
  - `ConfigureRepositoryInput` — z.object({ repositoryUrl: z.string().url(), branch: z.string().min(1).default("main"), basePath: z.string().min(1).default("schemas/"), authMethod: z.enum(["SSH_KEY", "PERSONAL_ACCESS_TOKEN", "GITHUB_APP"]), authCredential: z.string().min(1) })
  - `TestConnectionInput` — z.object({ configId: z.string().cuid() })
  - `ExportEntityInput` — z.object({ entityId: z.string().cuid() })
  - `EnableDisableInput` — z.object({ configId: z.string().cuid() })
  - `GitConfigSchema` — Zod schema for the GitConfig response type (with `authCredential` omitted)
  - `GitExportResultSchema` — z.object({ success: z.boolean(), filesExported: z.number(), commitSha: z.string().optional(), error: z.string().optional() })

### Frontend — Admin Panel Git Tab
- [ ] Create `src/components/custom/AdminPanel/GitConfigTab.tsx`:
  - Repository URL input (text input with URL validation)
  - Branch input (text input, default "main")
  - Base path input (text input, default "schemas/")
  - Auth method selector (Shadcn Select: SSH Key, Personal Access Token, GitHub App)
  - Auth credential input: SSH Key → textarea, PAT → password input, GitHub App → JSON config textarea
  - "Save Configuration" button — calls `git.configure` mutation
  - "Test Connection" button — calls `git.testConnection` mutation, shows success/failure toast
  - Enable/Disable toggle — calls `git.enable` or `git.disable` mutation
  - Connection status indicator: green dot for connected, red dot for failed, gray dot for untested
  - Last sync timestamp and status display
- [ ] Add "Git" tab to Admin Panel tab bar (`src/components/custom/AdminPanel/AdminPanel.tsx` or equivalent):
  - New tab alongside existing admin tabs
  - Tab icon: Git branch icon

### Frontend — Entity Header "Push to Git" Button
- [ ] Modify entity header component (`src/components/custom/EntityEditor/EntityHeader.tsx` or equivalent):
  - Add "Push to Git" secondary button (only visible when Git is configured and enabled)
  - Button shows Git icon + "Push to Git" text
  - On click: calls `git.exportEntity` mutation with current entity ID
  - Loading state: button shows spinner during export
  - Success toast: "Pushed {entityName} to Git — {commitSha}"
  - Error toast: "Git push failed: {reason}"
  - Disabled state: when Git is not configured or not enabled, button is hidden or shows tooltip "Git not configured"

### Frontend — Hooks
- [ ] Create `src/hooks/useGitExport.ts`:
  - Hook wrapping oRPC mutations for Git export operations
  - Provides: `exportEntity` (mutation), `isExporting` (loading state), `gitConfig` (query for config status)
  - Auto-refetch config status after successful export
- [ ] Create `src/hooks/useGitConfig.ts`:
  - Hook wrapping oRPC queries/mutations for Git configuration
  - Provides: `config` (query), `saveConfig` (mutation), `testConnection` (mutation), `toggleEnabled` (mutation), `isTesting` (loading state)

### Frontend — Auto-Export on Emit Integration
- [ ] Modify emission flow (in the emit service or emit hook) to trigger Git export after successful emission:
  - After `emitEntity()` succeeds, check if Git is configured and enabled
  - If yes, call `gitService.exportEntity()` automatically
  - Show toast: "Emitted and pushed to Git" on success, or "Emitted successfully. Git push failed: {reason}" on Git failure
  - Git failure does NOT prevent emission success

### Testing
- [ ] **Unit tests** (`tests/unit/services/git.service.test.ts`):
  - configureRepository creates git_config record with encrypted credential
  - configureRepository rejects non-Admin users
  - testConnection returns connected: true for valid repository
  - testConnection returns connected: false with error for invalid repository
  - exportEntity generates correct file paths: `{basePath}/{domain}/{entity}.superschema.json`
  - exportEntity generates correct file paths for each emitter format (.bq.sql, .avro.json, .openapi.yaml)
  - exportEntity creates commit with correct message format
  - exportEntity sets commit author to the triggering user
  - exportEntity updates lastSyncAt and lastSyncStatus on success
  - exportEntity updates lastSyncStatus to FAILED on push failure
  - exportEntity does NOT roll back emission on Git failure
  - exportAll creates single commit with all entity files
  - enableExport sets enabled to true
  - disableExport sets enabled to false
  - buildExportFilePath returns correct paths for all formats
  - buildCommitMessage returns correctly formatted message
  - All write operations logged via withAudit()
- [ ] **Integration test** (`tests/integration/git-export.test.ts`):
  - Configure Git repository (using a temporary local Git repo)
  - Test connection to the configured repo
  - Create entity with fields, emit to BigQuery and Avro targets
  - Export entity to Git — verify files are committed with correct structure
  - Verify `.superschema.json` contains full entity definition
  - Verify `.bq.sql` contains BigQuery DDL
  - Verify `.avro.json` contains Avro schema
  - Verify commit message includes entity name and version
  - Verify `lastSyncAt` and `lastSyncStatus` are updated
- [ ] **E2E test** (`tests/e2e/git-export.spec.ts`):
  - Navigate to Admin Panel → Git tab
  - Configure repository URL, branch, and auth method
  - Click "Test Connection" → verify success indicator
  - Enable Git export toggle
  - Navigate to entity editor → click "Push to Git" button
  - Verify success toast appears
  - Verify entity header shows Git status indicator

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/git.service.ts` owns all Git export business logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All Git configuration and export write operations are logged to `audit_log`.
- **Credential encryption**: `authCredential` is encrypted at rest using the application's encryption utility. Decrypted only when needed for Git operations.
- **RBAC**: Admin role required for configuration operations (configure, test, enable/disable). Author role required for entity export. Enforced via `protectedProcedure` in oRPC middleware.
- **Non-blocking Git export**: Git push failures do NOT roll back emissions. The emission is always persisted locally. Git export is a best-effort push.
- **Single config for MVP**: Only one Git repository configuration per instance. Multi-repo support deferred to Phase 2.
- **Temporary directory strategy**: Each export clones/fetches the repo into a temp directory, writes files, commits, pushes, and cleans up. Consider caching the clone for performance in future iterations.
- **Auto-export trigger**: After successful emission, the emit flow checks `git_config.enabled` and triggers `exportEntity()` automatically. This is a fire-and-forget operation — emit success is independent of Git push success.

### UX/Design Requirements
- Admin Panel Git tab follows the existing Admin Panel tab pattern with form inputs and action buttons
- "Test Connection" button shows inline loading spinner and result toast
- Enable/Disable toggle uses Shadcn Switch component with confirmation for disabling
- "Push to Git" button in entity header is a secondary (outline) button with Git branch icon
- Git status in entity header is a compact badge: green "Pushed" / amber "Failed" / muted "Not configured"
- Toast messages follow existing toast pattern with appropriate severity (success/error)

### File Structure
```
src/services/git.service.ts                                    # Git export CRUD + export logic
src/types/schemas/git.ts                                       # Zod schemas — ConfigureRepositoryInput, GitExportResult, etc.
src/server/api/routers/git.ts                                  # oRPC router (Admin for config, Author for export)
src/components/custom/AdminPanel/GitConfigTab.tsx              # Admin Panel Git configuration tab
src/components/custom/EntityEditor/EntityHeader.tsx            # Modified — add "Push to Git" button
src/hooks/useGitExport.ts                                      # React hook for Git export mutations
src/hooks/useGitConfig.ts                                      # React hook for Git config queries/mutations
prisma/schema.prisma                                           # Modified — add git_config table, GitAuthMethod, GitSyncStatus enums
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/git.service.test.ts`): Service logic — configuration, export file generation, commit messages, error handling, RBAC, audit
- **Integration test** (`tests/integration/git-export.test.ts`): Full flow — configure → emit → export → verify Git repo contents
- **E2E test** (`tests/e2e/git-export.spec.ts`): UI flow — Admin Panel config, Test Connection, Push to Git button, success/error toasts

### Dependencies & Prerequisites
- Epic 2 (Entity Authoring) complete — entities with fields exist
- Epic 3 (Emission Pipeline) complete — emission targets with emittedOutput exist
- Epic 4 (Versioning) complete — entity_versions table exists for version references
- Admin Panel component exists with tab infrastructure
- Entity header component exists with button slots
- Application encryption utility exists for credential storage
- Git CLI or library (e.g., `isomorphic-git` or `simple-git`) available as a dependency

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, Git Export file structure, Data Architecture (git_config table)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Admin Panel layout, Entity Header buttons
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 10, Story 10.1
- PRD: FR38-FR40 (Git-Native Workflow)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
