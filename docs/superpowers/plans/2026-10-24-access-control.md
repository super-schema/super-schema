# Access control and user management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deny-by-default, scope-aware (global/tenant/domain/product) role-based access control with in-app user management, hardened local sign-in and Google sign-in, enforced at one choke point across server actions, API routes and page loaders.

**Architecture:** A pure policy module resolves the highest role covering a resource from a principal's assignments and maps actions to minimum roles. A principal loader (disabled check, assignments, per-request cache) and `authorize()` live in `action-context`; every server action, API handler and page loader goes through them. A new migration adds scope keys, invitations, tokens, auth events and audit tenancy. Admin UI manages users, invitations and scoped roles. A repository scan test fails when an exported server action or route handler has no guard and no reasoned allow-list entry.

**Tech Stack:** Next.js, Auth.js v5 (credentials + Google OIDC), Prisma (PGlite + PostgreSQL), zod, bcryptjs, Vitest, Playwright. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-access-control-design.md` (read it first; it has the decisions: action→role table, scope containment, grant rules, registration modes, bootstrap admin, Google rules, API key principal, migration columns).

## Global Constraints

- Deny by default. No assignment → no tenant content (reads answer NOT_FOUND like missing rows; mutations FORBIDDEN or NOT_FOUND per the existing `notFoundFailure` pattern: foreign and missing resources answer identically).
- Roles ladder `VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN`; scopes `GLOBAL` (ADMIN only) ⊃ `TENANT` ⊃ `DOMAIN` ⊃ `PRODUCT` ⊃ entity; a tenant-level entity (no domain/product) is covered by tenant and global assignments only; the effective role is the maximum over covering assignments.
- Single source for the action→minimum-role table: `src/lib/access/actions.ts`; no role strings or hierarchy arrays elsewhere (`APPROVER_ROLES`, `COMPLIANCE_ROLES`, type-mapping arrays, `!== "ADMIN"` checks are replaced).
- Grant rules: only an ADMIN covering the target scope assigns/revokes; nobody grants above their own role; last global ADMIN cannot be removed or disabled; no one removes their own admin role.
- Registration `AUTH_REGISTRATION=open|invite|closed`, default `invite`; e2e and dev use `open`. No first-registrant-becomes-admin; no default `admin/admin` in production; `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` or `npm run admin:create`.
- Emails normalized (trim + lower case), unique case-insensitively; password 12–72 bytes with a deny-list; uniform answers (no enumeration, no timing oracle); session `maxAge` 12 h, `updateAge` 1 h; disabled users refused at sign-in and on every request.
- Throttling and lockout from the database (`auth_events`), IP only from a trusted proxy header when `AUTH_TRUST_PROXY=1`.
- Google: provider shown only when configured; `email_verified` required; `GOOGLE_ALLOWED_DOMAINS` optional; no automatic linking to an existing local account.
- API key is a service principal bound to `API_KEY_TENANT_ID` (default the default tenant) and `API_KEY_ROLE` (default `ADMIN`); a session on `/api/v1` carries its real roles.
- Migration applies to PGlite and PostgreSQL via the project process (`docs/database.md`), backfills before constraining, adds no extensions, never destroys data.
- The seeded administrator stays a global ADMIN; existing e2e specs keep running. Tests that asserted "any signed-in user can do X" are updated honestly; known defects KD-016/020/023/024/025/026/027/028 flip and `docs/testing/known-defects.md` is updated in the same commit.
- New env names are accounted for in `scripts/e2e-env.mjs` groups (the env-scan test fails otherwise), documented in `.env.example` and `docs/`.
- No Co-Authored-By trailers. Gortex unavailable (plain tools authorised). Run the suite on Node 20.19.4 (`PATH=$HOME/.nvm/versions/node/v20.19.4/bin:$PATH`); the Node guard refuses 26.

## Review Focus

- A roleless signed-in user: reads nothing in any tenant, mutates nothing, cannot switch to a tenant they have no assignment in, cannot use `/api/v1` or `/api/*` for data, still gets notifications and their profile (Tasks 3, 5, 6).
- Domain-scoped and product-scoped roles actually take effect (today every caller passes `null`): an AUTHOR on domain A cannot write domain B nor tenant-level entities (Tasks 1, 3, 5).
- Server action POST to a guarded action without the role, with a foreign tenant resource, with a disabled user, with a stale session: refused (Tasks 3, 5).
- Last-admin and self-demotion protections under concurrency (two admins removing each other) (Task 7).
- Invitation/reset tokens: single use, expiry, hashed at rest, not guessable, not reusable after use, not leaking whether an e-mail exists (Tasks 4, 8).

---

### Task 1: Policy engine (pure)

**Files:**
- Create: `src/lib/access/scope.ts`, `src/lib/access/policy.ts`, `src/lib/access/actions.ts`, `src/lib/access/index.ts`
- Modify: `src/types/schemas/rbac.ts` (roles stay; scope types added; `SYSTEM_ONLY_ROLES`/`DOMAIN_SCOPED_ROLES` replaced by scope validity: `GLOBAL` only ADMIN)
- Test: `tests/unit/lib/access/policy.test.ts`

**Interfaces:**
- Produces: `type Scope = { kind: "GLOBAL" } | { kind: "TENANT"; tenantId: string } | { kind: "DOMAIN"; tenantId: string; domainId: string } | { kind: "PRODUCT"; tenantId: string; domainId: string; productId: string }`; `type Assignment = { role: Role; scope: Scope }`; `type ResourceRef = { tenantId: string; domainId?: string | null; productId?: string | null }`; `scopeKey(scope): string` (`G`, `T:<id>`, `D:<id>`, `P:<id>`) and `parseScopeKey(key): Scope | undefined`; `covers(scope: Scope, resource: ResourceRef): boolean`; `effectiveRole(assignments: Assignment[], resource: ResourceRef): Role | null`; `ACTIONS` (a `const` map action id → `{ minRole: Role; level: "resource" | "tenant" | "global" }`); `can(assignments: Assignment[], action: ActionId, resource: ResourceRef): boolean`; `grantAllowed(granter: Assignment[], role: Role, target: Scope): boolean`; `isValidAssignment(role: Role, scope: Scope): boolean`.

- [ ] **Step 1: Write failing tests**: a role × scope × action matrix (table-driven, every action in `ACTIONS`); cross-tenant never applies; global ADMIN applies everywhere, global non-ADMIN invalid; DOMAIN covers its products and entities but not siblings nor tenant-level entities; TENANT covers every domain/product/entity of that tenant only; unknown action id denied; empty assignments → `effectiveRole` null → every action denied; `grantAllowed`: tenant ADMIN may grant ≤ ADMIN within the tenant and below, domain STEWARD may not grant, nobody grants above own role, an ADMIN of tenant A cannot grant in tenant B; `isValidAssignment` rejects GLOBAL for non-ADMIN; the `ACTIONS` table matches the spec's action→role list (a snapshot of ids and roles so a change is deliberate).
- [ ] **Step 2: Run** `npx vitest run tests/unit/lib/access/policy.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the modules (pure, no I/O, no throws, bounded). Action ids are dotted strings (`entity.read`, `entity.write`, `entity.publish`, `domain.create`, `product.create`, `domain.delete`, `governance.decide`, `retention.write`, `compliance.query`, `compliance.audit`, `user.manage`, `role.assign`, `platform.admin`, `tenant.admin`, `glossary.write`, `event.write`, `trait.write`, `import.run`, `deploy.run`, `typemapping.global`, `typemapping.entity`, `notification.own`, …): enumerate every distinct operation found by the enforcement map in the fact sheet (`.superpowers/sdd/2026-10-23-release-ui-suite` not needed: grep each actions file) so later tasks only map calls to ids.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(access): pure scope-aware policy engine and the action table`.

### Task 2: Data migration

**Files:**
- Create: `prisma/migrations/<timestamp>_access_control/migration.sql` (name later than `20261020_drop_legacy_event_catalog`), changes in `prisma/schema.prisma`
- Modify: `prisma/seed.ts`, `src/lib/admin-bootstrap.ts`, `src/lib/access-control.ts` (stop calling bootstrap from a read path), `src/services/rbac.service.ts` (duplicate `bootstrapFirstAdmin` removed)
- Create: `scripts/admin-create.mjs` (+ `package.json` script `admin:create`)
- Test: `tests/unit/lib/admin-bootstrap.test.ts` (rewritten), `tests/integration/access-control-migration.test.ts` (applies the migration to PGlite and checks backfill/constraints), `tests/unit/scripts/admin-create.test.ts`

**Interfaces:**
- Consumes: Task 1 `scopeKey`.
- Produces: tables/columns: `users.disabledAt`, `users.lastLoginAt`, unique index on `lower(email)` (migration first lower-cases existing e-mails and fails with a clear message listing duplicates if any exist); `user_roles.scopeKey` (backfilled from `tenantId/domainId/productId`; `tenantId` backfilled from the domain/product when null), `user_roles.grantedById`, unique `(userId, role, scopeKey)` replacing the NULL-distinct index, CHECK `scopeKey` shape; `invitations` (id, emailLower, tokenHash, expiresAt, usedAt, createdById, createdAt) + `invitation_roles` (invitationId, role, scopeKey); `auth_tokens` (id, userId?, kind `INVITE|RESET`, tokenHash, expiresAt, usedAt, createdAt); `auth_events` (id, kind, emailHash, ipHash, createdAt, outcome); `audit_log.tenantId` nullable + backfill where derivable from the entity. `ensureBootstrapAdmin({ email, password })` only runs from the seed and `admin:create` (never from a request path); the seed's `admin@admin.com`/`admin` runs only when `NODE_ENV !== "production"` or `BOOTSTRAP_ADMIN_*` are set (then uses them).

- [ ] **Step 1: Write failing tests**: the migration applied on a PGlite database seeded with the OLD schema rows (duplicate-case e-mails absent; global, domain-scoped and tenant-null roles) yields correct `scopeKey`/`tenantId`, the unique constraint refuses a duplicate global ADMIN row (the old NULL-distinct hole), the CHECK refuses a bad key; `admin-bootstrap` creates the first admin only through `ensureBootstrapAdmin`, is idempotent, never from `resolveGlobalAdminAccess`; `admin:create` refuses weak passwords and existing e-mails with a clear message.
- [ ] **Step 2: Run** the tests — expect FAIL.
- [ ] **Step 3: Implement**: author the migration against PostgreSQL per `docs/database.md` (`DB_PROVIDER=postgresql DATABASE_URL=<throwaway> npm run db:migrate -- --name access_control`, throwaway local PostgreSQL via `pg_ctl` under /tmp), verify `npm run db:deploy` applies it to PGlite, update the Prisma schema and generated client usage, seed, bootstrap helpers and the script.
- [ ] **Step 4: Run** the tests plus `npx vitest run tests/unit/services/rbac.service.test.ts tests/unit/app/register-actions.test.ts` (update their mocks only as the new schema requires) — expect PASS.
- [ ] **Step 5: Commit** `feat(access): schema for scoped roles, disabled users, invitations, tokens, auth events, audit tenancy; bootstrap admin only from seed/script`.

### Task 3: Principal, guard, tenant membership

**Files:**
- Modify: `src/lib/action-context.ts`, `src/lib/active-tenant.ts`, `src/lib/current-user.ts` (remove the e-mail fallback), `src/lib/require-session.ts`, `src/app/(dashboard)/schemas/tenant-actions.ts`, `src/app/api/tenants/route.ts`, `src/services/rbac.service.ts` (assignments loaded with scope; `getEffectiveRole` removed or reimplemented on the policy)
- Create: `src/lib/access/principal.ts`, `tests/helpers/access-mocks.ts` (shared mock helper for the many unit tests that mock `@/lib/auth`/rbac)
- Test: `tests/unit/lib/access/principal.test.ts`, `tests/unit/lib/action-context.test.ts` (updated), `tests/unit/app/tenant-actions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`can`, `effectiveRole`, `Assignment`, `ResourceRef`), Task 2 columns.
- Produces: `getPrincipal(): Promise<Principal | null>` (`{ userId: string; email: string; assignments: Assignment[]; isGlobalAdmin: boolean }`; null when no session, user missing or `disabledAt` set; cached per request via `react.cache`/`AsyncLocalStorage`-style so repeated calls are one query; NO e-mail fallback); `authorize(action: ActionId, resource: ResourceRef): Promise<Result<Principal, ServiceError>>` (FORBIDDEN when the principal has some role covering the resource but too low; NOT_FOUND when no assignment covers the resource's tenant; UNAUTHORIZED when no principal); `authorizeTenant(action, tenantId)`; `resolveResourceRef(kind, id): Promise<ResourceRef | null>` generalising `TENANT_OF` (entity, field, domain, product, model, modelField, sharedEnum, customScalar, unionType, service, operation, event, trait…); `accessibleTenants(principal): Promise<Tenant[]>`; `getActiveTenantId()` returns the cookie tenant only if the principal may access it, else the first accessible tenant (global admin: first active), else throws a typed `NoTenantAccess` that pages convert to the "no access yet" screen; `setActiveTenantAction` accepts only accessible tenants; `/api/tenants` lists only accessible tenants; `requireSession()` unchanged contract plus disabled-user denial; `runMutation`/`withOwnedTarget` take an `action` parameter and call `authorize`.

- [ ] **Step 1: Write failing tests**: disabled user denied everywhere; roleless user: `authorize` NOT_FOUND for any resource, `getActiveTenantId` throws `NoTenantAccess`, `setActiveTenantAction` refuses; tenant switch to a tenant with an assignment works; domain-scoped AUTHOR passes for an entity in that domain, fails (NOT_FOUND vs FORBIDDEN as specified) for a sibling domain and for a tenant-level entity; global admin passes; foreign and missing resources produce identical results (whole error); principal cached within a request (one DB read); no e-mail fallback (stale session user id → null).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** per the interfaces; keep `inActiveTenant`/`withOwnedTarget` call signatures working through thin adapters so Task 5 can migrate by area; add the shared mock helper and migrate the ~29 unit tests that mock rbac/getEffectiveRole only as far as needed to keep them green (full migration happens with each area in Task 5).
- [ ] **Step 4: Run** `npx vitest run tests/unit/lib tests/unit/app tests/unit/services` — expect PASS (fix mocks, not behaviour).
- [ ] **Step 5: Commit** `feat(access): principal loader, authorize(), tenant membership for the active tenant and tenant listing`.

### Task 4: Authentication hardening and registration modes

**Files:**
- Modify: `src/lib/auth.ts`, `src/app/(auth)/register/actions.ts`, `src/app/(auth)/register/page.tsx`, `src/app/(auth)/login/page.tsx` (+ its action), `src/middleware.ts` (public paths for `/invite/*`, `/reset/*`), `src/env.ts`
- Create: `src/lib/auth/password-policy.ts`, `src/lib/auth/throttle.ts`, `src/lib/auth/tokens.ts`, `src/app/(auth)/invite/[token]/page.tsx` + action, `src/app/(auth)/reset/[token]/page.tsx` + action, `src/app/(auth)/no-access/page.tsx`
- Test: `tests/unit/lib/auth/*.test.ts`, `tests/unit/app/register-actions.test.ts` (updated), `tests/unit/app/auth-pages-*.test.tsx` (updated), `tests/e2e/auth.spec.ts` (updated: `AUTH_REGISTRATION=open` in e2e env)

**Interfaces:**
- Produces: `normalizeEmail(raw)`, `validatePassword(raw): { ok: true } | { ok: false; message: string }` (12–72 bytes, deny-list, not equal to the e-mail), `hashPassword`/`verifyPassword` (bcrypt cost 12; `verifyPassword` always runs a compare, including a dummy for unknown users), `recordAuthEvent(kind, { email, ip, outcome })`, `isThrottled({ email, ip }): Promise<{ throttled: boolean; retryAfterSeconds?: number }>` (5 failures per 15 min per e-mail hash and per IP hash; IP from `x-forwarded-for` only when `AUTH_TRUST_PROXY=1`), `createInvitation({ email, roles, createdById, ttlHours })` / `acceptInvitation(token, { name, password })` / `createResetToken(userId)` / `consumeResetToken(token, password)` (tokens are 32 random bytes, stored as SHA-256, single use, expiry 7 days invite / 1 hour reset), registration modes `open|invite|closed` (`env.AUTH_REGISTRATION`, default `invite`), uniform register/login answers (registering an existing e-mail answers like a new one in `open` mode: "check your details" style message without revealing existence; login failure message identical for unknown e-mail, wrong password, disabled, locked), Auth.js options `session.maxAge = 12h`, `updateAge = 1h`, explicit `trustHost`, `signIn` callback refusing disabled users and recording `lastLoginAt`, credentials `authorize` using normalized e-mail and the constant-time path, the `/no-access` page for a roleless principal (explains who to ask, offers sign out), `login/page.tsx` shows the Google button only when `GOOGLE_CLIENT_ID` is set (server-passed flag).

- [ ] **Step 1: Write failing tests**: password policy table; normalize e-mail; throttle: 5 failures lock, success resets, per-IP and per-email independent, trusted-proxy header only honoured with `AUTH_TRUST_PROXY=1`; token create/accept: wrong, expired, reused tokens refused with the same message; invitation grants its role rows; reset consumes the token, changes the password and invalidates other outstanding reset tokens; register modes: `closed` -> refusal, `invite` without token -> refusal, `open` -> roleless user and uniform answer for an existing e-mail; timing: unknown user still calls compare (spy); disabled user cannot sign in (credentials) and the generic message is used; the invite/reset pages render only with a valid token (otherwise the generic invalid-link page); `auth.spec.ts` flows still pass in `open` mode and a new e2e proves `invite` mode requires a token.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; `scripts/e2e-env.mjs` gets `AUTH_REGISTRATION=open` for the app under test plus the new names accounted for; update `.env.example` and `docs/` (modes, bootstrap, policy).
- [ ] **Step 4: Run** `npx vitest run tests/unit/lib/auth tests/unit/app tests/unit/scripts` and the e2e `auth.spec.ts` via the release runner on Node 20 — expect PASS.
- [ ] **Step 5: Commit** per concern (policy+throttle; tokens+pages; modes+auth.ts hardening).

### Task 5: Enforce on server actions (by area)

**Files:**
- Modify: every `"use server"` module (list from the fact sheet: `[entityId]/actions.ts`, `version-actions.ts`, `[domainSlug]/actions.ts`, `product-actions.ts`, `openapi-import-actions.ts`, `typespec-import-actions.ts`, `jsonschema-url-import-actions.ts`, `event-actions.ts`, `trait-actions.ts`, `usage-actions.ts`, `schemas/actions.ts`, `enterprise/actions.ts`, `pin-actions.ts`, `governance/actions.ts`, `governance/retention/actions.ts`, `glossary/actions.ts`, `deployments/actions.ts`, `admin/actions.ts`, `schemas/tenant-actions.ts`) and the services that carry role checks (`type-mapping.service`, `governance.service`, `compliance.service`, `webhook.service`, `user.service`, `domain-admin.service`, `emitter-config.service`, `health.service`, `classification-taxonomy.service`, `git.service`); remove hard-coded roles (`entity-workspace.tsx:991` STEWARD; `glossary/actions.ts:28` AUTHOR)
- Create: `tests/unit/access/deny-by-default.test.ts` (repository scan)
- Test: per area, in the existing `*-tenant.test.ts` style: roleless, VIEWER, AUTHOR, STEWARD, COMPLIANCE_OFFICER, ADMIN × the area's operations; foreign tenant; domain-scoped.

**Interfaces:**
- Consumes: Task 3 `authorize`, `resolveResourceRef`, `runMutation(action, …)`.
- Produces: every exported server action calls `authorize(<ActionId>, <resource>)` (or a `runMutation`/`withOwnedTarget` that does) BEFORE any read or write; allow-list file `src/lib/access/public-actions.ts` listing the few intentionally open actions (`registerAction`, login, `acceptInvitationAction`, `consumeResetAction`, own-notification actions) with a one-line reason each; the scan test enumerates all `"use server"` modules' exports and all `app/**/route.ts` handlers and fails for any without a guard call or allow-list entry (route handlers: `requireSession`/`withApiAuth`/`authenticateRequest`+`authorize`, or `PUBLIC_ROUTES` allow-list: `/api/auth/*`, `/api/v1/health`, `/api/v1/docs`, `/api/asyncapi-preview/*`).

- [ ] **Step 1: Write the scan test first** (fails listing every unguarded action), then per-area tests (red).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement area by area in this order, one commit each**: entities/fields/schema/publish/deploy; domain assets + imports (+URL import: authorize before fetch); products and domains (create domain = STEWARD at tenant; delete = tenant ADMIN; the global-ADMIN-only `deleteDomainAction` becomes tenant ADMIN); events/traits/pins/usages; governance + retention (approver rule becomes `governance.decide` = STEWARD+, COMPLIANCE_OFFICER and ADMIN included); glossary (read VIEWER, write AUTHOR anywhere in the tenant); deployments; admin (user/role actions: tenant ADMIN within tenant, platform items global ADMIN); type-mapping (global = STEWARD+, entity = AUTHOR+). Replace the scattered role arrays/strings with the table. Keep denial messages generic.
- [ ] **Step 4: Run** `npx vitest run tests/unit` (the ~29 mocking files now use the shared helper) — expect PASS; the scan test passes with the allow-list only.
- [ ] **Step 5: Commit** per area.

### Task 6: Enforce on API routes and page loaders

**Files:**
- Modify: `src/app/api/v1/middleware.ts` (principal-based `authenticateRequest`; API key = service principal with `API_KEY_TENANT_ID`/`API_KEY_ROLE`), every `src/app/api/v1/**/route.ts`, `src/app/api/{domains-tree,tenants,command-palette-fields,compliance/*,ai/generate-entity}/route.ts`, `src/services/entity.service.ts` (`getEntities`, `getEntityById` tenant-scoped), `src/services/compliance.service.ts` (audit trail tenant-scoped using `audit_log.tenantId`), `src/services/webhook.service.ts` (list masks secrets; ownership), server-component loaders reading `prisma` directly (15 files from the fact sheet: add `authorize`/`accessibleTenants` filters), dashboard layout comment corrected to what is true
- Create: `src/lib/access/api.ts` (`withApiAuth(action, handler)`)
- Test: `tests/unit/api/*` (per route), `tests/e2e/api-v1.spec.ts` (pins flip), `docs/testing/known-defects.md` (KD-016/020/023/024/025/026/027/028 resolved or updated)

**Interfaces:**
- Produces: `withApiAuth(action, handler)` wrapper returning 401 JSON (no session/key), 403 JSON (role too low) or 404 (foreign/missing) — same shapes as today; `/api/v1/webhooks*` need `platform.admin` (service principal ADMIN or global admin session); list responses never include secrets; `/api/v1/schemas*` only the principal's tenant(s); page loaders show only accessible tenants' data; a roleless user's pages render the `/no-access` screen via the layout guard (data-layer check, not the layout alone).

- [ ] **Step 1: Write failing tests** (roleless/viewer/author per route; API key principal; session roles real; secrets masked; cross-tenant 404; audit trail scoped).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; flip the pinned `test.fail`/characterization tests in `api-v1.spec.ts` and `known-defects.md` in the same commits.
- [ ] **Step 4: Run** unit + the API e2e on Node 20 — expect PASS.
- [ ] **Step 5: Commit** per surface (API v1; internal API; loaders).

### Task 7: Admin UI and user lifecycle

**Files:**
- Modify: `src/app/(dashboard)/admin/layout.tsx` (server-side gate + role-aware tabs), `TopBar.tsx`/`ActivityBar.tsx` (Admin link only for principals with admin rights), `src/components/custom/admin/{UserDataTable,UserDetailPanel,RolesEditor}.tsx`, `src/services/{user,rbac}.service.ts`
- Create: `src/components/custom/admin/{InviteUserDialog,ScopePicker,RoleMatrix,UserStatusToggle,ResetLinkDialog}.tsx`, tenant manager page if a tenant admin UI is needed for scope pickers (list only; tenant creation is a platform task: `npm run tenant:create` script if missing)
- Test: component tests, service tests, `tests/e2e/admin.spec.ts` (updated: RolesEditor tests move to scope pickers; keep the data-testids where possible), new `tests/e2e/user-management.spec.ts`

**Interfaces:**
- Consumes: Task 1 `grantAllowed`, Task 4 invitation/reset functions.
- Produces: services `inviteUser({ email, roles })` (returns the one-time link, audited), `setUserDisabled(userId, disabled)` (last global ADMIN protected; audited; disabling invalidates access immediately because the principal loader checks it), `createResetLink(userId)`, `assignRole({ userId, role, scope })` / `revokeRole(...)` using the policy (`grantAllowed`, no own-admin removal, last-admin protection inside a Serializable transaction to survive two admins racing), `listUsers` scoped (global admin: all; tenant admin: users with any assignment in their tenants plus invited), role matrix view (users × scopes), audit entries for every change; UI: invite dialog with email + role + scope picker (tenant/domain/product dropdowns replacing the raw domain-id text), copyable link with expiry, disable/enable with confirmation, reset-link dialog, "last sign-in" and status columns (real data), tenant admin sees only their tenant's scopes.

- [ ] **Step 1: Write failing tests**: tenant ADMIN can invite/assign within the tenant and not elsewhere; AUTHOR sees no admin link and gets the no-permission screen on `/admin`; invite → accept → roles applied; disable → next request denied; last global admin cannot be disabled/removed; concurrent mutual removal leaves one admin (Serializable retry); every change writes an audit entry; e2e: admin invites a user, user accepts and sees only the granted scope, admin disables them and the user is signed out on the next request.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; remove dead oRPC routers under `src/server/api` (nothing mounts them) once nothing imports them; update admin tests/testids.
- [ ] **Step 4: Run** unit + the admin and user-management e2e on Node 20 — expect PASS.
- [ ] **Step 5: Commit** per concern (services; UI; e2e).

### Task 8: Google sign-in — REMOVED 2026-10-25, replaced by Task 8b (pluggable provider registry)

> **Owner change (2026-10-25):** Google sign-in is out of scope; logins are admin-controlled only (local accounts, invite/closed registration). The owner asked to use the library (Auth.js) so an administrator can configure other sign-in providers later. **Task 8b replaces everything below:** one typed provider registry (`AUTH_PROVIDERS`; credentials is the only provider enabled by default; no Google-specific code, no `GOOGLE_*` settings, no Google button); a pure `evaluateProviderSignIn(profile, { provider, config, existingUser })` for any non-credentials provider (provider enabled; e-mail present and verified; the user must already exist and not be disabled (no self-signup); no automatic linking by e-mail unless an admin-set allow flag for that provider is on; optional per-provider allowed e-mail domains; refusals use the login failure message); `docs/auth.md` explains enabling a provider (client id/secret env names, redirect URI, marked untested against a real IdP). Not built: an in-app screen storing provider secrets (needs encrypted secret storage): recorded as a follow-up. The Task 4 plumbing (`GOOGLE_CLIENT_ID` flag, `GOOGLE_ALLOWED_DOMAINS`, login-page Google button flag) is generalised. The original text is kept below for reference only.

**Files:**
- Modify: `src/lib/auth.ts` (Google `signIn` rules), `src/app/(auth)/login/page.tsx`, `src/env.ts`, `.env.example`, `docs/`
- Create: `docs/auth.md` (Google setup: OAuth client, redirect URI `{AUTH_URL}/api/auth/callback/google`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS`, `AUTH_URL`, `AUTH_TRUST_HOST`)
- Test: `tests/unit/lib/auth/google-signin.test.ts` (stubbed profiles), e2e: Google button absent without configuration

**Interfaces:**
- Produces: `evaluateGoogleSignIn(profile, { allowedDomains, existingUser, invitation })` pure decision function → `{ allow: true; applyInvitationId?: string } | { allow: false; reason: "unverified" | "domain" | "local-account-exists" | "disabled" | "no-invitation-in-invite-mode" }`; wired in the Auth.js `signIn` callback: refuse unverified e-mail, refuse a domain outside `GOOGLE_ALLOWED_DOMAINS` (checks both the `hd` claim and the e-mail domain), refuse when a local account with that e-mail exists (message: sign in with your password), in `invite` mode require a pending invitation, otherwise create the user with no roles and apply a matching pending invitation; the login page's Google button is rendered only when `GOOGLE_CLIENT_ID` is set; the generic failure message is used for every refusal on the login page.

- [ ] **Step 1: Write failing tests** for every branch of `evaluateGoogleSignIn` and the callback wiring with a stubbed Prisma.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** and document; note in the docs that the real redirect needs the owner's Google client id and secret and that nothing here contacts Google in tests.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(auth): Google sign-in rules (verified e-mail, allowed domains, no automatic linking, invitation in invite mode)`.

### Task 9: End-to-end access matrix and harness

**Files:**
- Modify: `tests/e2e/helpers/db.ts` (`grantRole(userId, role, scope)`, `createUser`, `disableUser`), `tests/e2e/helpers/second-user.ts` (optional `roles`), `scripts/e2e-env.mjs` (registration open), existing specs that rely on roleless users or any-user access (`admin.spec.ts`, `governance-compliance.spec.ts`, `discovery.spec.ts`, `api-v1.spec.ts`, `auth.spec.ts`)
- Create: `tests/e2e/access-matrix.spec.ts`, `docs/testing/access-control.md`
- Test: the new spec

**Interfaces:**
- Produces: e2e coverage: viewer sees but cannot create/edit/publish (buttons absent or actions refused via UI and via a direct server-action POST and the API); author can write but not publish/approve; steward publishes/approves; compliance officer reads compliance data; tenant ADMIN of tenant A cannot see or switch to tenant B (UI, `/api/tenants`, direct URL, API); domain-scoped AUTHOR confined to the domain; disabled user is signed out on the next request; roleless user lands on `/no-access` and gets nothing from `/api/*`; invite flow end to end; throttling after 5 bad logins; `AUTH_REGISTRATION=invite` requires a token. Existing specs updated so every signed-in test user has the roles their scenario needs (the seeded admin stays a global ADMIN); `known-defects.md` entries closed.

- [ ] **Step 1: Write the spec and harness helpers; update existing specs.**
- [ ] **Step 2: Run** the whole regression tier on Node 20 via the release runner — expect failures where specs relied on old behaviour; fix each honestly (spec update when the old behaviour was the defect; product fix when it is a regression).
- [ ] **Step 3: Run** three consecutive runs of the new spec and the whole regression tier once, smoke once — 0 flaky.
- [ ] **Step 4: Run** `npx vitest run tests/unit` and tsc/eslint.
- [ ] **Step 5: Commit** per concern.

### Task 10: Final review hardening and documentation

**Files:**
- Modify/Create: `docs/auth.md` (final), `docs/testing/access-control.md`, `docs/testing/e2e.md` (access section), `.env.example`, release notes entry (`CHANGELOG.md` if the repo has one)
- Test: the deny-by-default scan, the env-scan test, docs link check if any

- [ ] **Step 1: Re-run** the scan, the full unit suite, tsc, eslint, the whole e2e nightly tier on Node 20; fix findings.
- [ ] **Step 2: Review** with a fresh reviewer focused on authorization bypass (forged/stale/disabled sessions, server action POSTs, cross-tenant by id, API key, tokens, throttling bypass via IP header, Google refusals).
- [ ] **Step 3: Document** operator steps: bootstrap admin, registration modes, Google setup, API key principal, token expiries, how to grant the first roles, rollback of the migration (SQL provided), what is NOT covered.
- [ ] **Step 4: Commit** `docs(access): operator guide and final hardening`.

---

## Self-review notes

- Spec coverage: policy/scopes/action table → T1; data model → T2; principal/tenant membership → T3; registration/hardening/tokens/throttle → T4; enforcement → T5, T6; admin UI/user lifecycle → T7; Google → T8; tests/harness → T9; docs/final review → T10.
- Names across tasks: `Scope`, `Assignment`, `ResourceRef`, `ActionId`, `can`, `effectiveRole`, `grantAllowed`, `getPrincipal`, `authorize`, `resolveResourceRef`, `accessibleTenants`, `withApiAuth`, `evaluateGoogleSignIn` — consistent.
- Risks: widest change in the repo (touches every action); mitigated by the scan test, per-area commits and the e2e matrix. Migration backfill on existing data (duplicate-case e-mails) fails loudly with instructions rather than guessing.
