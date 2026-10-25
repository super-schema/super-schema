# Access control and user management

Date: 2026-10-24. Status: approved by the owner in principle ("implement access control and user management, locally or Google sign-in, free open source"); the calls below are the assistant's, recorded for the owner to review. The owner was away while this was written.

## Intent and why

Today any signed-in person can do almost everything in the active tenant, the "active tenant" is a cookie anyone can set to any tenant, domain/product/tenant-scoped roles never take effect (every check passes `domainId = null`), anyone can register, the first registrant of an unseeded database becomes the administrator, a seeded database ships `admin@admin.com` / `admin`, there is no way to disable a user, and the admin screens cannot invite users or assign roles by scope. The owner wants roles (admin, viewer and the existing ladder) assignable per tenant, domain and product, user management in the app, and either local accounts or Google sign-in, using free open-source building blocks.

## Findings the design rests on (from the recon, see the fact sheet in the conversation / `.superpowers/sdd`)

- Auth.js v5 (`next-auth@5.0.0-beta.30`) with a Credentials provider and an optional Google provider, JWT sessions, `@auth/prisma-adapter`, `bcryptjs`, `zod`, `jose` are installed. `@casl/ability`, `casbin`, `@openfga/sdk`, `oso`, rate limiters, mailers are NOT installed, and installing from the internal registry has needed a short-lived token.
- Roles: `VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN` (`src/types/schemas/rbac.ts`). `UserRole` rows already carry nullable `tenantId`, `domainId`, `productId`; `getEffectiveRole` ignores all but `domainId` and every caller passes `null`.
- Enforcement: role checks exist only in admin services, the global-ADMIN domain delete, governance approve/reject, `setFieldReferenceAction` and type-mapping overrides; tenant checks exist via `inActiveTenant` / `withOwnedTarget` (foreign and missing rows both answer NOT_FOUND: keep that).
- The tenant cookie `active_tenant` is validated only for existence.

## Goals

1. Deny by default: a signed-in person with no role assignment sees no tenant content and can change nothing.
2. Roles per scope: a role assignment is global (platform), tenant, domain or product scoped; the effective role on a resource is the highest role among assignments whose scope contains the resource.
3. One enforcement point: every server action, API route and page loader asks the same `authorize(principal, action, resource)`; a repository test fails when a new server action or route handler has neither a guard nor a reasoned allow-list entry.
4. Tenant boundary: the active tenant must be one the user has an assignment in (global admins: any); `/api/tenants` and the tenant switcher list only accessible tenants.
5. User management in the app: invite by link, disable/enable, reset-password link, role assignment with scope pickers, an audit trail for every identity or role change, last-admin protection.
6. Sign-in: local email + password (hardened) and Google (OpenID Connect through Auth.js) with verified-email and optional allowed-domain checks; no automatic linking of an existing local account.
7. Abuse limits: login and registration throttling and lockout stored in the database (works with several instances), uniform answers (no account enumeration), password policy.

## Non-goals

- Real Google Cloud IAM integration: GCP IAM governs cloud resources and has no mapping onto this app's roles. Google sign-in (OpenID Connect) plus role assignment inside the app is the supported design. Mapping Google Workspace groups to roles is out of scope (needs a service account and the Directory API); the allowed-domain check and invitations cover onboarding.
- SAML, SCIM, MFA and an email service. Invitation and reset links are shown to the administrator to copy; an SMTP sender can be added later behind the same function.
- Fine-grained attribute/field-level permissions, per-entity ACLs.
- A new authorization library (decision below).

## Decisions (the assistant's calls)

1. **No policy library.** The roles are a linear ladder over a scope tree; an in-repo pure module (about 100 lines plus a table of actions) is clearer, testable and adds no install risk. If the model ever needs relationships beyond the tree, revisit OpenFGA or Casbin.
2. **Scopes:** `GLOBAL` (platform), `TENANT`, `DOMAIN`, `PRODUCT`. Containment: global ⊃ tenant ⊃ domain ⊃ product ⊃ entity. A tenant-level entity (no domain/product) is governed by tenant and global assignments only.
3. **Who may hold which role where:** any role may be assigned at any scope, except `GLOBAL` which is only valid for `ADMIN` (platform administrator, above tenant administrators). `COMPLIANCE_OFFICER` and `ADMIN` at tenant scope are allowed (today they are "system only").
4. **Action → minimum role (the table lives in `src/lib/access/actions.ts` and is the single source):**
   - read/list/get content: `VIEWER`;
   - create/edit/delete entities, fields, schema generation, imports, domain assets, events, traits, pins, glossary edit: `AUTHOR`;
   - publish, deploy, mark deployed, deprecate/retire, governance approve/reject, retention policy edit, global type-mapping override, create product, create domain: `STEWARD` (domain/product: at the covering scope; create domain: at tenant scope);
   - compliance Query/Gaps/Audit/export: `COMPLIANCE_OFFICER`;
   - delete domain/product, user and role management for the tenant, tenant settings: tenant `ADMIN`;
   - platform items (emitter configs, health, git configuration, classification taxonomy, tenant creation): global `ADMIN`.
   - Notifications and the user's own profile: any active principal (user-scoped).
5. **Grant rules:** only an `ADMIN` whose scope covers the target scope may assign or revoke roles there; nobody grants above their own role; the last global `ADMIN` cannot be removed or disabled; a user cannot remove their own admin role.
6. **Registration mode** `AUTH_REGISTRATION=open|invite|closed`, default `invite`: registering requires a valid invitation token (the new account receives the invitation's role assignments) or, for the very first user, the bootstrap path below. `open` creates a roleless account (sees a "no access yet" page); the e2e and dev environments use `open`. `closed` disables the register page.
7. **First administrator:** no more "first registrant becomes admin" and no default `admin/admin` in production. `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` (or a one-time `npm run admin:create`) create the global administrator; the seed only creates the default admin when `NODE_ENV !== "production"` or the variables are set. The guard that `ensureFirstAdminAssignment` ran from a read path is removed. Existing databases keep their current administrators.
8. **Identity hardening:** emails are normalized (trim + lower case) and unique case-insensitively; constant-time dummy password comparison for unknown users; password policy 12-72 bytes with a deny-list of trivial values; session `maxAge` 12 hours with `updateAge` 1 hour; `trustHost` explicit; disabled users are refused at sign-in and at every request (the principal loader checks `disabledAt`); the user-by-email fallback in `resolveCurrentUserId` is removed.
9. **Throttling:** `auth_events` rows (email hash, IP hash, kind, time) drive per-email and per-IP limits (5 failures in 15 minutes → lock for the remainder, with a uniform response); the client IP comes only from a trusted proxy header when `AUTH_TRUST_PROXY=1`.
10. **Google:** Auth.js Google provider shown only when configured; `email_verified` must be true; `GOOGLE_ALLOWED_DOMAINS` (comma list, checked against the `hd` claim and the e-mail domain) restricts who can sign in; a first Google sign-in creates a user with no roles then applies a matching pending invitation (same e-mail); a Google e-mail that matches an existing local account is refused with a message to sign in with the password (no automatic linking). Redirect URI `{AUTH_URL}/api/auth/callback/google`, documented.
11. **API:** `/api/v1/*` handlers authenticate with the same principal: a session gets its real roles (fixes the "session is always VIEWER" defect), the API key becomes a service principal bound to a tenant and role (`API_KEY`, `API_KEY_TENANT_ID` default the default tenant, `API_KEY_ROLE` default `ADMIN` to keep existing integrations working; documented as a trade-off). `getEntities`/`getEntityById` become tenant-scoped.
12. **Data model (migration for PostgreSQL and PGlite):** `users`: `disabledAt`, `lastLoginAt`, unique `lower(email)`; `user_roles`: `scopeKey` (`G`, `T:<id>`, `D:<id>`, `P:<id>`) backfilled and made part of the unique key instead of the NULL-distinct index, `tenantId` backfilled from the domain, `grantedById`; new `invitations` (+ their role grants), `auth_tokens` (hashed single-use tokens for invitation acceptance and password reset), `auth_events`; `audit_log.tenantId` (closes KD-016) with backfill where derivable.
13. **Audit:** every role grant/revoke, invitation, invitation use, password reset, disable/enable and sign-in failure/lockout writes an audit or auth event.

## Constraints

- No new runtime dependency unless installing it is verified to work (registry token); default design needs none.
- The seeded administrator stays a global `ADMIN` so the existing e2e suite keeps running; the e2e harness gains `grantRole` and registers users with chosen roles.
- Existing tests keep their meaning: where a test asserted "any signed-in user can do X" it is updated honestly with the new rule and, where the old behaviour was a recorded known defect (KD-016, 020, 023, 024, 025, 026, 027, 028), the pin flips and the doc is updated.
- Foreign and missing resources keep answering the same (no existence oracle).
- Migrations must apply to both PGlite and PostgreSQL via the project's process (`docs/database.md`) and never break existing data (backfill, then constrain).
- No outbound email, no network calls to Google in tests (the Google flow is unit/contract tested with a stubbed provider; the real redirect needs the owner's client id and secret).

## Out of scope but recorded

- Google Workspace group → role mapping, MFA, SCIM, SSO via SAML, email delivery, per-entity ACLs, API tokens per user (the API key remains a single configured service principal).

## Left to the builder

- Exact file layout under `src/lib/access/`, naming of the guard helpers, UI layout of the role matrix, migration folder name, wording of denial messages (they must stay generic: no existence oracle).
