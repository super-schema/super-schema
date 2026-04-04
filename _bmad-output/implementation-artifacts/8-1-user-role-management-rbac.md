# Story 8.1: User & Role Management (RBAC)

Status: review

## Story
As an **administrator**, I want to manage users and assign roles with domain-scoped permissions, so that I can control who can author, approve, and administer schemas.

## Acceptance Criteria

**Given** basic authentication works (Epic 1 complete)
**When** RBAC user management is implemented
**Then** the Prisma schema includes a `user_roles` table: `id` (cuid), `userId` (FK to users), `role` (enum: VIEWER, AUTHOR, STEWARD, COMPLIANCE_OFFICER, ADMIN), `domainId` (FK to domains, nullable — null means system-level role), `createdAt`
**And** a user can have **multiple roles** — one per domain plus optionally a system-level role; the most permissive applicable role is used for any given action
**And** the RBAC model enforces permissions as defined in the Architecture document:
**And** **Viewer** (domain or system): read entities, view emissions, browse compliance
**And** **Author** (domain): Viewer + create/edit entities in that domain, emit, view governance
**And** **Steward** (domain): Author + approve/reject governance requests, create type mapping overrides
**And** **Compliance Officer** (system): query compliance across all domains, export reports, view audit trail
**And** **Admin** (system): all permissions + user/role management, domain management, emitter configuration, system health
**And** oRPC middleware is updated: `protectedProcedure` checks session; new `authorProcedure`, `stewardProcedure`, `complianceProcedure`, and `adminProcedure` base procedures check the required role (and domain scope where applicable) — unauthorized access returns `ORPCError('FORBIDDEN')` with message "Requires {role} role" and `suggestedFix: "Contact your administrator"`
**And** the **Admin Panel** (Activity Bar → Admin) includes a **Users tab** displaying a DataTable of all users: email, name, roles (badges per domain), last login, status
**And** clicking a user opens a detail panel: edit name, view linked auth providers, and a **roles editor** — a list of current roles (role + domain badge) with "Remove" button on each, and an "Add Role" button that opens a form: role dropdown + domain dropdown (or "System-level" checkbox for COMPLIANCE_OFFICER/ADMIN)
**And** only **Admin** role users can access the Admin Panel — non-admin users see the Admin icon in the Activity Bar grayed out with tooltip "Requires Admin role"
**And** the first user who registers in a fresh installation is automatically assigned the **Admin** role (bootstrap mechanism)
**And** an admin cannot remove their own Admin role (safety check) — attempting to do so shows error "Cannot remove your own admin role"
**And** unit tests verify: each role permits only its documented operations, domain-scoped roles only apply within their domain, system-level roles apply globally, most permissive role is used, first user gets Admin role, admin cannot self-remove
**And** integration test: create users with different roles → verify each user can/cannot perform expected operations via oRPC procedures
**And** a Playwright E2E test verifies: admin can view user list, add a role to a user, remove a role, non-admin user cannot access Admin panel

## Tasks / Subtasks

### Database — Prisma Schema
- [x] Add `Role` enum to `prisma/schema.prisma`: `VIEWER`, `AUTHOR`, `STEWARD`, `COMPLIANCE_OFFICER`, `ADMIN`
- [x] Add `user_roles` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `userId` String (FK to users)
  - `role` Role (enum)
  - `domainId` String? (FK to domains, nullable — null = system-level)
  - `createdAt` DateTime @default(now())
  - Relation: user (User), domain (Domain?)
  - Unique constraint on (userId, role, domainId) to prevent duplicate role assignments
  - Index on (userId) for fast role lookups
- [x] Run `npx prisma migrate dev` to generate and apply migration
- [x] Add seed data in `prisma/seed.ts`: bootstrap logic — if no users exist with ADMIN role, assign ADMIN to the first user

### Backend — RBAC Service
- [x] Create `src/services/rbac.service.ts`
- [x] Implement `getUserRoles(userId, ctx): Result<UserRole[]>`:
  - Fetch all roles for a user from `user_roles` table
  - Return array of `{ role, domainId, domainName }` objects
- [x] Implement `assignRole(input, ctx): Result<UserRole>`:
  - Validate input via Zod: userId (string), role (Role enum), domainId (string, optional)
  - Enforce: COMPLIANCE_OFFICER and ADMIN must be system-level (domainId = null)
  - Enforce: VIEWER, AUTHOR, STEWARD require domainId
  - Prevent duplicate role assignments (same user + role + domain)
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log role assignment to audit trail
- [x] Implement `removeRole(id, ctx): Result<void>`:
  - Safety check: if removing Admin role, verify the user is not the current user (admin cannot self-remove)
  - Safety check: ensure at least one Admin remains in the system
  - RBAC: require Admin role
  - Wrap in `withAudit()` — log role removal to audit trail
- [x] Implement `getEffectiveRole(userId, domainId, ctx): Result<Role>`:
  - Fetch all roles for user
  - Filter to roles applicable to the given domain (domain-specific + system-level)
  - Return the most permissive role (ADMIN > COMPLIANCE_OFFICER > STEWARD > AUTHOR > VIEWER)
  - If no roles found, return null (no access)
- [x] Implement `hasPermission(userId, requiredRole, domainId, ctx): Result<boolean>`:
  - Get effective role for user + domain
  - Compare against required role using permission hierarchy
  - Return true if effective role is >= required role
- [x] Implement `bootstrapFirstAdmin(userId, ctx): Result<void>`:
  - Check if any user_roles with role=ADMIN exist
  - If not, assign ADMIN to the given userId
  - Called during user registration flow

### Backend — User Management Service
- [x] Create `src/services/user.service.ts` (or extend existing)
- [x] Implement `getUsers(ctx): Result<UserWithRoles[]>`:
  - Fetch all users with their roles (include user_roles with domain relation)
  - RBAC: require Admin role
- [x] Implement `getUserById(id, ctx): Result<UserWithRoles>`:
  - Fetch single user with roles
  - RBAC: require Admin role
- [x] Implement `updateUser(id, input, ctx): Result<User>`:
  - Allow updating name
  - RBAC: require Admin role
  - Wrap in `withAudit()`

### Backend — oRPC Middleware & Base Procedures
- [x] Update `src/server/api/orpc.ts` (oRPC middleware setup):
  - `protectedProcedure`: checks valid session (existing)
  - Add `authorProcedure`: extends protectedProcedure, checks Author role (or higher) for the relevant domain
  - Add `stewardProcedure`: extends protectedProcedure, checks Steward role (or higher) for the relevant domain
  - Add `complianceProcedure`: extends protectedProcedure, checks Compliance Officer role (or higher, system-level)
  - Add `adminProcedure`: extends protectedProcedure, checks Admin role (system-level)
  - On role check failure: throw `ORPCError('FORBIDDEN')` with `{ message: "Requires {role} role", suggestedFix: "Contact your administrator" }`
- [x] Domain-scoped procedures extract `domainId` from input or context and pass to `hasPermission()`

### Backend — oRPC Router
- [x] Create `src/server/api/routers/admin/users.ts` oRPC router
- [x] Add `users.getAll` query — thin wrapper calling `userService.getUsers()`, Admin-only
- [x] Add `users.getById` query — thin wrapper calling `userService.getUserById()`, Admin-only
- [x] Add `users.update` mutation — thin wrapper calling `userService.updateUser()`, Admin-only
- [x] Add `users.getRoles` query — thin wrapper calling `rbacService.getUserRoles()`, Admin-only
- [x] Add `users.assignRole` mutation — thin wrapper calling `rbacService.assignRole()`, Admin-only
- [x] Add `users.removeRole` mutation — thin wrapper calling `rbacService.removeRole()`, Admin-only
- [x] Wire router into `appRouter` under `admin.users` namespace

### Backend — Zod Schemas
- [x] Create `src/types/schemas/rbac.ts`:
  - `RoleEnum` Zod schema (z.enum(['VIEWER', 'AUTHOR', 'STEWARD', 'COMPLIANCE_OFFICER', 'ADMIN']))
  - `AssignRoleInput` schema: userId (z.string()), role (RoleEnum), domainId (z.string().optional())
  - `RemoveRoleInput` schema: id (z.string())
  - `UserWithRoles` schema: user fields + roles array
- [x] Create `src/types/schemas/user.ts`:
  - `UpdateUserInput` schema: id (z.string()), name (z.string().optional())

### Frontend — Admin Panel Layout
- [x] Create `src/app/(dashboard)/admin/page.tsx` — Admin panel entry page
- [x] Create `src/app/(dashboard)/admin/layout.tsx` — Admin layout with tab navigation (Users, Domains, Emitters, Health, Classifications)
- [x] Implement Admin route protection: redirect non-admin users to dashboard with toast "Requires Admin role"
- [x] Update Activity Bar component: gray out Admin icon for non-admin users with tooltip "Requires Admin role"

### Frontend — Users Tab UI Components
- [x] Create `src/components/custom/admin/UserDataTable.tsx`:
  - DataTable using Shadcn DataTable pattern
  - Columns: email, name, roles (rendered as badges per domain), last login, status
  - Row click opens user detail panel
  - Search/filter by name or email
- [x] Create `src/components/custom/admin/UserDetailPanel.tsx`:
  - Slide-over or right panel showing user details
  - Editable name field with save button
  - Auth providers list (read-only)
  - Roles editor section (see below)
- [x] Create `src/components/custom/admin/RolesEditor.tsx`:
  - List of current roles: each row shows role name + domain badge (or "System" badge) + "Remove" button
  - "Add Role" button opens inline form
  - Role dropdown: VIEWER, AUTHOR, STEWARD, COMPLIANCE_OFFICER, ADMIN
  - Domain dropdown (filtered from available domains) — disabled when COMPLIANCE_OFFICER or ADMIN selected, replaced with "System-level" indicator
  - Confirmation dialog on remove
  - Error display: "Cannot remove your own admin role" if applicable
- [x] Create `src/hooks/useAdminUsers.ts`:
  - oRPC query hooks for user list, user detail, roles
  - oRPC mutation hooks for assignRole, removeRole, updateUser
  - Optimistic updates for role changes

### Testing
- [x] **Unit tests** (`tests/unit/services/rbac.service.test.ts`):
  - Viewer can only read entities, view emissions, browse compliance
  - Author can do Viewer + create/edit entities in their domain, emit, view governance
  - Steward can do Author + approve/reject governance, manage overrides in their domain
  - Compliance Officer can query compliance across all domains, export reports
  - Admin has all permissions
  - Domain-scoped roles only apply within their assigned domain
  - System-level roles (ADMIN, COMPLIANCE_OFFICER) apply globally
  - Most permissive applicable role is used when user has multiple roles
  - First user gets Admin role (bootstrap mechanism)
  - Admin cannot remove their own Admin role
  - Duplicate role assignment is rejected
  - At least one Admin must remain in the system
- [x] **Unit tests** (`tests/unit/services/user.service.test.ts`):
  - getUsers returns all users with roles (Admin only)
  - getUserById returns single user with roles
  - updateUser updates name and logs to audit
  - Non-admin access is rejected
- [x] **Integration test** (`tests/integration/rbac.test.ts`):
  - Create users with different roles via oRPC
  - Verify Author can create entity in assigned domain but not another domain
  - Verify Steward can approve governance in assigned domain
  - Verify Viewer cannot create entities
  - Verify Admin can access all admin procedures
  - Verify non-admin gets FORBIDDEN error on admin procedures
- [x] **Playwright E2E test** (`tests/e2e/admin-users.spec.ts`):
  - Admin navigates to Admin Panel → Users tab
  - User list displays with correct columns
  - Click user → detail panel opens
  - Add a role to a user → role badge appears
  - Remove a role from a user → role badge disappears
  - Non-admin user cannot access Admin panel (icon grayed out, redirect on direct URL)

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/rbac.service.ts` and `src/services/user.service.ts` own all business logic. oRPC router is a thin wrapper.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw.
- **withAudit()**: All role assignment/removal and user updates are logged to `audit_log`.
- **RBAC enforcement**: Two layers — oRPC middleware (base procedures) for route-level checks, and service-level `hasPermission()` for fine-grained domain-scoped checks.
- **Permission hierarchy**: ADMIN > COMPLIANCE_OFFICER > STEWARD > AUTHOR > VIEWER. Most permissive applicable role wins.
- **Bootstrap mechanism**: First registered user auto-receives ADMIN role. Implemented in registration flow, not seed data (seed is for dev convenience).
- **oRPC base procedures**: `protectedProcedure` (session), `authorProcedure` (Author+), `stewardProcedure` (Steward+), `complianceProcedure` (Compliance Officer+), `adminProcedure` (Admin). Domain-scoped procedures extract domainId from input.

### UX/Design Requirements
- Admin Panel is accessible via Activity Bar icon (shield/gear icon)
- Non-admin users see the icon grayed out with tooltip
- Users tab is the default tab in Admin Panel
- Role badges use color coding: ADMIN (red), STEWARD (amber), AUTHOR (blue), COMPLIANCE_OFFICER (purple), VIEWER (gray)
- Domain badges next to roles show which domain the role applies to; system-level roles show "System" badge
- Confirmation dialog when removing roles

### File Structure
```
prisma/schema.prisma                                    # Extended — Role enum, user_roles table
prisma/seed.ts                                          # Extended — bootstrap Admin role
src/services/rbac.service.ts                            # RBAC business logic
src/services/user.service.ts                            # User management (Admin)
src/types/schemas/rbac.ts                               # Zod schemas — RoleEnum, AssignRoleInput
src/types/schemas/user.ts                               # Zod schemas — UpdateUserInput
src/server/api/orpc.ts                                  # Modified — new base procedures (adminProcedure, etc.)
src/server/api/routers/admin/users.ts                   # oRPC router (Admin-only)
src/app/(dashboard)/admin/page.tsx                      # Admin panel entry page
src/app/(dashboard)/admin/layout.tsx                    # Admin panel layout with tabs
src/components/custom/admin/UserDataTable.tsx            # Users tab DataTable
src/components/custom/admin/UserDetailPanel.tsx          # User detail slide-over
src/components/custom/admin/RolesEditor.tsx              # Role assignment/removal UI
src/hooks/useAdminUsers.ts                              # oRPC hooks for user/role management
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/rbac.service.test.ts`): 12+ test cases covering permission hierarchy, domain scoping, bootstrap, self-removal prevention
- **Unit tests** (`tests/unit/services/user.service.test.ts`): 4+ test cases covering user CRUD with role data
- **Integration test** (`tests/integration/rbac.test.ts`): End-to-end role enforcement across oRPC procedures
- **Playwright E2E** (`tests/e2e/admin-users.spec.ts`): Admin user management workflow

### Dependencies & Prerequisites
- Epic 1 (Auth) complete — user sessions and authentication working
- Story 2.1 (Domain model) complete — domains table exists for domain-scoped roles
- Auth.js v5 with Prisma adapter — user table exists

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — RBAC model, Authentication & Security, Module Boundaries (Admin module)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Admin Panel layout, Activity Bar
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 8, Story 8.1
- PRD: FR38-FR43 (Administration & Platform), FR38 (RBAC)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
