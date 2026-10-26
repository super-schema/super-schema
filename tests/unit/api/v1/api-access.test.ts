// @vitest-environment node
/**
 * Who may call what on /api/v1, through the REAL guard, principal loader and services (only the session, the database and the emission are
 * stand-ins): a roleless user, a viewer, an author, a domain-scoped role, a platform administrator, and the API key as a service principal.
 * What is pinned: the 401 / 403 / 404 answers and their shapes, that a session carries its real roles (it used to be a viewer always), that the key
 * acts in ITS tenant with ITS role, that another tenant's entity is the very 404 of a missing one, and that no list carries a signing secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    entity: { findMany: vi.fn(), findUnique: vi.fn() },
    field: { findMany: vi.fn() },
    webhookEndpoint: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhookDelivery: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: h.activeTenant }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: () => null }));

import { GET as listSchemas } from "@/app/api/v1/schemas/route";
import { GET as getSchema } from "@/app/api/v1/schemas/[id]/route";
import { POST as emitSchema } from "@/app/api/v1/schemas/[id]/emit/route";
import { POST as validateSchema } from "@/app/api/v1/schemas/[id]/validate/route";
import { GET as listWebhooks, POST as createWebhook } from "@/app/api/v1/webhooks/route";
import { PUT as updateWebhook, DELETE as deleteWebhook } from "@/app/api/v1/webhooks/[id]/route";
import { GET as webhookDeliveries } from "@/app/api/v1/webhooks/[id]/deliveries/route";

const SAVED = { ...process.env };
const KEY = "the-key-of-the-run";

const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost/api/v1${path}`, init);
const asKey = { headers: { authorization: `Bearer ${KEY}` } };
const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (response: Response) => JSON.parse(await response.text());

/** Sign in as a user who holds `assignments` (the real principal loader reads this row). */
function signIn(assignments: Assignment[]) {
  h.auth.mockResolvedValue(sessionOf("user-1"));
  h.prisma.user.findUnique.mockResolvedValue(userRow(assignments, { id: "user-1" }));
}

const ENTITY = { id: "e1", tenantId: "t1", domainId: "d1", productId: "p1", name: "Customer", description: "", status: "DRAFT", version: 1, domain: { id: "d1" }, fields: [], product: { domainId: "d1" }, createdAt: new Date(), updatedAt: new Date() };
const ENDPOINT = { id: "w1", url: "https://example.invalid/h", events: ["emission.completed"], secret: "f".repeat(64), active: true, createdBy: "u9", createdAt: new Date(), updatedAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_KEY;
  delete process.env.API_KEY_ROLE;
  delete process.env.API_KEY_TENANT_ID;
  h.activeTenant.mockResolvedValue("t1");
  h.prisma.entity.findMany.mockResolvedValue([ENTITY]);
  h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === ENTITY.id ? ENTITY : null));
  h.prisma.webhookEndpoint.findMany.mockResolvedValue([ENDPOINT]);
  h.prisma.webhookEndpoint.findUnique.mockResolvedValue(ENDPOINT);
  h.prisma.webhookEndpoint.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ENDPOINT, ...data, id: "w2" }));
  h.prisma.webhookEndpoint.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...ENDPOINT, ...data }));
  h.prisma.webhookEndpoint.delete.mockResolvedValue(ENDPOINT);
  h.prisma.webhookDelivery.findMany.mockResolvedValue([]);
  h.prisma.field.findMany.mockResolvedValue([]);
});
afterEach(() => {
  process.env = { ...SAVED };
});

const nothingWasRead = () => {
  expect(h.prisma.entity.findMany).not.toHaveBeenCalled();
  expect(h.prisma.entity.findUnique).not.toHaveBeenCalled();
  expect(h.prisma.field.findMany).not.toHaveBeenCalled();
};
const noWebhookTouched = () => {
  for (const fn of Object.values(h.prisma.webhookEndpoint)) expect(fn).not.toHaveBeenCalled();
  expect(h.prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
};

const SCHEMA_CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET /schemas", () => listSchemas(req("/schemas"), noParams)],
  ["GET /schemas/:id", () => getSchema(req("/schemas/e1"), withId("e1"))],
  ["POST /schemas/:id/emit", () => emitSchema(req("/schemas/e1/emit", { method: "POST" }), withId("e1"))],
  ["POST /schemas/:id/validate", () => validateSchema(req("/schemas/e1/validate", { method: "POST" }), withId("e1"))],
];
const WEBHOOK_CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET /webhooks", () => listWebhooks(req("/webhooks"), noParams)],
  ["POST /webhooks", () => createWebhook(req("/webhooks", json({ url: "https://example.invalid/h", events: ["emission.completed"] })), noParams)],
  ["PUT /webhooks/:id", () => updateWebhook(req("/webhooks/w1", json({ active: false }, "PUT")), withId("w1"))],
  ["DELETE /webhooks/:id", () => deleteWebhook(req("/webhooks/w1", { method: "DELETE" }), withId("w1"))],
  ["GET /webhooks/:id/deliveries", () => webhookDeliveries(req("/webhooks/w1/deliveries"), withId("w1"))],
];

describe("nobody: every route is a 401 in the API's envelope, and nothing is read", () => {
  it.each([...SCHEMA_CALLS, ...WEBHOOK_CALLS])("%s", async (_name, call) => {
    h.auth.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    nothingWasRead();
    noWebhookTouched();
  });

  it("a disabled user is nobody: 401", async () => {
    h.auth.mockResolvedValue(sessionOf("user-1"));
    h.prisma.user.findUnique.mockResolvedValue(userRow([assign.global()], { id: "user-1", disabledAt: new Date() }));
    expect((await listSchemas(req("/schemas"), noParams)).status).toBe(401);
    expect((await listWebhooks(req("/webhooks"), noParams)).status).toBe(401);
  });
});

describe("a signed-in user with no role: never a 500, nothing of any tenant", () => {
  beforeEach(() => signIn([]));

  it.each(SCHEMA_CALLS)("%s is a 404 and reads nothing", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    nothingWasRead();
  });

  it("has no tenant at all (the principal may reach none): the same 404, not a 500", async () => {
    const { NoTenantAccess } = await import("@/lib/access/no-tenant-access");
    h.activeTenant.mockRejectedValue(new NoTenantAccess());
    for (const [, call] of SCHEMA_CALLS) expect((await call()).status).toBe(404);
    nothingWasRead();
  });

  it.each(WEBHOOK_CALLS)("%s is a 403 and touches no endpoint", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error.code).toBe("FORBIDDEN");
    noWebhookTouched();
  });
});

describe("a session carries its REAL roles (it used to be a viewer, always)", () => {
  it("a viewer of the tenant lists and reads the schemas, in that tenant only", async () => {
    signIn([assign.tenant("VIEWER", "t1")]);
    const list = await listSchemas(req("/schemas"), noParams);
    expect(list.status).toBe(200);
    expect((await bodyOf(list)).data).toHaveLength(1);
    expect(h.prisma.entity.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect((await getSchema(req("/schemas/e1"), withId("e1"))).status).toBe(200);
  });

  it("a viewer is refused every webhook route (a platform item): 403 in the envelope, naming no role", async () => {
    signIn([assign.tenant("VIEWER", "t1")]);
    for (const [name, call] of WEBHOOK_CALLS) {
      const response = await call();
      const text = await response.text();
      expect(response.status, name).toBe(403);
      expect(JSON.parse(text).error).toEqual({ code: "FORBIDDEN", message: "You do not have permission to do this" });
      expect(text).not.toMatch(/ADMIN|Admin|VIEWER|platform/);
    }
    noWebhookTouched();
  });

  it("an author (a tenant role, not a platform one) is refused the webhooks too, and a TENANT administrator as well: webhooks are the platform's", async () => {
    for (const assignments of [[assign.tenant("AUTHOR", "t1")], [assign.tenant("ADMIN", "t1")]]) {
      signIn(assignments);
      for (const [name, call] of WEBHOOK_CALLS) expect((await call()).status, name).toBe(403);
    }
    noWebhookTouched();
  });

  it("a platform administrator's session may use the webhooks: the admin's own login works (KD-025)", async () => {
    signIn([assign.global()]);
    const list = await listWebhooks(req("/webhooks"), noParams);
    expect(list.status).toBe(200);
    expect((await bodyOf(list)).data).toHaveLength(1);
    const created = await createWebhook(req("/webhooks", json({ url: "https://example.invalid/h", events: ["emission.completed"] })), noParams);
    expect(created.status).toBe(201);
    expect(h.prisma.webhookEndpoint.create.mock.calls[0][0].data.createdBy).toBe("user-1");
    expect((await updateWebhook(req("/webhooks/w1", json({ active: false }, "PUT")), withId("w1"))).status).toBe(200);
    expect((await deleteWebhook(req("/webhooks/w1", { method: "DELETE" }), withId("w1"))).status).toBe(200);
    expect((await webhookDeliveries(req("/webhooks/w1/deliveries"), withId("w1"))).status).toBe(200);
  });

  it("a domain-scoped viewer lists only the entities under its domain, in the query", async () => {
    signIn([assign.domain("VIEWER", "t1", "d1")]);
    expect((await listSchemas(req("/schemas"), noParams)).status).toBe(200);
    expect(h.prisma.entity.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", OR: [{ domainId: { in: ["d1"] } }, { productId: { in: [] } }] });
  });

  it("a role in ANOTHER tenant than the one in view is no role here: 404, nothing read", async () => {
    signIn([assign.tenant("ADMIN", "t2")]);
    for (const [, call] of SCHEMA_CALLS) expect((await call()).status).toBe(404);
    nothingWasRead();
  });
});

describe("another tenant's entity (or one no role covers) is the very 404 of a missing one", () => {
  const foreign = { ...ENTITY, id: "e-foreign", tenantId: "t2", domainId: "d9", product: { domainId: "d9" } };
  const sibling = { ...ENTITY, id: "e-sibling", domainId: "d2", product: { domainId: "d2" } };
  beforeEach(() => {
    h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => [ENTITY, foreign, sibling].find((e) => e.id === where.id) ?? null);
  });

  it("detail, emit and validate: a foreign id and a missing id answer the same bytes, and the fields are never read", async () => {
    signIn([assign.tenant("ADMIN", "t1"), assign.tenant("ADMIN", "t2")]); // roles in both; t1 is in view
    for (const [make] of [
      [(id: string) => getSchema(req(`/schemas/${id}`), withId(id))],
      [(id: string) => emitSchema(req(`/schemas/${id}/emit`, { method: "POST" }), withId(id))],
      [(id: string) => validateSchema(req(`/schemas/${id}/validate`, { method: "POST" }), withId(id))],
    ] as const) {
      const other = await make("e-foreign");
      const missing = await make("e-foreign".replace("foreign", "nowhere"));
      expect(other.status).toBe(404);
      expect(missing.status).toBe(404);
      const a = await bodyOf(other);
      const b = await bodyOf(missing);
      expect(a.error.code).toBe(b.error.code);
      expect(a.error.suggestedFix).toBe(b.error.suggestedFix);
      expect(a.error.message.replace("e-foreign", "ID")).toBe(b.error.message.replace("e-nowhere", "ID"));
    }
    expect(h.prisma.field.findMany).not.toHaveBeenCalled();
  });

  it("a domain-scoped caller gets the 404 for an entity of a sibling domain on every route", async () => {
    signIn([assign.domain("AUTHOR", "t1", "d1")]);
    expect((await getSchema(req("/schemas/e-sibling"), withId("e-sibling"))).status).toBe(404);
    expect((await emitSchema(req("/schemas/e-sibling/emit", { method: "POST" }), withId("e-sibling"))).status).toBe(404);
    expect((await validateSchema(req("/schemas/e-sibling/validate", { method: "POST" }), withId("e-sibling"))).status).toBe(404);
    expect((await getSchema(req("/schemas/e1"), withId("e1"))).status).toBe(200);
    expect(h.prisma.field.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: { entityId: "e-sibling" } }));
  });
});

describe("the API key is a service principal bound to a tenant and a role", () => {
  beforeEach(() => {
    process.env.API_KEY = KEY;
  });

  it("by default an administrator acting in the default tenant: no session, and the entity query is that tenant's", async () => {
    const list = await listSchemas(req("/schemas", asKey), noParams);
    expect(list.status).toBe(200);
    expect(h.prisma.entity.findMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant_default" });
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.activeTenant).not.toHaveBeenCalled();
  });

  it("an entity of another tenant than the key's is a 404, even for an administrator key", async () => {
    h.prisma.entity.findUnique.mockResolvedValue({ ...ENTITY, tenantId: "t2" });
    expect((await getSchema(req("/schemas/e1", asKey), withId("e1"))).status).toBe(404);
  });

  it("API_KEY_TENANT_ID moves it to another tenant", async () => {
    process.env.API_KEY_TENANT_ID = "t7";
    await listSchemas(req("/schemas", asKey), noParams);
    expect(h.prisma.entity.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t7" });
    h.prisma.entity.findUnique.mockResolvedValue({ ...ENTITY, tenantId: "t7" });
    expect((await getSchema(req("/schemas/e1", asKey), withId("e1"))).status).toBe(200);
  });

  it("an administrator key may use the webhooks, and an endpoint it creates has no creator row (KD-024): the secret is in the answer once", async () => {
    const created = await createWebhook(req("/webhooks", { ...json({ url: "https://example.invalid/h", events: ["emission.completed"] }), headers: { ...asKey.headers, "content-type": "application/json" } }), noParams);
    expect(created.status).toBe(201);
    expect(h.prisma.webhookEndpoint.create.mock.calls[0][0].data.createdBy).toBeNull();
    expect((await bodyOf(created)).data.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the list and an update never carry a secret (KD-027)", async () => {
    const list = await bodyOf(await listWebhooks(req("/webhooks", asKey), noParams));
    expect(list.data[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(list)).not.toContain(ENDPOINT.secret);
    const updated = await bodyOf(await updateWebhook(req("/webhooks/w1", { method: "PUT", headers: { ...asKey.headers, "content-type": "application/json" }, body: JSON.stringify({ active: false }) }), withId("w1")));
    expect(updated.data).not.toHaveProperty("secret");
    expect(JSON.stringify(updated)).not.toContain(ENDPOINT.secret);
  });

  it("a key given a lower role reads schemas but may not use the webhooks, and may not write", async () => {
    process.env.API_KEY_ROLE = "VIEWER";
    expect((await listSchemas(req("/schemas", asKey), noParams)).status).toBe(200);
    const keyJson = (method: string, body: unknown) => ({ method, headers: { ...asKey.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const answers = await Promise.all([
      listWebhooks(req("/webhooks", asKey), noParams),
      createWebhook(req("/webhooks", keyJson("POST", { url: "https://example.invalid/h", events: ["emission.completed"] })), noParams),
      updateWebhook(req("/webhooks/w1", keyJson("PUT", { active: false })), withId("w1")),
      deleteWebhook(req("/webhooks/w1", { method: "DELETE", ...asKey }), withId("w1")),
      webhookDeliveries(req("/webhooks/w1/deliveries", asKey), withId("w1")),
    ]);
    expect(answers.map((a) => a.status)).toEqual([403, 403, 403, 403, 403]);
    noWebhookTouched();
  });

  it("an API_KEY_ROLE that is not a role turns the key off: 401, never an administrator", async () => {
    process.env.API_KEY_ROLE = "SUPERUSER";
    expect((await listWebhooks(req("/webhooks", asKey), noParams)).status).toBe(401);
    expect((await listSchemas(req("/schemas", asKey), noParams)).status).toBe(401);
    noWebhookTouched();
  });

  it("a wrong key is 401 even next to a valid administrator session", async () => {
    signIn([assign.global()]);
    const wrong = { headers: { authorization: "Bearer not-the-key" } };
    expect((await listSchemas(req("/schemas", wrong), noParams)).status).toBe(401);
    expect((await listWebhooks(req("/webhooks", wrong), noParams)).status).toBe(401);
  });
});
