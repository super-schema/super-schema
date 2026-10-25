/**
 * The REST API (src/app/api/v1/**, and the JSON endpoints under src/app/api/*) over HTTP, with Playwright's `request` (no browser,
 * except where a second user has to sign in): status codes AND bodies, who may call what, and what a bad request gets back.
 *
 * Who calls (helpers/api.ts): the admin's saved session (a VIEWER on this API, always), the run's API key (`Authorization: Bearer`,
 * an ADMIN; the release runner makes the key up per run), and nobody. Every test sends a client address of its own, so the rate limit
 * (100 requests a minute per address, on emit / validate / event-specs) never couples two tests.
 *
 *   health         unauthenticated, 200 for healthy and degraded, no internals
 *   docs           /api/v1/docs is a valid OpenAPI 3 document, names every route group, and every documented operation exists
 *   authentication every non-public route (found by reading src/app/api, so a new route fails until it is listed here) answers 401 JSON
 *                  without a credential; a wrong key is refused even with a session; the middleware's own 401 for the other JSON endpoints
 *   schemas        list (filters, shape), detail, unknown / hostile ids, methods; CHARACTERIZES that no route is tenant scoped (KD-026)
 *   emit/validate  the shape of an emission, the closure `files` and `resolution`, the 422 AMBIGUOUS_REFERENCE error and its fix, the rate limit
 *   webhooks       endpoints are admin-only: the session is refused (KD-025), no one can create one (KD-024, pinned); the rest through rows
 *   notifications  per-user list, filters, pages, counts, mark-read, mark-all-read, other users' rows; a second user signs in for it
 *   event-specs    404 for an unknown id and for another tenant's (the same answer), bad parameters, a draft, no published version
 *   hardening      a body that is not JSON, an oversized body, ids that look like SQL / operators / NUL, wrong methods, nothing internal in an error
 *
 * Where the API had a bug the test came first and the fix with it (a body that is not JSON, an unknown `status` filter, a NUL byte in an id,
 * an unknown action, deliveries of an unknown endpoint); what stays open is in docs/testing/known-defects.md (KD-024 .. KD-028).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { test as base, expect, unique } from "./helpers/fixtures";
import {
  expectApiError, expectApiSuccess, jsonOf, keysOf, newCallers, SERVER_INTERNALS, signInCaller, type Callers,
} from "./helpers/api";
import {
  createEntityInProduct, createEventSpecInProduct, createFieldRow, createForeignTenantSpec, createNotifications, createProductInDomain,
  createSecondTenant, createUserRow, createUserWithPassword, createWebhookDeliveryRows, createWebhookRow, deleteForeignTenantSpec, deleteTenantWithDomain,
  deleteUsersByEmail, deleteWebhookRows, createEntityInTenant, notificationReadFlags, setFieldDecorators, webhookRow, webhookRowState, pg,
  type ForeignTenantSpec,
} from "./helpers/db";
import { SCHEMA_TARGETS_FOR_TESTS } from "./helpers/targets";


const test = base.extend<{ api: Callers }>({
  api: async ({ playwright, baseURL }, provide) => {
    const callers = await newCallers(playwright, baseURL);
    try {
      await provide(callers);
    } finally {
      await callers.dispose();
    }
  },
});

const API = "/api/v1";
const TARGET_KEYS = SCHEMA_TARGETS_FOR_TESTS.map((t) => t.key).sort();
/** The targets that emit the entity together with everything it references, one file per entity (`files`); the others emit one DDL string. */
const CLOSURE_TARGETS = ["avro", "java-pojo", "json-schema", "openapi3", "protobuf"];
const DB_TARGETS = ["bigquery", "postgresql", "spanner"];
const WEBHOOK_EVENT = "emission.completed";

interface EmittedFile { path: string; content: string; target: string; entityId: string }
interface TargetResult { target: string; output: string; files?: EmittedFile[]; validationStatus: string; warnings: string[] }
interface Resolution { mode: string; preview: boolean; entities: Array<{ ref: { entityId: string; domain: string; product: string; entity: string }; source: string }> }
interface EmitData { entityId: string; entityName: string; version: number; typespec: string; targets: TargetResult[]; files: EmittedFile[]; resolution: Resolution }
interface ValidateData {
  valid: boolean; entityId: string; entityName: string; resolution: Resolution;
  targets: Array<{ target: string; status: string; errors: string[]; warnings: string[]; files?: EmittedFile[] }>;
  summary: { totalTargets: number; validCount: number; warningCount: number; invalidCount: number };
  ci: { pass: boolean; summary: string };
}
interface Webhook { id: string; url: string; events: string[]; secret: string; active: boolean; createdBy: string; createdAt: string; updatedAt: string }
interface Delivery { id: string; endpointId: string; event: string; payload: Record<string, unknown>; statusCode: number | null; error: string | null; attempt: number; nextRetryAt: string | null; deliveredAt: string }
interface NotificationItem { id: string; userId: string; type: string; title: string; body: string; entityRef: Record<string, unknown>; read: boolean; createdAt: string }
interface NotificationList { notifications: NotificationItem[]; unreadCount: number }
interface SchemaListItem { id: string; name: string; description: string; status: string; version: number; domainId: string | null; createdAt: string; updatedAt: string }

const asJson = (data: unknown) => ({ data, headers: { "content-type": "application/json" } });
/** A body that is not what its content type says: the bytes go as they are (a string would be JSON-encoded again). */
const rawBody = (text: string) => ({ data: Buffer.from(text), headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------
// The routes of the API, as the code has them
// ---------------------------------------------------------------------------

/** Handlers found in src/app/api: `GET /api/v1/schemas/{id}`. A segment `[id]` is `{id}`, `[...nextauth]` is `{...nextauth}`. */
function discoverHandlers(): string[] {
  const root = path.resolve(__dirname, "../../src/app/api");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") {
        const urlPath = `/api/${path.relative(root, dir).split(path.sep).filter(Boolean).join("/")}`.replace(/\[([^\]]+)\]/g, "{$1}").replace(/\/$/, "");
        const source = readFileSync(full, "utf8");
        for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) found.push(`${match[1]} ${urlPath}`);
        // `export const { GET, POST } = handlers;` (Auth.js)
        for (const match of source.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)) {
          for (const name of match[1].split(",").map((part) => part.trim())) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) found.push(`${name} ${urlPath}`);
        }
      }
    }
  };
  walk(root);
  return found.sort();
}

interface RouteCase { method: "GET" | "POST" | "PUT" | "DELETE"; template: string; path: string; body?: unknown }

/** Every route of the REST API that needs a credential: the handler itself answers 401 in the API's own envelope. */
const PROTECTED_V1: RouteCase[] = [
  { method: "GET", template: "/api/v1/schemas", path: "/api/v1/schemas" },
  { method: "GET", template: "/api/v1/schemas/{id}", path: "/api/v1/schemas/some-id" },
  { method: "POST", template: "/api/v1/schemas/{id}/emit", path: "/api/v1/schemas/some-id/emit" },
  { method: "POST", template: "/api/v1/schemas/{id}/validate", path: "/api/v1/schemas/some-id/validate" },
  { method: "GET", template: "/api/v1/webhooks", path: "/api/v1/webhooks" },
  { method: "POST", template: "/api/v1/webhooks", path: "/api/v1/webhooks", body: { url: "https://example.invalid/hook", events: [WEBHOOK_EVENT] } },
  { method: "PUT", template: "/api/v1/webhooks/{id}", path: "/api/v1/webhooks/some-id", body: { active: false } },
  { method: "DELETE", template: "/api/v1/webhooks/{id}", path: "/api/v1/webhooks/some-id" },
  { method: "GET", template: "/api/v1/webhooks/{id}/deliveries", path: "/api/v1/webhooks/some-id/deliveries" },
  { method: "GET", template: "/api/v1/notifications", path: "/api/v1/notifications" },
  { method: "POST", template: "/api/v1/notifications", path: "/api/v1/notifications?action=mark-all-read" },
  { method: "GET", template: "/api/v1/event-specs/{id}", path: "/api/v1/event-specs/some-id" },
];

/** The JSON endpoints of the app itself: the middleware answers 401 before the handler runs, in a shape of its own. */
const PROTECTED_APP: RouteCase[] = [
  { method: "GET", template: "/api/tenants", path: "/api/tenants" },
  { method: "GET", template: "/api/domains-tree", path: "/api/domains-tree" },
  { method: "GET", template: "/api/command-palette-fields", path: "/api/command-palette-fields" },
  { method: "POST", template: "/api/compliance/query", path: "/api/compliance/query", body: {} },
  { method: "POST", template: "/api/compliance/gaps", path: "/api/compliance/gaps", body: {} },
  { method: "POST", template: "/api/compliance/audit-trail", path: "/api/compliance/audit-trail", body: {} },
  { method: "POST", template: "/api/ai/generate-entity", path: "/api/ai/generate-entity", body: {} },
];

/** Answered without a credential on purpose: the health probe, the API's own description, Auth.js, and the preview iframe's assets (it sends no cookie). */
const PUBLIC_ROUTES = ["GET /api/v1/health", "GET /api/v1/docs", "GET /api/auth/{...nextauth}", "POST /api/auth/{...nextauth}", "GET /api/asyncapi-preview/{asset}"];

const call = (context: APIRequestContext, route: RouteCase): Promise<APIResponse> =>
  context.fetch(route.path, { method: route.method, ...(route.body !== undefined ? asJson(route.body) : {}), maxRedirects: 0 });

// ---------------------------------------------------------------------------
// health, docs
// ---------------------------------------------------------------------------

test.describe("health", () => {
  test("GET /api/v1/health answers 200 with the status of each component and nothing of the server, without a login", { tag: ["@smoke", "@regression"] }, async ({ api }) => {
    // 200 within a few tries: a probe that has just started the app may find the database slow for a moment (degraded is still 200).
    let response = await api.anon.get(`${API}/health`, { maxRedirects: 0 });
    await expect
      .poll(async () => (response = await api.anon.get(`${API}/health`, { maxRedirects: 0 })).status(), { message: "health never answered 200", intervals: [250, 500, 1000, 2000], timeout: 30_000 })
      .toBe(200);
    expect(response.headers()["content-type"]).toMatch(/application\/json/);
    expect(response.headers()["cache-control"]).toBe("no-cache");
    const text = await response.text();
    const body = JSON.parse(text) as { status: string; timestamp: string; components: Record<string, { name: string; status: string; message?: string; latencyMs?: number }> };
    // The body is the health report itself, not the `{ success, data }` envelope the other endpoints use.
    expect(keysOf(body)).toEqual(["components", "status", "timestamp"]);
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(Object.keys(body.components).sort()).toEqual(["compiler", "database", "emitters"]);
    for (const component of Object.values(body.components)) {
      expect(["healthy", "degraded", "unhealthy"]).toContain(component.status);
      expect(typeof component.name).toBe("string");
    }
    expect(body.components.database.status, "the app cannot reach its database").not.toBe("unhealthy");
    expect(text).not.toMatch(SERVER_INTERNALS);
    expect(text).not.toMatch(/password|secret|token/i);
  });

  test("health ignores credentials, and only GET is a method of it", { tag: ["@regression"] }, async ({ api }) => {
    // A wrong key is not an error here: the probe is public, whatever it is sent.
    const wrongKey = await api.custom({ authorization: "Bearer not-the-key" });
    expect((await wrongKey.get(`${API}/health`)).status()).toBe(200);
    expect((await api.session.get(`${API}/health`)).status()).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await api.anon.fetch(`${API}/health`, { method })).status(), method).toBe(405);
    }
  });
});

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  security?: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, { responses: Record<string, unknown>; parameters?: Array<{ name: string; in: string; required?: boolean }>; security?: unknown[]; operationId?: string }>>;
  components: { securitySchemes?: Record<string, { type: string; scheme?: string }>; schemas?: Record<string, unknown>; responses?: Record<string, unknown> };
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

/** What a client of the API documents: path -> methods. */
const DOCUMENTED = {
  "/health": ["get"],
  "/schemas": ["get"],
  "/schemas/{id}": ["get"],
  "/schemas/{id}/emit": ["post"],
  "/schemas/{id}/validate": ["post"],
  "/webhooks": ["get", "post"],
  "/webhooks/{id}": ["put", "delete"],
  "/webhooks/{id}/deliveries": ["get"],
  "/notifications": ["get", "post"],
  "/event-specs/{id}": ["get"],
};

test.describe("docs", () => {
  async function docs(api: Callers): Promise<OpenApiDocument> {
    const response = await api.anon.get(`${API}/docs`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/application\/json/);
    return jsonOf<OpenApiDocument>(response);
  }

  test("GET /api/v1/docs is a valid OpenAPI 3 document that needs no login", { tag: ["@regression"] }, async ({ api }) => {
    const doc = await docs(api);
    expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.servers[0].url).toBe(API);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    const operationIds = new Set<string>();
    for (const [route, item] of Object.entries(doc.paths)) {
      expect(route.startsWith("/"), route).toBe(true);
      const methods = Object.keys(item);
      expect(methods.length, route).toBeGreaterThan(0);
      for (const method of methods) {
        expect(HTTP_METHODS, `${route}: ${method} is not an HTTP method`).toContain(method);
        const operation = item[method];
        expect(Object.keys(operation.responses).length, `${method} ${route} has no responses`).toBeGreaterThan(0);
        for (const status of Object.keys(operation.responses)) expect(status, `${method} ${route}`).toMatch(/^(\d{3}|default)$/);
        // Every `{name}` of the path is a declared, required path parameter.
        for (const name of [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
          const parameter = operation.parameters?.find((p) => p.name === name && p.in === "path");
          expect(parameter, `${method} ${route}: path parameter ${name} is not declared`).toBeDefined();
          expect(parameter?.required, `${method} ${route}: ${name} must be required`).toBe(true);
        }
        if (operation.operationId) {
          expect(operationIds.has(operation.operationId), `operationId ${operation.operationId} is used twice`).toBe(false);
          operationIds.add(operation.operationId);
        }
      }
    }

    // Every $ref points at something in the document.
    const refs: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (key === "$ref" && typeof inner === "string") refs.push(inner);
          else collect(inner);
        }
      }
    };
    collect(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/"), ref).toBe(true);
      const target = ref.slice(2).split("/").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], doc);
      expect(target, `${ref} does not resolve`).toBeDefined();
    }

    // The security the document asks for is defined, and the public endpoint opts out of it.
    for (const requirement of doc.security ?? []) {
      for (const name of Object.keys(requirement)) expect(doc.components.securitySchemes?.[name], `security scheme ${name}`).toBeDefined();
    }
    expect(doc.components.securitySchemes?.BearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(doc.paths["/health"].get.security).toEqual([]);
  });

  test("the document names a path and a method for every route group the API implements", { tag: ["@regression"] }, async ({ api }) => {
    const doc = await docs(api);
    const documented = Object.fromEntries(Object.entries(doc.paths).map(([route, item]) => [route, Object.keys(item).sort()]));
    for (const [route, methods] of Object.entries(DOCUMENTED)) {
      expect(documented[route], `${route} is not in /api/v1/docs`).toBeDefined();
      expect(documented[route], route).toEqual([...methods].sort());
    }
    // And nothing is documented that the API does not have.
    expect(Object.keys(documented).sort()).toEqual(Object.keys(DOCUMENTED).sort());
  });

  test("every documented operation is a route that exists (an unknown id is a JSON 404, not a missing route)", { tag: ["@regression"] }, async ({ api }) => {
    const doc = await docs(api);
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item)) {
        const response = await api.anon.fetch(`${API}${route.replace(/\{\w+\}/g, "some-id")}`, { method: method.toUpperCase(), ...(method === "post" || method === "put" ? asJson({}) : {}), maxRedirects: 0 });
        expect(response.status(), `${method.toUpperCase()} ${route}: the route is not there`).not.toBe(405);
        if (response.status() === 404) expect(response.headers()["content-type"], `${method.toUpperCase()} ${route}: a 404 that is a missing route`).toMatch(/application\/json/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

test.describe("authentication", () => {
  test("every route of src/app/api is either public, or in the table of this spec that is checked for a 401 below", { tag: ["@regression"] }, async () => {
    const listed = new Set([...PROTECTED_V1, ...PROTECTED_APP].map((r) => `${r.method} ${r.template}`).concat(PUBLIC_ROUTES));
    const found = discoverHandlers();
    expect(found.length).toBeGreaterThan(10);
    expect(found.filter((handler) => !listed.has(handler)), "a route handler that this spec does not know: say whether it is public, and test its 401").toEqual([]);
    expect([...listed].filter((handler) => !found.includes(handler)), "listed here, but not in src/app/api any more").toEqual([]);
  });

  for (const route of PROTECTED_V1) {
    test(`${route.method} ${route.template} without a credential is 401 UNAUTHORIZED in the API's envelope`, { tag: ["@regression"] }, async ({ api }) => {
      const response = await call(api.anon, route);
      const error = await expectApiError(response, 401, "UNAUTHORIZED");
      expect(error.message).toBe("Authentication required");
      expect(error.suggestedFix).toMatch(/Bearer/);
      expect(response.headers()["set-cookie"], "an unauthenticated answer must not set a cookie").toBeUndefined();
    });
  }

  for (const route of PROTECTED_APP) {
    test(`${route.method} ${route.template} without a session is 401 from the middleware, in the middleware's own shape`, { tag: ["@regression"] }, async ({ api }) => {
      const response = await call(api.anon, route);
      expect(response.status()).toBe(401);
      expect(response.headers()["content-type"]).toMatch(/application\/json/);
      expect(await jsonOf(response)).toEqual({ error: "Not authenticated" });
    });
  }

  test("a cookie that only has a session's name is no session: the REST API and the app's endpoints both answer 401", { tag: ["@regression"] }, async ({ api }) => {
    const forged = await api.custom({ cookie: "authjs.session-token=not-a-real-session-token" });
    await expectApiError(await forged.get(`${API}/schemas`), 401, "UNAUTHORIZED");
    await expectApiError(await forged.get(`${API}/webhooks`), 401, "UNAUTHORIZED");
    expect((await forged.get("/api/tenants")).status()).toBe(401);
  });

  test("a wrong key is refused, and it is not replaced by the session next to it", { tag: ["@regression"] }, async ({ api }) => {
    const apiKey = process.env.E2E_API_KEY ?? "";
    expect(apiKey.length, "E2E_API_KEY is not set (the release runner sets it)").toBeGreaterThan(10);
    // Wrong in its length, wrong in its last character only (the same length takes the constant-time comparison), empty after the scheme.
    const lastOfKey = apiKey.slice(-1);
    const sameLength = `${apiKey.slice(0, -1)}${lastOfKey === "0" ? "1" : "0"}`;
    for (const header of [`Bearer ${apiKey}x`, `Bearer ${apiKey.slice(0, -1)}`, `Bearer ${sameLength}`, "Bearer not-the-key"]) {
      const anon = await api.custom({ authorization: header });
      await expectApiError(await anon.get(`${API}/schemas`), 401, "UNAUTHORIZED");
      // With the admin's session as well: the key header decides, the session is not the fallback.
      const withSession = await api.custom({ authorization: header }, { session: true });
      await expectApiError(await withSession.get(`${API}/schemas`), 401, "UNAUTHORIZED");
    }
  });

  test("the run's API key authenticates without a session, and the key is never echoed", { tag: ["@regression"] }, async ({ api }) => {
    const response = await api.key.get(`${API}/schemas?search=${unique("nothing-")}`);
    const text = await response.text();
    expect(response.status(), text).toBe(200);
    expect(text).not.toContain(process.env.E2E_API_KEY ?? "no-key");
    expect(JSON.parse(text)).toEqual({ success: true, data: [], summary: "Found 0 entities" });
  });

  test("an empty bearer token, or another scheme, is not a key: the request is judged by its session", { tag: ["@regression"] }, async ({ api }) => {
    for (const header of ["Bearer ", "Bearer    ", "Basic dXNlcjpwYXNz", "bearer-without-space"]) {
      const withSession = await api.custom({ authorization: header }, { session: true });
      expect((await withSession.get(`${API}/schemas?search=${unique("nothing-")}`)).status(), header).toBe(200);
      const without = await api.custom({ authorization: header });
      await expectApiError(await without.get(`${API}/schemas`), 401, "UNAUTHORIZED");
    }
  });
});

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

test.describe("schemas: list and detail", () => {
  test.use({ workspaceEntities: ["Alpha", "Beta"] });

  test("the list names the entities of a domain with exactly the public fields, for a session and for the key alike", { tag: ["@regression"] }, async ({ api, workspace }) => {
    for (const caller of [api.session, api.key]) {
      const body = await expectApiSuccess<SchemaListItem[]>(await caller.get(`${API}/schemas?domain=${workspace.domainId}`));
      expect(body.summary).toBe("Found 2 entities");
      expect(body.data.map((e) => e.name).sort()).toEqual(["Alpha", "Beta"]);
      for (const item of body.data) {
        // Not the tenant, the owner, the slug or the metadata of the row: only what the documentation promises.
        expect(keysOf(item)).toEqual(["createdAt", "description", "domainId", "id", "name", "status", "updatedAt", "version"]);
        expect(item).toMatchObject({ status: "DRAFT", version: 1, domainId: workspace.domainId, description: "" });
        expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
      }
      expect(new Set(body.data.map((e) => e.id))).toEqual(new Set(workspace.entities.map((e) => e.id)));
    }
  });

  test("the list's filters: search is a case-insensitive contains, status narrows, an unknown domain is empty", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const names = async (query: string) => (await expectApiSuccess<SchemaListItem[]>(await api.session.get(`${API}/schemas?domain=${workspace.domainId}${query}`))).data.map((e) => e.name);
    expect(await names("&search=alp")).toEqual(["Alpha"]);
    expect(await names("&search=BETA")).toEqual(["Beta"]);
    expect(await names("&search=a")).toHaveLength(2);
    expect(await names(`&search=${unique("zz")}`)).toEqual([]);
    expect(await names("&status=DRAFT")).toHaveLength(2);
    expect(await names("&status=ACTIVE")).toEqual([]);
    expect(await names("&status=ACTIVE&search=alp")).toEqual([]);
    const unknownDomain = await expectApiSuccess<SchemaListItem[]>(await api.session.get(`${API}/schemas?domain=${unique("no-such-domain-")}`));
    expect(unknownDomain).toMatchObject({ data: [], summary: "Found 0 entities" });
    // A search that is made of LIKE wildcards or quotes is text, not a pattern or a statement.
    for (const hostile of ["%", "_", "'", "\\", "' OR '1'='1", "\"; DROP TABLE entities; --"]) {
      const body = await expectApiSuccess<SchemaListItem[]>(await api.session.get(`${API}/schemas?domain=${workspace.domainId}&search=${encodeURIComponent(hostile)}`));
      expect(body.data.length, hostile).toBeLessThanOrEqual(2);
    }
    expect(await names("")).toHaveLength(2); // the table is still there
  });

  test("a status that is not one of the four is a 400 VALIDATION_ERROR naming them, not a 500", { tag: ["@regression"] }, async ({ api }) => {
    for (const status of ["BOGUS", "draft", "'", "ACTIVE,DRAFT"]) {
      const error = await expectApiError(await api.session.get(`${API}/schemas?status=${encodeURIComponent(status)}`), 400, "VALIDATION_ERROR");
      expect(error.message).toMatch(/DRAFT/);
      expect(error.message).toMatch(/RETIRED/);
    }
  });

  test("the detail is the entity with its fields in order, and its domain", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const alpha = workspace.entities[0];
    await createFieldRow(alpha.id, { name: "amount", type: "decimal", sortOrder: 2 });
    await createFieldRow(alpha.id, { name: "note", type: "string", sortOrder: 1 });
    const body = await expectApiSuccess<{ id: string; name: string; slug: string; status: string; domainId: string; productId: string; domain: { id: string; slug: string }; fields: Array<{ name: string; type: string; isKey: boolean; sortOrder: number; entityId: string }> }>(
      await api.session.get(`${API}/schemas/${alpha.id}`),
    );
    expect(body.summary).toBeUndefined();
    expect(body.data).toMatchObject({ id: alpha.id, name: "Alpha", slug: "alpha", status: "DRAFT", domainId: workspace.domainId, productId: workspace.productId });
    expect(body.data.domain).toMatchObject({ id: workspace.domainId, slug: workspace.domainSlug });
    expect(body.data.fields.map((f) => f.name)).toEqual(["id", "note", "amount"]);
    expect(body.data.fields[0]).toMatchObject({ type: "string", isKey: true, entityId: alpha.id });
    expect(body.data.fields.map((f) => f.sortOrder)).toEqual([0, 1, 2]);
    // The key sees the same entity.
    expect(await expectApiSuccess(await api.key.get(`${API}/schemas/${alpha.id}`))).toMatchObject({ data: { id: alpha.id } });
  });

  test("an unknown id is a 404 NOT_FOUND with a suggested fix, and an id made of SQL, operators or paths is just an unknown id", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const hostile = [
      unique("no-such-entity-"),
      "' OR '1'='1",
      "1; DROP TABLE entities; --",
      "' UNION SELECT password FROM users --",
      '{"$ne":null}',
      "$where: 1",
      "../../../etc/passwd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "éü日本語",
      "a".repeat(4000),
    ];
    for (const id of hostile) {
      const response = await api.session.get(`${API}/schemas/${encodeURIComponent(id)}`);
      const error = await expectApiError(response, 404, "NOT_FOUND");
      expect(error.suggestedFix, id.slice(0, 40)).toBeTruthy();
      // The answer to an id that does not exist does not depend on how hostile the id is.
      expect(error.message).toContain("not found");
    }
    // Nothing the ids said ran: the rows are all still there.
    const still = await expectApiSuccess<SchemaListItem[]>(await api.session.get(`${API}/schemas?domain=${workspace.domainId}`));
    expect(still.data).toHaveLength(2);
  });

  test("an id with a NUL byte is a 404, not a 500, on every route that takes an id", { tag: ["@regression"] }, async ({ api }) => {
    // PostgreSQL text cannot hold a NUL byte: a lookup with one used to throw, and the API answered 500.
    const cases: Array<[APIRequestContext, "GET" | "POST" | "PUT" | "DELETE", string]> = [
      [api.session, "GET", `${API}/schemas/%00`],
      [api.session, "POST", `${API}/schemas/%00/emit`],
      [api.session, "POST", `${API}/schemas/%00/validate`],
      [api.key, "PUT", `${API}/webhooks/%00`],
      [api.key, "DELETE", `${API}/webhooks/%00`],
      [api.key, "GET", `${API}/webhooks/%00/deliveries`],
      [api.session, "GET", `${API}/event-specs/%00`],
      [api.session, "POST", `${API}/notifications?action=mark-read&id=%00`],
      [api.session, "GET", `${API}/schemas/ab%00cd`],
    ];
    for (const [caller, method, url] of cases) {
      const response = await caller.fetch(url, { method, ...(method === "PUT" ? asJson({ active: false }) : {}) });
      await expectApiError(response, 404, "NOT_FOUND");
    }
  });

  test("the schemas routes take the methods they document and answer 405 to the others", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const id = workspace.entities[0].id;
    const wrong: Array<["PUT" | "POST" | "DELETE" | "PATCH" | "GET", string]> = [
      ["POST", `${API}/schemas`], ["PUT", `${API}/schemas`], ["DELETE", `${API}/schemas`], ["PATCH", `${API}/schemas`],
      ["POST", `${API}/schemas/${id}`], ["PUT", `${API}/schemas/${id}`], ["DELETE", `${API}/schemas/${id}`],
      ["GET", `${API}/schemas/${id}/emit`], ["PUT", `${API}/schemas/${id}/emit`], ["DELETE", `${API}/schemas/${id}/emit`],
      ["GET", `${API}/schemas/${id}/validate`], ["PUT", `${API}/schemas/${id}/validate`],
    ];
    for (const [method, url] of wrong) expect((await api.session.fetch(url, { method })).status(), `${method} ${url}`).toBe(405);
    // ...and nothing was changed or deleted by them.
    expect((await api.session.get(`${API}/schemas/${id}`)).status()).toBe(200);
  });
});

test.describe("schemas: tenants", () => {
  test("CHARACTERIZED (KD-026): the schemas routes are not tenant scoped, an entity of another tenant is listed and readable", { tag: ["@regression"] }, async ({ api }) => {
    // The session below views the default tenant. These are the routes' policy today (the user will add access control later); when a
    // route starts to scope by tenant these assertions change together with KD-026.
    const other = await createSecondTenant();
    const name = unique("OtherTenant");
    try {
      const entity = await createEntityInTenant(other.tenantId, name);
      for (const caller of [api.session, api.key]) {
        const list = await expectApiSuccess<SchemaListItem[]>(await caller.get(`${API}/schemas?search=${name}`));
        expect(list.data.map((e) => e.id), "the list is scoped to a tenant now: edit this test and KD-026").toEqual([entity.id]);
        expect(list.data[0].domainId).toBeNull(); // a tenant-level entity
        const detail = await expectApiSuccess<{ tenantId: string; name: string }>(await caller.get(`${API}/schemas/${entity.id}`));
        expect(detail.data).toMatchObject({ name, tenantId: other.tenantId });
      }
    } finally {
      await deleteTenantWithDomain(other);
    }
  });
});

// ---------------------------------------------------------------------------
// emit and validate
// ---------------------------------------------------------------------------

test.describe("emit and validate", () => {
  test.use({ workspaceEntities: ["Customer"] });

  test("emit returns the TypeSpec, the output of every target, and the files of the closure targets", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const customer = workspace.entities[0];
    const body = await expectApiSuccess<EmitData>(await api.session.post(`${API}/schemas/${customer.id}/emit`));
    const { data } = body;
    expect(body.summary).toMatch(new RegExp(`^Emitted to ${TARGET_KEYS.length} targets — \\d+ valid, \\d+ warnings, 0 invalid$`));
    expect(keysOf(data)).toEqual(["entityId", "entityName", "files", "resolution", "targets", "typespec", "version"]);
    expect(data).toMatchObject({ entityId: customer.id, entityName: "Customer", version: 1 });
    expect(data.typespec).toContain("model Customer");
    expect(data.typespec).toContain("id: string");

    expect(data.targets.map((t) => t.target).sort()).toEqual(TARGET_KEYS);
    for (const target of data.targets) {
      expect(["VALID", "WARNING"], `${target.target}: ${target.warnings.join("; ")}`).toContain(target.validationStatus);
      expect(typeof target.output).toBe("string");
      expect(target.output.length, target.target).toBeGreaterThan(0);
      expect(Array.isArray(target.warnings)).toBe(true);
    }
    // The closure targets have one file per entity, `output` is their text; the database targets have one string and no `files`.
    for (const key of CLOSURE_TARGETS) {
      const target = data.targets.find((t) => t.target === key) as TargetResult;
      expect(keysOf(target), key).toEqual(["files", "output", "target", "validationStatus", "warnings"]);
      expect(target.files, key).toHaveLength(1);
      const file = (target.files as EmittedFile[])[0];
      expect(keysOf(file)).toEqual(["content", "entityId", "path", "target"]);
      expect(file).toMatchObject({ target: key, entityId: customer.id });
      expect(file.path.length).toBeGreaterThan(0);
      expect(file.content).toContain("Customer");
      expect(target.output, `${key}: a single file is the output as it is`).toBe(file.content);
    }
    for (const key of DB_TARGETS) {
      const target = data.targets.find((t) => t.target === key) as TargetResult;
      expect(keysOf(target), key).toEqual(["output", "target", "validationStatus", "warnings"]);
    }
    const bigquery = data.targets.find((t) => t.target === "bigquery") as TargetResult;
    expect(bigquery.output).toMatch(/CREATE TABLE \S+\.customer \(/);
    // `data.files` is every file of the run in one list, each tagged by its target.
    expect(data.files.map((f) => `${f.target}:${f.path}`).sort()).toEqual(
      data.targets.flatMap((t) => (t.files ?? []).map((f) => `${f.target}:${f.path}`)).sort(),
    );
    expect(new Set(data.files.map((f) => f.target))).toEqual(new Set(CLOSURE_TARGETS));
    // What the run used: the saved draft of the entity, so it is a preview.
    expect(data.resolution).toEqual({ mode: "draft", preview: true, entities: [{ ref: { entityId: customer.id, domain: workspace.domainName, product: workspace.productName, entity: "Customer" }, source: "draft" }] });
    // The key gets the same emission.
    const viaKey = await expectApiSuccess<EmitData>(await api.key.post(`${API}/schemas/${customer.id}/emit`));
    expect(viaKey.data.typespec).toBe(data.typespec);
    expect(viaKey.data.targets.map((t) => t.target)).toEqual(data.targets.map((t) => t.target));
  });

  test("validate says per target whether the entity emits, with the CI summary, and the same closure files and resolution as emit", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const customer = workspace.entities[0];
    const body = await expectApiSuccess<ValidateData>(await api.session.post(`${API}/schemas/${customer.id}/validate`));
    const { data } = body;
    expect(keysOf(data)).toEqual(["ci", "entityId", "entityName", "resolution", "summary", "targets", "valid"]);
    expect(data).toMatchObject({ valid: true, entityId: customer.id, entityName: "Customer" });
    expect(data.targets.map((t) => t.target).sort()).toEqual(TARGET_KEYS);
    for (const target of data.targets) {
      expect(["VALID", "WARNING", "INVALID"]).toContain(target.status);
      expect(Array.isArray(target.errors)).toBe(true);
      expect(Array.isArray(target.warnings)).toBe(true);
    }
    expect(data.summary.totalTargets).toBe(TARGET_KEYS.length);
    expect(data.summary.validCount + data.summary.warningCount + data.summary.invalidCount).toBe(data.summary.totalTargets);
    expect(data.summary.invalidCount).toBe(0);
    expect(data.ci.pass).toBe(true);
    expect(data.ci.summary).toMatch(/^All \d+ targets valid/);
    for (const key of CLOSURE_TARGETS) {
      const target = data.targets.find((t) => t.target === key) as ValidateData["targets"][number];
      expect(target.files?.map((f) => f.entityId), key).toEqual([customer.id]);
    }
    for (const key of DB_TARGETS) expect((data.targets.find((t) => t.target === key) as ValidateData["targets"][number]).files).toBeUndefined();
    expect(data.resolution).toMatchObject({ mode: "draft", preview: true });
    expect(data.resolution.entities.map((e) => e.ref.entity)).toEqual(["Customer"]);
  });

  test("an entity that references another is emitted with it: one file per entity per closure target, bundled in `output`, both in `resolution`", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const invoice = await createEntityInProduct(workspace.domainId, workspace.productId, "Invoice");
    const customer = workspace.entities[0];
    await createFieldRow(invoice.id, {
      name: "customer", type: "reference", sortOrder: 1,
      decorators: { referencedEntityId: customer.id, referencedEntityName: "Customer", referencedQualifiedName: `${workspace.domainName}/${workspace.productName}/Customer` },
    });
    const { data } = await expectApiSuccess<EmitData>(await api.session.post(`${API}/schemas/${invoice.id}/emit`));
    expect(data.entityName).toBe("Invoice");
    expect(data.resolution.entities.map((e) => e.ref.entity).sort()).toEqual(["Customer", "Invoice"]);
    expect(data.resolution.entities.map((e) => e.ref.entityId).sort()).toEqual([customer.id, invoice.id].sort());
    for (const key of CLOSURE_TARGETS) {
      const target = data.targets.find((t) => t.target === key) as TargetResult;
      const files = target.files as EmittedFile[];
      expect(new Set(files.map((f) => f.entityId)), `${key}: one file for each entity`).toEqual(new Set([customer.id, invoice.id]));
      expect(files.every((f) => f.target === key)).toBe(true);
      // `output` is the files, one after the other, each under a `===== path =====` line.
      for (const file of files) expect(target.output, `${key}: ${file.path} is in output`).toContain(`===== ${file.path} =====`);
      expect(target.output).toContain(files[0].content);
    }
    const jsonSchema = (data.targets.find((t) => t.target === "json-schema") as TargetResult).files as EmittedFile[];
    expect(jsonSchema.map((f) => f.path).sort()).toEqual(["Customer.json", "Invoice.json"]);
    const invoiceFile = jsonSchema.find((f) => f.entityId === invoice.id) as EmittedFile;
    expect(JSON.parse(invoiceFile.content).properties.customer).toBeDefined();
    // The same closure from validate.
    const validated = await expectApiSuccess<ValidateData>(await api.session.post(`${API}/schemas/${invoice.id}/validate`));
    expect(validated.data.resolution.entities.map((e) => e.ref.entity).sort()).toEqual(["Customer", "Invoice"]);
    expect(validated.data.valid).toBe(true);
  });

  test("a bare-name reference that matches two entities is a 422 AMBIGUOUS_REFERENCE naming both, from emit and from validate, and a qualified reference settles it", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const twin = unique("Twin");
    const otherProduct = await createProductInDomain(workspace.domainId);
    const inFirst = await createEntityInProduct(workspace.domainId, workspace.productId, twin);
    const inSecond = await createEntityInProduct(workspace.domainId, otherProduct.id, twin);
    const customer = workspace.entities[0];
    const reference = await createFieldRow(customer.id, { name: "twin", type: "reference", sortOrder: 1, decorators: { referencedEntityName: twin } });

    for (const route of ["emit", "validate"]) {
      const response = await api.session.post(`${API}/schemas/${customer.id}/${route}`);
      const error = await expectApiError(response, 422, "AMBIGUOUS_REFERENCE");
      expect(error.message, route).toContain(`Field "twin" refers to "${twin}", which matches 2 entities`);
      expect(error.message).toContain(`${workspace.domainName} / ${workspace.productName} / ${twin}`);
      expect(error.message).toContain(`${workspace.domainName} / ${otherProduct.name} / ${twin}`);
      expect(error.suggestedFix, route).toMatch(/Pick the entity/);
      expect(keysOf(error.details)).toEqual(["candidates", "entityId", "field", "fieldId", "name"]);
      expect(error.details).toMatchObject({ field: "twin", name: twin, entityId: customer.id, fieldId: reference.id });
      const candidates = (error.details as { candidates: Array<{ entityId: string; domain: string; product: string; entity: string }> }).candidates;
      expect(candidates.map((c) => c.entityId).sort(), route).toEqual([inFirst.id, inSecond.id].sort());
      expect(candidates).toContainEqual({ entityId: inSecond.id, domain: workspace.domainName, product: otherProduct.name, entity: twin });
      expect(candidates).toContainEqual({ entityId: inFirst.id, domain: workspace.domainName, product: workspace.productName, entity: twin });
    }

    // The fix the message suggests: the field names the entity it means (a qualified reference), and the same request now succeeds.
    await setFieldDecorators(reference.id, { referencedEntityId: inSecond.id, referencedEntityName: twin, referencedQualifiedName: `${workspace.domainName}/${otherProduct.name}/${twin}` });
    const { data } = await expectApiSuccess<EmitData>(await api.session.post(`${API}/schemas/${customer.id}/emit`));
    expect(data.resolution.entities.map((e) => e.ref.entityId).sort()).toEqual([customer.id, inSecond.id].sort());
  });

  test("emit and validate for an unknown id are a 404 and for a missing credential a 401", { tag: ["@regression"] }, async ({ api }) => {
    for (const route of ["emit", "validate"]) {
      const error = await expectApiError(await api.session.post(`${API}/schemas/${unique("no-such-")}/${route}`), 404, "NOT_FOUND");
      expect(error.message).toContain("not found");
      await expectApiError(await api.anon.post(`${API}/schemas/${unique("no-such-")}/${route}`), 401, "UNAUTHORIZED");
    }
  });

  test("a request body that is not JSON is ignored by emit (the route reads none), the answer does not depend on it", { tag: ["@regression"] }, async ({ api, workspace }) => {
    const id = workspace.entities[0].id;
    const response = await api.session.post(`${API}/schemas/${id}/validate`, rawBody("{this is not json"));
    expect((await expectApiSuccess<ValidateData>(response)).data.entityId).toBe(id);
  });
});

test.describe("rate limit", () => {
  test("the 101st request of one client address within a minute is a 429 with Retry-After, whatever route it goes to; another address is not limited (KD-028)", { tag: ["@regression"] }, async ({ api }) => {
    // Unauthenticated requests count too: the limit comes before the credential check. The unknown id is a cheap 404/401 for the first 100.
    for (let i = 0; i < 100; i += 1) {
      const response = await api.anon.get(`${API}/event-specs/some-id`);
      expect(response.status(), `request ${i + 1}`).toBe(401);
    }
    const limited = await api.anon.get(`${API}/event-specs/some-id`);
    expect(limited.status()).toBe(429);
    expect(limited.headers()["content-type"]).toMatch(/application\/json/);
    expect(limited.headers()["x-ratelimit-limit"]).toBe("100");
    expect(limited.headers()["x-ratelimit-remaining"]).toBe("0");
    expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers()["retry-after"])).toBeLessThanOrEqual(60);
    expect(Number(limited.headers()["x-ratelimit-reset"])).toBeGreaterThan(Date.now() / 1000 - 5);
    const body = await jsonOf<{ error: string; message: string; retryAfter: number }>(limited);
    // The answer has an envelope of its own (not `{ success: false, error: { code } }`): KD-028.
    expect(body).toMatchObject({ error: "Too Many Requests", retryAfter: Number(limited.headers()["retry-after"]) });
    expect(body.message).toMatch(/Rate limit exceeded\. Try again in \d+ seconds\./);
    // The limit is per address across the routes that have one.
    expect((await api.anon.post(`${API}/schemas/some-id/emit`)).status()).toBe(429);
    expect((await api.anon.post(`${API}/schemas/some-id/validate`)).status()).toBe(429);
    // The routes without a limit are not affected.
    expect((await api.anon.get(`${API}/health`)).status()).toBe(200);
    expect((await api.anon.get(`${API}/schemas`)).status()).toBe(401);
    // The address is the client's own header: another value is another client (a spoofable limit unless a proxy sets the header).
    const another = await api.custom({ "x-forwarded-for": `10.${(Number(api.ip.split(".")[1]) + 1) % 256}.1.1` });
    expect((await another.get(`${API}/event-specs/some-id`)).status()).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------

test.describe("webhooks", () => {
  const created: string[] = [];
  test.afterEach(async () => {
    await deleteWebhookRows(created.splice(0));
  });

  test("CHARACTERIZED (KD-025): a session is a viewer on this API, so the admin's own login is refused by every webhook endpoint", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    const refused: Array<[string, string, unknown?]> = [
      ["GET", `${API}/webhooks`],
      ["POST", `${API}/webhooks`, { url: "https://example.invalid/hook", events: [WEBHOOK_EVENT] }],
      ["PUT", `${API}/webhooks/${row.id}`, { active: false }],
      ["DELETE", `${API}/webhooks/${row.id}`],
      ["GET", `${API}/webhooks/${row.id}/deliveries`],
    ];
    const messages = new Set<string>();
    for (const [method, url, data] of refused) {
      const error = await expectApiError(await api.session.fetch(url, { method, ...(data ? asJson(data) : {}) }), 403, "FORBIDDEN");
      expect(error.message).toMatch(/^Only Admin users can (view|create|update|delete) webhook (endpoints|deliveries)$/);
      messages.add(error.message);
    }
    expect(messages.size).toBe(5);
    // Nothing was changed by the refused calls.
    expect(await webhookRow(row.id)).toMatchObject({ url: row.url, active: true, events: row.events });
  });

  test("[KD-024 POST /api/v1/webhooks cannot create an endpoint: the key's user is no row of users, so the insert fails] a key creates an endpoint", { tag: ["@regression"] }, async ({ api }) => {
    test.fail();
    const url = `https://e2e-hook-${unique("create-")}.example.invalid/hook`;
    const response = await api.key.post(`${API}/webhooks`, asJson({ url, events: [WEBHOOK_EVENT] }));
    const text = await response.text();
    try {
      expect(response.status(), text).toBe(201);
      const body = JSON.parse(text) as { data: Webhook; summary: string };
      created.push(body.data.id);
      expect(body.summary).toBe("Webhook endpoint created");
      expect(body.data).toMatchObject({ url, events: [WEBHOOK_EVENT], active: true });
      expect(body.data.secret).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      const { rows } = await pg().query(`SELECT id FROM webhook_endpoints WHERE url = $1`, [url]);
      await deleteWebhookRows(rows.map((r) => r.id as string));
    }
  });

  test("a body that is not a valid endpoint is a 400 VALIDATION_ERROR that says what is wrong", { tag: ["@regression"] }, async ({ api }) => {
    const valid = { url: "https://example.invalid/hook", events: [WEBHOOK_EVENT] };
    const cases: Array<[string, unknown, RegExp]> = [
      ["no url", { events: [WEBHOOK_EVENT] }, /Invalid input|expected string/i],
      ["a url that is not one", { ...valid, url: "not a url" }, /URL must be a valid URL/],
      ["an empty url", { ...valid, url: "" }, /URL must be a valid URL/],
      ["no events", { url: valid.url }, /Invalid input|expected array/i],
      ["an empty list of events", { ...valid, events: [] }, /At least one event type is required/],
      ["an unknown event", { ...valid, events: ["not.an.event"] }, /Invalid option/],
      ["events as a string", { ...valid, events: WEBHOOK_EVENT }, /Invalid input|expected array/i],
      ["active as a string", { ...valid, active: "yes" }, /Invalid input|expected boolean/i],
      ["an empty object", {}, /Invalid input|expected/i],
      ["an array", [], /Invalid input|expected object/i],
      ["null", null, /Invalid input|expected object/i],
      ["a string", "hello", /Invalid input|expected object/i],
      ["a number", 42, /Invalid input|expected object/i],
    ];
    for (const [what, body, message] of cases) {
      const error = await expectApiError(await api.key.post(`${API}/webhooks`, rawBody(JSON.stringify(body))), 400, "VALIDATION_ERROR");
      expect(error.message, what).toMatch(message);
    }
    // Nothing was created by any of them.
    const list = await expectApiSuccess<Webhook[]>(await api.key.get(`${API}/webhooks`));
    expect(list.data.filter((w) => w.url === "not a url" || w.url === "")).toEqual([]);
  });

  test("a body that is not JSON is a 400 VALIDATION_ERROR, not a 500, for a create and for an update", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    for (const text of ["{not json", "", "{\"url\": ", "undefined", "<xml/>", "{'single': 'quotes'}"]) {
      const create = await expectApiError(await api.key.post(`${API}/webhooks`, rawBody(text)), 400, "VALIDATION_ERROR");
      expect(create.message, JSON.stringify(text)).toMatch(/JSON/);
      const update = await expectApiError(await api.key.put(`${API}/webhooks/${row.id}`, rawBody(text)), 400, "VALIDATION_ERROR");
      expect(update.message, JSON.stringify(text)).toMatch(/JSON/);
    }
    expect(await webhookRow(row.id)).toMatchObject({ url: row.url, active: true });
  });

  test("a body of several megabytes is refused as invalid, not as a server error, and the server answers afterwards; without a credential it is 401 at once", { tag: ["@regression"] }, async ({ api }) => {
    const filler = "x".repeat(5 * 1024 * 1024);
    const big = { url: "https://example.invalid/hook", events: ["not.an.event"], filler };
    await expectApiError(await api.key.post(`${API}/webhooks`, asJson(big)), 400, "VALIDATION_ERROR");
    await expectApiError(await api.anon.post(`${API}/webhooks`, asJson(big)), 401, "UNAUTHORIZED");
    expect((await api.anon.get(`${API}/health`)).status()).toBe(200);
  });

  test("the list holds the endpoints with their fields, and a key sees every endpoint (they belong to no tenant and no user)", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow({ events: [WEBHOOK_EVENT, "drift.detected"] });
    created.push(row.id);
    const body = await expectApiSuccess<Webhook[]>(await api.key.get(`${API}/webhooks`));
    const listed = body.data.find((w) => w.id === row.id) as Webhook;
    expect(listed).toBeDefined();
    // CHARACTERIZED (KD-027): the list carries each endpoint's signing secret, every time it is listed.
    expect(keysOf(listed)).toEqual(["active", "createdAt", "createdBy", "events", "id", "secret", "updatedAt", "url"]);
    expect(listed).toMatchObject({ url: row.url, events: [WEBHOOK_EVENT, "drift.detected"], active: true, secret: row.secret });
    expect(listed.createdBy).toBe((await webhookRow(row.id))?.createdBy);
    expect(Number.isNaN(Date.parse(listed.createdAt))).toBe(false);
  });

  test("an update changes the url, the events and the flag, and nothing else: not the secret, not the creator, whatever the body says", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    const before = await webhookRow(row.id);
    const url = `https://e2e-hook-${unique("moved-")}.example.invalid/other`;
    const body = await expectApiSuccess<Webhook>(
      await api.key.put(`${API}/webhooks/${row.id}`, asJson({ url, events: ["drift.detected", "compliance.gap.detected"], active: false, secret: "chosen-by-the-caller", createdBy: "someone-else", id: "another-id" })),
    );
    expect(body.data).toMatchObject({ id: row.id, url, events: ["drift.detected", "compliance.gap.detected"], active: false, secret: row.secret, createdBy: before?.createdBy });
    expect(await webhookRow(row.id)).toMatchObject({ url, events: ["drift.detected", "compliance.gap.detected"], active: false, secret: row.secret, createdBy: before?.createdBy });
    // One field alone, and an empty body, leave the rest as it is.
    expect((await expectApiSuccess<Webhook>(await api.key.put(`${API}/webhooks/${row.id}`, asJson({ active: true })))).data).toMatchObject({ url, active: true });
    expect((await expectApiSuccess<Webhook>(await api.key.put(`${API}/webhooks/${row.id}`, asJson({})))).data).toMatchObject({ url, active: true });
    // The id in the body did not move the row.
    expect((await webhookRow("another-id"))).toBeUndefined();
  });

  test("an update with a bad value is a 400 and changes nothing; an unknown id is a 404", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    for (const [what, body, message] of [
      ["a url that is not one", { url: "nope" }, /URL must be a valid URL/],
      ["an empty list", { events: [] }, /too small|at least|Too small/i],
      ["an unknown event", { events: ["x.y"] }, /Invalid option/],
      ["a string flag", { active: "false" }, /Invalid input|expected boolean/i],
    ] as Array<[string, unknown, RegExp]>) {
      const error = await expectApiError(await api.key.put(`${API}/webhooks/${row.id}`, asJson(body)), 400, "VALIDATION_ERROR");
      expect(error.message, what).toMatch(message);
    }
    expect(await webhookRow(row.id)).toMatchObject({ url: row.url, active: true, events: row.events });
    const missing = await expectApiError(await api.key.put(`${API}/webhooks/${unique("no-such-")}`, asJson({ active: false })), 404, "NOT_FOUND");
    expect(missing.message).toMatch(/Webhook endpoint ".+" not found/);
  });

  test("a delete removes the endpoint and its deliveries; the same delete again is a 404", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    await createWebhookDeliveryRows(row.id, 2);
    expect(await webhookRowState(row.id)).toEqual({ endpoint: true, deliveries: 2 });
    const body = await expectApiSuccess<{ deleted: boolean }>(await api.key.delete(`${API}/webhooks/${row.id}`));
    expect(body.data).toEqual({ deleted: true });
    expect(await webhookRowState(row.id)).toEqual({ endpoint: false, deliveries: 0 });
    const list = await expectApiSuccess<Webhook[]>(await api.key.get(`${API}/webhooks`));
    expect(list.data.map((w) => w.id)).not.toContain(row.id);
    await expectApiError(await api.key.delete(`${API}/webhooks/${row.id}`), 404, "NOT_FOUND");
  });

  test("the deliveries of an endpoint are listed newest first with their outcome; an endpoint with none has an empty list; an unknown endpoint is a 404", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    const empty = await createWebhookRow();
    created.push(row.id, empty.id);
    const seeded = await createWebhookDeliveryRows(row.id, 3);
    const body = await expectApiSuccess<Delivery[]>(await api.key.get(`${API}/webhooks/${row.id}/deliveries`));
    // createWebhookDeliveryRows makes each one older than the one before: the API lists the first one first.
    expect(body.data.map((d) => d.id)).toEqual(seeded.map((d) => d.id));
    for (const delivery of body.data) {
      expect(keysOf(delivery)).toEqual(["attempt", "deliveredAt", "endpointId", "error", "event", "id", "nextRetryAt", "payload", "statusCode"]);
      expect(delivery.endpointId).toBe(row.id);
      expect(delivery.event).toBe(WEBHOOK_EVENT);
    }
    expect(body.data.map((d) => d.statusCode)).toEqual([200, 500, 200]);
    expect(body.data[1]).toMatchObject({ error: "HTTP 500: Internal Server Error", attempt: 2 });
    expect(body.data[0]).toMatchObject({ error: null, attempt: 1, nextRetryAt: null });
    expect(body.data[0].payload).toMatchObject({ event: WEBHOOK_EVENT, data: { n: 0 } });
    const times = body.data.map((d) => Date.parse(d.deliveredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Another endpoint's deliveries are not in it.
    expect(await expectApiSuccess<Delivery[]>(await api.key.get(`${API}/webhooks/${empty.id}/deliveries`))).toMatchObject({ data: [] });
    await expectApiError(await api.key.get(`${API}/webhooks/${unique("no-such-")}/deliveries`), 404, "NOT_FOUND");
  });

  test("the webhook routes answer 405 to the methods they do not have", { tag: ["@regression"] }, async ({ api }) => {
    const row = await createWebhookRow();
    created.push(row.id);
    for (const [method, url] of [
      ["PUT", `${API}/webhooks`], ["DELETE", `${API}/webhooks`], ["PATCH", `${API}/webhooks`],
      ["GET", `${API}/webhooks/${row.id}`], ["POST", `${API}/webhooks/${row.id}`], ["PATCH", `${API}/webhooks/${row.id}`],
      ["POST", `${API}/webhooks/${row.id}/deliveries`], ["PUT", `${API}/webhooks/${row.id}/deliveries`], ["DELETE", `${API}/webhooks/${row.id}/deliveries`],
    ] as const) {
      expect((await api.key.fetch(url, { method })).status(), `${method} ${url}`).toBe(405);
    }
    expect(await webhookRow(row.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

test.describe("notifications", () => {
  /** A signed-in user with three notifications (newest first: a change, a drift alert, an approval request; the last one read) and a stranger with one. */
  async function withMailbox(
    playwright: PlaywrightWorkerArgs["playwright"],
    baseURL: string | undefined,
    body: (mailbox: { request: APIRequestContext; userId: string; titles: string[]; otherUserId: string; otherTitle: string; ids: string[] }) => Promise<void>,
  ) {
    const password = "Str0ng!Passw0rd";
    const user = await createUserWithPassword({ email: `${unique("e2e-notif-")}@example.com`.toLowerCase(), password });
    const stranger = await createUserRow({ email: `${unique("e2e-stranger-")}@example.com`.toLowerCase() });
    let request: APIRequestContext | undefined;
    try {
      request = await signInCaller(playwright, baseURL, { email: user.email, password });
      const tag = unique("N");
      const titles = [`${tag} change`, `${tag} drift`, `${tag} approval`];
      const ids = await createNotifications(user.id, [
        { title: titles[0], type: "CHANGE_COMPLETE", minutesAgo: 1, entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "sales", productSlug: "crm" } },
        { title: titles[1], type: "DRIFT_ALERT", minutesAgo: 2 },
        { title: titles[2], type: "APPROVAL_REQUEST", minutesAgo: 3, read: true },
      ]);
      const otherTitle = `${tag} not yours`;
      await createNotifications(stranger.id, [{ title: otherTitle, type: "CHANGE_COMPLETE" }]);
      await body({ request, userId: user.id, titles, otherUserId: stranger.id, otherTitle, ids });
    } finally {
      await request?.dispose();
      await deleteUsersByEmail([user.email, stranger.email]);
    }
  }

  test("the list is the signed-in user's own, newest first, with the unread count and each one's entity reference", { tag: ["@regression"] }, async ({ playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request, userId, titles, otherTitle }) => {
      const body = await expectApiSuccess<NotificationList>(await request.get(`${API}/notifications`));
      expect(keysOf(body.data)).toEqual(["notifications", "unreadCount"]);
      expect(body.data.notifications.map((n) => n.title)).toEqual(titles);
      expect(body.data.unreadCount).toBe(2);
      for (const item of body.data.notifications) {
        expect(keysOf(item)).toEqual(["body", "createdAt", "entityRef", "id", "read", "title", "type", "userId"]);
        expect(item.userId).toBe(userId);
      }
      expect(body.data.notifications.map((n) => [n.type, n.read])).toEqual([["CHANGE_COMPLETE", false], ["DRIFT_ALERT", false], ["APPROVAL_REQUEST", true]]);
      expect(body.data.notifications[0].entityRef).toMatchObject({ entityId: "entity-1", entitySlug: "customer", domainSlug: "sales", productSlug: "crm" });
      expect(JSON.stringify(body)).not.toContain(otherTitle);
    });
  });

  test("filters by read state and type, and pages: page and pageSize cut the same ordered list", { tag: ["@regression"] }, async ({ playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request, titles }) => {
      const titlesOf = async (query: string) => (await expectApiSuccess<NotificationList>(await request.get(`${API}/notifications?${query}`))).data.notifications.map((n) => n.title);
      expect(await titlesOf("read=false")).toEqual([titles[0], titles[1]]);
      expect(await titlesOf("read=true")).toEqual([titles[2]]);
      expect(await titlesOf("types=DRIFT_ALERT")).toEqual([titles[1]]);
      expect(await titlesOf("types=DRIFT_ALERT,APPROVAL_REQUEST")).toEqual([titles[1], titles[2]]);
      expect(await titlesOf("types=COMPLIANCE_GAP")).toEqual([]);
      expect(await titlesOf("types=DRIFT_ALERT&read=true")).toEqual([]);
      expect(await titlesOf("pageSize=2")).toEqual([titles[0], titles[1]]);
      expect(await titlesOf("pageSize=2&page=2")).toEqual([titles[2]]);
      expect(await titlesOf("pageSize=2&page=3")).toEqual([]);
      expect(await titlesOf("pageSize=1&page=3")).toEqual([titles[2]]);
      // The unread count is the user's, not the page's or the filter's.
      const filtered = await expectApiSuccess<NotificationList>(await request.get(`${API}/notifications?read=true`));
      expect(filtered.data.unreadCount).toBe(2);
    });
  });

  test("a page, page size or type that cannot be is a 400 VALIDATION_ERROR", { tag: ["@regression"] }, async ({ api }) => {
    for (const query of ["page=0", "page=-1", "page=abc", "pageSize=0", "pageSize=101", "pageSize=abc", "types=NOT_A_TYPE", "types=DRIFT_ALERT,NOPE", "types="]) {
      const response = await api.session.get(`${API}/notifications?${query}`);
      // `types=` (empty) is "no filter": the only one of these that is accepted.
      if (query === "types=") expect(response.status(), query).toBe(200);
      else await expectApiError(response, 400, "VALIDATION_ERROR");
    }
  });

  test("`countOnly` answers just the unread count, and for a caller without a credential 0 instead of a 401 (the polling of the bell)", { tag: ["@regression"] }, async ({ api, playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request }) => {
      const body = await expectApiSuccess<{ unreadCount: number }>(await request.get(`${API}/notifications?countOnly=true`));
      expect(body.data).toEqual({ unreadCount: 2 });
    });
    expect(await expectApiSuccess(await api.anon.get(`${API}/notifications?countOnly=true`))).toMatchObject({ data: { unreadCount: 0 } });
    // The list itself needs a credential.
    await expectApiError(await api.anon.get(`${API}/notifications`), 401, "UNAUTHORIZED");
    // The key has no mailbox of its own: it is nobody in `users`.
    expect(await expectApiSuccess<NotificationList>(await api.key.get(`${API}/notifications`))).toMatchObject({ data: { notifications: [], unreadCount: 0 } });
  });

  test("mark-read marks one of the user's own notifications, and says so again when asked twice", { tag: ["@regression"] }, async ({ playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request, userId, titles, ids }) => {
      const first = await request.post(`${API}/notifications?action=mark-read&id=${ids[0]}`);
      expect(await expectApiSuccess(first)).toMatchObject({ data: { marked: true } });
      expect(await notificationReadFlags(userId)).toEqual({ [titles[0]]: true, [titles[1]]: false, [titles[2]]: true });
      expect((await expectApiSuccess(await request.post(`${API}/notifications?action=mark-read&id=${ids[0]}`))).data).toEqual({ marked: true });
      const after = await expectApiSuccess<NotificationList>(await request.get(`${API}/notifications`));
      expect(after.data.unreadCount).toBe(1);
    });
  });

  test("mark-all-read marks the user's own notifications and none of anybody else's", { tag: ["@regression"] }, async ({ playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request, userId, titles, otherUserId, otherTitle }) => {
      expect((await expectApiSuccess(await request.post(`${API}/notifications?action=mark-all-read`))).data).toEqual({ marked: true });
      expect(await notificationReadFlags(userId)).toEqual({ [titles[0]]: true, [titles[1]]: true, [titles[2]]: true });
      expect(await notificationReadFlags(otherUserId)).toEqual({ [otherTitle]: false });
      expect((await expectApiSuccess<{ unreadCount: number }>(await request.get(`${API}/notifications?countOnly=true`))).data.unreadCount).toBe(0);
    });
  });

  test("mark-read needs an id, an existing one, one of the caller's own; an unknown action is a 400", { tag: ["@regression"] }, async ({ playwright, baseURL }) => {
    await withMailbox(playwright, baseURL, async ({ request, otherUserId, otherTitle, titles, userId }) => {
      const missing = await expectApiError(await request.post(`${API}/notifications?action=mark-read`), 400, "VALIDATION_ERROR");
      expect(missing.message).toBe("Notification id is required");
      await expectApiError(await request.post(`${API}/notifications?action=mark-read&id=${unique("no-such-")}`), 404, "NOT_FOUND");
      // Somebody else's notification: refused, and not changed.
      const { rows } = await pg().query(`SELECT id FROM notifications WHERE "userId" = $1`, [otherUserId]);
      const foreign = await expectApiError(await request.post(`${API}/notifications?action=mark-read&id=${rows[0].id as string}`), 403, "FORBIDDEN");
      expect(foreign.message).toBe("You can only mark your own notifications as read");
      expect(await notificationReadFlags(otherUserId)).toEqual({ [otherTitle]: false });
      for (const query of ["action=nonsense", "", "action=", "action=MARK-READ", "action=delete-all"]) {
        const error = await expectApiError(await request.post(`${API}/notifications?${query}`), 400, "VALIDATION_ERROR");
        expect(error.message, query).toMatch(/action/i);
      }
      // None of it marked anything of the user's.
      expect(await notificationReadFlags(userId)).toEqual({ [titles[0]]: false, [titles[1]]: false, [titles[2]]: true });
    });
  });

  test("the notification routes answer 405 to the methods they do not have", { tag: ["@regression"] }, async ({ api }) => {
    for (const method of ["PUT", "DELETE", "PATCH"] as const) expect((await api.session.fetch(`${API}/notifications`, { method })).status(), method).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// event specs
// ---------------------------------------------------------------------------

test.describe("event specs", () => {
  test("an unknown id and the id of an event of another tenant get the same 404, byte for byte", { tag: ["@regression"] }, async ({ api }) => {
    let foreign: ForeignTenantSpec | undefined;
    try {
      foreign = await createForeignTenantSpec();
      const unknown = await api.session.get(`${API}/event-specs/${unique("no-such-")}`);
      const another = await api.session.get(`${API}/event-specs/${foreign.specId}?version=draft`);
      const error = await expectApiError(unknown, 404, "NOT_FOUND");
      expect(error.message).toBe("Event spec not found");
      expect(error.suggestedFix).toBe("Check the event spec id.");
      expect(another.status()).toBe(404);
      expect(await another.text()).toBe(await unknown.text());
      // The key is in the default tenant too.
      expect((await api.key.get(`${API}/event-specs/${foreign.specId}`)).status()).toBe(404);
    } finally {
      await deleteForeignTenantSpec(foreign);
    }
  });

  test("a format or version that cannot be is a 400 with a suggested fix, checked before the event is looked up", { tag: ["@regression"] }, async ({ api }) => {
    const id = unique("no-such-");
    for (const query of ["format=xml", "format=YAML", "format=", "version=abc", "version=1", "version=1.", "version=1.0.0", "version=-1.0", "version=DRAFT", "version=1.0;DROP"]) {
      const error = await expectApiError(await api.session.get(`${API}/event-specs/${id}?${query}`), 400, "VALIDATION_ERROR");
      expect(error.suggestedFix, query).toMatch(/\?(format|version)=/);
    }
  });

  test.describe("an event in a product of the tenant", () => {
    test("with no published version the latest is a 404 that says to ask for the draft; a version that cannot exist is a 404 too", { tag: ["@regression"] }, async ({ api, workspace }) => {
      const event = await createEventSpecInProduct(workspace.domainId, workspace.productId);
      const latest = await expectApiError(await api.session.get(`${API}/event-specs/${event.id}`), 404, "NOT_FOUND");
      expect(latest.message).toBe("The event spec has no published version");
      expect(latest.suggestedFix).toMatch(/version=draft/);
      for (const version of ["1.0", "2.7", "0.1", "01.00", "2147483647.0", "99999999999.0", "1.99999999999"]) {
        const error = await expectApiError(await api.session.get(`${API}/event-specs/${event.id}?version=${version}`), 404, "NOT_FOUND");
        expect(error.message, version).toBe("That version of the event spec was not found");
      }
    });

    test("a stored draft that is not a document (a corrupt row) is a generic 500 that says nothing of what is wrong with it", { tag: ["@regression"] }, async ({ api, workspace }) => {
      // The row an event spec has when it is made through the app is a valid document; this one holds `{}`, which the emission refuses as
      // corrupt data. That is the server's problem, not the caller's (500), and the answer must not carry the stored text or the problems.
      const event = await createEventSpecInProduct(workspace.domainId, workspace.productId);
      for (const format of ["yaml", "json"]) {
        const response = await api.session.get(`${API}/event-specs/${event.id}?version=draft&format=${format}`);
        const error = await expectApiError(response, 500, "INTERNAL_ERROR");
        expect(error.message).toBe("Internal server error");
        expect(error.details).toBeUndefined();
        expect(await response.text()).not.toContain(event.name);
      }
    });
  });

  test("the event-spec route answers 405 to the methods it does not have", { tag: ["@regression"] }, async ({ api }) => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) expect((await api.session.fetch(`${API}/event-specs/some-id`, { method })).status(), method).toBe(405);
  });
});
