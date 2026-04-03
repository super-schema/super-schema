# Story 1.4: Local User Authentication

Status: ready-for-dev

## Story

As a **user**,
I want to register with email/password and log in to access the application,
so that I can securely access my schema workspace.

## Acceptance Criteria

**Given** the application shell exists (Story 1.3 complete)
**When** the authentication system is implemented
**Then** a Prisma schema exists with `users`, `accounts`, `sessions`, and `verification_tokens` tables (Auth.js Prisma adapter schema), and the database migration runs successfully
**And** Auth.js v5 is configured with the Credentials provider (email + bcrypt-hashed password)
**And** a **Register page** (`/register`) exists with a centered frosted glass card containing: email input, password input (min 8 chars), confirm password input, "Create Account" primary button, and "Already have an account? Sign in" link
**And** a **Login page** (`/login`) exists with a centered frosted glass card containing: email input, password input, "Sign In" primary button, and "Don't have an account? Register" link
**And** registration creates a new user in the database with bcrypt-hashed password and redirects to the dashboard
**And** registration validates: email format, password minimum 8 characters, passwords match — showing inline error messages (red ring + message below input) for validation failures
**And** registration rejects duplicate email addresses with an error message "An account with this email already exists"
**And** login authenticates against stored credentials and redirects to the dashboard
**And** login shows an inline error message "Invalid email or password" for incorrect credentials (no distinction between wrong email vs wrong password)
**And** unauthenticated users are redirected to `/login` when accessing any dashboard route
**And** a user menu in the Top Bar shows the user's email and a "Sign Out" option that destroys the session and redirects to `/login`
**And** Next.js middleware protects all `/(dashboard)/*` routes, redirecting unauthenticated requests to `/login`
**And** an oRPC base context (`createRPCContext`) extracts the session from the request and makes it available to all procedures
**And** `publicProcedure` and `protectedProcedure` oRPC base procedures are defined — `protectedProcedure` throws `ORPCError('UNAUTHORIZED')` if no session exists
**And** integration tests verify: successful registration creates a user, duplicate email is rejected, login with valid credentials returns a session, login with invalid credentials fails, protected oRPC procedures reject unauthenticated requests
**And** a Playwright E2E test verifies the full flow: navigate to `/login` → click register link → fill registration form → submit → redirected to dashboard → sign out → redirected to login → sign in with created credentials → dashboard loads

## Tasks / Subtasks

- [ ] **Define Auth.js Prisma adapter schema in `prisma/schema.prisma`**
  - Add `User` model: `id` (cuid), `name` (String?), `email` (String, unique), `emailVerified` (DateTime?), `image` (String?), `password` (String?) -- password field for Credentials provider
  - Add `Account` model: `id` (cuid), `userId` (FK to User), `type`, `provider`, `providerAccountId`, `refresh_token`, `access_token`, `expires_at`, `token_type`, `scope`, `id_token`, `session_state` -- unique constraint on `(provider, providerAccountId)`
  - Add `Session` model: `id` (cuid), `sessionToken` (String, unique), `userId` (FK to User), `expires` (DateTime)
  - Add `VerificationToken` model: `identifier`, `token`, `expires` -- unique constraint on `(identifier, token)`
  - Run `npx prisma migrate dev --name auth-tables` to create migration
  - Verify migration runs successfully against PostgreSQL

- [ ] **Install bcrypt dependency**
  - Run `npm install bcryptjs` and `npm install -D @types/bcryptjs`
  - Use bcryptjs (pure JS, no native compilation issues in Docker)

- [ ] **Configure Auth.js v5 (`src/lib/auth.ts`)**
  - Create `src/lib/auth.ts` with Auth.js v5 configuration:
    - PrismaAdapter from `@auth/prisma-adapter`
    - Credentials provider with `email` and `password` fields
    - `authorize` callback: look up user by email, compare password with `bcryptjs.compare()`, return user or null
    - Session strategy: `jwt` (for Credentials provider compatibility)
    - Callbacks: `jwt` callback includes `user.id` in token, `session` callback includes `token.sub` as `session.user.id`
    - Pages: `signIn: '/login'`
  - Export `auth`, `signIn`, `signOut`, `handlers` from Auth.js config
  - Create `src/app/api/auth/[...nextauth]/route.ts` exporting `GET` and `POST` handlers

- [ ] **Create registration API route or server action**
  - Create `src/app/(auth)/register/actions.ts` (server action) or `src/app/api/auth/register/route.ts` (API route):
    - Accept: `email`, `password`, `confirmPassword`
    - Validate with Zod:
      - `email`: `z.string().email("Invalid email format")`
      - `password`: `z.string().min(8, "Password must be at least 8 characters")`
      - `confirmPassword`: must match password
    - Check for existing user by email -- if exists, return error "An account with this email already exists"
    - Hash password with `bcryptjs.hash(password, 12)` (12 salt rounds)
    - Create user in database via Prisma
    - Auto sign-in the new user via Auth.js `signIn('credentials', ...)`
    - Redirect to dashboard

- [ ] **Build Register page (`src/app/(auth)/register/page.tsx`)**
  - Centered layout: frosted glass card on `background` (#14141C) page
  - Card styling: `surface-glass` (rgba(28,28,38,0.8), backdrop-blur 12px), 12px border-radius, 1px `border` (#333340), max-width 400px
  - Card content:
    - Heading: "Create Account" using `heading-1` (22px, weight 600), `foreground` (#e3e1e4)
    - Email input: Shadcn Input, label "Email", placeholder "you@example.com"
    - Password input: Shadcn Input, type="password", label "Password", placeholder "Min 8 characters"
    - Confirm password input: Shadcn Input, type="password", label "Confirm Password"
    - Submit button: Shadcn Button, `primary` variant (#A477B2 bg), full width, text "Create Account"
    - Link: "Already have an account? Sign in" -> `/login`, `primary` color (#A477B2)
  - Form validation (react-hook-form + Zod):
    - Inline error messages below each input using `destructive` color (#e55b5b)
    - Red ring on invalid inputs (1px border `destructive`)
    - Validate on blur and on submit
  - Loading state: Button shows spinner during submission
  - Server error display: Error message above form in `destructive` color

- [ ] **Build Login page (`src/app/(auth)/login/page.tsx`)**
  - Same centered frosted glass card layout as Register page
  - Card content:
    - Heading: "Sign In" using `heading-1`
    - Email input: Shadcn Input, label "Email"
    - Password input: Shadcn Input, type="password", label "Password"
    - Submit button: Shadcn Button, `primary` variant, full width, text "Sign In"
    - Link: "Don't have an account? Register" -> `/register`, `primary` color
  - Form validation: email format required, password required (no min length check on login)
  - On submit: call Auth.js `signIn('credentials', { email, password, redirect: false })`
  - On success: redirect to `/(dashboard)/schemas`
  - On failure: show "Invalid email or password" error message (no distinction between wrong email vs wrong password)
  - Loading state on button

- [ ] **Create auth layout (`src/app/(auth)/layout.tsx`)**
  - Full page with `background` (#14141C) color
  - Centered content (flexbox center both axes)
  - No TopBar, ActivityBar, or other chrome -- clean auth pages

- [ ] **Implement Next.js middleware for route protection (`src/middleware.ts`)**
  - Use Auth.js middleware or custom middleware
  - Protect all `/(dashboard)/*` routes
  - If no session: redirect to `/login`
  - Allow access to `/(auth)/*` routes (`/login`, `/register`) without session
  - Allow access to `/api/auth/*` routes without session
  - If authenticated user visits `/login` or `/register`: redirect to `/(dashboard)/schemas`

- [ ] **Update TopBar user menu with real auth data**
  - In `TopBar.tsx`: use Auth.js `useSession()` hook (or server-side `auth()`) to get current user
  - Display user's email in the dropdown menu header
  - "Sign Out" item: calls Auth.js `signOut()`, redirects to `/login`
  - Replace placeholder avatar with user's first letter initial or email icon

- [ ] **Set up oRPC base context and procedures**
  - Create `src/server/api/context.ts`:
    ```typescript
    export async function createRPCContext(opts: { headers: Headers }) {
      const session = await auth(); // Auth.js session
      return { session, db: prisma };
    }
    export type RPCContext = Awaited<ReturnType<typeof createRPCContext>>;
    ```
  - Create `src/server/api/procedures.ts`:
    - `publicProcedure`: base oRPC procedure with context
    - `protectedProcedure`: extends publicProcedure, middleware checks `ctx.session` -- if null, throws `ORPCError('UNAUTHORIZED')` with message "You must be logged in"
  - Create `src/server/api/root.ts`: root oRPC router (empty for now, routers added in Epic 2)
  - Create `src/app/api/orpc/[...orpc]/route.ts` or equivalent oRPC HTTP handler

- [ ] **Write integration tests (`tests/integration/auth.test.ts`)**
  - Test: Registration with valid data creates a user in the database with hashed password
  - Test: Registration with duplicate email returns error "An account with this email already exists"
  - Test: Login with valid credentials returns a session/token
  - Test: Login with invalid password fails with appropriate error
  - Test: Login with non-existent email fails with same error as wrong password
  - Test: `protectedProcedure` rejects requests without a session (returns UNAUTHORIZED)
  - Test: `protectedProcedure` allows requests with a valid session
  - Use Vitest with test database setup/teardown

- [ ] **Write Playwright E2E test (`tests/e2e/auth.spec.ts`)**
  - Full flow test:
    1. Navigate to `/login`
    2. Click "Don't have an account? Register" link
    3. Verify redirect to `/register`
    4. Fill email, password (8+ chars), confirm password
    5. Click "Create Account"
    6. Verify redirect to dashboard (URL matches `/(dashboard)/schemas`)
    7. Verify TopBar shows user email
    8. Click user avatar → "Sign Out"
    9. Verify redirect to `/login`
    10. Fill same email and password
    11. Click "Sign In"
    12. Verify dashboard loads
  - Validation test:
    1. Try registering with invalid email -- verify inline error
    2. Try registering with short password (< 8 chars) -- verify inline error
    3. Try registering with mismatched passwords -- verify inline error
    4. Try logging in with wrong password -- verify "Invalid email or password" error

## Dev Notes

### Architecture & Patterns
- **Auth.js v5** (`next-auth@beta`): Uses the Prisma adapter for database-backed sessions. The Credentials provider requires JWT session strategy (not database sessions).
- **Password hashing**: `bcryptjs` with 12 salt rounds. Pure JS implementation for Docker compatibility (no native `bcrypt` compilation).
- **RBAC foundation**: This story creates the `users` table. The `user_roles` table and RBAC middleware are added in Epic 8 (Story 8.1). For now, all authenticated users have equal access.
- **oRPC (not tRPC)**: The project uses oRPC for typesafe API. `@orpc/server` for router definition, `@orpc/client` for client calls, `@orpc/react` for React hooks. The `protectedProcedure` pattern is the same concept as tRPC but using oRPC's API.
- **Service layer**: Auth-related business logic (registration, password hashing) can be in `src/services/auth.service.ts` following the service pattern. However, Auth.js handles most auth flow internally.
- **Error handling**: Auth errors use the standardized shape `{ code: string; message: string; suggestedFix?: string }`. Login errors intentionally give the same message for wrong email and wrong password to prevent user enumeration.
- **Security**: Passwords never stored in plain text. Sessions managed by Auth.js with JWT. No password reset flow in MVP (can be added later).

### UX/Design Requirements

**Auth Pages (UX-DR34):**
- Centered frosted glass card on obsidian background (#14141C)
- Card: `rgba(28,28,38,0.8)` background, `backdrop-filter: blur(12px)`, 12px border-radius, 1px border `#333340`
- Max-width: 400px
- Card padding: `space-8` (32px)

**Form Inputs:**
- Shadcn Input component with dark theme customization from Story 1.2
- Background: `#2a2a36` (muted)
- Border: `#333340` (border), focus ring: `#A477B2` (primary)
- Error state: border `#e55b5b` (destructive), error message below input in `#e55b5b`
- Label typography: `body-small` (13px, weight 400), `foreground` (#e3e1e4)
- Input typography: `body` (14px), `foreground` (#e3e1e4)
- Placeholder: `muted-foreground` (#8a8694)

**Buttons:**
- Primary button: `#A477B2` (primary) background, `#e3e1e4` text, 12px border-radius
- Full width in auth forms
- Hover: slightly lighter primary
- Loading state: spinner icon replacing text

**Error Handling UX (UX-DR32):**
- Inline validation: red ring + message below input, no modals
- Server errors: message displayed above form
- No distinction between wrong email and wrong password on login

**Typography:**
- Page heading: `heading-1` (22px, weight 600, `#e3e1e4`)
- Links: `body` (14px), `#A477B2` (primary), underline on hover

### File Structure
Files this story creates or modifies:

```
prisma/
├── schema.prisma                      # ADD: User, Account, Session, VerificationToken models
├── migrations/
│   └── XXXXXX_auth_tables/
│       └── migration.sql              # Auth tables migration
src/
├── app/
│   ├── (auth)/
│   │   ├── layout.tsx                 # Centered, no-chrome auth layout
│   │   ├── login/
│   │   │   └── page.tsx               # Login page with frosted glass card
│   │   └── register/
│   │       ├── page.tsx               # Register page with frosted glass card
│   │       └── actions.ts             # Server action for registration
│   ├── api/
│   │   └── auth/
│   │       └── [...nextauth]/
│   │           └── route.ts           # Auth.js route handlers
│   └── (dashboard)/
│       └── layout.tsx                 # MODIFY: add auth check, pass session
├── components/layout/
│   └── TopBar.tsx                     # MODIFY: real user email + sign out
├── lib/
│   └── auth.ts                        # Auth.js v5 config (Prisma adapter + Credentials)
├── server/api/
│   ├── context.ts                     # oRPC context with session extraction
│   ├── procedures.ts                  # publicProcedure + protectedProcedure
│   └── root.ts                        # Root oRPC router
├── middleware.ts                       # Next.js route protection middleware
tests/
├── integration/
│   └── auth.test.ts                   # Auth integration tests
└── e2e/
    └── auth.spec.ts                   # Full auth flow E2E test
```

### Testing Requirements
- **Integration tests** (`tests/integration/auth.test.ts`):
  - Registration creates user with hashed password
  - Duplicate email rejected
  - Login with valid credentials returns session
  - Login with invalid credentials fails
  - `protectedProcedure` rejects unauthenticated requests
  - `protectedProcedure` allows authenticated requests
- **E2E tests** (`tests/e2e/auth.spec.ts`):
  - Full flow: register -> dashboard -> sign out -> login -> dashboard
  - Validation: invalid email, short password, mismatched passwords, wrong credentials

### Dependencies & Prerequisites
- **Prerequisites**: Story 1.1 (scaffolding with Prisma, Auth.js deps) and Story 1.2 (design system for auth page styling) and Story 1.3 (application shell with TopBar for user menu)
- **Enables**: Story 1.5 (Google & SSO Authentication) -- adds providers to the auth config created here
- **Enables**: Epic 2 (all stories use `protectedProcedure` for data access)

### References
- [Source: epics.md - Epic 1, Story 1.4]
- [Source: architecture.md - Authentication & Security (Auth.js v5 + Prisma adapter)]
- [Source: architecture.md - API & Communication (service layer pattern)]
- [Source: architecture.md - Implementation Patterns (Result type, RBAC)]
- [Source: ux-design-specification.md - UX-DR34 (Login/auth pages)]
- [Source: ux-design-specification.md - UX-DR32 (Error handling UX)]
- [Source: epics.md - Additional Requirements (oRPC replaces tRPC)]

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### Change Log
