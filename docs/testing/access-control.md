# Access control in the browser suite

What `tests/e2e/access-matrix.spec.ts` (and the specs it points at) prove about who may see and do what, how the suite makes the people it needs, and what is proved
somewhere else and why. The rule itself is the action table in `src/lib/access/actions.ts` (the single source: an action id, the lowest role that may do it, and the level
at which that role is judged); the design is `docs/superpowers/specs/2026-10-24-access-control-design.md`; an operator's view is `docs/auth.md` and `docs/auth-ops.md`.
This page is about the tests.

## The rule, in one paragraph

Roles are one linear ladder, `VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN`. A role is held at a scope: the platform (`GLOBAL`, valid for `ADMIN` only), a tenant, a
domain or a product. The role a person has over a thing is the highest one held at a scope that CONTAINS it (a domain contains its products and entities; a tenant-level
(Enterprise) entity is contained by tenant and platform scopes only). Nothing is allowed by default: a signed-in person with no role sees no tenant content and changes nothing. A
thing the person has no role over answers exactly like a thing that does not exist (404 / "not found"); a thing they have a role over but too low a one answers 403 / "You do not
have permission to do this", in words that name no role, tenant or id. Reading content is `VIEWER`; writing, importing and generating is `AUTHOR`; publishing, deploying, approving
and creating a domain or product is `STEWARD`; compliance is `COMPLIANCE_OFFICER`; deleting a domain, managing users and tenant settings is a tenant `ADMIN`; platform items
(webhooks, emitters, health, git, classifications) are a platform `ADMIN`.

The ladder is linear on purpose: a `COMPLIANCE_OFFICER` holds the author's and the steward's rights as well as compliance, and an `ADMIN` everything. It is **not** a read-only
audit role. (`tests/unit/lib/access/policy.test.ts` pins the whole role x scope x action matrix; `access-matrix.spec.ts` pins the officer's ladder rights in one assertion so a change
of that rule is deliberate. If the owner wants an audit role that cannot edit, that is a policy change, not a test change.)

## How a test makes a person

`tests/e2e/helpers/db.ts` and `tests/e2e/helpers/second-user.ts`:

| Helper | What it does |
| --- | --- |
| `createUser({ email, password, name? })` | a user the login form accepts: the e-mail normalized (trim + lower case) and the password stored by the app's own `hashPassword` (bcrypt, cost 12) |
| `grantRole(userId, role, scope)` | a role row as the app stores it (`scopeKey` and the id columns agree, as the table's CHECK needs): `"GLOBAL"`, `{ tenantId }`, `{ tenantId, domainId }`, `{ tenantId, domainId, productId }` |
| `disableUser(userId)` / `enableUser(userId)` | `users.disabledAt`: what the administrator's switch sets; the user's next request is refused |
| `withSecondUser(browser, baseURL, body, { roles })` | `createUser` + `grantRole` for each entry of `roles` (no `roles` = a person with NO role) + a sign-in through the real login form in a fresh browser context; closes the context and deletes the user afterwards (a user an audit row points at cannot be deleted and is left: `deleteUsersBestEffort`) |
| `registerThroughTheForm(browser, baseURL)` | the register page itself, for a test OF registration: open-mode registration signs nobody in and gives no role |

Registration through the page is NOT how a test gets a user any more: `AUTH_REGISTRATION=open` (the run's mode) answers a new address and a known one the same and signs
neither in (so the page cannot be used as an existence oracle), and the account it makes holds no role. The seeded administrator (`admin@admin.com`) is a platform `ADMIN`, so every spec that
works as the admin is unchanged.

## What `access-matrix.spec.ts` covers

Each test makes a tenant of its own (a domain, a product, an entity "Customer", a sibling domain with "Invoice"), so nothing depends on what another spec has in the database. Every
test checks the same rule in every place it is enforced: the screens, the app's own JSON endpoints, the REST API v1, and a server action POSTed by hand.

| Test | Screens | Endpoints | A server action POSTed by hand |
| --- | --- | --- | --- |
| **VIEWER** (tenant) | sees both domains and the entity with its field; the added field, the publish and the new domain are refused with the generic message, in the screen; the new-entity page is a not-found | `GET /api/v1/schemas` lists the tenant's entities; webhooks, the three compliance routes and the AI suggestion answer 403 | the add-field POST, sent again with another name: refused; nothing written, not even an audit row |
| **AUTHOR** (tenant) | adds a field (kept; its audit row names the tenant: KD-016); publish refused; a governance request is listed and its approval refused (stays pending); a new domain refused | the AI suggestion passes its role gate (503: a run has no AI provider; a viewer gets 403); compliance 403 | (the viewer's) |
| **STEWARD** (tenant) | publishes (1.0, a version row); approves a governance request (decision recorded); creates a domain (in this tenant); no delete control on the domain cards | compliance 403: it sits above the steward | |
| **COMPLIANCE_OFFICER** (tenant) | the Query tab lists the tenant's fields; Gaps and Audit Trail open with no error; holds the author's rights too (a field is added) | query, gaps and audit-trail answer 200 | |
| **tenant ADMIN of A, with a tenant B** | the switcher offers A only; B's entity is a not-found and B's domain is not in the tree; a forged `active_tenant` cookie naming B changes nothing; the delete control is on A's domain cards | `/api/tenants` lists A only; `/api/domains-tree` and `/api/v1/schemas` hold none of B; B's entity by id is the same 404 as an id that does not exist, and so is its emit; webhooks 403 (a platform item) | the add-field POST that worked on A, sent again with B's entity id: refused ("Entity not found"), B untouched |
| **AUTHOR of one domain** | the sibling domain is absent from the tree and the grid, a not-found at its address and its entity's; the tenant-level (Enterprise) entity is a not-found; own domain: opens, a field is added; creating a domain is refused | `/api/v1/schemas` lists the one entity, the others are 404; the tree holds the one domain | the add-field POST, sent again with the sibling's entity id and with the tenant-level entity's: refused, nothing written |
| **AUTHOR of one product** | its domain is the parent in the tree, its product is there, the sibling product and the sibling domain are not; the sibling product's entity is a not-found | `/api/v1/schemas` lists the one entity; `/api/domains-tree` has the one domain with the one product | the add-field POST, sent again with the sibling product's entity id: refused |
| **no role** | `/no-access` from `/schemas`, an entity address, a domain page, `/governance`, `/compliance`, `/admin`, `/notifications` | `/api/tenants` is `{ activeTenantId: null, tenants: [] }` (200); `/api/domains-tree`, `/api/command-palette-fields`, `/api/v1/schemas`, an entity by id, the three compliance routes, emit and the AI suggestion are 404; webhooks 403; their own notifications 200; nothing of the tenant in any body; with no session at all: 401 | |
| **disabled while signed in** | the next page is `/no-access`; enabled again, the same cookie works | `/api/v1/schemas` and `/api/tenants` are 401, then 200 again | the author's add-field POST, sent again after the disable: refused, nothing written; accepted again after the enable |
| **reference closure** (KD-045) | a domain author's Mod+E on an entity that refers to an entity of another domain: the toast says the schema cannot be generated from here, names the author's own field and nothing of the other entity | emit and validate: 403 `REFERENCE_NOT_READABLE`, the same message; a tenant-wide author is not refused | |
| **invite mode** (`@external`, needs the second app) | `/register` has no form, a dead token is the one "not valid" card, a live token continues at `/invite/<token>` and shows the invited address | | |

### Why a server action POSTed by hand is done with the page's own request

A server action is called by a `Next-Action` POST. The suite does not invent one: a test makes the screen call the action (`captureAction`, `helpers/admin-users.ts`: the first
`Next-Action` request after a trigger whose body names what only that call holds), and sends it again with other arguments (`replayAction`) as the SAME person's session, so the call has the real action id and encoding. It is cheap (the
arguments of the actions used here are plain strings, which Next sends as JSON text) and it reaches what the screen never lets a person do: the id of an entity of another tenant, domain or product, a call after
the account was disabled. If a Next upgrade changes the wire format the test fails loudly (it asserts the refusal text, or the absence of the write), it cannot pass by doing nothing. The unit scan
`tests/unit/access/deny-by-default.test.ts` is the other half: it fails for any exported server action with no guard, and `tests/unit/app/*-access.test.ts` and `tests/unit/access/*` call each action as
each role.

### What the UI does and does not do for a person who may not

The entity page, the domain grid and the governance dashboard draw their controls for everybody who can read the page: a viewer sees "Add Field", "Publish", "New domain" and "Approve". The
server refuses the act and the screen says so (a toast, the publish dialog's own line, the domain form's error). That is what the tests pin: **refused**, not **absent**. (Controls that a person
can never use are hidden where the server hands the page a capability, e.g. the Admin area and the domain delete button: `src/lib/access/capabilities.ts`; the rest is a polish decision, not a hole: the
refusal does not depend on it.)

## What is covered elsewhere, and not repeated

| What | Where |
| --- | --- |
| the invite flow end to end (an invitation made in the dialog, opened in a fresh browser, the roles it grants, the sibling domain's entity not found), revoking an invitation, disabling a person and the next request refused, the reset link, the last platform administrator (controls disabled with the reason and the server's own refusal), a tenant administrator's and an AUTHOR's views of `/admin` | `user-management.spec.ts` (6) |
| the lock after five wrong passwords, the same answer for every kind of failed sign-in, the register page and its notices, dead invitation and reset links | `auth.spec.ts` |
| the webhook endpoints are refused to a viewer and to a user with no role (403, the generic message), the notifications API, the API key's principal | `api-v1.spec.ts` |
| an Author who may not approve or reject, per button; compliance for a user with no role (404) and a Viewer (403) | `governance-compliance.spec.ts` |
| a user who registers is listed with no roles and lands on `/no-access`; a visitor with no role is sent there from every admin tab | `admin.spec.ts` |
| the Disabled and Invited badges and the Revoke button, their contrast | `a11y.spec.ts` ("the users table with a disabled account and a pending invitation") |
| `AUTH_REGISTRATION=invite` and `closed` as a server: the PGlite and unit proof (`tests/unit/app/register-actions.test.ts`, `register-page-modes.test.tsx`, `tests/integration/auth/register-pglite.test.ts`); `invite` also in a browser, against the second app (above). `closed` has no browser proof | |
| the whole role x scope x action matrix, scope containment, who may grant what | `tests/unit/lib/access/policy.test.ts` (176 tests) |
| every server action and route handler is guarded or on a reasoned allow-list | `tests/unit/access/deny-by-default.test.ts` |

## Decisions the tests record

- A role over a domain or a product does not reach the tenant-level (Enterprise) entities, traits and types: a domain author does not see them, and what they inherit from the Enterprise level is empty (design decision 2).
- A role over a product shows its domain as the parent in the tree and nothing else of that domain.
- A person with a role in one tenant only never sees a tenant switcher with a second entry; a forged `active_tenant` cookie falls back to a tenant they hold a role in.
- A person who wrote something cannot be deleted (their audit rows are immutable): the suite leaves such accounts, and `deleteUsersBestEffort` says which.

## Running it

```
# the access matrix (the @external invite-mode test needs the second app: the nightly tier starts it, or add --second-app)
node scripts/e2e-release.mjs --tier nightly --project chromium -- tests/e2e/access-matrix.spec.ts
# the regression tier (the invite-mode test is @external and is listed as skipped there, which is allowed)
node scripts/e2e-release.mjs --tier regression --project chromium
```

Node 22.22.2+, Docker on the PATH, as for every release run (`docs/testing/e2e.md`).
