# Story 8.4: System Health Monitoring Dashboard

Status: review

## Story
As an **administrator**, I want to monitor system health, active users, schema counts, and emission metrics, so that I can ensure the platform is operating correctly and understand usage patterns.

## Acceptance Criteria

**Given** the application is running with entities, emissions, and users (Epics 1-3 complete)
**When** the health dashboard is implemented
**Then** the **Admin Panel** includes a **Health tab** displaying a system health dashboard with the following sections:
**And** **Service Status** section: a status card showing: Application (green/red with uptime), Database (green/red with connection pool status), TypeSpec Compiler (green/red — tested by compiling a trivial schema)
**And** **Usage Metrics** section showing current counts: Total Entities, Total Fields, Total Domains, Total Users, Total Emissions (all time)
**And** **Activity Metrics** section showing recent activity: Active Users (last 24h — count of users who performed any action), Emissions Today, Schema Changes Today, Governance Requests Pending
**And** **Error Summary** section: count of TypeSpec compilation errors (last 24h), count of emission validation failures (last 24h), count of API errors (last 24h) — each clickable to see the error details from audit trail
**And** a **"Run Health Check"** button that actively tests: database connection (simple query), TypeSpec compiler (compile a trivial model), emitter validation (emit + validate a sample) — returns green/red per component with error details if failed
**And** all metrics are computed from existing data (audit_log, entity counts, emission_targets) — no separate metrics collection infrastructure for MVP
**And** metrics are **refreshed** when the Health tab is loaded and can be manually refreshed via a "Refresh" button — no auto-polling
**And** a `/api/v1/health` REST endpoint returns a JSON health check response: `{ status: "healthy"|"degraded"|"unhealthy", components: { database, compiler, emitters }, timestamp }` — this endpoint does NOT require authentication (for monitoring tools)
**And** unit tests verify: health check correctly reports component status, metrics queries return correct counts, `/health` endpoint returns correct response
**And** a Playwright E2E test verifies: Health tab shows all sections with data, Run Health Check returns results, error counts reflect actual errors

## Tasks / Subtasks

### Backend — Zod Schemas
- [x] Create `src/types/schemas/health.ts`:
  - `ComponentStatus` schema: z.object({ name: z.string(), status: z.enum(['healthy', 'degraded', 'unhealthy']), message: z.string().optional(), latencyMs: z.number().optional() })
  - `HealthCheckResponse` schema: z.object({ status: z.enum(['healthy', 'degraded', 'unhealthy']), components: z.object({ database: ComponentStatus, compiler: ComponentStatus, emitters: ComponentStatus }), timestamp: z.string() })
  - `UsageMetrics` schema: z.object({ totalEntities: z.number(), totalFields: z.number(), totalDomains: z.number(), totalUsers: z.number(), totalEmissions: z.number() })
  - `ActivityMetrics` schema: z.object({ activeUsers24h: z.number(), emissionsToday: z.number(), schemaChangesToday: z.number(), governanceRequestsPending: z.number() })
  - `ErrorSummary` schema: z.object({ compilationErrors24h: z.number(), emissionValidationFailures24h: z.number(), apiErrors24h: z.number() })

### Backend — Health Service
- [x] Create `src/services/health.service.ts`
- [x] Implement `checkDatabase(ctx): Promise<ComponentStatus>`:
  - Execute a simple query (`SELECT 1`) via Prisma
  - Measure latency
  - Return healthy (< 100ms), degraded (100-500ms), or unhealthy (> 500ms or error)
  - On error: return unhealthy with error message
- [x] Implement `checkCompiler(ctx): Promise<ComponentStatus>`:
  - Compile a trivial TypeSpec model using ICompilerService: `model HealthCheck { id: string; }`
  - Measure compilation time
  - Return healthy (success), unhealthy (compilation failed) with error details
- [x] Implement `checkEmitters(ctx): Promise<ComponentStatus>`:
  - For each enabled emitter: attempt to emit a sample entity and validate
  - Return healthy (all pass), degraded (some pass), unhealthy (all fail)
  - Include per-emitter status in message
- [x] Implement `runHealthCheck(ctx): Result<HealthCheckResponse>`:
  - Call all three check functions in parallel
  - Compute overall status: healthy (all components healthy), degraded (any component degraded), unhealthy (any component unhealthy)
  - Return full HealthCheckResponse with timestamp
- [x] Implement `getUsageMetrics(ctx): Result<UsageMetrics>`:
  - Query counts from database:
    - `SELECT COUNT(*) FROM entities`
    - `SELECT COUNT(*) FROM fields`
    - `SELECT COUNT(*) FROM domains`
    - `SELECT COUNT(*) FROM users`
    - `SELECT COUNT(*) FROM emission_targets`
  - All queries via Prisma count operations
  - RBAC: require Admin role
- [x] Implement `getActivityMetrics(ctx): Result<ActivityMetrics>`:
  - Active Users (last 24h): count distinct `userId` from `audit_log` where `timestamp > now - 24h`
  - Emissions Today: count `emission_targets` where `lastEmittedAt > start of today`
  - Schema Changes Today: count `audit_log` where `action LIKE 'entity.%' OR action LIKE 'field.%'` and `timestamp > start of today`
  - Governance Requests Pending: count `governance_requests` where `status = 'PENDING'`
  - RBAC: require Admin role
- [x] Implement `getErrorSummary(ctx): Result<ErrorSummary>`:
  - Compilation Errors (last 24h): count `audit_log` where `action = 'compilation.error'` and `timestamp > now - 24h`
  - Emission Validation Failures (last 24h): count `audit_log` where `action = 'emission.validation.failure'` and `timestamp > now - 24h`
  - API Errors (last 24h): count `audit_log` where `action LIKE '%.error'` and `timestamp > now - 24h`
  - RBAC: require Admin role
- [x] Implement `getErrorDetails(errorType, ctx): Result<AuditLogEntry[]>`:
  - Fetch audit_log entries matching the error type filter for last 24h
  - Return with pagination (limit 50)
  - RBAC: require Admin role

### Backend — REST Health Endpoint
- [x] Create `src/app/api/v1/health/route.ts`:
  - GET `/api/v1/health` — no authentication required (for monitoring tools)
  - Call `healthService.runHealthCheck()` with system context (no user session)
  - Return JSON response matching HealthCheckResponse schema
  - Set appropriate HTTP status: 200 (healthy), 200 (degraded), 503 (unhealthy)
  - Include `Cache-Control: no-cache` header

### Backend — oRPC Router
- [x] Create `src/server/api/routers/admin/health.ts` oRPC router
- [x] Add `health.runCheck` query — thin wrapper calling `healthService.runHealthCheck()`, Admin-only via `adminProcedure`
- [x] Add `health.usageMetrics` query — thin wrapper calling `healthService.getUsageMetrics()`, Admin-only
- [x] Add `health.activityMetrics` query — thin wrapper calling `healthService.getActivityMetrics()`, Admin-only
- [x] Add `health.errorSummary` query — thin wrapper calling `healthService.getErrorSummary()`, Admin-only
- [x] Add `health.errorDetails` query — thin wrapper calling `healthService.getErrorDetails()`, Admin-only
- [x] Wire router into `appRouter` under `admin.health` namespace

### Frontend — Health Tab UI Components
- [x] Create `src/components/custom/admin/HealthDashboard.tsx`:
  - Main dashboard layout organizing all sections
  - "Refresh" button in top-right corner
  - Fetches all metrics on mount and on refresh
- [x] Create `src/components/custom/admin/ServiceStatusCards.tsx`:
  - Three status cards side-by-side: Application, Database, TypeSpec Compiler
  - Each card shows: component name, status indicator (green circle / red circle / amber circle), status text, latency or uptime info
  - "Run Health Check" button triggers active health check and updates all cards
  - Loading state while health check runs (spinner on each card)
- [x] Create `src/components/custom/admin/UsageMetricsCards.tsx`:
  - Row of metric cards: Total Entities, Total Fields, Total Domains, Total Users, Total Emissions
  - Each card shows: metric name, large number value, icon
  - Simple numeric display — no charts for MVP
- [x] Create `src/components/custom/admin/ActivityMetricsCards.tsx`:
  - Row of metric cards: Active Users (24h), Emissions Today, Schema Changes Today, Governance Requests Pending
  - Each card shows: metric name, number, contextual icon
  - Governance Requests Pending highlighted in amber if > 0
- [x] Create `src/components/custom/admin/ErrorSummaryCards.tsx`:
  - Row of error count cards: Compilation Errors (24h), Emission Failures (24h), API Errors (24h)
  - Each card shows: error type, count (red if > 0, green if 0)
  - Cards are clickable — click opens error detail panel/modal
- [x] Create `src/components/custom/admin/ErrorDetailDialog.tsx`:
  - Modal showing audit trail entries for the selected error type
  - DataTable: timestamp, action, entity, user, error details
  - Paginated (50 per page)
- [x] Create `src/hooks/useAdminHealth.ts`:
  - oRPC query hooks for health check, usage metrics, activity metrics, error summary, error details
  - Manual refresh via `refetch()` — no auto-polling
  - All queries enabled only when Health tab is active

### Testing
- [x] **Unit tests** (`tests/unit/services/health.service.test.ts`):
  - checkDatabase returns healthy on successful query
  - checkDatabase returns unhealthy on query failure
  - checkCompiler returns healthy when trivial model compiles
  - checkCompiler returns unhealthy when compiler fails
  - checkEmitters returns correct status based on emitter results
  - runHealthCheck aggregates component statuses correctly (healthy/degraded/unhealthy)
  - getUsageMetrics returns correct counts from database
  - getActivityMetrics returns correct 24h activity counts
  - getErrorSummary returns correct error counts from audit_log
  - getErrorDetails returns filtered audit entries
  - Usage/activity/error metrics require Admin role
- [x] **Unit tests** (`tests/unit/api/health-endpoint.test.ts`):
  - GET /api/v1/health returns 200 with healthy status
  - GET /api/v1/health returns 503 when database is unreachable
  - Response matches HealthCheckResponse schema
  - Endpoint does not require authentication
  - Response includes Cache-Control: no-cache header
- [x] **Integration test** (`tests/integration/health-dashboard.test.ts`):
  - Run health check via oRPC → all components report healthy
  - Create entities/users → usage metrics reflect correct counts
  - Trigger actions → activity metrics update correctly
  - Trigger compilation error → error summary count increases
  - GET /api/v1/health → returns correct response
- [x] **Playwright E2E test** (`tests/e2e/admin-health.spec.ts`):
  - Admin navigates to Admin Panel → Health tab
  - Service Status cards display (all green in healthy system)
  - Usage Metrics show non-zero counts (entities, users exist from test setup)
  - Activity Metrics show recent activity
  - Click "Run Health Check" → cards update with fresh results
  - Click "Refresh" → all metrics reload
  - Error Summary cards are clickable → detail dialog shows entries

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/health.service.ts` owns all health check and metrics logic. oRPC router and REST endpoint are both thin wrappers calling the same service.
- **Result type**: All service functions return `Result<T, ServiceError>`. Never throw. Health check functions return `Promise<ComponentStatus>` directly since they are internal components of the aggregated health check.
- **Dual API**: Health check is available both via oRPC (Admin panel UI) and REST (`/api/v1/health` for monitoring tools). REST endpoint has no authentication to support external monitoring (Nagios, Prometheus, etc.).
- **No separate metrics infrastructure**: All metrics are computed from existing tables (audit_log, entities, fields, etc.) using Prisma count queries. This is sufficient for MVP scale (50 users, 5000 entities).
- **RBAC**: Admin panel metrics require Admin role. REST `/api/v1/health` is unauthenticated.
- **Compiler health check**: Uses `ICompilerService.compile()` with a trivial model. Mock compiler returns success in unit tests; real compiler used in integration tests.
- **withAudit()**: Health checks themselves are NOT audited (they're read-only). Only the "Run Health Check" action could optionally be logged.

### UX/Design Requirements
- Health tab is the fourth tab in the Admin Panel
- Dashboard layout: 2-column grid on large screens, single column on smaller
- Status cards use consistent color coding: green (healthy), amber (degraded), red (unhealthy)
- Metric cards are read-only display — no interaction except error cards
- Error cards turn red when count > 0, green (or gray) when 0
- "Run Health Check" button has a loading spinner overlay on the status cards while running
- "Refresh" button refreshes all sections, not just status
- No auto-refresh or polling — manual only for MVP

### File Structure
```
src/services/health.service.ts                              # Health check + metrics logic
src/types/schemas/health.ts                                 # Zod schemas — HealthCheckResponse, metrics
src/server/api/routers/admin/health.ts                      # oRPC router (Admin-only)
src/app/api/v1/health/route.ts                              # REST endpoint (unauthenticated)
src/components/custom/admin/HealthDashboard.tsx              # Main dashboard layout
src/components/custom/admin/ServiceStatusCards.tsx           # Service status cards
src/components/custom/admin/UsageMetricsCards.tsx            # Usage metric cards
src/components/custom/admin/ActivityMetricsCards.tsx         # Activity metric cards
src/components/custom/admin/ErrorSummaryCards.tsx            # Error summary cards (clickable)
src/components/custom/admin/ErrorDetailDialog.tsx            # Error detail modal
src/hooks/useAdminHealth.ts                                 # oRPC hooks for health data
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/health.service.test.ts`): 11+ test cases covering each health check component, metrics queries, RBAC
- **Unit tests** (`tests/unit/api/health-endpoint.test.ts`): 5+ test cases covering REST endpoint behavior
- **Integration test** (`tests/integration/health-dashboard.test.ts`): End-to-end health check, metrics accuracy
- **Playwright E2E** (`tests/e2e/admin-health.spec.ts`): Health dashboard UI workflow

### Dependencies & Prerequisites
- Epic 1 (Auth) complete — user sessions exist
- Epic 2 (Schema CRUD) complete — entities and fields exist for counts
- Epic 3 (Emission) complete — emission data exists for metrics
- Story 8.1 (RBAC) complete — Admin role and `adminProcedure` exist
- TypeSpec compiler service (`src/lib/compiler/`) exists — ICompilerService interface for health check
- Audit trail (`audit_log` table) exists — used for activity and error metrics

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — Infrastructure & Deployment, TypeSpec Integration (ICompilerService), API Strategy (REST endpoints)
- UX Spec: `_bmad-output/planning-artifacts/ux-design-specification.md` — Admin Panel, Health dashboard
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 8, Story 8.4
- PRD: FR38-FR45 (Administration), NFRs (uptime, performance monitoring)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
