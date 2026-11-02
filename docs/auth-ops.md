# Authentication: what to configure and what to know before you run it

Short and operational. It covers sign-in (registration modes, passwords, throttling, invitation and reset links, sessions), the first administrator,
the scoped roles and user management, the REST API key, the secrets the database keeps (the Git credential, the webhook signing secret), the tenant of the audit trail, and how to roll back the access-control migration. Identity
providers an administrator can add next to the local accounts (Google, GitHub, Microsoft Entra ID, Okta, Keycloak, a generic OpenID Connect issuer; none
by default) are in [`auth.md`](auth.md), with the settings, the rules, the risk of linking existing users and worked examples. What is not covered, and
the known defects behind it, is at the end of this file.

## Settings at a glance

| Setting | What it does | Default |
|---|---|---|
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Signs every session; the whole authentication boundary. `AUTH_SECRET` wins when both are set. | A production server refuses to start without one of at least 32 characters that is not a known placeholder |
| `AUTH_URL` / `NEXTAUTH_URL` | The public origin of the app. `AUTH_URL` also makes the `Host` header trusted; `NEXTAUTH_URL` alone does not. | Unset |
| `AUTH_TRUST_HOST` | `true` or `1` trusts the `Host` header (behind a reverse proxy you control). | Production does not trust the header unless `AUTH_URL` is set; development and test always do |
| `AUTH_TRUST_PROXY` | Exactly `1`: the client address is the left-most `X-Forwarded-For` entry (the sign-in throttle, the invitation and reset links, the provider refusals, and the REST API's limit on requests that do not authenticate). | Off: there is no client address. Sign-in is limited per e-mail only, and a sign-in without an address is slowed (never refused) once failures pile up in the process. Invitation, reset and provider refusals are then not limited at all. Open registration without an address is slowed like a sign-in without one, never refused, and the REST API's failed requests share one allowance of 20 a minute (see Throttling). A production start logs a warning when this is off |
| `API_RATE_LIMIT_PER_MINUTE` | A positive whole number: the requests a minute one authenticated caller (the API key, or a signed-in user) may make to the rate-limited `/api/v1` routes. | 100 |
| `TSP_MAX_CONCURRENT_RUNS` | A positive whole number: how many TypeSpec compiler runs (`tsp`, about 100 MB each) run at once in this process. The rest wait, up to 200 waiting and at most 60 seconds each; a run beyond either is answered `EMITTER_BUSY` (the REST API answers 503 with `Retry-After`). A timeout covers a run, not its wait. | Half the CPU cores, at least 1 |
| `AUTH_REGISTRATION` | `open`, `invite` or `closed`. | `invite`; an unknown value is `invite` |
| `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` | The administrator the seed creates. Set both or neither. | Unset: the seed creates `admin@admin.com` only when `NODE_ENV` is not `production` |
| `API_KEY` | Enables `Authorization: Bearer <key>` on `/api/v1/*`. | Off |
| `API_KEY_TENANT_ID` | The tenant the key acts in. | `tenant_default` |
| `API_KEY_ROLE` | The role the key holds: `VIEWER`, `AUTHOR`, `STEWARD`, `COMPLIANCE_OFFICER` or `ADMIN`. A value that is not a role turns the key off. | `ADMIN` |
| `AUTH_PROVIDERS`, `AUTH_PROVIDER_<KEY>_*` | Identity providers. See [`auth.md`](auth.md). | None |
| `AUTH_SECRET_1` to `_3` | Auth.js's secret rotation names. Auth.js reads them only when no secret is set; the middleware never does, so rotation is not supported. | Not used |
| `SECRETS_ENCRYPTION_KEY` | The key that seals the stored Git credential and webhook signing secret: 32 random bytes in base64 (`openssl rand -base64 32`). See [Stored secrets](#stored-secrets-the-git-credential-and-the-webhook-signing-secret). | Unset: the key is derived from `AUTH_SECRET` |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | Development only: `true` lets a webhook delivery reach `http:` URLs and private or loopback addresses. Never set it in production. See [Webhooks](#webhooks-tenant-and-destination). | Unset: `https` to public addresses only |

## The secret

Every login is a signed cookie (an Auth.js session JWT). **The secret that signs it is the entire authentication boundary**: whoever holds it can
forge a session for any user, an administrator included.

| Setting | Notes |
| --- | --- |
| `AUTH_SECRET` | The name Auth.js documents. Wins when both are set. |
| `NEXTAUTH_SECRET` | The name this app's `.env.example` and compose file use. |

Rules, the same in the middleware (which verifies the cookie) and in the Auth.js configuration (which signs it): `AUTH_SECRET`, else
`NEXTAUTH_SECRET`; **a name set to the empty string counts as not set** (`src/lib/auth-secret.ts`).

**In production** (`NODE_ENV=production`: `next start`, the Docker image) the server **refuses to start** (the process writes the reason and exits with code 1; it does not stay up answering 500) with a secret that is missing, shorter than
32 characters, or a known development value or placeholder (`dev-secret-change-in-production`, `your-secret-here`, `secret`, `changeme` ...). The
message says why and how to make one. Development and test accept any value.

```sh
openssl rand -base64 32      # 44 characters; put it in AUTH_SECRET (or NEXTAUTH_SECRET)
```

`.docker/docker-compose.yml` has no default for it: `docker compose up` stops with "set NEXTAUTH_SECRET" until you `export NEXTAUTH_SECRET="$(openssl rand -base64 32)"`. The same file also requires `POSTGRES_PASSWORD` (`export POSTGRES_PASSWORD="$(openssl rand -hex 24)"`; see the Docker Compose section of `database.md`).
A secret is per deployment and per environment: a secret that is shared between environments makes a login of one valid in the other.

**Rotation is not supported.** Auth.js can rotate with `AUTH_SECRET_1`, `AUTH_SECRET_2`, `AUTH_SECRET_3`, but it reads those only when it has no
secret of its own, and the middleware reads only `AUTH_SECRET` and `NEXTAUTH_SECRET`. With the rotation names alone the middleware has no
secret and **fails closed**: every request bounces to `/login`, and a production server refuses to start. To change the secret, change
`AUTH_SECRET` (or `NEXTAUTH_SECRET`) and restart: every session is signed out (users log in again). The throttle counts restart too: the e-mail and
address hashes in `auth_events` are keyed with the secret, so after the change no earlier failure is found. **Unless `SECRETS_ENCRYPTION_KEY` is
set, the change also makes the stored Git credential and webhook signing secrets unreadable** (see the next section).

## Stored secrets: the Git credential and the webhook signing secret

Two secrets are kept in the database, and both are sealed (AES-256-GCM, `src/lib/crypto/secret-box.ts`), so a copy of the database (a backup, a
replica, a read-only SQL session) does not hold them in clear text (a token written into a repository URL is the exception, see below, and values
stored before this change are plain until they are written again):

| Secret | Where | Shown again? |
| --- | --- | --- |
| Git repository credential (a personal access token or an SSH key) | `git_config.authCredential` | Never: the API answers the configuration without it |
| Webhook signing secret | `webhook_endpoints.secret` | Once, in the answer of the creation. The list and an update never carry it |

**The key.** `SECRETS_ENCRYPTION_KEY` is 32 random bytes in base64 (`openssl rand -base64 32`). Every server that reads or writes these rows needs the
same key. When it is not set, the key is derived from `AUTH_SECRET` (`NEXTAUTH_SECRET` when that is not set), which the app requires anyway.

- **Changing the session secret then makes every secret sealed since this change unreadable** (a value still in plain text is not affected). A
  webhook delivery fails with the error "cannot be opened" in its delivery list (it is retried like any other failure, and never sent unsigned).
  The Git credential has to be entered again. There is no tool that re-keys stored values, and a webhook secret cannot be shown again: delete the
  endpoint and create it again.
- Set `SECRETS_ENCRYPTION_KEY` before the first secret is stored. It keeps the two rotations apart: rotating `AUTH_SECRET` then leaves the stored
  secrets alone. Changing `SECRETS_ENCRYPTION_KEY` later makes them unreadable in the same way, and no tool re-keys them.
- Storing a secret is refused, with the variable to set in the answer, when neither key source is set. A secret already stored stays unreadable
  until its key is back.
- A malformed `SECRETS_ENCRYPTION_KEY` (not 32 random bytes in base64) refuses the same way, with the reason. An update of a webhook endpoint still
  goes through: its plain secret stays as it is, and the server log names the variable on one line (never the value).

**Values stored before this change** are plain text, and they keep working as they are. The Git credential is sealed the next time the configuration
is saved; enabling or disabling the export does not rewrite it. A webhook secret is sealed the next time its endpoint is updated (a change of its URL,
events or active flag; the secret itself does not change), so an endpoint that is never updated keeps its plain secret until it is created again. No
migration is run.

**The repository URL holds no token.** A configuration is refused when its URL has a password in it, or a user name in any scheme but ssh
(`https://<token>@host/...`, `ssh://user:password@host/...`): the token goes in the credential field, which is sealed. An ssh account name
(`ssh://git@host/...`) and the scp form (`git@host:path`) are allowed, since they name an account and no secret. A URL saved with a token before this
change still shows that token to the administrators who read the configuration, until the configuration is saved again with a URL that has none.
Rotate that token.

**The audit trail.** From this change on, no audit entry holds the Git credential: the entries of a configuration record a projection without it, and
the audit writer replaces the value under any credential-looking key (by name, at any depth, in the before and after states). The writer does not
look inside a text value, so a token in a text field such as the repository URL is kept out by the refusal above instead. The audit trail is
immutable (a trigger refuses `UPDATE` and `DELETE`), so the entries written before this change still hold the credential that was saved with them, in
clear text, and any repository URL saved with a token in it. Those rows are not rewritten.

**The connection test.** `testConnection` for a Git configuration does not reach the repository, and it never reports a connection: its answer
says "Not verified". Nothing in this build sends a file to a Git host either: the export and pull request paths record their work and do not push,
and they still write a sync status of SUCCESS for it (see `src/services/git.service.ts`). So a `lastSyncStatus` of SUCCESS written before this change
is not evidence that a host was reached: the old connection test wrote it without contacting anything.

No secret is written to a log or to an error message: the errors and the warning name the variable or the field, never the value.

## Webhooks: tenant and destination

A webhook endpoint (`/api/v1/webhooks`, a platform administrator's item) belongs to **one tenant**: the tenant the request acts in, which is the API key's tenant (`API_KEY_TENANT_ID`) or the signed-in session's active tenant. The list, the reads, the changes, the deletion and the delivery history of an endpoint are scoped to that tenant; another tenant's endpoint is the same 404 as a missing one. An event (`emission.completed`, `governance.request.*`) is sent only to the active endpoints of the tenant it belongs to; its payload names that tenant in `data.tenantId`.

The migration `20261101120000_webhook_endpoint_tenant` adds the column and backfills each existing endpoint from its creator's roles, when those roles name exactly one tenant. An endpoint it cannot attribute is **deactivated** and keeps no tenant, so it receives nothing: an endpoint the REST API key made (no creator), one whose creator holds only platform roles or no roles, and one whose creator's roles span more than one tenant. Such an endpoint is invisible to the REST routes until an administrator gives it a tenant: `UPDATE "webhook_endpoints" SET "tenantId" = '<tenant id>', "active" = true WHERE "id" = '<endpoint id>';`.

**Destinations.** An endpoint URL must be `https`, and its address must be public: a loopback, private, link-local, shared (CGNAT), multicast, documentation or other reserved address is refused, IPv4 or IPv6. An IPv4-mapped (`::ffff:`) or NAT64 (`64:ff9b::/96`) address is judged by the IPv4 address it carries. A URL is checked when an endpoint is created or its URL is changed, and every delivery checks the address it connects to, so a name that later resolves to a private address is not called. A redirect is not followed (a 3xx answer is a failed delivery), a delivery times out after 10 seconds, and a refused destination is recorded as one failed delivery that is not retried.

**Development only.** `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (or `1`) lets a delivery reach `http:` URLs and private or loopback addresses, so a receiver on the developer's machine can be tested. Never set it in production: an endpoint URL could then steer the server into its own network.

## Trusting the host (`UntrustedHost`) and the proxy (`AUTH_TRUST_PROXY`)

Two different questions, two different settings.

**The `Host` header** (`trustHost`, written out in `src/lib/auth.ts` by `src/lib/auth/trust-host.ts`). With `NODE_ENV=production` Auth.js rejects every request
whose `Host` it does not trust (`UntrustedHost`). The host is trusted when **`AUTH_URL`** names the public origin (`https://schemas.example.com`: Auth.js then builds
its URLs from it and not from the header) **or `AUTH_TRUST_HOST` is `true` (or `1`)**, which is right **behind a reverse proxy you control** that sets the `Host` header,
or when the app is reached at one address only. The compose file sets `AUTH_TRUST_HOST: "true"`. Directly on the internet, set `AUTH_URL` and drop `AUTH_TRUST_HOST`.
Without either, nothing can log in. Development and test always trust it. Differences from Auth.js's own default, on purpose: `AUTH_TRUST_HOST=false` (or `0`) means
no (Auth.js reads any set value as yes), `NEXTAUTH_URL` alone does not trust the host, and the `VERCEL` / `CF_PAGES` platform defaults are not applied (set `AUTH_URL`
or `AUTH_TRUST_HOST=true` there). The e2e release runner sets both for its own app.

**The client address** (`AUTH_TRUST_PROXY`, used by the sign-in throttle, below, and by the REST API's limit on requests that do not authenticate, under "The REST API key"). Set `AUTH_TRUST_PROXY=1` (exactly `1`; `true` is not read) only when a reverse proxy in front of the app **sets
`X-Forwarded-For` itself and overwrites whatever the client sent** (nginx `proxy_set_header X-Forwarded-For $remote_addr;`, most cloud load balancers). The app then
takes the **left-most** entry as the client address (a loopback address, 127.0.0.0/8 or `::1`, counts as no address: `next start` writes the socket's own address into the header when a request
carries none, so with the setting on and no proxy in front every request would be taken for one unknown client, which counts for nothing). If the proxy appends instead of overwriting, a client can write that header and choose its own bucket:
leave the setting off. Without it there is no client address (see "Throttling" and "The REST API key"), and **a header a caller makes up buys no allowance at all**
(KD-028: the limiter used to read `X-Forwarded-For` unconditionally). The 429 answer of the REST API is its own error envelope,
`{ "success": false, "error": { "code": "RATE_LIMITED", "message": ..., "details": { "retryAfter": <seconds> } } }`, with `Retry-After` and `X-RateLimit-*` headers. The limiters are
in memory, per process.

## Registration and the first administrator: read this before you expose it

### Who may make an account: `AUTH_REGISTRATION`

| Value | What `/register` does |
| --- | --- |
| `invite` (**the default**) | An account is made by accepting an invitation, `/invite/<token>`; the new account receives the roles the invitation carries. `/register` shows the generic "this link is not valid or has expired" page unless it is given a live invitation token (`/register?token=...` continues at `/invite/<token>`), and the sign-in page offers no "Create one" link. |
| `open` | Anyone may register. The account holds **no role**: the user lands on `/no-access` ("no access yet") until an administrator assigns one. The sign-in page shows "Create one". The e2e run uses this mode; a deployment that strangers can reach should not. Registering an address that already has an account is answered **exactly** like a new one (the same words, the same redirect to the sign-in page, no second account), so the form cannot be used to find out who has an account; nobody is signed in by registering. |
| `closed` | `/register` says registration is closed and the action refuses. Accounts come from `npm run admin:create`, the seed, or an invitation made earlier and still live. |

An unknown value (a typo) is the default (`invite`), never `open`, and the log says so once. The `.env.example` and `docker-compose.yml` leave it unset, so a
deployment starts invite-only.

### The first administrator

- **Nobody becomes the administrator by registering first.** No request creates an administrator: the first one is made by the seed or by a command
  (`src/lib/admin-bootstrap.ts`), and afterwards administrators grant roles.
- **The seed's administrator.** `npm run db:seed` creates `admin@admin.com` with the password `admin` as the global ADMIN **only when `NODE_ENV` is not
  `production`** (the e2e suite and a local seed rely on it). With `NODE_ENV=production` the seed creates no administrator unless **both**
  `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set, and then it creates that one instead (in any environment); setting only one of them stops
  the seed with a message. A configured password follows the policy below; the development default `admin` does not. Running the seed again changes nothing for an administrator that exists, and never resets
  a password; it gives the global role to an existing account only when the password you supply is that account's own.
- **`npm run admin:create`** makes one global administrator without seeding anything: `npm run admin:create -- --email you@example.com` and type the
  password at the prompt (not shown), or pipe it on standard input, or set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. It refuses a password
  the policy refuses and an e-mail that already has an account (it never promotes an existing account), says why, and changes nothing. The password is never
  a command-line argument.
- **Losing every administrator.** `npm run admin:create` with an address that has no account makes a new platform administrator. It cannot change an existing account.

### Roles at a glance

- Roles, lowest to highest: `VIEWER` reads; `AUTHOR` also writes, imports and generates; `STEWARD` also publishes, deploys, decides governance requests and
  makes products and domains; `COMPLIANCE_OFFICER` also reads the compliance pages (query, gaps, audit trail, export); `ADMIN` also deletes domains and products,
  manages the users and roles of its tenant, and holds the platform items (health, emitters, webhooks, git, classifications, the global type-mapping override)
  at the platform scope.
- Scopes, widest to narrowest: `GLOBAL` (the platform; ADMIN only) contains `TENANT`, which contains `DOMAIN`, which contains `PRODUCT`, which contains the
  entities. A tenant-level (Enterprise) entity is covered by its tenant and by the platform scope only.
- A person's role over a thing is the highest role they hold at a scope that covers it.
- **`COMPLIANCE_OFFICER` is not read-only.** The ladder is linear, so a compliance officer also holds the author's and the steward's rights. A read-only audit
  role would be a separate role outside the ladder: a policy change with its own tests, not a setting.

### How the first roles are granted

1. The first platform administrator comes from the seed or from `npm run admin:create` (above). Sign in as that account.
2. **A new person:** Admin, Users, invite. Enter the e-mail address, the role or roles, and the scope (a tenant, a domain or a product). The platform scope is
   offered only for ADMIN, and only to a platform administrator. The dialog shows one link, once, with its expiry (7 days by default; see "Invitation and reset
   links"). Hand the link over. The person opens `/invite/<token>`, sets a password, and the account receives exactly those roles.
3. **A person who already has an account:** Admin, Users, the user, roles: assign a role at a scope. The same rule applies: only an administrator who covers that
   scope may assign it, and nobody grants above their own role.
4. **A tenant administrator:** give ADMIN at the tenant scope with step 2 or step 3. A tenant administrator manages that tenant's users and roles. They cannot
   grant at the platform scope, cannot grant above their own role, and cannot remove their own administrator assignment.
5. No command grants a tenant role. Only an administrator in the application (or a direct edit of `user_roles`, which is not recommended) can.
6. The platform keeps at least one enabled platform administrator: the last one cannot be disabled, and its role cannot be removed (see "Administering users").

### Passwords and e-mail addresses

- An e-mail address is trimmed and lower-cased everywhere it is stored or compared, and unique case-insensitively.
- **A password is 12 to 72 BYTES** (bcrypt reads at most 72 bytes of the UTF-8 form and ignores the rest, so the limit counts bytes: `ü` is two, an emoji four) and
  must not be on the deny-list (`src/lib/auth/common-passwords.ts`: common passwords such as `password1234`, `123456789012`, `qwertyuiop12`; the same words
  dressed up, `P@ssw0rd!2024`, `MyPassword1234`; one character or one short unit repeated; a plain run such as `abcdefghijkl`; the user's e-mail address or the name in front of its `@`).
  The same rule applies to registration, accepting an invitation, a reset link, the seed and `admin:create`. Hashes are bcrypt at cost 12; hashes made earlier
  (any cost, `$2a$`, `$2b$`, `$2y$`) still verify, and are not re-made at sign-in.
- **No signed-in screen changes a password.** A person who forgot theirs is given a reset link by an administrator (Admin, Users, the user: a one-hour link, shown
  once; earlier reset links of that user stop working; not for a disabled account). Using it sets the new password and signs nobody in.
- **No timing oracle.** A sign-in for an address that has no account, one with no password, a locked one and a disabled one all cost one bcrypt compare, like
  a known account (a precomputed dummy hash is compared for the ones that have no hash to try).
- **One message.** The sign-in page answers `Invalid email or password` for an unknown e-mail, a wrong password, a disabled account and a locked e-mail or
  address alike. Nothing in the answer says "locked" and no `Retry-After` is sent.

### Throttling and lockout

Rows of the `auth_events` table drive it, so it holds across several instances and survives a restart. A row holds the kind of event, its outcome, the time and **HMAC-SHA-256
hashes (keyed with the session secret) of the e-mail address and of the client address, never the values**; rows older than 24 hours are deleted a batch at a time by the
inserts that follow (no scheduler). No screen clears a lock: it lifts when its window of 15 minutes has passed.

| Endpoint | What counts | Limit |
| --- | --- | --- |
| Sign-in | failures, per e-mail hash **and**, independently, per client-address hash | 5 in 15 minutes each; a success resets the e-mail's count (not the address's); an attempt refused because of the lock is recorded but does not count. An attempt takes its place BEFORE its password is compared (a `pending` row that counts as a failure until it is settled), so requests that arrive together cannot all be tried: at most 5 passwords per e-mail and window. Without a trusted proxy the address is not counted, so the e-mail limit is the only lock; the slowing described below applies to such sign-ins |
| `/register` (open mode) | every attempt, counted from the moment it takes its place (before the password is hashed) | 5 in 15 minutes per client address, with a trusted proxy only. Without one, nothing is locked and nothing is refused: a registration without an address waits, like a sign-in without one (point 2 below) |
| `/invite/<token>` and `/reset/<token>` | dead-link failures (a wrong, expired or used token), not a password the policy refused | 5 in 15 minutes per client address, with a trusted proxy only. Without one, a dead link is recorded but not counted, the address is never locked, and nothing is refused: a token is 32 random bytes, so there is nothing to guess, and a shared lock would turn away every valid link. A locked address gets the same "not valid or expired" answer, and the token is not looked at |
| Sign-in through an identity provider ([`auth.md`](auth.md)) | refusals by the provider policy (`provider_refused:<reason>` rows), whatever the reason | 5 in 15 minutes per client address, with a trusted proxy only. Without one, a refusal is recorded but not counted, so nothing is locked; the e-mail is never limited (the provider vouched for the person already). A locked address is refused with the same generic answer as a wrong password; the password login is not locked by it |

Without `AUTH_TRUST_PROXY=1` there is **no client address**: every request carries the same placeholder, and a bucket of it would let one anonymous caller lock out
everybody who shares it (a password sign-in, an invitation, a reset link, a provider sign-in). So the placeholder is never a lock. For a password sign-in the per-e-mail
limit (5) is the lock; invitation, reset and provider refusals have no limit at all in this configuration (the table above). Four things follow.

1. **Guesses spread over many e-mail addresses are slowed, not refused.** Once more than 20 counted attempts without an address (failed sign-ins, and every registration)
   have happened in this process within 15 minutes, each further sign-in or registration without an address waits 100 ms per extra attempt, up to 2 seconds
   (`src/lib/auth/login-backoff.ts`). Nothing is refused by it, and the wait holds the request, not a database connection. **The trade-off:** while the count is above 20,
   every sign-in or registration without an address waits, a correct password included, so
   an ordinary user signing in during a spread-out guessing run is slowed by up to 2 seconds. The count is per process, so N instances allow about N times as many guesses.
   It is a brake, not a limit: the real protection is a limit on `/api/auth/*` at the proxy, or `AUTH_TRUST_PROXY=1` behind one.
2. Open registration without an address is slowed by the same wait and never refused. Every such attempt counts toward the wait, because each one hashes a
   password. So one anonymous client cannot stop the sign-ups of everybody else (there is no shared lock for registration); the cost is the one of point 1.
3. The REST API's failed requests share one allowance of 20 a minute, which refuses only requests that failed to authenticate.
4. Set `AUTH_TRUST_PROXY=1` behind a proxy that overwrites `X-Forwarded-For` (above) to get a bucket per client. A production server that starts without it logs a warning
   saying so once.

A throttle that cannot be read, or in which a sign-in cannot take its place, refuses the attempt (fail closed). An attempt that never settles (the process died during the compare) stays counted as a failure for the rest of its window, which errs toward the lock.

The password sign-in and `/register` reserve their place: the row is written first and counted with the others, so of any number of simultaneous requests at most five are let through (a refused one stops counting). `/invite/<token>`, `/reset/<token>` and the provider check read the count and write afterwards, so a burst of simultaneous requests can pass their limit by about the size of the burst. None of them lets a guess be tried against a secret that can be found by guessing: an invitation or reset token is 32 random bytes, and a refused provider sign-in tries no password.

### Invitation and reset links

There is no e-mail service: an administrator copies the link and hands it over. A link carries a token of 32 random bytes; **only its SHA-256 is stored**, so nothing in the database opens
a link. A link works **once** (one atomic `UPDATE ... WHERE usedAt IS NULL AND expiresAt > now`, so two concurrent uses cannot both succeed). It lives **7 days (invitation)** or **1 hour (reset)**.
The Admin dialog always makes a 7-day invitation. The service accepts a lifetime from 1 hour to 30 days, which only a direct call sets. A wrong, expired and used token get the same page and the same words. An invitation makes the account for **the invited e-mail only** (the form cannot change it), grants the roles
the invitation carries, and is audited; a reset link sets a new password, kills the user's other outstanding reset links, and signs nobody in. A session that is already signed in
stays valid until it expires (the session is a signed token with no record on the server to revoke): disabling the user is what stops it, on the next request.

**The creator is judged again when the link is used.** An invitation is a promise of roles its creator could grant. At acceptance the creator is read from the database again
(`acceptInvitation`): a creator who has since been **disabled, demoted or removed from a tenant** can no longer promise them, so each role they may still grant (`grantAllowed`) is
given and the others are **skipped and listed in the audit entry** (`INVITATION_ACCEPTED`, `afterState.skipped`, each with its reason: `creator-cannot-grant`, or `scope-gone` for
a domain or product that has since been deleted). An invitation none of whose roles survives makes a roleless account (it sees "no access yet"). The e-mail was the creator's to
invite either way.

### Administering users (what the Admin screens call)

`src/services/user.service.ts` (the one place to import from; the parts live in `invitation.service.ts`, `user-directory.service.ts`, `rbac.service.ts`). Every function answers
`Result<T, ServiceError>` and never throws; the actor is **read from the database inside the SERIALIZABLE transaction that decides** (the context's label counts for nothing), and the
change and its audit entry commit together.

| Function | Who | What |
|---|---|---|
| `inviteUser({ email, roles, ttlHours? })` | an administrator allowed by `grantAllowed` for **every** role and scope asked | one-time link (`token`, `path`, `url`) and expiry; the address is normalized; an address that already has an account is refused; an earlier pending invitation for the same address that the inviter administers is replaced |
| `revokeInvitation(id)` | an administrator who reaches it | a **pending** invitation only; its link then answers the generic "not valid" |
| `listPendingInvitations()` | tenant administrator, platform administrator | the pending invitations in reach, roles by name |
| `setUserDisabled(userId, disabled)` | platform administrator: anyone; tenant administrator: a user whose roles all lie in their tenants | disable or enable; **never yourself, never the last enabled platform administrator**; disabling ends the user's reset links; takes effect on the next request |
| `createResetLink(userId)` | as `setUserDisabled` | a one-hour link; earlier links of that user stop working; not for a disabled account |
| `assignRole` / `removeRole` (`revokeRole`) | an administrator who covers the scope | every grant and revoke is audited (`ROLE_ASSIGNED`, `ROLE_REMOVED`); the last enabled platform administrator's role cannot be removed; nobody removes their own administrator assignment |
| `listUsers({ tenantId? })` | tenant administrator, platform administrator | users (status, last sign-in, roles by the names of their scopes) and the pending invitations, as far as the caller reaches |
| `getRoleMatrix(tenantId)` | an administrator of that tenant | users by scopes (the tenant, its domains, their products), the highest role per cell |

**Accounts are never deleted.** Audit rows point at their user and are immutable, so a user who has done anything cannot be removed; a person who must lose access is **disabled**
(refused at sign-in and on the next request). No code path deletes a user (`tests/unit/access/no-user-delete.test.ts` keeps it so).

**Reach.** A tenant administrator administers a user who holds at least one role in a tenant they administer and **whose every role lies in tenants they administer**. A user with a
platform role, with a role in another tenant too, or with no role at all is out of reach (only a platform administrator touches them), and so is a user, an invitation or a tenant that
does not exist: **a target out of reach answers byte for byte like a missing one** (`NOT_FOUND`, "User not found" / "Invitation not found" / "Tenant not found"), so a tenant
administrator cannot probe other tenants. The one refusal that says why is the one about yourself. Inviting an address that already has an account is told plainly to a platform
administrator and to one who can see that account (it holds a role in their tenant); to any other tenant administrator the answer is the hedged `INVITATION_REFUSED` ("if the person
already has an account, ask an administrator to assign their roles"): it does not say whether there is one (the refusal itself still shows that the address cannot be invited).

### Stored generated schemas and who reads them

A generated schema is stored in the entity's `metadata.schemaVersions` with the files of **every entity of the closure it was made from**. A version made by a wider role (a tenant
administrator) therefore holds files of entities a narrower reader of the root (a steward of one domain) may not read. **Every reader of the stored versions gets a copy**
(`src/lib/access/schema-version-redaction.ts`): the files of entities its roles do not cover are removed (a file with no `entityId` is the root's), `output` is rebuilt from the files that
are left with the generator's own bundling, the unreadable entities leave the resolution (and its free-text notes), and the copy says `redacted: { hiddenFiles, hiddenEntities }`; the Schemas tab
shows "N files of referenced entities are hidden for your role". The stored value is never changed (publishing and deploying go on from the whole list). Tenant and platform administrators, and
holders who cover every referenced entity, get the stored version as it is. Two cases hide the **whole** version, because one file there carries more than the entity it is tagged with:
the OpenAPI and Avro targets (each file inlines the entities it refers to, and the reference graph is not stored) and a Protobuf reference cycle (one shared file, tagged with its first member
only). An entity deleted since the version was made is judged as a tenant-level entity of the root's tenant. The surfaces: the Schemas tab (`getSchemaVersionsAction`),
`GET /api/v1/schemas/:id` (`metadata`), the entity page (the stored versions are not sent at all), the retention table, the entity list and the change log (the audit states drop them). The git
export writes the stored file sets whole: it is a platform administrator's act. `tests/unit/access/schema-versions-scan.test.ts` fails when a new reader of `schemaVersions` is neither redacted nor recorded
with its reason. Publishing a stored draft is judged on the entity (`entity.publish`) and publishes the stored version as it is: see "Access notes" in [`auth.md`](auth.md).

### Sessions

A session lasts **12 hours** and is renewed at most once an hour (`maxAge` and `updateAge` in `src/lib/auth.ts`). **A signed-in user is known by the id in the session, and only by it.** There is no
look-up by e-mail: after a database reset and reseed an old session names a user that no longer exists and is refused (the user signs in again), and a disabled account is refused on every request, not at
the end of the session. A signed-in user who holds no role in any tenant lands on `/no-access` (which shows who is signed in, says to ask an administrator, and offers to sign out), and the tenant they
work in (the `active_tenant` cookie) is only ever one they hold a role in.

A role limits what a user may change, and it also decides which tenants the user may open. **Every server action** asks the policy before it reads or writes (the deny-by-default
test fails for a new one that does not): the resource must lie in the tenant in view and a role of the user's must cover it (a domain- or product-scoped role judges at that domain or
product; a viewer reads, an author edits, a steward publishes, deploys, makes a product or a domain and decides governance requests, a compliance officer reads the compliance pages, a tenant
administrator deletes a domain or a product and manages the tenant's users and roles). Platform items (health, emitter configuration, webhooks, git configuration, the classification taxonomy and a
*global* type-mapping override, which changes every tenant's mapping) are for a global administrator only, whatever a user holds in a tenant. A webhook endpoint belongs to one tenant (`webhook_endpoints.tenantId`, see [Webhooks](#webhooks-tenant-and-destination)): an event reaches only the active endpoints of the tenant it belongs to. Lists across the tenant (governance requests, the retention
page, the deployment overview, external event references, "who uses", a concept's linked fields) show a user only what their roles cover. Every route handler is held to the same rule by the
deny-by-default scan (`tests/unit/access/deny-by-default.test.ts`): it fails for a handler that is neither guarded nor on the public list, and its pending lists are empty. The scan does not read page
files. The dashboard layout sends a role-less user to `/no-access`, and KD-034 in `docs/testing/known-defects.md` records how the pages ask the policy and what the tenant-in-view cookie still allows.

## What to do on any deployment that is not a laptop

1. Leave `AUTH_REGISTRATION` unset (invite-only) or `closed`. Run the seed with `NODE_ENV=production` (or do not seed) and make your administrator with `npm run admin:create` or the two `BOOTSTRAP_ADMIN_*` variables.
   A database that was seeded earlier outside production keeps `admin@admin.com` / `admin`. Change that: make a second platform administrator with `npm run admin:create`, sign in as it,
   and in Admin, Users make a reset link for `admin@admin.com` and set a new password from it; or disable that account once the second administrator exists (the last enabled platform administrator cannot be disabled).
2. Leave `AUTH_PROVIDERS` unset unless you want identity providers (then read [`auth.md`](auth.md): a provider only signs in people who already have an account, `_LINK_EXISTING_USERS` is a
   risk you take for a provider whose verified e-mails you trust, and a mistake in the provider settings stops a production server from starting).
3. Behind a reverse proxy: let it overwrite `X-Forwarded-For` and set `AUTH_TRUST_PROXY=1`; also keep a rate limit on `/api/auth/*` at the proxy (the throttle covers password attempts, not requests that never reach the check).
4. Keep the app on a private network, or behind an authenticating proxy (SSO, a VPN), until you have accepted the open items in "What is NOT covered" below. The REST API's rate limit is per process (KD-028), and the tenant in view is a per-browser cookie (KD-034).

## Health endpoint

`GET /api/v1/health` is unauthenticated on purpose (monitors call it): `200` for healthy or degraded, `503` for unhealthy, `Cache-Control: no-cache`.
It checks the database (`SELECT 1`, the result is cached for five seconds, so a monitor that calls every second costs one query per five), the
parser worker and the compiler and emitters that are installed. It answers `503 {"status":"unhealthy","error":"Health check unavailable"}` and
logs the cause when the check itself cannot run: it never returns the cause to an unauthenticated caller. The same checks, in more detail, are in
Admin, Health (platform administrators only).

**The status code is readiness for serving requests**, so a probe can gate on it: `503` only when the database does not answer or the TypeSpec
compiler (the core) is not installed. A missing emitter package makes the answer `degraded` (`200`, "N of M emitter packages installed"): the
application serves, and only generating that target fails. **The unauthenticated body names no package and no version** (they fingerprint the
install); the names of what is missing and the installed versions are in the server's log and in Admin, Health (the `detail` line of each service).

**The Docker image cannot generate schemas yet** (KD-040 in `docs/testing/known-defects.md`). Its standalone output ships `@typespec/compiler` and no
emitter package and no `node_modules/.bin/tsp`, so in that image `/api/v1/health` reads `degraded` (`200`) with a count below M and generating a
target fails; import, editing and the in-process compile work. Five of the emitters are `file:../typespec/packages/*` dependencies of the sibling
`typespec` repository, which the image build does not have. Until they are vendored (as `vendor/typespec-enterprise` is), run the application from
a checkout (`npm ci && npm run build && npm start`) when generation is needed.

## The REST API key

`API_KEY` (an environment variable) enables `Authorization: Bearer <key>` on `/api/v1/*`. The root middleware lets only `/api/v1/*`, `/api/auth/*` and
the asyncapi preview assets through without a session cookie, so **a key works on `/api/v1/*` only**; every other `/api/*` route needs a session (a
Bearer-only caller gets 401 from the middleware before the route runs). The key is compared in constant time; a bearer token that is not the key is
401, and the session next to it is not the fallback (an EMPTY bearer token, or another scheme, is judged by the session).

**The key is a service principal bound to one tenant and one role** (`src/lib/access/api-key.ts`):

| Setting | Meaning | Default |
|---|---|---|
| `API_KEY_TENANT_ID` | the tenant the key acts in: `GET /api/v1/schemas` and the by-id routes answer for that tenant's entities and nothing else (an entity of another tenant is the same 404 as a missing one) | the default tenant (`tenant_default`) |
| `API_KEY_ROLE` | the role the key holds: `VIEWER`, `AUTHOR`, `STEWARD`, `COMPLIANCE_OFFICER` or `ADMIN` | `ADMIN` |

The default is `ADMIN` so integrations that existed before access control keep working, and that is a trade-off to decide on, not a recommendation: **an
`ADMIN` key is a platform administrator**, as the key has always been (`/api/v1/webhooks*` are platform items and need one), while its schemas are confined
to `API_KEY_TENANT_ID`. A key that only reads schemas for CI should be `API_KEY_ROLE=VIEWER`: it holds a role in its tenant only, reads that tenant's
schemas, and is refused the webhook routes (403). An `API_KEY_ROLE` that is not one of the five roles turns the key OFF (every call is 401); it never falls
back to `ADMIN`. Blank settings are the defaults. The key has no user row: it has no notifications, and a webhook endpoint it creates has no creator and belongs to the key's tenant (`API_KEY_TENANT_ID`).

**A session on `/api/v1` has the signed-in user's real roles** (it used to be a viewer, the administrator's own login included): it reads the schemas of its
active tenant that its roles cover (a domain- or product-scoped role sees only its own), and uses the webhook routes only when the user is a platform
administrator. A user with no role is told 404 on the schema routes and 403 on the webhook routes, never a 500. **The webhook list never carries a signing
secret**: the secret is in the answer of the creation, once.

### Rate limits

The REST API limits the routes that serve tenant data: `GET /api/v1/schemas` and `/api/v1/schemas/:id`, `POST` on `/api/v1/schemas/:id/emit` and `/validate`,
`GET /api/v1/event-specs/:id`, `/api/v1/notifications` and the webhook routes. The credential is checked **first**, so a request without a valid one never spends
anyone's allowance:

- An authenticated request counts against its **principal**: the API key (one service principal, so every caller of the key shares one allowance) or the
  signed-in user. The allowance is **100 requests a minute**; `API_RATE_LIMIT_PER_MINUTE` sets another positive whole number. The 101st is a 429.
- A request that does not authenticate (no credential, a wrong key, an expired session) counts against its **client address**, in an allowance of its own of
  **20 a minute**. With `AUTH_TRUST_PROXY=1` each address has its own; without it there is no address, and all such requests share one allowance. That
  allowance refuses only requests that failed to authenticate: a valid key or session is never refused because of it.
- The 429 is the API's error envelope (`RATE_LIMITED`), with `Retry-After` and `X-RateLimit-*` headers. The allowances are kept in memory, per process (KD-028).
- **Compiler runs have their own share.** One emission (`emit`, `validate`) is one TypeSpec run per enabled target. A principal may hold **16 runs** in flight
  (queued or running) at once: an emit or validate call that would go over it is a 429 (`RATE_LIMITED`) and builds nothing, so one caller cannot fill the
  compiler's shared queue for everybody else. The process-wide queue itself is bounded (`TSP_MAX_CONCURRENT_RUNS` at a time, 200 waiting, and a run waits at
  most **60 seconds** for its slot, `TSP_MAX_WAIT_MS` in src/lib/typespec-official/emitter.service.ts): a run that finds the queue full, or that waited that
  long, is answered **503** (`EMITTER_BUSY`, `Retry-After`), never as `valid: false`. A client that disconnects cancels its runs: one still waiting leaves its queue
  at once and starts nothing; one running is killed. The share is given back when the request has settled. An event's renders (the draft, a preview, a publish, a
  pinned schema) take one unit each, up to the whole share, and wait in the renderer's own queue (two at a time, 200 waiting, 60 seconds each, the same answers).
- `POST /api/ai/generate-entity` (the app's own route, not `/api/v1`) is limited by the same principal allowance, answered in the app's `{ "error": "..." }`
  shape with a 429 and `Retry-After`.

The app's own session endpoints under `/api/` (the compliance ones, the tenant switcher's, the command palette's) are not limited by this, except the AI
generation route described above. The dashboard's generate and emit actions share the compiler-run share of their user (16 runs in flight), but not the
per-minute allowance. So do the event renders: a draft emission (`GET /api/v1/event-specs/:id?version=draft`, the dashboard's draft and preview) and a publish
preview or publish take **one unit of the caller's share per render they start** (at most the whole share), and a pinned JSON Schema takes one. The units are given back
when the call settles. A call the share cannot hold is refused the same way (429 on the REST route, the same message in the dashboard) before anything is rendered.
A busy compiler or render queue answers 503 with `Retry-After` on the REST route, and a retry in the dashboard. The draft's compiler runs are cancelled when the client goes away
on the REST route. The renders wait in the renderer's own queue (two at a time, 200 waiting, 60 seconds each), so one caller's queued renders are bounded by its share, or by
one document's own renders when that is more than the share.

## The audit trail has a tenant

Every audit row (`audit_log`) carries the tenant it belongs to (`audit_log.tenantId`), written by `withAudit` (`src/lib/audit.ts`) from the **acting tenant**: the
tenant the guard resolved for the action (an action passes it), or, where a caller does not know it, the tenant of the row the entry is about (an entity, a domain, an
event or a trait states its own tenant, a field is found through its entity, a product through its domain, an annotation through the entity or field it is on). The compliance
**Audit Trail** and its export (`/api/compliance/audit-trail` and `/api/compliance/audit-trail/export`, both `compliance.audit`: a compliance officer or administrator of the **whole** tenant)
read only the rows of the tenant being viewed. The export is every entry the filters select, up to 10,000 (`MAX_EXPORT_ROWS`), and says so when it is cut short.

Rows **no tenant owns** have `tenantId = NULL` and are **shown to platform administrators only** (a platform administrator reading a tenant's trail also gets them):
the entries about the platform itself (a user's name, the git connection, a pull request) and **the rows written before the column existed that the migration could
not attribute** (a CREATE that was written with the placeholder id `pending`, a row whose target had been deleted and whose state names no tenant). A tenant's own
compliance officers never see them, which is the point: they cannot be told apart from another tenant's. If you need an old row in a tenant's trail, set its `tenantId`
by hand (the table is immutable: lift the `audit_log_immutable` trigger for that statement, as the migration does, and put it back).

## Rolling back the access-control migration

The procedure is also in [`database.md`](database.md). The rollback is `prisma/migrations/20261025230000_access_control/rollback.sql`. Neither runner reads it: the
migration is applied forward only, and a rollback is a decision taken with the application stopped.

**Before you deploy the migration** (it applies to a database that already has data):

- It refuses, changing nothing, when two accounts have the same e-mail address once trimmed and lower-cased, or when one user holds two role rows for the same
  role and scope. The error lists them. To find the first kind: `SELECT lower(btrim("email")), count(*) FROM "users" GROUP BY 1 HAVING count(*) > 1;`
- Legacy global roles other than ADMIN (for example a system-level `COMPLIANCE_OFFICER`) become one tenant-scoped role per tenant that exists when the migration runs.
  A tenant created later gets none. Read that conversion (the migration's header) before you deploy.

**Rolling back**, newest migration first, and only what you applied:

1. Stop the application.
2. The webhook endpoint tenant migration (`20261101120000_webhook_endpoint_tenant`), only if you need the endpoints to belong to no tenant again: its `rollback.sql` drops `webhook_endpoints.tenantId`. The endpoints it deactivated stay inactive; re-activate the ones that should deliver. Run the file (`psql` with `-v ON_ERROR_STOP=1 -f`), then delete its tracking row: `DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101120000_webhook_endpoint_tenant';`. On PGlite, use `"_pglite_migrations"` and `name`, as for the migration below.
3. The webhook endpoint migration (`20261026000000_webhook_endpoint_creator_optional`), only if you need `webhook_endpoints.createdBy` NOT NULL again. Its
   `rollback.sql` refuses, changing nothing, while any endpoint has no creator, and every endpoint the REST API key created has none. Delete those endpoints, or
   give each a creator first: `UPDATE "webhook_endpoints" SET "createdBy" = '<a user id>' WHERE "createdBy" IS NULL;`. Then run the file (`psql` with `-v ON_ERROR_STOP=1 -f`, as in step 4) and delete its tracking row: `DELETE FROM "_prisma_migrations" WHERE migration_name = '20261026000000_webhook_endpoint_creator_optional';`.
   On PGlite, run the file through a PGlite handle and delete its row: `DELETE FROM "_pglite_migrations" WHERE name = '20261026000000_webhook_endpoint_creator_optional';`.
   The access-control rollback does not need this step.
4. The access-control migration:
   - PostgreSQL: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025230000_access_control/rollback.sql`. The file is one transaction: it completes or
     changes nothing. Then remove the record: `DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025230000_access_control';`. Do not use
     `prisma migrate resolve --rolled-back`: it refuses a migration that succeeded (P3012).
   - PGlite: the same file runs through a PGlite handle on the data directory, then `DELETE FROM "_pglite_migrations" WHERE name = '20261025230000_access_control';`.
     The repository has no command for that; `tests/integration/access-control-migration.test.ts` runs it that way.
5. Start the older application version, the one that predates access control.

**What the rollback does:**

- Drops `invitations`, `invitation_roles`, `auth_tokens` and `auth_events` (pending invitations and reset links are lost, and so is the throttle history: every lock lifts),
  the tenant column of the audit trail, the scope key and granting-user columns of `user_roles`, the case-insensitive e-mail index, `users.disabledAt` and `users.lastLoginAt`,
  and restores the old unique key of `user_roles`.
- Keeps every user, every global and domain-scoped role, and every audit row (their tenant is lost).
- Moves tenant- and product-scoped role rows to `user_roles_access_control_backup` and removes them from `user_roles`. The older code would read them as wider, so they are not
  left in place. Those people lose those roles in the older version until someone grants them again by hand. This includes the roles the migration itself made from legacy
  global roles.
- Clears `users.password` for disabled users, so the rollback does not silently re-enable them. They cannot sign in with a password until a new bcrypt hash is written to `users.password`.
- Does not revert the lower-cased e-mail addresses.

**Limits:**

- Not reversible. The dropped rows are gone; export invitations, tokens and auth events first if you need them.
- The backup table is created by the rollback. Keep it until you have granted again what it holds, then drop it. The migration can be applied again afterwards, once the tracking row is gone (the integration test does this after dropping the backup table).
- The suite runs `rollback.sql` on PGlite only. The PostgreSQL run is not in the suite: rehearse it on a throwaway database before you do it on yours.

## What is NOT covered

These are the open items. Each is either a decision recorded in `docs/testing/known-defects.md` or a thing this repository does not do.

- **Identity providers against a real provider.** None has been tried. The rules are tested against stubs; see [`auth.md`](auth.md). Provider settings are environment variables only: there is no in-app screen for provider secrets (KD-047).
- **E-mail.** Nothing is sent. Invitation and reset links are shown once to the administrator, who hands them over.
- **Inviting an address tells an administrator whether it has an account (accepted).** The hedged `INVITATION_REFUSED` hides it from a tenant administrator who cannot see that account, but the refusal itself shows that the address cannot be invited, so a person with the right to invite can still learn that an address has an account somewhere. Platform administrators are told plainly.
- **Sessions cannot be revoked one by one, and they slide.** A session is a 12-hour window renewed at most once an hour, so a user who keeps working stays signed in. A disabled user is refused on the next request. A password reset does not end sessions that are already signed in.
- **The tenant in view is a cookie** (KD-034). A user with roles in two tenants who opens a deep link into the other tenant gets a 404 until they switch, and a cookie that names a tenant whose role was revoked falls back silently.
- **Page files are not in the deny-by-default scan.** The scan covers server actions and route handlers. KD-034 records how the pages ask the policy.
- **The REST API's limits are per process** (KD-028): several instances each allow their own 100 a minute per authenticated caller, 16 compiler runs in flight per caller, and 20 a minute of requests that do not authenticate (per address with `AUTH_TRUST_PROXY=1`; one shared allowance without it). The sign-in throttle is in the database and holds across instances.
- **Password guesses spread over many e-mail addresses are only slowed by this app without `AUTH_TRUST_PROXY=1`, never refused** (see Throttling: a per-process wait that grows with the failures, which also slows correct sign-ins while it runs). The start-up warning says so; a real limit belongs at the proxy.
- **The glossary is one list for every tenant** (KD-043). **An event document can name an entity its author may not read** (KD-044).
- **A steward can publish a stored draft whose files they cannot see.** This is accepted; see [`auth.md`](auth.md), "Access notes".
- **Closed registration has no browser test.** Its server behaviour is unit and PGlite tested (`docs/testing/access-control.md`).
- **The rollback is proved on PGlite only** (see above).
- **Changing the password of the development administrator** has no screen (see "What to do" above). Accounts are never deleted, so the development administrator stays until it is disabled or its password is changed.
- **Lost administrators** are recovered from the command line only: `npm run admin:create` for a new address, or the seed with both `BOOTSTRAP_ADMIN_*` variables set to an existing account's own e-mail and password. There is no unlock screen for a throttled account (the lock lifts after 15 minutes).
- **Audit rows with no tenant** are visible to platform administrators only, and the rows the migration could not attribute stay that way.
- **Auth.js's `AUTH_REDIRECT_PROXY_URL`** is read by Auth.js. This application does not set it, and the e2e runner blanks it (`docs/testing/e2e.md`).

## See also

- [`auth.md`](auth.md): the identity providers (settings, redirect URIs, the rules of a provider sign-in, linking, worked examples), and the access notes.
- `docs/database.md`: the migrations, the rollback procedure, and the production notes.
- `docs/testing/access-control.md`: what the browser suite proves about who may see and do what.
- `docs/testing/e2e.md`, "Access control": how the browser suite sets the access-control scenarios up.
- `docs/testing/known-defects.md`: KD-028 (the REST rate limit), KD-034 (the tenant in view), KD-038 (the registration and bootstrap risks above), KD-043 and KD-044 (glossary and event documents), KD-047 (no in-app screen for provider secrets).
- `docs/testing/e2e.md`: the browser suite, which runs with its own throwaway secret and database and never uses a `.env`.
- `src/lib/auth-secret.ts`, `src/instrumentation.ts`, `src/lib/session-cookie.ts`, `src/middleware.ts`, and for sign-in `src/lib/auth.ts` with `src/lib/auth/` (`credentials.ts`,
  `password-policy.ts`, `password-hash.ts`, `throttle.ts`, `tokens.ts`, `registration-mode.ts`, `trust-host.ts`, and for identity providers `providers.ts`, `provider-signin.ts`,
  `provider-callback.ts`, `adapter-guard.ts`).
