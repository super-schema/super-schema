// @vitest-environment node
/**
 * KD-045 on /api/v1: `POST /schemas/:id/emit` and `/validate` emit the entity together with everything it references, and only what the caller's
 * roles cover. Through the REAL guard, principal loader, entity service and reference closure (the session, the database and the emitters are
 * stand-ins): a domain-scoped AUTHOR whose entity references an entity of another domain is refused with 403 REFERENCE_NOT_READABLE and a message that
 * names nothing of the other entity, before any row of it is read or any file built; the same domain, a tenant administrator, a tenant-wide viewer,
 * a platform administrator and the default API key are unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  emitClosure: vi.fn(),
  emitStandalone: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    entity: { findMany: vi.fn(), findUnique: vi.fn() },
    field: { findMany: vi.fn() },
    entityVersion: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: h.activeTenant }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkPrincipalRateLimit: () => null, checkFailedAuthRateLimit: () => null }));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: h.emitStandalone,
}));

import { POST as emitSchema } from "@/app/api/v1/schemas/[id]/emit/route";
import { POST as validateSchema } from "@/app/api/v1/schemas/[id]/validate/route";

const SAVED = { ...process.env };
const KEY = "the-key-of-the-run";
const T = "t1";

const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, init: RequestInit = {}) => new Request(`http://localhost/api/v1${path}`, { method: "POST", ...init });
const bodyOf = async (response: Response) => JSON.parse(await response.text());

function signIn(assignments: Assignment[]) {
  h.auth.mockResolvedValue(sessionOf("user-1"));
  h.prisma.user.findUnique.mockResolvedValue(userRow(assignments, { id: "user-1" }));
}

type Row = { id: string; name: string; domain: string | null; product: string | null; references?: string };
/**
 * "order" (domain sales) references "customer" (domain finance); "invoice" (sales) references "line" (sales); "line" (sales) references nothing.
 * Every row carries its place the way the database does (a domain id, a product id).
 */
const ROWS: Row[] = [
  { id: "order", name: "Order", domain: "sales", product: "orders", references: "customer" },
  { id: "customer", name: "Customer", domain: "finance", product: "ledger" },
  { id: "invoice", name: "Invoice", domain: "sales", product: "orders", references: "line" },
  { id: "line", name: "InvoiceLine", domain: "sales", product: "orders" },
];
const place = (r: Row) => ({ domainId: r.domain ? `d-${r.domain}` : null, productId: r.product ? `p-${r.product}` : null });
const fieldsOf = (r: Row) =>
  r.references
    ? [
        {
          id: `${r.id}-f`, entityId: r.id, name: `${r.references}Ref`, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
          description: "", classification: null, aliases: [], sortOrder: 0,
          decorators: { referencedEntityId: r.references, referencedEntityName: ROWS.find((x) => x.id === r.references)?.name },
        },
      ]
    : [];
const entityRow = (r: Row) => ({
  id: r.id, tenantId: T, name: r.name, description: "", status: "DRAFT", version: 1, metadata: null, latestVersionId: null,
  ...place(r), domain: r.domain ? { id: `d-${r.domain}`, name: r.domain, slug: r.domain } : null,
  product: r.product ? { name: r.product, domainId: r.domain ? `d-${r.domain}` : null } : null, fields: fieldsOf(r), createdAt: new Date(), updatedAt: new Date(),
});

/** The rows the database was asked about, by entity: the proof that an entity the caller may not read is never opened. */
const touched = { fieldsOf: [] as string[], metadataOf: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  touched.fieldsOf = [];
  touched.metadataOf = [];
  delete process.env.API_KEY;
  delete process.env.API_KEY_ROLE;
  delete process.env.API_KEY_TENANT_ID;
  h.activeTenant.mockResolvedValue(T);
  h.prisma.entity.findMany.mockImplementation(async () => ROWS.map(entityRow));
  h.prisma.entity.findUnique.mockImplementation(async ({ where, select }: { where: { id: string }; select?: { metadata?: boolean } }) => {
    const row = ROWS.find((r) => r.id === where.id);
    if (select?.metadata) {
      touched.metadataOf.push(where.id);
      return row ? { metadata: null } : null;
    }
    return row ? entityRow(row) : null;
  });
  h.prisma.field.findMany.mockImplementation(async ({ where }: { where: { entityId: string } }) => {
    touched.fieldsOf.push(where.entityId);
    const row = ROWS.find((r) => r.id === where.entityId);
    return row ? fieldsOf(row) : [];
  });
  h.prisma.entityVersion.findUnique.mockResolvedValue(null);
  h.emitClosure.mockImplementation(async (_closure: unknown, key: string) => ({
    success: true,
    data: { files: [{ path: `${key}.out`, content: key, target: key, entityId: "x" }], warnings: [], entityFiles: {} },
  }));
  h.emitStandalone.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});
afterEach(() => {
  process.env = { ...SAVED };
});

const CALLS: Array<[string, (id: string) => Promise<Response>]> = [
  ["emit", (id) => emitSchema(post(`/schemas/${id}/emit`), withId(id))],
  ["validate", (id) => validateSchema(post(`/schemas/${id}/validate`), withId(id))],
];
const closureOf = () => h.emitClosure.mock.calls[0][0] as { entities: Array<{ entityId: string }> };

describe.each(CALLS)("POST /schemas/:id/%s", (_name, call) => {
  describe("a domain-scoped AUTHOR of sales", () => {
    beforeEach(() => signIn([assign.domain("AUTHOR", T, "d-sales")]));

    it("whose entity references an entity of another domain is refused: 403 REFERENCE_NOT_READABLE, nothing of the other entity named or read", async () => {
      const response = await call("order");
      expect(response.status).toBe(403);
      const body = await bodyOf(response);
      expect(body).toMatchObject({ success: false, error: { code: "REFERENCE_NOT_READABLE", details: { field: "customerRef" } } });
      expect(body.error.message).toContain('"customerRef"');
      expect(JSON.stringify(body)).not.toMatch(/Customer|finance|ledger|d-finance|p-ledger/);
      // No file was built, and no row of the other entity was opened.
      expect(h.emitClosure).not.toHaveBeenCalled();
      expect(touched.fieldsOf).not.toContain("customer");
      expect(touched.metadataOf).not.toContain("customer");
    });

    it("whose entity references an entity of the same domain is emitted whole", async () => {
      const response = await call("invoice");
      expect(response.status).toBe(200);
      expect(closureOf().entities.map((e) => e.entityId)).toEqual(["invoice", "line"]);
      const body = await bodyOf(response);
      expect(body.data.resolution.entities.map((e: { ref: { entity: string } }) => e.ref.entity)).toEqual(["Invoice", "InvoiceLine"]);
    });

    it("an entity of another domain is still the 404 of a missing one (the guard on the entity asked for is unchanged)", async () => {
      expect((await call("customer")).status).toBe(404);
      expect(h.emitClosure).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["a tenant administrator", [assign.tenant("ADMIN", T)]],
    ["a tenant-wide viewer", [assign.tenant("VIEWER", T)]],
    ["a platform administrator", [assign.global()]],
    ["a user who holds sales AND finance", [assign.domain("VIEWER", T, "d-sales"), assign.domain("VIEWER", T, "d-finance")]],
  ] as Array<[string, Assignment[]]>)("%s is unaffected: the closure holds the entity in the other domain", async (_who, assignments) => {
    signIn(assignments);
    const response = await call("order");
    expect(response.status).toBe(200);
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["order", "customer"]);
  });

  it("the default API key (a service principal with the ADMIN role, global) is unaffected", async () => {
    process.env.API_KEY = KEY;
    process.env.API_KEY_TENANT_ID = T;
    const route = call === CALLS[0][1] ? emitSchema : validateSchema;
    const response = await route(post("/schemas/order/x", { headers: { authorization: `Bearer ${KEY}` } }), withId("order"));
    expect(response.status).toBe(200);
    expect(closureOf().entities.map((e) => e.entityId)).toEqual(["order", "customer"]);
  });

  it("an API key whose role is a tenant-wide VIEWER reads the whole tenant too", async () => {
    process.env.API_KEY = KEY;
    process.env.API_KEY_TENANT_ID = T;
    process.env.API_KEY_ROLE = "VIEWER";
    const route = call === CALLS[0][1] ? emitSchema : validateSchema;
    const response = await route(post("/schemas/order/x", { headers: { authorization: `Bearer ${KEY}` } }), withId("order"));
    expect(response.status).toBe(200);
  });
});
