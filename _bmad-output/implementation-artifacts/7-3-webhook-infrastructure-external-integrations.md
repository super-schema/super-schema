# Story 7.3: Webhook Infrastructure for External Integrations

Status: ready-for-dev

## Story
As a **platform administrator**, I want to configure webhook endpoints that receive governance events, so that external tools (Slack, email, PagerDuty) can be notified of schema changes.

## Acceptance Criteria

**Given** the notification system exists (Story 7.1 complete)
**When** webhook infrastructure is implemented
**Then** the Prisma schema includes a `webhook_endpoints` table: `id` (cuid), `url` (string — the target URL), `events` (string[] — list of event types to subscribe to), `secret` (string — HMAC signing secret), `active` (boolean, default true), `createdBy` (FK to users), `createdAt`, `updatedAt`
**And** a **webhook service** (`src/services/webhook.service.ts`) exports: `createEndpoint(input, ctx): Result<WebhookEndpoint>`, `updateEndpoint(id, input, ctx): Result<WebhookEndpoint>`, `deleteEndpoint(id, ctx): Result<void>`, `getEndpoints(ctx): Result<WebhookEndpoint[]>`, `dispatchEvent(event, ctx): Promise<void>`
**And** subscribable event types include: `governance.request.created`, `governance.request.approved`, `governance.request.rejected`, `emission.completed`, `drift.detected`, `compliance.gap.detected`
**And** `dispatchEvent()` sends an HTTP POST to all active endpoints subscribed to the event type with: JSON payload containing `{ event: string, timestamp: string, data: object }`, HMAC-SHA256 signature in `X-Webhook-Signature` header computed with the endpoint's secret, and `Content-Type: application/json`
**And** dispatch is **fire-and-forget** — failures are logged but do not block the triggering operation; a `webhook_deliveries` table tracks delivery attempts: `id`, `endpointId`, `event`, `payload` (JSONB), `statusCode` (int, nullable), `error` (text, nullable), `deliveredAt`
**And** retry logic: failed deliveries (non-2xx response or timeout after 10s) are retried up to 3 times with exponential backoff (10s, 60s, 300s) — retries are managed via a simple queue checked on the next incoming request (no background worker for MVP)
**And** the webhook service is integrated into the notification service: when a notification-triggering event occurs, both in-app notification AND webhook dispatch happen
**And** webhook management UI is part of the **Admin panel** (Epic 8 will add the admin UI, but the service and data model are built here)
**And** only **Admin** role users can create/manage webhook endpoints
**And** unit tests verify: webhook dispatch sends correct payload with HMAC signature, failed delivery is logged, retry logic respects exponential backoff, only subscribed events are dispatched to each endpoint, admin-only access is enforced
**And** integration test: create webhook endpoint → trigger a governance event → verify HTTP request is sent with correct payload and signature

## Tasks / Subtasks

### Database — Prisma Schema
- [ ] Add `webhook_endpoints` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `url` String
  - `events` String[] (array of subscribable event type strings)
  - `secret` String (HMAC signing secret — generated on creation)
  - `active` Boolean @default(true)
  - `createdBy` String (FK to users)
  - `createdAt` DateTime @default(now())
  - `updatedAt` DateTime @updatedAt
  - Relation: creator (User)
- [ ] Add `webhook_deliveries` table to `prisma/schema.prisma`:
  - `id` String @id @default(cuid())
  - `endpointId` String (FK to webhook_endpoints)
  - `event` String
  - `payload` Json (JSONB)
  - `statusCode` Int? (nullable — null if request failed before response)
  - `error` String? (nullable — error message if failed)
  - `attempt` Int @default(1) (delivery attempt number, 1-4)
  - `nextRetryAt` DateTime? (nullable — scheduled time for next retry)
  - `deliveredAt` DateTime @default(now())
  - Relation: endpoint (WebhookEndpoint)
  - Index on (endpointId, deliveredAt)
  - Index on (nextRetryAt) for retry queue queries
- [ ] Run `npx prisma migrate dev` to generate and apply migration

### Backend — Webhook Service
- [ ] Create `src/services/webhook.service.ts`
- [ ] Implement `createEndpoint(input, ctx): Result<WebhookEndpoint>`:
  - Validate input via Zod (url must be valid URL, events must be from allowed list)
  - Generate HMAC secret using `crypto.randomBytes(32).toString('hex')`
  - RBAC: require Admin role
  - Log to audit trail
- [ ] Implement `updateEndpoint(id, input, ctx): Result<WebhookEndpoint>`:
  - Allow updating url, events, active status
  - RBAC: require Admin role
  - Log to audit trail
- [ ] Implement `deleteEndpoint(id, ctx): Result<void>`:
  - Soft delete (set active=false) or hard delete — hard delete for MVP
  - RBAC: require Admin role
  - Log to audit trail
- [ ] Implement `getEndpoints(ctx): Result<WebhookEndpoint[]>`:
  - Return all endpoints (active and inactive)
  - RBAC: require Admin role
- [ ] Implement `dispatchEvent(event, ctx): Promise<void>`:
  - Query all active endpoints where `events` array contains the event type
  - For each matching endpoint, send HTTP POST (see dispatch subtasks below)
  - Fire-and-forget: wrap entire function in try/catch, log errors, never throw

### Backend — Webhook Event Types
- [ ] Define `WebhookEventType` enum in `src/types/schemas/webhook.ts`:
  - `governance.request.created`
  - `governance.request.approved`
  - `governance.request.rejected`
  - `emission.completed`
  - `drift.detected`
  - `compliance.gap.detected`
- [ ] Define `WebhookPayload` type: `{ event: string, timestamp: string, data: object }`
- [ ] Define `CreateWebhookEndpointInput` Zod schema: url (z.string().url()), events (z.array(WebhookEventType)), active (z.boolean().optional())

### Backend — HTTP Dispatch with HMAC Signing
- [ ] Implement `sendWebhookRequest(endpoint, payload)` internal function:
  - Serialize payload to JSON string
  - Compute HMAC-SHA256 signature: `crypto.createHmac('sha256', endpoint.secret).update(payloadString).digest('hex')`
  - Send HTTP POST to `endpoint.url` with:
    - Body: JSON payload string
    - Headers: `Content-Type: application/json`, `X-Webhook-Signature: sha256={signature}`
  - Timeout: 10 seconds (AbortController with setTimeout)
  - Use `fetch()` (native Node.js fetch)
- [ ] On success (2xx response): create `webhook_deliveries` record with statusCode, no error
- [ ] On failure (non-2xx or timeout or network error): create `webhook_deliveries` record with statusCode (if available), error message, and schedule retry

### Backend — Retry Logic
- [ ] Implement retry scheduling: on failed delivery, set `nextRetryAt` based on attempt number:
  - Attempt 1 failed → nextRetryAt = now + 10 seconds
  - Attempt 2 failed → nextRetryAt = now + 60 seconds
  - Attempt 3 failed → nextRetryAt = now + 300 seconds (5 minutes)
  - Attempt 4 failed → no more retries (max 3 retries = 4 total attempts)
- [ ] Implement `processRetryQueue(ctx): Promise<void>`:
  - Query `webhook_deliveries` where `nextRetryAt <= now` and `attempt < 4` and `error IS NOT NULL`
  - For each pending retry: re-send the webhook request, update the delivery record
  - Called opportunistically on incoming requests (not a background worker)
- [ ] Integrate retry queue check: call `processRetryQueue()` at the end of `dispatchEvent()` (process pending retries while dispatching new events)

### Backend — Integration with Notification Triggers
- [ ] Modify `src/services/notification.triggers.ts`:
  - After creating in-app notifications, also call `webhookService.dispatchEvent()` with the appropriate event type and data
  - Governance approval request → dispatch `governance.request.created`
  - Governance decision (approved) → dispatch `governance.request.approved`
  - Governance decision (rejected) → dispatch `governance.request.rejected`
  - Emission complete → dispatch `emission.completed`
- [ ] Each dispatch includes relevant data in the payload: entityId, entityName, version, domain, user info, etc.

### Backend — oRPC Router
- [ ] Create `src/server/api/routers/webhook.ts` oRPC router
- [ ] Add `webhook.create` mutation — thin wrapper, Admin-only
- [ ] Add `webhook.update` mutation — thin wrapper, Admin-only
- [ ] Add `webhook.delete` mutation — thin wrapper, Admin-only
- [ ] Add `webhook.getAll` query — thin wrapper, Admin-only
- [ ] Add `webhook.getDeliveries` query — returns delivery history for an endpoint, Admin-only
- [ ] Wire router into `appRouter`

## Dev Notes

### Architecture & Patterns
- **Service layer pattern**: `src/services/webhook.service.ts` owns all webhook business logic. oRPC router is thin.
- **Result type**: CRUD operations return `Result<T, ServiceError>`. `dispatchEvent()` returns `Promise<void>` (fire-and-forget).
- **Fire-and-forget**: Both in-app notification creation and webhook dispatch are non-blocking. If either fails, the triggering operation (governance, emission) still succeeds.
- **HMAC-SHA256**: Standard webhook signing pattern. Consumer verifies by computing the same HMAC with their copy of the secret and comparing to the `X-Webhook-Signature` header.
- **Retry without background worker**: MVP uses a "piggyback" retry strategy — pending retries are processed during the next `dispatchEvent()` call. This is sufficient for low-volume MVP. A proper background worker (cron job or queue) would be added in Phase 2.
- **withAudit()**: All webhook endpoint CRUD operations are logged to `audit_log`.
- **RBAC**: Only Admin role can manage webhook endpoints. Enforced in oRPC middleware.
- **No UI in this story**: The webhook management UI will be part of the Admin panel (Epic 8). This story builds the service, data model, and oRPC endpoints.

### UX/Design Requirements
- No UI components in this story. The Admin panel UI for webhook management is deferred to Epic 8.
- Webhook endpoint secret is shown once on creation (never again) — the Admin UI in Epic 8 should display it in a copy-able field with a warning.

### File Structure
```
prisma/schema.prisma                               # Extended — webhook_endpoints, webhook_deliveries tables
src/services/webhook.service.ts                     # Webhook CRUD + dispatch + retry
src/types/schemas/webhook.ts                        # Zod schemas — WebhookEventType, CreateWebhookEndpointInput, WebhookPayload
src/server/api/routers/webhook.ts                   # oRPC router (Admin-only)
src/services/notification.triggers.ts               # Modified — add webhook dispatch calls
```

### Testing Requirements
- **Unit tests** (`tests/unit/services/webhook.service.test.ts`):
  - createEndpoint generates HMAC secret and stores correctly
  - createEndpoint rejects non-Admin users
  - updateEndpoint updates url, events, active status
  - deleteEndpoint removes endpoint
  - getEndpoints returns all endpoints
  - dispatchEvent sends HTTP POST to all active endpoints subscribed to the event
  - dispatchEvent skips inactive endpoints
  - dispatchEvent skips endpoints not subscribed to the event type
  - Payload includes correct `{ event, timestamp, data }` structure
  - HMAC-SHA256 signature is computed correctly and sent in `X-Webhook-Signature` header
  - Failed delivery (non-2xx) is logged in webhook_deliveries with error
  - Failed delivery schedules retry with correct nextRetryAt (exponential backoff: 10s, 60s, 300s)
  - Max 3 retries (4 total attempts) — no retry scheduled after 4th attempt
  - Timeout after 10 seconds triggers failure handling
  - dispatchEvent never throws — failures logged but do not propagate
- **Integration test** (`tests/integration/webhook-dispatch.test.ts`):
  - Create webhook endpoint subscribed to `governance.request.created`
  - Trigger a governance approval request
  - Verify HTTP POST received at endpoint URL with correct payload and HMAC signature
  - Verify webhook_deliveries record created with success status
  - Test failure case: endpoint returns 500 → verify retry is scheduled
- **Mock HTTP server**: Use `msw` (Mock Service Worker) or a local test HTTP server to verify outbound webhook requests

### Dependencies & Prerequisites
- Story 7.1 (In-App Notification System) complete — notification triggers exist
- Governance service (Epic 5) complete — triggers governance events
- Emission service (Epic 3) complete — triggers emission events
- Node.js native `fetch` available (Node 18+)
- Node.js `crypto` module for HMAC-SHA256

### References
- Architecture: `_bmad-output/planning-artifacts/architecture.md` — API & Integration (webhook dispatch, FR66), Module Boundaries
- UX Spec: N/A (no UI in this story)
- Epics: `_bmad-output/planning-artifacts/epics.md` — Epic 7, Story 7.3
- PRD: FR63-FR67 (API & Integration), FR66 (webhook dispatch)

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
