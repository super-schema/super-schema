# Authentication: what to configure and what to know before you run it

Short and operational. The access-control work (roles per tenant, domain and product) is still landing: the sections below say what is true now and what is
not yet. Sign-in itself (registration modes, passwords, throttling, invitation and reset links, sessions) is described in full here.

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

`.docker/docker-compose.yml` has no default for it: `docker compose up` stops with "set NEXTAUTH_SECRET" until you `export NEXTAUTH_SECRET="$(openssl rand -base64 32)"`.
A secret is per deployment and per environment: a secret that is shared between environments makes a login of one valid in the other.

**Rotation is not supported.** Auth.js can rotate with `AUTH_SECRET_1`, `AUTH_SECRET_2`, `AUTH_SECRET_3`, but it reads those only when it has no
secret of its own, and the middleware reads only `AUTH_SECRET` and `NEXTAUTH_SECRET`. With the rotation names alone the middleware has no
secret and **fails closed**: every request bounces to `/login`, and a production server refuses to start. To change the secret, change
`AUTH_SECRET` (or `NEXTAUTH_SECRET`) and restart: every session is signed out (users log in again).

## Trusting the host (`UntrustedHost`) and the proxy (`AUTH_TRUST_PROXY`)

Two different questions, two different settings.

**The `Host` header** (`trustHost`, written out in `src/lib/auth.ts` by `src/lib/auth/trust-host.ts`). With `NODE_ENV=production` Auth.js rejects every request
whose `Host` it does not trust (`UntrustedHost`). The host is trusted when **`AUTH_URL`** names the public origin (`https://schemas.example.com`: Auth.js then builds
its URLs from it and not from the header) **or `AUTH_TRUST_HOST` is `true` (or `1`)**, which is right **behind a reverse proxy you control** that sets the `Host` header,
or when the app is reached at one address only. The compose file sets `AUTH_TRUST_HOST: "true"`. Directly on the internet, set `AUTH_URL` and drop `AUTH_TRUST_HOST`.
Without either, nothing can log in. Development and test always trust it. Differences from Auth.js's own default, on purpose: `AUTH_TRUST_HOST=false` (or `0`) means
no (Auth.js reads any set value as yes), `NEXTAUTH_URL` alone does not trust the host, and the `VERCEL` / `CF_PAGES` platform defaults are not applied (set `AUTH_URL`
or `AUTH_TRUST_HOST=true` there). The e2e release runner sets both for its own app.

**The client address** (`AUTH_TRUST_PROXY`, used only by throttling: below). Set `AUTH_TRUST_PROXY=1` only when a reverse proxy in front of the app **sets
`X-Forwarded-For` itself and overwrites whatever the client sent** (nginx `proxy_set_header X-Forwarded-For $remote_addr;`, most cloud load balancers). The app then
takes the **left-most** entry as the client address. If the proxy appends instead of overwriting, a client can write that header and choose its own throttle bucket:
leave the setting off. Without it every request is in one shared bucket (see "Throttling").

## Registration and the first administrator: read this before you expose it

### Who may make an account: `AUTH_REGISTRATION`

| Value | What `/register` does |
| --- | --- |
| `invite` (**the default**) | An account is made by accepting an invitation, `/invite/<token>`; the new account receives the roles the invitation carries. `/register` shows the generic "this link is not valid or has expired" page unless it is given a live invitation token (`/register?token=...` continues at `/invite/<token>`), and the sign-in page offers no "Create one" link. |
| `open` | Anyone may register. The account holds **no role**: the user lands on `/no-access` ("no access yet") until an administrator assigns one. The e2e run and a laptop use it; a deployment that is reachable by strangers should not. Registering an address that already has an account is answered **exactly** like a new one (the same words, the same redirect to the sign-in page, no second account), so the form cannot be used to find out who has an account; nobody is signed in by registering. |
| `closed` | `/register` says registration is closed and the action refuses. Accounts come from `npm run admin:create`, the seed, or an invitation made earlier and still live. |

An unknown value (a typo) is the default (`invite`), never `open`, and the log says so once. The `.env.example` and `docker-compose.yml` leave it unset, so a
deployment starts invite-only.

### The first administrator

- **Nobody becomes the administrator by registering first.** No request creates an administrator: the first one is made by the seed or by a command
  (`src/lib/admin-bootstrap.ts`), and afterwards administrators grant roles.
- **The seed's administrator.** `npm run db:seed` creates `admin@admin.com` with the password `admin` as the global ADMIN **only when `NODE_ENV` is not
  `production`** (the e2e suite and a laptop rely on it). With `NODE_ENV=production` the seed creates no administrator unless **both**
  `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set, and then it creates that one instead (in any environment); setting only one of them stops
  the seed with a message. The password follows the policy below. Running the seed again changes nothing for an administrator that exists, and never resets
  a password; it gives the global role to an existing account only when the password you supply is that account's own.
- **`npm run admin:create`** makes one global administrator without seeding anything: `npm run admin:create -- --email you@example.com` and type the
  password at the prompt (not shown), or pipe it on standard input, or set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. It refuses a password
  the policy refuses and an e-mail that already has an account (it never promotes an existing account), says why, and changes nothing.

### Passwords and e-mail addresses

- An e-mail address is trimmed and lower-cased everywhere it is stored or compared, and unique case-insensitively.
- **A password is 12 to 72 BYTES** (bcrypt reads at most 72 bytes of the UTF-8 form and ignores the rest, so the limit counts bytes: `ü` is two, an emoji four) and
  must not be on the deny-list (`src/lib/auth/common-passwords.ts`: common passwords such as `password1234`, `123456789012`, `qwertyuiop12`; the same words
  dressed up, `P@ssw0rd!2024`, `MyPassword1234`; one character or one short unit repeated; a plain run such as `abcdefghijkl`; the user's e-mail address or the name in front of its `@`).
  The same rule applies to registration, accepting an invitation, a reset link, the seed and `admin:create`. Hashes are bcrypt at cost 12; hashes made earlier
  (any cost, `$2a$`, `$2b$`, `$2y$`) still verify, and are not re-made at sign-in.
- **No timing oracle.** A sign-in for an address that has no account, one with no password, a locked one and a disabled one all cost one bcrypt compare, like
  a known account (a precomputed dummy hash is compared for the ones that have no hash to try).
- **One message.** The sign-in page answers `Invalid email or password` for an unknown e-mail, a wrong password, a disabled account and a locked e-mail or
  address alike. Nothing in the answer says "locked" and no `Retry-After` is sent.

### Throttling and lockout

Rows of the `auth_events` table drive it, so it holds across several instances and survives a restart. A row holds the kind of event, its outcome, the time and **HMAC-SHA-256
hashes (keyed with the session secret) of the e-mail address and of the client address, never the values**; rows older than 24 hours are deleted a batch at a time by the
inserts that follow (no scheduler).

| Endpoint | What counts | Limit |
| --- | --- | --- |
| Sign-in | failures, per e-mail hash **and**, independently, per client-address hash | 5 in 15 minutes each; a success resets the e-mail's count (not the address's); an attempt refused because of the lock is recorded but does not count |
| `/register` (open mode) | every attempt | 5 in 15 minutes per client address |
| `/invite/<token>` and `/reset/<token>` | dead-link failures (a wrong, expired or used token), not a password the policy refused | 5 in 15 minutes per client address; a locked address gets the same "not valid or expired" answer |

Without `AUTH_TRUST_PROXY=1` every request is in **one shared address bucket**, so it has a higher ceiling (100 failures in 15 minutes: five typos by five people must not
lock everybody out) and the per-e-mail limit (5) is the protection that matters. Set `AUTH_TRUST_PROXY=1` behind a proxy that overwrites `X-Forwarded-For` (above) to get a
bucket per client. A throttle that cannot be read refuses the attempt (fail closed).

### Invitation and reset links

There is no e-mail service: an administrator copies the link and hands it over. A link carries a token of 32 random bytes; **only its SHA-256 is stored**, so nothing in the database opens
a link. A link works **once** (one atomic `UPDATE ... WHERE usedAt IS NULL AND expiresAt > now`, so two concurrent uses cannot both succeed) and lives **7 days (invitation)** or **1 hour (reset)**.
A wrong, expired and used token get the same page and the same words. An invitation makes the account for **the invited e-mail only** (the form cannot change it), grants the roles
the invitation carries, and is audited; a reset link sets a new password, kills the user's other outstanding reset links, and signs nobody in. A session that is already signed in
stays valid until it expires (the session is a signed token with no record on the server to revoke): disabling the user is what stops it, on the next request.

### Sessions

A session lasts **12 hours** and is renewed at most once an hour (`maxAge` and `updateAge` in `src/lib/auth.ts`). **A signed-in user is known by the id in the session, and only by it.** There is no
look-up by e-mail: after a database reset and reseed an old session names a user that no longer exists and is refused (the user signs in again), and a disabled account is refused on every request, not at
the end of the session. A signed-in user who holds no role in any tenant lands on `/no-access` (which shows who is signed in, says to ask an administrator, and offers to sign out), and the tenant they
work in (the `active_tenant` cookie) is only ever one they hold a role in.

A role limits what a user may change, and it also decides which tenants the user may open. **Every server action** asks the policy before it reads or writes (the deny-by-default
test fails for a new one that does not): the resource must lie in the tenant in view and a role of the user's must cover it (a domain- or product-scoped role judges at that domain or
product; a viewer reads, an author edits, a steward publishes, deploys, makes a product or a domain and decides governance requests, a compliance officer reads the compliance pages, a tenant
administrator deletes a domain or a product and manages the tenant's users and roles). Platform items (health, emitter configuration, webhooks, git configuration, the classification taxonomy and a
*global* type-mapping override, which changes every tenant's mapping) are for a global administrator only, whatever a user holds in a tenant. Lists across the tenant (governance requests, the retention
page, the deployment overview, external event references, "who uses", a concept's linked fields) show a user only what their roles cover. What does not ask the policy yet: the API routes (`/api/*`,
`/api/v1`) and the page loaders that read the database directly (KD-034 in `docs/testing/known-defects.md`; the deny-by-default test lists each route by name).

What to do on any deployment that is not a laptop:

1. Leave `AUTH_REGISTRATION` unset (invite-only) or `closed`. Run the seed with `NODE_ENV=production` (or do not seed) and make your administrator with `npm run admin:create` or the two `BOOTSTRAP_ADMIN_*` variables.
   A database that was seeded earlier keeps `admin@admin.com` / `admin`: change that password straight away (there is no UI for it yet: update the
   `User.password` bcrypt hash in the database, or delete the user once you have another administrator).
2. Behind a reverse proxy: let it overwrite `X-Forwarded-For` and set `AUTH_TRUST_PROXY=1`; also keep a rate limit on `/api/auth/*` at the proxy (the throttle covers password attempts, not requests that never reach the check).
3. Keep the app on a private network, or behind an authenticating proxy (SSO, a VPN), until the API routes and the page loaders ask the policy too (KD-034).

## Health endpoint

`GET /api/v1/health` is unauthenticated on purpose (monitors call it): `200` for healthy or degraded, `503` for unhealthy, `Cache-Control: no-cache`.
It checks the database (`SELECT 1`, the result is cached for five seconds, so a monitor that calls every second costs one query per five), the
parser worker and the compiler and emitters that are installed. It answers `503 {"status":"unhealthy","error":"Health check unavailable"}` and
logs the cause when the check itself cannot run: it never returns the cause to an unauthenticated caller. The same checks, in more detail, are in
Admin, Health (administrators only).

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

`API_KEY` (an environment variable) enables `Authorization: Bearer <key>` on `/api/v1/*`. Whoever has the key acts as an administrator there. The
root middleware lets only `/api/v1/*`, `/api/auth/*` and the asyncapi preview assets through without a session cookie, so **a key works on
`/api/v1/*` only**; every other `/api/*` route needs a session (a Bearer-only caller gets 401 from the middleware before the route runs).

## See also

- `docs/testing/e2e.md`: the browser suite, which runs with its own throwaway secret and database and never uses a `.env`. Access control, and what
  the suite will need when it lands, is in its last section.
- `docs/testing/known-defects.md`: KD-034 (a tenant is a cookie), KD-035 (granting and revoking a role is not audited), KD-038 (the registration and bootstrap risks above).
- `src/lib/auth-secret.ts`, `src/instrumentation.ts`, `src/lib/session-cookie.ts`, `src/middleware.ts`, and for sign-in `src/lib/auth.ts` with `src/lib/auth/` (`credentials.ts`,
  `password-policy.ts`, `password-hash.ts`, `throttle.ts`, `tokens.ts`, `registration-mode.ts`, `trust-host.ts`).
