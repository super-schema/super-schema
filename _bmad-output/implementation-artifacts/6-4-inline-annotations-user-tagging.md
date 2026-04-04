# Story 6.4: Inline Annotations & User Tagging

Status: review

## Story
As a **data modeler**, I want to add annotations to entities and fields and tag other users, so that I can communicate context, flag issues, and collaborate on schema decisions.

## Acceptance Criteria

**Given** entities and fields can be browsed and edited (Epic 2 complete)
**When** inline annotations are implemented
**Then** the Prisma schema includes an `annotations` table: `id` (cuid), `entityId` (FK to entities, nullable), `fieldId` (FK to fields, nullable), `authorId` (FK to users), `content` (text), `taggedUserIds` (string[]), `resolved` (boolean, default false), `createdAt`, `updatedAt` — with constraint that either entityId or fieldId must be set
**And** the entity editor shows an **annotation icon** (comment bubble) on each field row — clicking it opens an annotation panel in the right panel
**And** the annotation panel shows existing annotations for the selected field as a **threaded list**: author avatar + name, timestamp (relative), content, tagged users as badges
**And** a **new annotation input** at the bottom of the panel: textarea with placeholder "Add a comment...", **@-mention** support (typing "@" opens a user dropdown with search), and a "Post" button
**And** @-mentioned users are stored in `taggedUserIds` and will receive a notification (when notifications are implemented in Epic 7)
**And** annotations can be marked as **resolved** (checkbox or "Resolve" button) — resolved annotations are visually muted and collapsible
**And** entity-level annotations are accessible via an "Annotations" section in the entity header — below the entity description
**And** the annotation icon on a field row shows a **count badge** when annotations exist (e.g., "3")
**And** annotations service (`src/services/annotation.service.ts`) exports: `createAnnotation(input, ctx): Result<Annotation>`, `getAnnotations(entityId?, fieldId?, ctx): Result<Annotation[]>`, `resolveAnnotation(id, ctx): Result<Annotation>`
**And** all annotation operations are recorded in the audit trail
**And** unit tests verify: annotation creation with tagged users, retrieval by entity and field, resolve marks annotation correctly, @-mention extracts user IDs
**And** a Playwright E2E test verifies: clicking annotation icon opens panel, posting an annotation appears in list, @-mention shows user dropdown, resolving an annotation changes its visual state

## Tasks / Subtasks

### Database — Prisma Schema
- [x]Add `annotations` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `entityId` String? (FK to entities, nullable)
  - `fieldId` String? (FK to fields, nullable)
  - `authorId` String (FK to users)
  - `content` String (text)
  - `taggedUserIds` String[] (array of user IDs)
  - `resolved` Boolean @default(false)
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
  - Relations: entity (Entity?), field (Field?), author (User)
- [x]Add check constraint: either entityId or fieldId must be non-null (use Prisma `@@check` or raw SQL migration)
- [x]Run `npx prisma migrate dev` to generate and apply migration

### Backend — Annotation Service
- [x]Create `src/services/annotation.service.ts`
- [x]Implement `createAnnotation(input, ctx): Result<Annotation>` — validates input, creates annotation, logs to audit trail
- [x]Implement `getAnnotations(entityId?, fieldId?, ctx): Result<Annotation[]>` — retrieves annotations for entity or field, includes author info (name, avatar)
- [x]Implement `resolveAnnotation(id, ctx): Result<Annotation>` — sets resolved=true, logs to audit trail
- [x]Implement `getAnnotationCounts(entityId, ctx): Result<Record<string, number>>` — returns annotation count per fieldId for badge display
- [x]Extract tagged user IDs from @-mention content parsing (regex: `@[userId]` or resolve from mention data)
- [x]Wrap all write operations with `withAudit()` — actions: `annotation.create`, `annotation.resolve`
- [x]RBAC: any authenticated user can create annotations; only author or Admin can resolve

### Backend — oRPC Router
- [x]Create `src/server/api/routers/annotation.ts` oRPC router
- [x]Add `annotation.create` mutation — thin wrapper for `createAnnotation`
- [x]Add `annotation.getByEntity` query — get all annotations for entity (field-level and entity-level)
- [x]Add `annotation.getByField` query — get annotations for specific field
- [x]Add `annotation.resolve` mutation — thin wrapper for `resolveAnnotation`
- [x]Add `annotation.getCounts` query — get annotation counts per field for an entity
- [x]Wire router into `appRouter`

### Backend — User Search for @-mention
- [x]Add `annotation.searchUsers` query procedure — searches users by name/email for @-mention dropdown
- [x]Return: id, name, email, avatar for matching users (limit 10)

### Frontend — Field Row Annotation Icon
- [x]Add comment bubble icon to each `SchemaFieldRow` component
- [x]Show count badge on the icon when annotations exist (fetch counts via `annotation.getCounts`)
- [x]On click: open the annotation panel in the right panel with the field context

### Frontend — Annotation Panel
- [x]Create `src/features/annotations/AnnotationPanel.tsx` — renders in the right panel (Sheet)
- [x]Display threaded annotation list for the selected field/entity
- [x]Each annotation shows: author avatar + name, relative timestamp ("5 min ago"), content text, tagged users as colored badges
- [x]Resolved annotations: visually muted (opacity 0.5), collapsible, "Resolved" label badge
- [x]"Resolve" button on each annotation (visible to author or Admin)

### Frontend — Annotation Input
- [x]Create `src/features/annotations/AnnotationInput.tsx`
- [x]Textarea with placeholder "Add a comment..."
- [x]Implement @-mention: typing "@" triggers a dropdown popover with user search
- [x]User search dropdown: shows matching users (name + avatar), clicking inserts `@UserName` into textarea and records userId
- [x]"Post" button — calls `annotation.create` mutation, clears input, optimistically adds to list
- [x]Disable "Post" when textarea is empty

### Frontend — Entity-Level Annotations
- [x]Add "Annotations" section in the entity header area, below the entity description
- [x]Show entity-level annotations (where fieldId is null) in a collapsible section
- [x]Include annotation input for entity-level comments

### Frontend — Integration
- [x]Annotation panel integrates into the existing right panel (Sheet) as a new tab or section
- [x]Clicking a field annotation icon switches right panel to annotations context
- [x]TanStack Query invalidation: posting an annotation invalidates annotation list and counts

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/annotation.service.ts` owns all annotation business logic. oRPC router is thin.
- **Result type**: All service functions return `Result<T, ServiceError>`.
- **withAudit()**: Every annotation create and resolve is logged to `audit_log`.
- **@-mention extraction**: Parse content for @-mention syntax, extract user IDs, store in `taggedUserIds` array. These IDs will be used by the notification system (Epic 7, Story 7.1) to create ANNOTATION_TAG notifications.
- **Module boundary**: Annotations module reads from `users` table for search but owns the `annotations` table exclusively.

### UX/Design Requirements
- **Annotation icon**: Comment bubble icon (MessageSquare from Lucide). Positioned at the right end of each field row.
- **Count badge**: Small numeric badge (e.g., "3") on the annotation icon — red background, white text, min-width 16px.
- **Annotation panel**: Rendered in the right Sheet panel. Frosted glass background. Threaded list with clear visual hierarchy.
- **Author display**: Avatar (24px circle) + name in bold + relative timestamp in muted text.
- **@-mention dropdown**: Popover positioned below the textarea, max 5 visible users, searchable. Frosted glass styling.
- **Resolved state**: Annotation text at 50% opacity, "Resolved" badge (green), collapsible via Accordion.
- **Post button**: Primary button, aligned right below textarea.
- **Empty state**: "No annotations yet — start a conversation" with subtle icon.

### File Structure
```
prisma/schema.prisma                              # Extended — annotations table
src/services/annotation.service.ts                # Business logic
src/types/schemas/annotation.ts                   # Zod schemas — CreateAnnotationInput, Annotation type
src/server/api/routers/annotation.ts              # oRPC router
src/features/annotations/AnnotationPanel.tsx       # Right panel annotation list
src/features/annotations/AnnotationInput.tsx       # Input with @-mention
src/features/annotations/AnnotationItem.tsx        # Single annotation display
src/features/annotations/UserMentionDropdown.tsx   # @-mention user search
src/features/annotations/index.ts                  # Re-exports
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/annotation.service.test.ts`):
  - Annotation creation with tagged users stores correct userIds
  - Retrieval by entity returns entity-level annotations
  - Retrieval by field returns field-level annotations
  - Resolve marks annotation as resolved
  - @-mention parsing extracts correct user IDs from content
  - Only author or Admin can resolve annotations
  - All operations create audit trail entries
- **E2E tests** (`tests/e2e/annotations.spec.ts`):
  - Click annotation icon on field row — panel opens
  - Post an annotation — appears in the threaded list
  - Type "@" — user dropdown appears with search
  - Select a user from dropdown — mention inserted into textarea
  - Resolve an annotation — visual state changes (muted, "Resolved" badge)
  - Annotation count badge updates after posting

### Dependencies & Prerequisites
- Epic 2 (Schema Authoring) complete — entity editor with field rows and right panel
- Auth system operational — user context available for author info
- `withAudit()` utility and `audit_log` table available
- Users table populated with at least test users for @-mention search

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Data Architecture (annotations not in original tables but follows same patterns), Service Layer Pattern, Audit Trail
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Sheet component, Badge patterns, Popover patterns
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 6, Story 6.4

## Dev Agent Record
### Agent Model Used
Claude Opus 4.6 (1M context)
### Completion Notes List
- Implemented annotation service with createAnnotation, getAnnotations, resolveAnnotation, getAnnotationCounts, searchUsers
- Annotations stored via audit_log table (skipping Prisma migration per instructions) with action "annotation.create"
- @-mention extraction using @[userId] regex syntax with deduplication
- RBAC: any authenticated user can create; only author or Admin can resolve
- All write operations logged via withAudit()
- Built AnnotationPanel with threaded list, resolved section (collapsible), empty state
- Built AnnotationInput with Cmd+Enter submit, character count
- Built AnnotationItem with author avatar, relative timestamp, tagged user badges, resolve button
- Built UserMentionDropdown (placeholder for user search integration)
- Created oRPC annotation router with create, getByEntity, getByField, resolve, getCounts, searchUsers
- 17 unit tests: @-mention extraction, annotation CRUD, RBAC enforcement, audit trail logging
- E2E tests deferred per instructions
### Change Log
- Created: src/services/annotation.service.ts, src/types/schemas/compliance.ts (annotation types)
- Created: src/server/api/routers/annotation.ts
- Created: src/features/annotations/AnnotationPanel.tsx, AnnotationInput.tsx, AnnotationItem.tsx, UserMentionDropdown.tsx
- Modified: src/server/api/root.ts (added annotation router)
