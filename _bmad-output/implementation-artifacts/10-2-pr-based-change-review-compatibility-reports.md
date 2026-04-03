# Story 10.2: PR-Based Change Review with Compatibility Reports

Status: ready-for-dev

## Story
As a **data engineer**, I want schema changes exported as Git pull requests with compatibility reports, so that team members can review schema changes through their existing Git workflow.

## Acceptance Criteria

**Given** Git export works (Story 10.1 complete)
**When** PR-based review is implemented
**Then** when a **breaking change** is emitted and Git is configured, the export service creates a **pull request** (instead of pushing directly to the main branch):
**And** a new branch is created: `schema/{entity-name}/v{version}` (e.g., `schema/transaction/v3`)
**And** the changed files are committed to the new branch
**And** a PR is created via the Git provider's API (GitHub initially — using `GITHUB_TOKEN` env var):
**And** PR title: "Schema: {entityName} v{version} — {changeType}"
**And** PR body includes: change summary (from change record), change classification (breaking/non-breaking), per-target compatibility report (from impact analysis), migration artifact summaries (ALTER statements, compatibility), governance approval status, and a link back to the entity in Super Schema UI
**And** **Non-breaking changes** are pushed directly to the configured branch (no PR) with a commit containing the change summary in the commit message
**And** the PR body is formatted as Markdown with collapsible sections for migration artifacts (using `<details>` tags)
**And** the Git config includes a `prReviewMode` setting: "always" (PR for all changes), "breaking-only" (PR only for breaking changes, default), or "never" (always direct push)
**And** the PR status is tracked in a `git_pull_requests` table: `id`, `entityId`, `versionId`, `prUrl` (string), `prNumber` (int), `status` (OPEN, MERGED, CLOSED), `createdAt`
**And** the entity's Git status is displayed in the entity header: "Git: pushed ✓" (green), "Git: PR #123 open" (amber link), or "Git: not configured" (muted)
**And** unit tests verify: breaking change creates PR with correct branch name, non-breaking change pushes directly, PR body includes all required sections (compatibility, migration, governance), prReviewMode setting controls behavior
**And** integration test (using GitHub API mock): emit a breaking change → PR is created with correct body → PR URL is stored in database

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Add `prReviewMode` field to `git_config` table:
  - `prReviewMode` Enum(ALWAYS, BREAKING_ONLY, NEVER) @default(BREAKING_ONLY)
- [ ] Create `PrReviewMode` enum: `ALWAYS`, `BREAKING_ONLY`, `NEVER`
- [ ] Create `git_pull_requests` table in `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `entityId` String (FK to entities)
  - `versionId` String (FK to entity_versions)
  - `prUrl` String — full URL to the PR on the Git provider
  - `prNumber` Int — PR number on the Git provider
  - `branchName` String — the branch created for the PR (e.g., `schema/transaction/v3`)
  - `status` Enum(OPEN, MERGED, CLOSED) @default(OPEN)
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
- [ ] Create `GitPrStatus` enum: `OPEN`, `MERGED`, `CLOSED`
- [ ] Add relations: `git_pull_requests.entityId` → `entities.id`, `git_pull_requests.versionId` → `entity_versions.id`
- [ ] Run `npx prisma migrate dev` to generate and apply migration

### Backend — Service (`src/services/git-pr.service.ts`)
- [ ] Create `src/services/git-pr.service.ts`
- [ ] Implement `exportWithReview(entityId, versionId, changeRecord, ctx): Result<GitExportResult>`:
  - Fetch `git_config` — must be enabled
  - Fetch entity, version, emitted outputs, change record (from versioning/change tracking)
  - Determine if change is breaking or non-breaking (from change record classification)
  - Check `prReviewMode` setting:
    - `NEVER`: always direct push to configured branch (delegate to `gitService.exportEntity()`)
    - `BREAKING_ONLY` (default): create PR if breaking, direct push if non-breaking
    - `ALWAYS`: always create PR
  - For direct push: delegate to `gitService.exportEntity()` from Story 10.1
  - For PR creation: call `createPullRequest()` (below)
  - RBAC: require Author role on the entity's domain
  - Wrap in `withAudit()`
- [ ] Implement `createPullRequest(entity, version, changeRecord, emittedOutputs, ctx): Result<GitPrResult>`:
  - Create branch name: `schema/{entity-name}/v{version}` (slugified entity name)
  - Clone/fetch repo, create new branch from configured base branch
  - Write exported files to the new branch (same file structure as Story 10.1)
  - Commit with message: `"Schema: {entityName} v{version} — {changeType}"`
  - Push the new branch to remote
  - Build PR body using `buildPrBody()` helper
  - Create PR via GitHub API (using Octokit or fetch):
    - `POST /repos/{owner}/{repo}/pulls`
    - Title: `"Schema: {entityName} v{version} — {changeType}"`
    - Body: formatted Markdown with compatibility report
    - Base: configured branch (e.g., "main")
    - Head: the new branch
  - Store PR record in `git_pull_requests` table: entityId, versionId, prUrl, prNumber, branchName, status: OPEN
  - Return `GitPrResult`: `{ prUrl, prNumber, branchName }`
- [ ] Implement `buildPrBody(entity, version, changeRecord, emittedOutputs): string`:
  - Return Markdown-formatted PR body with sections:
    - **Change Summary**: from change record description
    - **Change Classification**: breaking/non-breaking badge
    - **Compatibility Report**: per-target impact analysis (field additions, removals, type changes)
    - **Migration Artifacts** (collapsible `<details>` section): ALTER statements for BigQuery, schema evolution notes for Avro, endpoint changes for OpenAPI
    - **Governance Status**: approval status from governance system (if applicable)
    - **Super Schema Link**: link back to entity in the UI (`{APP_URL}/entities/{entityId}`)
  - Use `<details><summary>` tags for collapsible migration artifact sections
- [ ] Implement `syncPrStatus(prId, ctx): Result<GitPullRequest>`:
  - Fetch PR status from GitHub API (`GET /repos/{owner}/{repo}/pulls/{prNumber}`)
  - Update `git_pull_requests.status` based on GitHub PR state (open → OPEN, merged → MERGED, closed → CLOSED)
  - RBAC: require Viewer role
- [ ] Implement `getPrHistory(entityId, ctx): Result<GitPullRequest[]>`:
  - Fetch all `git_pull_requests` for the given entity, ordered by `createdAt` desc
  - RBAC: require Viewer role
- [ ] Implement `getLatestPr(entityId, ctx): Result<GitPullRequest | null>`:
  - Fetch the most recent `git_pull_requests` record for the entity
  - Used for displaying Git status in entity header
  - RBAC: require Viewer role

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/git-pr.ts` oRPC router
- [ ] Add `gitPr.exportWithReview` mutation — thin wrapper calling `gitPrService.exportWithReview()`, accepts `{ entityId: string, versionId: string }`, requires Author role via `protectedProcedure`
- [ ] Add `gitPr.syncStatus` mutation — thin wrapper calling `gitPrService.syncPrStatus()`, accepts `{ prId: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `gitPr.getHistory` query — thin wrapper calling `gitPrService.getPrHistory()`, accepts `{ entityId: string }`, requires Viewer role via `protectedProcedure`
- [ ] Add `gitPr.getLatest` query — thin wrapper calling `gitPrService.getLatestPr()`, accepts `{ entityId: string }`, requires Viewer role via `protectedProcedure`
- [ ] Wire router into `appRouter`
- [ ] Update `git.configure` mutation (from Story 10.1 router) to accept the new `prReviewMode` field

### Backend — Zod Schemas
- [ ] Create `src/types/schemas/git-pr.ts`:
  - `ExportWithReviewInput` — z.object({ entityId: z.string().cuid(), versionId: z.string().cuid() })
  - `SyncPrStatusInput` — z.object({ prId: z.string().cuid() })
  - `GetPrHistoryInput` — z.object({ entityId: z.string().cuid() })
  - `GetLatestPrInput` — z.object({ entityId: z.string().cuid() })
  - `PrReviewModeSchema` — z.enum(["ALWAYS", "BREAKING_ONLY", "NEVER"])
  - `GitPrResultSchema` — z.object({ prUrl: z.string().url(), prNumber: z.number().int(), branchName: z.string() })
  - `GitPullRequestSchema` — Zod schema for the GitPullRequest response type (id, entityId, versionId, prUrl, prNumber, branchName, status, createdAt)
- [ ] Update `src/types/schemas/git.ts` (from Story 10.1):
  - Add `prReviewMode` to `ConfigureRepositoryInput`: `prReviewMode: PrReviewModeSchema.default("BREAKING_ONLY")`

### Frontend — Entity Header Git Status
- [ ] Modify entity header component (`src/components/custom/EntityEditor/EntityHeader.tsx`):
  - Add Git status badge next to the "Push to Git" button (from Story 10.1)
  - Fetch latest PR via `gitPr.getLatest` query
  - Display states:
    - No Git config: hidden (no badge)
    - Git configured, no PR: "Git: pushed ✓" (green badge) after successful push
    - PR open: "Git: PR #{prNumber} open" (amber badge, clickable — opens PR URL in new tab)
    - PR merged: "Git: PR #{prNumber} merged" (green badge)
    - PR closed: "Git: PR #{prNumber} closed" (muted badge)
  - "Sync Status" icon button — calls `gitPr.syncStatus` to refresh PR status from GitHub

### Frontend — Admin Panel PR Settings
- [ ] Modify `src/components/custom/AdminPanel/GitConfigTab.tsx` (from Story 10.1):
  - Add "PR Review Mode" setting section below the connection configuration:
    - Radio group or Select with options:
      - "Always create PR" (ALWAYS) — all schema changes go through PR review
      - "PR for breaking changes only" (BREAKING_ONLY, default) — non-breaking changes push directly
      - "Never create PR" (NEVER) — all changes push directly
    - Helper text explaining each mode
  - Save PR review mode as part of `git.configure` mutation

### Frontend — PR History Panel
- [ ] Create `src/components/custom/GitPanel/PrHistoryPanel.tsx`:
  - List of PRs for the current entity (displayed in Right Panel or as a section in the entity detail view)
  - Each PR row shows: PR number (link), branch name, status badge (OPEN/MERGED/CLOSED), created date
  - "Sync" button per row — refreshes status from GitHub
  - Empty state: "No pull requests for this entity"
- [ ] Create `src/components/custom/GitPanel/PrStatusBadge.tsx`:
  - Status badge component: OPEN (amber), MERGED (green/purple), CLOSED (red/muted)
  - Consistent with GitHub PR status colors
- [ ] Create `src/components/custom/GitPanel/index.ts`:
  - Re-exports for PrHistoryPanel and PrStatusBadge

### Frontend — Hooks
- [ ] Create `src/hooks/useGitPr.ts`:
  - Hook wrapping oRPC queries/mutations for PR operations
  - Provides: `latestPr` (query for current entity), `prHistory` (query), `syncStatus` (mutation), `exportWithReview` (mutation), `isExporting` (loading state)
  - Auto-refetch PR data after successful export or sync
- [ ] Update `src/hooks/useGitExport.ts` (from Story 10.1):
  - Modify export flow to call `exportWithReview` instead of direct `exportEntity` when PR review is applicable
  - Check `prReviewMode` from git config to determine behavior

### Frontend — Auto-Export Integration Update
- [ ] Modify emission flow integration (from Story 10.1) to use PR-aware export:
  - After successful emission, call `gitPrService.exportWithReview()` instead of `gitService.exportEntity()`
  - This respects the `prReviewMode` setting and creates PRs when appropriate
  - Toast messages:
    - Direct push success: "Emitted and pushed to Git"
    - PR created: "Emitted and PR #{prNumber} created for review"
    - Git failure: "Emitted successfully. Git push failed: {reason}"

### Testing
- [ ] **Unit tests** (`tests/unit/services/git-pr.service.test.ts`):
  - exportWithReview creates PR for breaking change when prReviewMode is BREAKING_ONLY
  - exportWithReview pushes directly for non-breaking change when prReviewMode is BREAKING_ONLY
  - exportWithReview always creates PR when prReviewMode is ALWAYS
  - exportWithReview never creates PR when prReviewMode is NEVER
  - createPullRequest creates correct branch name: `schema/{entity-name}/v{version}`
  - createPullRequest creates PR with correct title format
  - createPullRequest stores PR record in git_pull_requests table
  - buildPrBody includes change summary section
  - buildPrBody includes change classification (breaking/non-breaking)
  - buildPrBody includes per-target compatibility report
  - buildPrBody includes collapsible migration artifacts section
  - buildPrBody includes governance approval status
  - buildPrBody includes link back to Super Schema UI
  - buildPrBody uses `<details>` tags for collapsible sections
  - syncPrStatus updates status from GitHub API
  - getPrHistory returns PRs ordered by createdAt desc
  - getLatestPr returns most recent PR
  - All write operations logged via withAudit()
- [ ] **Integration test** (`tests/integration/git-pr-review.test.ts`):
  - Configure Git repository with prReviewMode: BREAKING_ONLY
  - Create entity, make a breaking change, emit
  - Verify PR is created via GitHub API mock
  - Verify git_pull_requests record is created with correct data (prUrl, prNumber, branchName, status: OPEN)
  - Verify PR body contains all required sections
  - Create entity, make a non-breaking change, emit
  - Verify direct push (no PR created)
  - Change prReviewMode to ALWAYS
  - Make non-breaking change, emit
  - Verify PR is created even for non-breaking change
- [ ] **E2E test** (`tests/e2e/git-pr-review.spec.ts`):
  - Navigate to Admin Panel → Git tab → set PR Review Mode to "Breaking changes only"
  - Navigate to entity editor → make a breaking change → emit
  - Verify toast: "PR #{prNumber} created for review"
  - Verify entity header shows "Git: PR #{prNumber} open" badge
  - Click PR badge → verify it links to the PR URL
  - Navigate to PR History panel → verify PR appears in the list
  - Click "Sync" on the PR → verify status updates

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/git-pr.service.ts` owns all PR-based review logic. Delegates to `git.service.ts` for underlying Git operations. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All PR creation and export operations are logged to `audit_log`.
- **Separation of concerns**: `git.service.ts` (Story 10.1) handles low-level Git operations (clone, commit, push). `git-pr.service.ts` (this story) handles PR-level logic (branch creation, PR creation via GitHub API, PR body generation, status tracking).
- **GitHub API integration**: Uses GitHub REST API (via Octokit or fetch) for PR creation and status checks. Authentication via `GITHUB_TOKEN` environment variable or the `authCredential` from `git_config`.
- **PR body generation**: The `buildPrBody()` helper assembles a rich Markdown body from multiple data sources (change record, compatibility analysis, migration artifacts, governance status). Uses `<details>` tags for collapsible sections to keep the PR readable.
- **RBAC**: Author role required for export/PR creation. Viewer role sufficient for PR status queries. Admin role for configuration changes. Enforced via `protectedProcedure` in oRPC middleware.
- **Change classification dependency**: This story relies on the change record from the versioning system (Epic 4) to determine if a change is breaking or non-breaking. The change record must include a `classification` field.
- **PR status lifecycle**: OPEN → MERGED (when merged on GitHub) or CLOSED (when closed without merge). Status is synced on-demand via `syncPrStatus()` — no webhooks for MVP.

### UX/Design Requirements
- Entity header Git status badge is compact — single line with PR number and status color
- PR badge is clickable — opens the PR URL in a new tab
- "Sync Status" is an icon button (refresh icon) next to the badge — not a full button with text
- Admin Panel PR Review Mode uses radio buttons with descriptions for each option
- PR History panel follows the same list pattern as other history/activity panels in the app
- PR status badges use GitHub-inspired colors: amber for open, green/purple for merged, muted for closed
- Toast messages for PR creation include the PR number for quick reference

### File Structure
```
src/services/git-pr.service.ts                                 # PR-based review logic + PR body generation
src/types/schemas/git-pr.ts                                    # Zod schemas — ExportWithReviewInput, GitPrResult, etc.
src/types/schemas/git.ts                                       # Modified — add PrReviewMode to ConfigureRepositoryInput
src/server/api/routers/git-pr.ts                               # oRPC router (Author for export, Viewer for queries)
src/components/custom/EntityEditor/EntityHeader.tsx            # Modified — add Git status badge
src/components/custom/AdminPanel/GitConfigTab.tsx              # Modified — add PR Review Mode setting
src/components/custom/GitPanel/PrHistoryPanel.tsx              # PR history list
src/components/custom/GitPanel/PrStatusBadge.tsx               # PR status badge component
src/components/custom/GitPanel/index.ts                        # Re-exports
src/hooks/useGitPr.ts                                          # React hook for PR queries/mutations
src/hooks/useGitExport.ts                                      # Modified — PR-aware export flow
prisma/schema.prisma                                           # Modified — add git_pull_requests table, PrReviewMode enum, GitPrStatus enum
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/git-pr.service.test.ts`): Service logic — PR creation, review mode behavior, PR body generation, status sync, RBAC, audit
- **Integration test** (`tests/integration/git-pr-review.test.ts`): Full flow — breaking change → PR created → status tracked → non-breaking change → direct push
- **E2E test** (`tests/e2e/git-pr-review.spec.ts`): UI flow — Admin Panel PR config, breaking change PR creation, entity header status, PR history panel

### Dependencies & Prerequisites
- Story 10.1 (Git Export Service) complete — git.service.ts, git_config table, Git configuration UI, export functionality exist
- Epic 4 (Versioning) complete — change records with breaking/non-breaking classification exist
- Epic 5 (Change Impact Analysis) complete — compatibility reports and migration artifacts exist
- Epic 6 (Governance) complete — governance approval status available (optional — degrade gracefully if not present)
- GitHub API access — `GITHUB_TOKEN` environment variable or GitHub App credentials configured
- Octokit or equivalent HTTP client for GitHub API calls

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Service Layer Pattern, Git Export, PR-based review workflow
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Entity Header layout, Admin Panel tabs
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 10, Story 10.2
- PRD: FR38-FR40 (Git-Native Workflow)
- Story 10.1: `_bmad-output/implementation-artifacts/10-1-git-export-service-configuration.md` — Git export service and configuration

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
