# Story 1.1: Project Scaffolding, Docker Environment & Test Infrastructure

Status: in-progress

## Story

As a **developer**,
I want the project scaffolded with all core dependencies, Docker composition, and test infrastructure configured,
so that the team has a runnable development environment with CI-ready testing from day one.

## Acceptance Criteria

**Given** no project exists yet
**When** the scaffolding is complete
**Then** the following project structure exists:
**And** Next.js 16.2 is initialized via `create-next-app` with TypeScript, Tailwind CSS, ESLint, and App Router
**And** the following dependencies are installed: `@orpc/server`, `@orpc/client`, `@orpc/react`, `@orpc/openapi`, `prisma`, `@prisma/client`, `next-auth@beta`, `@auth/prisma-adapter`, `@typespec/compiler`
**And** Shadcn/ui is initialized with default configuration
**And** the project directory structure follows the Architecture document layout (`src/app/`, `src/components/ui/`, `src/components/custom/`, `src/components/layout/`, `src/features/`, `src/services/`, `src/server/api/routers/`, `src/lib/`, `src/emitters/`, `src/types/schemas/`, `src/hooks/`, `tests/unit/`, `tests/integration/`, `tests/e2e/`)
**And** a `docker-compose.yml` exists with two services: `app` (Next.js on port 3000) and `db` (PostgreSQL 16 with persistent volume on port 5432)
**And** a `Dockerfile` exists for the app service with multi-stage build (deps → build → runtime)
**And** `.env.example` exists with all required environment variables (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`)
**And** `@t3-oss/env-nextjs` is configured in `src/env.ts` with validated environment variables
**And** Vitest is configured in `vitest.config.ts` with path aliases matching `tsconfig.json`, coverage reporter enabled, and a sample test in `tests/unit/sample.test.ts` that passes
**And** Playwright is configured in `playwright.config.ts` targeting Chromium with base URL `http://localhost:3000`, and a sample E2E test in `tests/e2e/sample.spec.ts` that verifies the app loads
**And** `npm run dev` starts the development server successfully
**And** `npm test` runs Vitest and all tests pass
**And** `docker compose up` builds and starts both containers, and the app is accessible at `http://localhost:3000`

## Tasks / Subtasks

- [ ] **Initialize Next.js project**
  - Run `npx create-next-app@latest super-schema` with TypeScript, Tailwind CSS 4.x, ESLint, App Router enabled
  - Verify `next` version is 16.2.x in `package.json`
  - Verify `typescript` version is 5.x in `package.json`
  - Verify `tailwindcss` version is 4.x in `package.json`

- [ ] **Install core dependencies**
  - Run `npm install @orpc/server @orpc/client @orpc/react @orpc/openapi` (oRPC for typesafe API layer)
  - Run `npm install prisma @prisma/client` (ORM)
  - Run `npm install next-auth@beta @auth/prisma-adapter` (Auth.js v5 + Prisma adapter)
  - Run `npm install @typespec/compiler` (TypeSpec compiler for schema emission)
  - Run `npm install @t3-oss/env-nextjs zod` (validated environment variables)
  - Verify all dependencies are in `package.json`

- [ ] **Initialize Shadcn/ui**
  - Run `npx shadcn@latest init` with default configuration
  - Verify `components.json` is created at project root
  - Verify `src/components/ui/` directory is created
  - Verify `src/lib/utils.ts` is created with `cn()` utility

- [ ] **Create project directory structure**
  - Create `src/components/custom/` (Super Schema custom components)
  - Create `src/components/layout/` (ActivityBar, Sidebar, StatusBar, RightPanel)
  - Create `src/features/` (feature-specific UI + logic)
  - Create `src/services/` (business logic shared by oRPC + REST)
  - Create `src/server/api/routers/` (oRPC thin wrappers)
  - Create `src/lib/` (utilities, TypeSpec compiler wrapper)
  - Create `src/lib/compiler/` (ICompilerService + TypeSpec implementation + mock)
  - Create `src/lib/type-mapping/` (translation policies + overrides)
  - Create `src/emitters/` (emitter plugins: bigquery, avro, openapi)
  - Create `src/types/schemas/` (shared Zod schemas)
  - Create `src/hooks/` (reusable React hooks)
  - Create `tests/unit/` (Vitest unit tests)
  - Create `tests/integration/` (Vitest integration tests with real DB)
  - Create `tests/e2e/` (Playwright E2E tests)
  - Add `.gitkeep` files to empty directories to preserve structure

- [ ] **Create Docker configuration**
  - Create `.docker/docker-compose.yml` with:
    - `app` service: builds from `Dockerfile`, port `3000:3000`, `DATABASE_URL=postgresql://superschema:password@db:5432/superschema`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL=http://localhost:3000`, depends_on `db`
    - `db` service: `postgres:16` image, persistent volume `pgdata:/var/lib/postgresql/data`, port `5432:5432`, `POSTGRES_USER=superschema`, `POSTGRES_PASSWORD=password`, `POSTGRES_DB=superschema`
    - Named volume `pgdata`
  - Create `.docker/Dockerfile` with multi-stage build:
    - Stage 1 (`deps`): `node:20-alpine`, copy `package*.json`, `npm ci`
    - Stage 2 (`build`): copy source, `npm run build`
    - Stage 3 (`runtime`): `node:20-alpine`, copy build output + node_modules, expose 3000, `CMD ["npm", "start"]`
  - Add symlinks or root-level `docker-compose.yml` pointing to `.docker/docker-compose.yml`

- [ ] **Create environment configuration**
  - Create `.env.example` with:
    ```
    DATABASE_URL=postgresql://superschema:password@localhost:5432/superschema
    NEXTAUTH_SECRET=your-secret-here
    NEXTAUTH_URL=http://localhost:3000
    ```
  - Create `src/env.ts` with `@t3-oss/env-nextjs` configuration:
    - Server vars: `DATABASE_URL` (z.string().url()), `NEXTAUTH_SECRET` (z.string().min(1)), `NEXTAUTH_URL` (z.string().url())
    - Validate with Zod schemas
  - Create `.env` from `.env.example` for local development (add `.env` to `.gitignore`)

- [ ] **Initialize Prisma**
  - Run `npx prisma init` to create `prisma/schema.prisma` and configure PostgreSQL datasource
  - Set datasource provider to `postgresql`
  - Set datasource URL to `env("DATABASE_URL")`
  - Create placeholder `prisma/seed.ts`

- [ ] **Configure Vitest**
  - Install: `npm install -D vitest @vitejs/plugin-react @vitest/coverage-v8`
  - Create `vitest.config.ts` with:
    - Path aliases matching `tsconfig.json` (e.g., `@/` -> `src/`)
    - Coverage reporter enabled (`v8` provider)
    - Test include pattern: `tests/unit/**/*.test.ts`, `tests/integration/**/*.test.ts`
    - Setup files if needed
  - Add `"test"` script to `package.json`: `"vitest"`
  - Add `"test:coverage"` script: `"vitest run --coverage"`
  - Create `tests/unit/sample.test.ts`:
    ```typescript
    import { describe, it, expect } from 'vitest';
    describe('sample', () => {
      it('should pass', () => { expect(1 + 1).toBe(2); });
    });
    ```

- [ ] **Configure Playwright**
  - Install: `npm install -D @playwright/test`
  - Run `npx playwright install chromium`
  - Create `playwright.config.ts` with:
    - `baseURL: 'http://localhost:3000'`
    - Projects: `[{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]`
    - `webServer` config to start dev server before tests
  - Create `tests/e2e/sample.spec.ts`:
    ```typescript
    import { test, expect } from '@playwright/test';
    test('app loads', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveTitle(/Super Schema/i);
    });
    ```
  - Add `"test:e2e"` script to `package.json`: `"playwright test"`

- [ ] **Verify everything works**
  - Run `npm run dev` and confirm server starts on port 3000
  - Run `npm test` and confirm Vitest sample test passes
  - Run `docker compose -f .docker/docker-compose.yml up --build` and confirm both containers start, app accessible at `http://localhost:3000`

## Dev Notes

### Architecture & Patterns
- **Starter template**: `create-next-app` (official Next.js 16.2 scaffolding). Prisma, oRPC, and Auth.js are added manually.
- **Unified API layer**: oRPC for BOTH UI-server communication (type-safe RPC) AND external/CI/CD access (auto-generated OpenAPI spec from same router). No separate REST API routes needed.
- **oRPC packages**: `@orpc/server` (server-side routers), `@orpc/client` (client-side calls), `@orpc/react` (React hooks), `@orpc/openapi` (OpenAPI 3.0 auto-generation from routers)
- **Service layer pattern**: Shared business logic in `src/services/`, thin oRPC router wrappers in `src/server/api/routers/`
- **Result type pattern**: Service functions return `Result<T, E>` (never throw) -- `{ success: true; data: T } | { success: false; error: E }` with `ServiceError` shape: `{ code: string; message: string; details?: object; suggestedFix?: string }`
- **Naming conventions**:
  - Component files: PascalCase (`SchemaFieldRow.tsx`)
  - Service/util files: camelCase (`schema.service.ts`)
  - Types/interfaces: PascalCase, `I` prefix for interfaces (`ICompilerService`)
  - DB tables: snake_case plural (`entity_versions`)
  - oRPC procedures: camelCase (`schema.getById`)
  - Env variables: SCREAMING_SNAKE (`DATABASE_URL`)
- **Docker composition**: 2 containers only (app + PostgreSQL). No Redis, no message queue for MVP.
- **Testing strategy**: Vitest (unit + integration), Playwright (E2E), Zod (runtime validation)
- **TypeScript strict mode**: Enabled project-wide

### Latest Version Notes (April 2026)
- **Next.js**: 16.2.x — use `npx create-next-app@latest`, select TypeScript + Tailwind + ESLint + App Router
- **Tailwind CSS 4.x**: Breaking change from v3 — use `@import "tailwindcss"` instead of three `@tailwind` directives. Opacity modifiers: `bg-black/50` replaces `bg-opacity-*`. `shadow-xs` replaces `shadow-sm`.
- **Vitest**: 4.x — requires Node >=20. `vitest.config.ts` takes priority over `vite.config.ts`
- **Playwright**: 1.59.x — install chromium only for faster setup
- **Prisma**: 7.x — straightforward upgrade, no breaking changes from 6.x
- **Auth.js**: v5 stable — install via `next-auth@beta`, generate secret via `npx auth secret`
- **@t3-oss/env-nextjs**: 0.13.x — still recommended for env validation
- **Shadcn/ui**: Use `npx shadcn@latest init` (not the older `shadcn-ui` package)

### UX/Design Requirements
- No UX-specific requirements for this scaffolding story. The design system is implemented in Story 1.2.
- Tailwind CSS 4.x is installed here but color tokens/theme are configured in Story 1.2.
- Tailwind v4 uses CSS-first config — `tailwind.config.ts` may be replaced by CSS `@theme` directives. Follow whatever `create-next-app` generates for v4.

### File Structure
Files and directories this story creates or modifies:

```
super-schema/
├── .docker/
│   ├── Dockerfile                    # Multi-stage build (deps → build → runtime)
│   └── docker-compose.yml            # app (Next.js:3000) + db (PostgreSQL 16:5432)
├── prisma/
│   ├── schema.prisma                 # PostgreSQL datasource, placeholder
│   └── seed.ts                       # Placeholder seed file
├── src/
│   ├── app/                          # Next.js App Router (created by create-next-app)
│   ├── components/
│   │   ├── ui/                       # Shadcn/ui components (created by shadcn init)
│   │   ├── custom/                   # Super Schema custom components (empty)
│   │   └── layout/                   # Layout components (empty)
│   ├── features/                     # Feature-specific logic (empty)
│   ├── services/                     # Business logic (empty)
│   ├── server/api/routers/           # oRPC routers (empty)
│   ├── lib/
│   │   ├── utils.ts                  # cn() utility (created by shadcn)
│   │   ├── compiler/                 # TypeSpec compiler wrapper (empty)
│   │   └── type-mapping/             # Translation policies (empty)
│   ├── emitters/                     # Emitter plugins (empty)
│   ├── types/
│   │   └── schemas/                  # Shared Zod schemas (empty)
│   ├── hooks/                        # Reusable React hooks (empty)
│   └── env.ts                        # @t3-oss/env-nextjs validated env vars
├── tests/
│   ├── unit/
│   │   └── sample.test.ts            # Vitest sample test
│   ├── integration/                  # Integration tests (empty)
│   └── e2e/
│       └── sample.spec.ts            # Playwright sample test
├── .env.example                      # Environment variable template
├── vitest.config.ts                  # Vitest configuration
├── playwright.config.ts              # Playwright configuration
├── tailwind.config.ts                # Tailwind CSS config (base, customized in 1.2)
├── components.json                   # Shadcn/ui configuration
└── package.json                      # All dependencies
```

### Testing Requirements
- **Unit test**: `tests/unit/sample.test.ts` -- simple passing test to verify Vitest works
- **E2E test**: `tests/e2e/sample.spec.ts` -- verify the app loads at `http://localhost:3000`
- Both tests must pass before this story is considered complete
- Vitest must be runnable via `npm test`
- Playwright must be runnable via `npm run test:e2e`

### Dependencies & Prerequisites
- **Prerequisites**: None -- this is the first story in the project
- **Enables**: Story 1.2 (Design System Foundation), and all subsequent stories depend on this scaffolding

### References
- [Source: epics.md - Epic 1, Story 1.1]
- [Source: architecture.md - Starter Template & Technology Stack]
- [Source: architecture.md - Project Structure]
- [Source: architecture.md - Infrastructure & Deployment]
- [Source: architecture.md - Implementation Patterns & Consistency Rules]
- [Source: epics.md - Additional Requirements (oRPC replaces tRPC, create-next-app replaces T3)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)
### Completion Notes List
### Change Log
