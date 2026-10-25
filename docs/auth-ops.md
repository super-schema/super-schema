# Authentication: what to configure and what to know before you run it

Short and operational. The access-control work (roles per tenant, domain and product, closed registration) will change several things below;
the sections that will change say so. Until then, read the warnings.

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

## Trusting the host (`UntrustedHost`)

With `NODE_ENV=production` Auth.js rejects every request whose `Host` it does not trust (`UntrustedHost`) unless `AUTH_URL` is set or the host is
trusted. The compose file sets `AUTH_TRUST_HOST: "true"`, which is right **behind a reverse proxy you control** that sets the `Host` header, or when
the app is reached at one address only. Directly on the internet, set `AUTH_URL` to the public origin (`https://schemas.example.com`) and drop
`AUTH_TRUST_HOST`. Without either, nothing can log in. The e2e release runner sets both for its own app.

## Registration and the first administrator: read this before you expose it

**This will change with the access-control work. Until it does:**

- `/register` is **open**: anyone who can reach the app can create an account. There is no invitation, no email check, no throttling on
  registration or login (a bcrypt hash at cost 12 is about 340 ms of CPU, so many attempts are also a way to load the server).
- **Nobody becomes the administrator by registering first any more.** A registered account holds no role. The first administrator is made by the seed
  or by a command, never by a request (`src/lib/admin-bootstrap.ts`).
- **The seed's administrator.** `npm run db:seed` creates `admin@admin.com` with the password `admin` as the global ADMIN **only when `NODE_ENV` is not
  `production`** (the e2e suite and a laptop rely on it). With `NODE_ENV=production` the seed creates no administrator unless **both**
  `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set, and then it creates that one instead (in any environment); setting only one of them stops
  the seed with a message. The password must be 12 to 72 bytes. Running the seed again changes nothing for an administrator that exists, and never resets
  a password; it gives the global role to an existing account only when the password you supply is that account's own.
- **`npm run admin:create`** makes one global administrator without seeding anything: `npm run admin:create -- --email you@example.com` and type the
  password at the prompt (not shown), or pipe it on standard input, or set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. It refuses a password
  outside 12 to 72 bytes and an e-mail that already has an account (it never promotes an existing account), says why, and changes nothing.
- Every signed-in user can currently read what the app shows: a role limits what a user may change, not which tenant (a tenant is a cookie and an
  organisational label: KD-034 in `docs/testing/known-defects.md`).

What to do meanwhile, on any deployment that is not a laptop:

1. Run the seed with `NODE_ENV=production` (or do not seed) and make your administrator with `npm run admin:create` or the two `BOOTSTRAP_ADMIN_*` variables.
   A database that was seeded earlier keeps `admin@admin.com` / `admin`: change that password straight away (there is no UI for it yet: update the
   `User.password` bcrypt hash in the database, or delete the user once you have another administrator).
2. Keep the app on a private network, or behind an authenticating proxy (SSO, a VPN), until registration can be closed.
3. Put a rate limit on `/register` and `/api/auth/*` at the proxy.

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
- `src/lib/auth-secret.ts`, `src/instrumentation.ts`, `src/lib/session-cookie.ts`, `src/middleware.ts`.
