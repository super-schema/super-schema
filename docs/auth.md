# Signing in: local accounts, and identity providers an administrator can add

**Local accounts are always the way in** (an e-mail address and a password; invitations, registration modes, throttling, sessions and the first administrator are in
[`auth-ops.md`](auth-ops.md)). On top of that an administrator can add **identity providers** that Auth.js already knows: Google, GitHub, Microsoft Entra ID, Okta, Keycloak and any
OpenID Connect issuer. By default there are none: no provider is enabled, the login page has no provider button, and nothing in this file applies.

> **UNTESTED against a real identity provider.** Nothing in this repository contacts one: the decision rules, the Auth.js callback, the adapter guard and the whole OAuth flow are tested
> against stubs (`tests/unit/lib/auth/provider-*.test.ts`, `tests/integration/auth/provider-signin-pglite.test.ts`), and the browser suite runs with no provider at all. The
> redirect URIs, issuer URLs and console steps below are from each provider's public documentation and from Auth.js's source, and have not been tried. Try yours on a test
> tenant of the provider before relying on it, and read the log of the first sign-in.

## The one rule that matters: a provider signs in people who already have an account

**Nobody signs up through a provider.** An account is made by an administrator (the Admin screens, `npm run admin:create`) or by an invitation, exactly as before. A provider only
proves *who a person is*; whether that person may come in, and with which roles, is what the account says. A person the provider knows and the app does not is refused, and
nothing is created for them: not a user, not a linked account. The check runs **before** Auth.js touches the database, and Auth.js's own `createUser` is switched off as a second
lock (`src/lib/auth/adapter-guard.ts`), so a mistake in the decision still cannot make an account.

Roles are never taken from the provider (no group or claim mapping): a user signs in through a provider with the roles an administrator gave them in the app.

## Enabling a provider

Set these in the environment of the server (a `.env`, the compose file, your orchestrator's secrets). `<KEY>` is the provider's key in capitals with `-` as `_`.

| Setting | Meaning |
| --- | --- |
| `AUTH_PROVIDERS` | Comma list of the providers to enable, from the table below (`google,github`). Empty or unset: none (the default). Letter case, spaces and repeats do not matter. |
| `AUTH_PROVIDER_<KEY>_CLIENT_ID` | Required. The client (application) id the provider gave you. |
| `AUTH_PROVIDER_<KEY>_CLIENT_SECRET` | Required. Its secret. |
| `AUTH_PROVIDER_<KEY>_ISSUER` | Required for `microsoft-entra-id`, `okta`, `keycloak` and `oidc`: the issuer URL, an `https` URL in production. |
| `AUTH_PROVIDER_<KEY>_LABEL` | The button text. Defaults to the provider's name (`Google`, `GitHub`, ...); **required** for the generic `oidc`, which has no name of its own. |
| `AUTH_PROVIDER_<KEY>_ALLOWED_DOMAINS` | Optional comma list of e-mail domains that may sign in through this provider (below). Unset: no limit. |
| `AUTH_PROVIDER_<KEY>_LINK_EXISTING_USERS` | `1` lets a user who has an account but has never signed in through this provider do so, matched by verified e-mail (below). Unset or `0`: off. Any other value is a configuration error. |

| Key (`AUTH_PROVIDERS`) | Names | Issuer setting | Where the verified e-mail comes from |
| --- | --- | --- | --- |
| `google` | Google | not needed | the ID token's `email_verified`; `hd` is checked too when domains are set |
| `github` | GitHub | not needed | GitHub's own e-mail list: only the **primary** address that GitHub says is **verified** is used, never the profile's public e-mail (`src/lib/auth/github-profile.ts`) |
| `microsoft-entra-id` | Microsoft Entra ID | the tenant's, `https://login.microsoftonline.com/<tenant-id>/v2.0` (never `common`) | the ID token's `xms_edov` claim (an optional claim that must be enabled on the app registration); without it every sign-in is refused |
| `okta` | Okta | your org or authorization server, `https://<org>.okta.com` or `.../oauth2/default` | the ID token's `email_verified` |
| `keycloak` | Keycloak | the realm, `https://<host>/realms/<realm>` | the ID token's `email_verified` |
| `oidc` | any OpenID Connect issuer | the issuer (its `/.well-known/openid-configuration` must exist) | the ID token's `email_verified` |

### Also needed for any provider

- **`AUTH_URL`** (or `NEXTAUTH_URL`): the public origin of the app, `https://schemas.example.com`. Auth.js builds the callback address from it, and it reads
  `NEXTAUTH_URL` when `AUTH_URL` is unset. `NEXTAUTH_URL` alone does not trust the `Host` header (`auth-ops.md`, "Trusting the host").
- **`AUTH_TRUST_HOST=true`** when the app is behind a reverse proxy you control and `AUTH_URL` is not set (`auth-ops.md`, "Trusting the host"). Without either, a production server rejects every request.
- **The redirect URI** to register at the provider is **`{AUTH_URL}/api/auth/callback/<key>`**, where `<key>` is the key from the table: `https://schemas.example.com/api/auth/callback/google`,
  `.../callback/microsoft-entra-id`, `.../callback/oidc`. It must match exactly (scheme, host, path, no trailing slash).
- `AUTH_TRUST_PROXY=1` behind a proxy that overwrites `X-Forwarded-For`, so the throttle below has a bucket per client (`auth-ops.md`).

### A mistake never switches anything on

A provider listed in `AUTH_PROVIDERS` that has a problem is **not enabled**: an unknown name (`gogle`), a missing client id, secret, issuer or (for `oidc`) label, an issuer that is not an
`https` URL in production, a domain entry that can never match, a `_LINK_EXISTING_USERS` that is not `0` or `1`. And a setting name that no provider has (`AUTH_PROVIDER_GOOGLE_ALLOWD_DOMAINS`,
a typo that would silently drop the domain rule) disables **every** provider, because a mistyped name cannot be attributed to the provider it was meant for.

- **Development and test:** each problem is written to the log once (`[auth] sign-in provider configuration: ... It is ignored.`) and the server carries on; the local accounts always work.
- **Production:** the server **refuses to start** and says every problem (`src/instrumentation.ts`, the same refusal as a weak session secret: the process ends with exit code 1).

## What decides a sign-in

After the provider has authenticated the person, the callback checks these, in this order, and the first that fails refuses (`src/lib/auth/provider-signin.ts`; one function for every provider):

1. the provider is enabled;
2. the profile carries an e-mail address;
3. the e-mail is **verified**: `email_verified` is `true` (for Entra, `xms_edov`). A claim that is missing is a refusal, except for a provider whose descriptor says its API can only return verified
   addresses (GitHub, through the replacement above). A claim that is present and not the boolean `true` is always a refusal;
4. when the provider has `_ALLOWED_DOMAINS`: the e-mail's domain matches, **and** the `hd` claim does too when the profile has one;
5. **an account exists** for the person (nobody signs up through a provider);
6. the account is **not disabled**;
7. the person has signed in through this provider before (their provider account is linked), **or** the provider has `_LINK_EXISTING_USERS=1`.

**Every refusal is the same to the visitor.** The login page answers with the words of a wrong password, "Invalid email or password"; the `?error=` code in the address is never shown;
the response is the same redirect whatever the rule. Which rule refused is only in the `auth_events` table (below). A database that cannot answer refuses (it never lets through).

A person is recognised by the provider's **stable account id** (`sub`), not by the e-mail it writes today: once linked, a user whose address changes at the provider still signs in as the
same user (the verified-e-mail and domain rules still apply to the address it sends).

### Allowed domains

`AUTH_PROVIDER_<KEY>_ALLOWED_DOMAINS=example.com,.eu.example.org`. Matching is case-insensitive and exact:

- `example.com` matches `ada@example.com`, not `ada@sub.example.com`, not `ada@notexample.com`, not `ada@example.com.evil.test`;
- `.example.org` (a leading dot) matches every subdomain, `ada@eu.example.org` and `ada@a.b.example.org`, **not** `ada@example.org` itself (list both to allow both).

No wildcards, no `@`, no scheme: an entry that can never match, or a list with no entry in it, is a configuration error (above), not a rule that silently locks everyone out or drops
the restriction. The `hd` claim (the hosted domain some providers send) must agree when present; one that is not a text is a refusal.

### Linking an existing user: `_LINK_EXISTING_USERS=1` and its risk

By default an existing local user who has never used a provider is **refused** when a provider says their e-mail address is theirs (`not-linked`): the provider's word about an address is not
accepted as proof of who owns a local account. They have to be signed in by another route first, or an administrator turns the flag on.

With the flag on for a provider, the first sign-in through it of a user whose e-mail matches (after trimming and lower-casing) links the provider account to that user, and from then on the
provider account id identifies them. This is the standard trade-off of "sign in with ..." (Auth.js calls it `allowDangerousEmailAccountLinking`): **the provider's claim that an address
is verified becomes the proof of identity.** If a provider lets someone claim an address it has not verified, or lets an administrator of some tenant of the provider set any address, that
person can take over the local account of that address, **administrator accounts included**.

So: the flag never waives rule 3 (the e-mail must still be verified) or rule 4 (the domains still apply); enable it **only** for identity providers whose verified e-mails you
trust: your own single sign-on, a company-managed workspace restricted with `_ALLOWED_DOMAINS`. Do not enable it for a public provider (`google` without domains, `github`) on a deployment
whose administrators you would not trust to share their address with a stranger. It is per provider and off by default. After the first sign-in the link is permanent: it
survives the flag being switched off.

One consequence of how Auth.js links accounts: when somebody is **already signed in** and completes a provider sign-in, Auth.js links the provider account to the signed-in user, not
to the user the address names. That needs the person to control both identities, so it gives nobody anything they did not have; it is noted here so that it is not a surprise.

## Disabled users and live sessions

A disabled user is refused at provider sign-in (rule 6) and, like every user, **on every request**: the session is a signed token that names the user by id, and the principal loader
(`src/lib/access/principal.ts`) treats a disabled or missing user as nobody. So a provider session that is still valid ends at the next request after an administrator disables the account;
it does not wait for the 12 hours. Both layers are tested together (`tests/integration/auth/provider-signin-pglite.test.ts`).

## What is recorded, and the throttle

Rows of `auth_events` (e-mail and client address as keyed hashes, never the values, like the password login: `auth-ops.md`):

| `kind` | `outcome` | When |
| --- | --- | --- |
| `provider_refused:<reason>` | `refused` | the decision refused: `<reason>` is `provider-disabled`, `email-missing`, `email-unverified`, `domain`, `no-account`, `disabled` or `not-linked` |
| `provider_refused:throttled` | `locked` | the client address is locked (below); does not count |
| `provider_login` | `success` | a provider sign-in was allowed (`users.lastLoginAt` is written too) |

`SELECT kind, outcome, count(*) FROM auth_events WHERE kind LIKE 'provider_%' GROUP BY 1, 2;` says what is being refused and why, without saying who.

**Throttle:** **5 refused provider sign-ins in 15 minutes from one client address** lock that address for provider sign-ins (every reason counts); without `AUTH_TRUST_PROXY=1`
there is no client address and the refusals are not counted at all (one caller must not be able to refuse every provider sign-in), as for the password login. The lock does not touch the password login. A locked address is refused before anything is looked up, with the same answer; a throttle that cannot
be read refuses. The e-mail is not limited here: what a refusal means is that the provider vouched for the person already. The cost: someone with any account at an enabled public provider can use
five refusals to lock provider sign-ins from their own address; the password login is not affected.

## Worked example 1: Google (UNTESTED against Google)

1. In the Google Cloud console create (or pick) a project; configure the OAuth consent screen (for a Google Workspace organisation, user type **Internal** limits sign-in to its users);
   under *Credentials* create an **OAuth client ID** of type **Web application**.
2. Add the authorised redirect URI **`https://schemas.example.com/api/auth/callback/google`** (your `AUTH_URL` followed by that path).
3. Set, on the server:

   ```
   AUTH_URL=https://schemas.example.com
   AUTH_PROVIDERS=google
   AUTH_PROVIDER_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   AUTH_PROVIDER_GOOGLE_CLIENT_SECRET=<the client secret>
   AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS=example.com
   ```

   Restart. The login page shows a **Google** button (or the text of `AUTH_PROVIDER_GOOGLE_LABEL`).
4. Make the accounts (invite your people, or create them). The first sign-in of someone who has an account but never used Google is refused unless you set
   `AUTH_PROVIDER_GOOGLE_LINK_EXISTING_USERS=1` (read the risk above first; with `_ALLOWED_DOMAINS` and an Internal consent screen the e-mails are your organisation's).

Google sends `email_verified` and, for Workspace accounts, `hd` (checked against the domain list). Nothing here is special to Google: it is the `google` row of the table in `src/lib/auth/providers.ts`.

## Worked example 2: a generic OpenID Connect issuer (UNTESTED against any issuer)

For an identity provider with no row of its own (a company's SSO, Authentik, Auth0, Zitadel, ...):

1. Register a **confidential web client** at the issuer with the redirect URI **`https://schemas.example.com/api/auth/callback/oidc`**, scopes `openid profile email`, authorization-code
   flow with PKCE, client authentication by client secret (HTTP basic: Auth.js's default). The ID token must carry **`email`** and **`email_verified: true`**.
2. Set:

   ```
   AUTH_URL=https://schemas.example.com
   AUTH_PROVIDERS=oidc
   AUTH_PROVIDER_OIDC_ISSUER=https://sso.example.com/realms/acme
   AUTH_PROVIDER_OIDC_CLIENT_ID=super-schema
   AUTH_PROVIDER_OIDC_CLIENT_SECRET=<the client secret>
   AUTH_PROVIDER_OIDC_LABEL=Acme single sign-on
   AUTH_PROVIDER_OIDC_ALLOWED_DOMAINS=acme.example,.acme.example
   ```

   The issuer's `/.well-known/openid-configuration` is read when somebody signs in (not at start-up, not by the tests). It must be an `https` URL in production.
3. Restart; the login page shows an **Acme single sign-on** button. Accounts and linking are as in example 1.

If the issuer does not send `email_verified` (some do not) every sign-in is refused (rule 3); there is no setting to waive it: ask the provider to send it, or do not use it.

## Not built: an in-app screen for provider settings

Providers are configured in the environment of the server, and a change needs a restart. A screen where an administrator **enters a client secret in the app** is **not built** (KD-047 in
[`testing/known-defects.md`](testing/known-defects.md)): it would put provider secrets in the database, which needs encrypted secret storage (a key held outside the database, rotation,
no secret ever shown again or logged, an audit entry for each change) that the app does not have. Until it does, secrets live where the deployment already keeps its other secrets
(`AUTH_SECRET`, `DATABASE_URL`).

## Access notes: decided behaviour, not defects

These follow from the roles (`docs/auth-ops.md`, "Roles at a glance"). They are recorded so that nobody reads them as a bug. The tests that say what each rule is are named in the bullets; the first one is accepted and has none.

- **A steward can publish a stored draft whose files they cannot see (accepted).** Publishing is judged on the entity (`entity.publish`: STEWARD or higher at a scope that covers the entity, so a compliance officer or a platform
  administrator can publish too). A stored draft is published as it is stored: the copies that the readers receive (`src/lib/access/schema-version-redaction.ts`)
  do not change the stored value, and publishing goes on from the whole list. A version that a wider role generated can therefore hold files of entities the steward may
  not read. A generation the steward makes now is different: the closure refuses when it reaches an entity no role of the caller covers (`REFERENCE_NOT_READABLE`, KD-045).
- **Domain- and product-scoped users never see tenant-level (Enterprise) entities, by design.** A DOMAIN or PRODUCT scope covers only the resources of that domain or
  product. A tenant-level entity (no domain, no product) is covered by its tenant and by the platform scope only, so a domain author neither reads it nor inherits
  anything from it (`src/lib/access/scope.ts`; `docs/testing/access-control.md`, design decision 2).
- **`COMPLIANCE_OFFICER` is not read-only.** The role ladder is linear: `VIEWER < AUTHOR < STEWARD < COMPLIANCE_OFFICER < ADMIN`. A compliance officer also holds the
  author's and the steward's rights, and an administrator holds everything. A read-only audit role would be a separate role outside the ladder, which is a policy
  change with its own tests (`tests/unit/lib/access/policy.test.ts`; `docs/testing/access-control.md`).

## Where it is in the code

`src/lib/auth/providers.ts` (the table, the settings, the checks, the startup refusal), `src/lib/auth/provider-signin.ts` (the pure decision), `src/lib/auth/provider-callback.ts`
(the Auth.js callback: lookup, events, throttle), `src/lib/auth/adapter-guard.ts` (no sign-in creates an account), `src/lib/auth/github-profile.ts`, `src/lib/auth.ts`,
`src/app/(auth)/login/` (the buttons and their server action), `scripts/e2e-env.mjs` (every setting name is blanked for the browser suite, and the runner refuses an app that offers a provider).
