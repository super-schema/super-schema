# Story 3.8: External API via oRPC OpenAPI Generation

Status: ready-for-dev

## Story
As an **API consumer**,
I want a versioned REST API for accessing schemas, validation, compatibility checking, and emission,
So that CI/CD pipelines and external tools can integrate with Super Schema programmatically.

## Acceptance Criteria

**Given** the emission pipeline and services work (Stories 3.1-3.6 complete)
**When** the external API is implemented
**Then** oRPC's `@orpc/openapi` generates an OpenAPI 3.0 specification from all existing oRPC routers — the spec is served at `/api/v1/openapi.json`
**And** the following API endpoints are available (all requiring authentication via API key or session):
**And** `GET /api/v1/schemas` — list all entities with pagination, filtering by domain, status, and search query
**And** `GET /api/v1/schemas/:id` — get entity details including all fields and decorators
**And** `POST /api/v1/schemas/:id/validate` — validate the entity against all enabled targets, returning a structured response: `{ valid: boolean, targets: [{ target, status, errors?, warnings? }] }`
**And** `POST /api/v1/schemas/:id/emit` — trigger emission for specified targets (or all enabled), returning: `{ entityId, version, targets: [{ target, output, validationStatus, warnings? }] }`
**And** `POST /api/v1/schemas/:id/compatibility` — check compatibility of current version against previous version, returning: `{ compatible: boolean, changeType: "breaking"|"non-breaking"|"none", changes: [...], perTarget: [{ target, compatible, details }] }`
**And** all API responses use the standardized error shape: `{ code, message, details?, suggestedFix? }`
**And** API responses include appropriate HTTP status codes: 200 (success), 201 (created), 400 (validation error), 401 (unauthorized), 403 (forbidden), 404 (not found), 500 (server error)
**And** the API supports **API key authentication** — a `user_api_keys` table stores hashed API keys linked to users; keys are created/revoked via user settings; API requests include the key in `Authorization: Bearer <key>` header
**And** API rate limiting is NOT implemented for MVP but the architecture supports adding it later
**And** CI/CD pipeline integration: the `/validate` and `/compatibility` endpoints return machine-parseable JSON that a CI pipeline can use for pass/fail decisions — the response includes a `ci` field with `{ pass: boolean, summary: string }` for easy integration
**And** integration tests verify: all API endpoints return correct responses for valid/invalid inputs, authentication rejects requests without valid API key, validate endpoint returns correct per-target status, emit endpoint triggers emission and returns output, compatibility endpoint correctly identifies breaking vs non-breaking changes
**And** a `/api/v1/docs` route serves a Swagger UI rendering the auto-generated OpenAPI spec

## Tasks / Subtasks

### 1. Set Up oRPC and OpenAPI Generation
- [ ] Install `@orpc/openapi` and related packages
- [ ] Configure oRPC to generate OpenAPI 3.0 spec from existing routers
- [ ] Create `src/app/api/v1/openapi.json/route.ts` — serves the generated OpenAPI spec
- [ ] Ensure all existing oRPC routers contribute to the spec

### 2. Create API Key Authentication System
- [ ] Add `user_api_keys` model to `prisma/schema.prisma`:
  - `id` — String @id @default(cuid())
  - `userId` — String (FK to users)
  - `name` — String (user-defined label for the key)
  - `hashedKey` — String (bcrypt or SHA-256 hash of the API key)
  - `prefix` — String (first 8 chars of key for identification)
  - `lastUsedAt` — DateTime? (nullable)
  - `expiresAt` — DateTime? (nullable, for optional expiration)
  - `revokedAt` — DateTime? (nullable)
  - `createdAt` — DateTime @default(now())
- [ ] Run migration
- [ ] Implement API key generation utility:
  - [ ] Generate cryptographically secure random key (32+ bytes, base64url encoded)
  - [ ] Hash the key for storage (SHA-256 or bcrypt)
  - [ ] Return the plaintext key to the user once (never stored or retrievable)
- [ ] Implement API key authentication middleware:
  - [ ] Extract key from `Authorization: Bearer <key>` header
  - [ ] Hash the provided key and look up in `user_api_keys`
  - [ ] Verify key is not revoked or expired
  - [ ] Update `lastUsedAt` timestamp
  - [ ] Resolve the associated user and their roles
  - [ ] Return 401 if no key or invalid key

### 3. Create API Key Management Service
- [ ] Create `src/services/api-key.service.ts`
- [ ] Implement `createApiKey(input: { name: string }, ctx: ServiceContext): Promise<Result<{ key: string; id: string }>>`
  - [ ] Generate key, hash, store in DB
  - [ ] Wrap in `withAudit()`
  - [ ] Return plaintext key (shown once to user)
- [ ] Implement `revokeApiKey(keyId: string, ctx: ServiceContext): Promise<Result<void>>`
  - [ ] Set `revokedAt` timestamp
  - [ ] Wrap in `withAudit()`
- [ ] Implement `listApiKeys(ctx: ServiceContext): Promise<Result<ApiKeyInfo[]>>`
  - [ ] Return key metadata (id, name, prefix, createdAt, lastUsedAt, revokedAt) — never return hash

### 4. Implement REST API Endpoints
- [ ] Create `src/app/api/v1/schemas/route.ts`:
  - [ ] `GET /api/v1/schemas` — list entities
    - [ ] Query params: `domain`, `status`, `search`, `page`, `limit`
    - [ ] Call `schema.service.listEntities()` with filters
    - [ ] Return paginated response: `{ data: [...], pagination: { page, limit, total, totalPages } }`
- [ ] Create `src/app/api/v1/schemas/[id]/route.ts`:
  - [ ] `GET /api/v1/schemas/:id` — get entity details
    - [ ] Call `schema.service.getEntityById()`
    - [ ] Return entity with fields and decorators
    - [ ] 404 if not found
- [ ] Create `src/app/api/v1/schemas/[id]/validate/route.ts`:
  - [ ] `POST /api/v1/schemas/:id/validate` — validate entity
    - [ ] Call `emission.service.previewEmission()` (runs all targets)
    - [ ] Return structured response:
      ```json
      {
        "valid": true/false,
        "targets": [
          { "target": "bigquery", "status": "VALID/INVALID/WARNING", "errors": [], "warnings": [] }
        ],
        "ci": { "pass": true/false, "summary": "All 3 targets valid" }
      }
      ```
- [ ] Create `src/app/api/v1/schemas/[id]/emit/route.ts`:
  - [ ] `POST /api/v1/schemas/:id/emit` — trigger emission
    - [ ] Request body: `{ targets?: string[] }` (optional, defaults to all)
    - [ ] Call `emission.service.commitEmission()`
    - [ ] Return:
      ```json
      {
        "entityId": "...",
        "version": 4,
        "targets": [
          { "target": "bigquery", "output": "CREATE TABLE...", "validationStatus": "VALID", "warnings": [] }
        ]
      }
      ```
- [ ] Create `src/app/api/v1/schemas/[id]/compatibility/route.ts`:
  - [ ] `POST /api/v1/schemas/:id/compatibility` — check compatibility
    - [ ] Compare current version against previous version
    - [ ] Return:
      ```json
      {
        "compatible": true/false,
        "changeType": "breaking"|"non-breaking"|"none",
        "changes": [{ "field": "amount", "change": "type_changed", "from": "integer", "to": "decimal" }],
        "perTarget": [
          { "target": "bigquery", "compatible": true, "details": "..." }
        ],
        "ci": { "pass": true/false, "summary": "Non-breaking changes detected" }
      }
      ```

### 5. Implement Standardized Error Handling
- [ ] Create `src/app/api/v1/error-handler.ts`
- [ ] Map all service errors to standardized shape:
  ```json
  { "code": "VALIDATION_ERROR", "message": "...", "details": {}, "suggestedFix": "..." }
  ```
- [ ] Map to HTTP status codes:
  - 200 — success (GET, validate, compatibility)
  - 201 — created (emit creates a version)
  - 400 — validation error
  - 401 — unauthorized (missing/invalid API key)
  - 403 — forbidden (insufficient role)
  - 404 — not found
  - 500 — server error
- [ ] Create error response helper function

### 6. Apply Auth Middleware to All Endpoints
- [ ] Create `src/app/api/v1/middleware.ts` (or use Next.js middleware)
- [ ] Check for `Authorization: Bearer <key>` header on all `/api/v1/*` routes
- [ ] Fall back to session-based auth (Auth.js) if no API key
- [ ] Return 401 if neither auth method succeeds
- [ ] Attach user context to request for downstream RBAC checks

### 7. Create Swagger UI Route
- [ ] Create `src/app/api/v1/docs/route.ts` (or page)
- [ ] Install Swagger UI dependency (e.g., `swagger-ui-react` or serve static Swagger UI)
- [ ] Render the auto-generated OpenAPI spec from `/api/v1/openapi.json`
- [ ] Serve at `/api/v1/docs`

### 8. Add API Key Management to User Settings
- [ ] Create oRPC procedures for API key management:
  - [ ] `apiKey.create` — mutation
  - [ ] `apiKey.revoke` — mutation
  - [ ] `apiKey.list` — query
- [ ] (UI for user settings page is out of scope for this story — procedures only)

### 9. Implement Rate Limiting Architecture Hooks
- [ ] Add rate limiting middleware stub (does nothing for MVP)
- [ ] Document where rate limiting should be added later
- [ ] Ensure middleware chain supports insertion of rate limiter

### 10. Write Integration Tests
- [ ] Create `tests/integration/api/v1/schemas.test.ts`
  - [ ] Test: `GET /api/v1/schemas` returns paginated list
  - [ ] Test: `GET /api/v1/schemas` supports domain, status, search filters
  - [ ] Test: `GET /api/v1/schemas/:id` returns entity with fields
  - [ ] Test: `GET /api/v1/schemas/:id` returns 404 for non-existent entity
- [ ] Create `tests/integration/api/v1/validate.test.ts`
  - [ ] Test: `POST /api/v1/schemas/:id/validate` returns correct per-target status
  - [ ] Test: validate returns `ci.pass: true` when all targets valid
  - [ ] Test: validate returns `ci.pass: false` when any target invalid
- [ ] Create `tests/integration/api/v1/emit.test.ts`
  - [ ] Test: `POST /api/v1/schemas/:id/emit` triggers emission and returns output
  - [ ] Test: emit creates entity_version snapshot
  - [ ] Test: emit returns per-target results
- [ ] Create `tests/integration/api/v1/compatibility.test.ts`
  - [ ] Test: compatibility correctly identifies breaking changes
  - [ ] Test: compatibility correctly identifies non-breaking changes
  - [ ] Test: compatibility returns `ci.pass` field
- [ ] Create `tests/integration/api/v1/auth.test.ts`
  - [ ] Test: request without API key or session returns 401
  - [ ] Test: request with invalid API key returns 401
  - [ ] Test: request with revoked API key returns 401
  - [ ] Test: request with valid API key succeeds
  - [ ] Test: request with valid session succeeds
- [ ] Create `tests/integration/api/v1/openapi-spec.test.ts`
  - [ ] Test: `/api/v1/openapi.json` returns valid OpenAPI 3.0 spec
  - [ ] Test: spec includes all endpoints

## Dev Notes

### Architecture & Patterns

**Two API layers (from architecture document):**
- **oRPC** — all UI-to-server communication. Type-safe routers.
- **REST API routes** — external API for CI/CD pipelines, webhooks, programmatic access. Versioned, documented via OpenAPI 3.0.

**Service layer pattern:** Both oRPC and REST wrappers call the same service layer. REST routes are thin wrappers around service functions.

```
src/app/api/v1/schemas/[id]/validate/route.ts  ← REST thin wrapper
  → src/services/emission.service.ts             ← Business logic (shared)
  ← src/server/api/routers/emission.ts           ← oRPC thin wrapper
```

**Standardized error shape:**
```typescript
{ code: string; message: string; details?: object; suggestedFix?: string }
```

**Result type pattern:** Services return `Result<T, E>`. REST wrappers convert `Result` errors to HTTP status codes + error shape.

**Key interfaces:**

```typescript
interface ICompilerService {
  compile(source: string): Promise<CompilationResult>;
  emit(model: SuperSchemaModel, target: string, policies: MappingPolicy[]): Promise<EmitterResult>;
  validate(output: string, targetFormat: string): Promise<ValidationResult>;
}

interface SuperSchemaModel {
  entity: { name: string; domain: string; version: number; metadata: EntityMetadata };
  fields: Array<{ name: string; type: LogicalType; decorators: DecoratorSet }>;
  relationships: Array<{ target: string; cardinality: string }>;
}
```

**API key authentication flow:**
```
Request → Extract Bearer token → Hash token → Lookup in user_api_keys
  → Verify not revoked/expired → Resolve user + roles → Attach to context
```

**CI/CD integration:** The `/validate` and `/compatibility` endpoints include a `ci` field with `{ pass: boolean, summary: string }` for easy pipeline integration:
```bash
# Example CI pipeline usage
RESULT=$(curl -s -H "Authorization: Bearer $API_KEY" \
  POST https://superschema.internal/api/v1/schemas/$ENTITY_ID/validate)
PASS=$(echo $RESULT | jq '.ci.pass')
if [ "$PASS" != "true" ]; then exit 1; fi
```

### UX/Design Requirements

No direct UI components in this story (API endpoints only). API key management UI in user settings is deferred to a separate story.

The Swagger UI at `/api/v1/docs` should use default Swagger UI styling (no custom theming needed for MVP).

### File Structure

```
prisma/
├── schema.prisma                  # Updated: user_api_keys model
├── migrations/                    # New migration
src/
├── app/api/v1/
│   ├── openapi.json/route.ts      # OpenAPI spec endpoint
│   ├── docs/route.ts              # Swagger UI
│   ├── middleware.ts              # API key + session auth middleware
│   ├── error-handler.ts           # Standardized error responses
│   ├── schemas/
│   │   ├── route.ts               # GET /api/v1/schemas (list)
│   │   └── [id]/
│   │       ├── route.ts           # GET /api/v1/schemas/:id (detail)
│   │       ├── validate/route.ts  # POST validate
│   │       ├── emit/route.ts      # POST emit
│   │       └── compatibility/route.ts  # POST compatibility
├── services/
│   └── api-key.service.ts         # API key create/revoke/list
├── server/api/routers/
│   └── api-key.ts                 # oRPC thin wrapper for key management
tests/
├── integration/api/v1/
│   ├── schemas.test.ts
│   ├── validate.test.ts
│   ├── emit.test.ts
│   ├── compatibility.test.ts
│   ├── auth.test.ts
│   └── openapi-spec.test.ts
```

### Testing Requirements

- **Integration tests (Vitest):** All REST endpoints (CRUD, validate, emit, compatibility), authentication (valid/invalid/revoked keys, session fallback), error responses (400, 401, 403, 404, 500), CI response fields, OpenAPI spec validity
- **No unit tests for REST routes** — they are thin wrappers; service logic is tested in service tests
- **No E2E tests** — API endpoints tested via integration tests with HTTP requests
- **Test framework:** Vitest with supertest or similar HTTP testing utility

### Dependencies & Prerequisites

- Stories 3.1-3.6 complete (compiler service, mapping engine, emitters, emission pipeline)
- Service layer functions: `schema.service.listEntities`, `schema.service.getEntityById`, `emission.service.previewEmission`, `emission.service.commitEmission`
- Auth.js session infrastructure
- Prisma schema infrastructure
- `withAudit()` wrapper
- oRPC router infrastructure
- `@orpc/openapi` package (or equivalent OpenAPI generation from oRPC)

### References

- Architecture document: "API Strategy" section — two API layers (oRPC + REST), service layer shared
- Architecture document: "API & Communication" section — error shape with suggestedFix
- Architecture document: "Authentication & Security" section — RBAC roles
- Architecture document: "Project Structure" section — `src/app/api/v1/` REST endpoints
- PRD: FR63-FR67 — versioned REST API, webhook dispatch, programmatic access

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### Change Log
