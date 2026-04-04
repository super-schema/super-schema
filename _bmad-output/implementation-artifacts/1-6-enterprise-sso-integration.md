# Story 1.6: Enterprise SSO Integration (SAML 2.0 / OIDC)

Status: ready-for-dev

## Story

As an **enterprise administrator**,
I want to configure SAML 2.0 / OIDC single sign-on for my organization,
So that employees can authenticate using their company identity provider without separate credentials.

## Acceptance Criteria

**Given** Google OAuth and local authentication work (Story 1.5 complete)
**When** BoxyHQ SAML Jackson is integrated and configured
**Then** Auth.js is configured with a BoxyHQ SAML Jackson custom OAuth provider using `JACKSON_URL`, `SAML_AUDIENCE`, and `SAML_CALLBACK` environment variables
**And** the SAML Jackson provider is only registered when `JACKSON_URL` env var is set (graceful degradation for deployments without SSO)
**And** the Login page shows a "Continue with SSO" button (with shield/key icon) when SSO is configured — hidden when not configured
**And** the Register page shows the same SSO button treatment
**And** SSO sign-in redirects to the configured SAML/OIDC identity provider, and on successful auth, creates/links the user account and redirects to `/schemas`
**And** the `accounts` table links the SSO provider to the user — a user who registered with email can later link their SSO account (same email) without creating a duplicate user
**And** all SSO environment variables are added to `src/env.ts` validation schema as optional
**And** BoxyHQ SAML Jackson is added as an optional service in `.docker/docker-compose.yml`
**And** integration tests verify: SAML Jackson provider registered/absent based on env vars, mock SSO callback creates user session, SSO callback with existing email links accounts
**And** a Playwright E2E test verifies: SSO button visible/hidden based on env vars, clicking SSO button initiates redirect

## Tasks / Subtasks

### Task 1: Add BoxyHQ SAML Jackson Docker service
- [ ] Add `jackson` service to `.docker/docker-compose.yml` as optional (commented out or with profile)
- [ ] Configure Jackson with environment variables: `JACKSON_API_KEYS`, `EXTERNAL_URL`, `SAML_AUDIENCE`, `NEXTAUTH_URL`
- [ ] Document setup in `.env.example` with SSO-related vars:
  ```
  # Enterprise SSO via BoxyHQ SAML Jackson (optional)
  # JACKSON_URL=http://localhost:5225
  # SAML_AUDIENCE=https://saml.example.com
  # SAML_CALLBACK=http://localhost:3000/api/auth/callback/saml-jackson
  ```

### Task 2: Integrate SAML Jackson provider in Auth.js
- [ ] Add SAML Jackson as a custom OAuth provider in `src/lib/auth.ts`:
  ```typescript
  ...(process.env.JACKSON_URL ? [{
    id: 'saml-jackson',
    name: 'SSO',
    type: 'oauth',
    wellKnown: `${process.env.JACKSON_URL}/.well-known/openid-configuration`,
    authorization: { params: { scope: 'openid email profile' } },
    clientId: 'dummy',
    clientSecret: 'dummy',
    profile(profile) {
      return { id: profile.sub, name: profile.name, email: profile.email, image: profile.picture };
    },
  }] : [])
  ```
- [ ] Update `authProviders` export to include `sso: !!process.env.JACKSON_URL`
- [ ] Update `src/env.ts` with optional `JACKSON_URL`, `SAML_AUDIENCE`, `SAML_CALLBACK` vars

### Task 3: Update auth pages with SSO button
- [ ] Add "Continue with SSO" button to Login page — displayed when `authProviders.sso` is true
- [ ] Add "Continue with SSO" button to Register page — same treatment
- [ ] Use Lucide `ShieldCheck` or `KeyRound` icon for SSO button
- [ ] SSO button calls `signIn('saml-jackson', { callbackUrl: '/schemas' })`

### Task 4: Account linking for SSO
- [ ] Configure `allowDangerousEmailAccountLinking: true` in Auth.js config or implement custom `signIn` callback
- [ ] Verify: user registered with email can link SSO account (same email) without duplicate user creation

### Task 5: Tests
- [ ] Integration tests (`tests/integration/sso-provider.test.ts`):
  - SAML Jackson provider registered when `JACKSON_URL` is set
  - SAML Jackson provider absent when `JACKSON_URL` is not set
  - `authProviders.sso` returns correct flag
- [ ] Playwright E2E test (`tests/e2e/sso-auth.spec.ts`):
  - SSO button visible when configured, hidden when not
  - Clicking SSO button initiates redirect

## Dev Notes

### Architecture & Patterns
- **BoxyHQ SAML Jackson**: Acts as an intermediary between Auth.js and enterprise SAML/OIDC identity providers. It presents a standard OAuth/OIDC interface to Auth.js while handling SAML complexity. Runs as a sidecar Docker container.
- **Conditional provider**: Same spread pattern as Google OAuth — only included when env var is set.
- Full OAuth round-trip cannot be tested without a real SAML IdP or mock server. E2E tests verify button presence and redirect initiation only.

### Dependencies & Prerequisites
- **Prerequisites**: Story 1.5 (Google OAuth) complete
- **Enables**: Epic 8 (Administration) for managing SSO configuration
- **External dependency**: BoxyHQ SAML Jackson Docker container

### References
- [Source: epics.md - Epic 1, Story 1.5 (SSO portion deferred)]
- [Source: architecture.md - Authentication & Security (BoxyHQ SAML Jackson)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
