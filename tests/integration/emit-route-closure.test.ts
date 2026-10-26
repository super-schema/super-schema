import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 7: POST /api/v1/schemas/:id/emit and /validate emit the closure targets (JSON Schema, OpenAPI 3, Protobuf, Avro, Java POJO)
// for the entity together with everything it references, through the REAL reference loader and the REAL TypeSpec emitters (one
// compile per target, a few seconds); an ambiguous bare-name reference is a structured error, not a guess. Only the database (an
// in-memory fake) and the DB-target emitters (BigQuery / Spanner / PostgreSQL, not under test here) are replaced.

type Decorators = Record<string, unknown>;
type FieldRow = { id: string; name: string; type: string; isKey: boolean; decorators: Decorators };
type EntityRow = { id: string; tenantId: string; name: string; domain: string; product: string; fields: FieldRow[] };

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  findMany: vi.fn(),
  emitStandalone: vi.fn(),
}));

// The caller is the API key's service principal (a platform administrator acting in tenant-1): `withApiAuth` needs no session or database for it.
vi.mock("@/app/api/v1/middleware", () => ({
  authenticateRequest: async () => ({
    authenticated: true,
    source: "api-key",
    tenantId: "tenant-1",
    principal: { userId: "api-key-user", email: "api-key@service.invalid", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], isGlobalAdmin: true },
  }),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant-1" }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: () => null }));
vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findMany: h.findMany, findUnique: async () => ({ metadata: {} }) },
    field: {
      findMany: async ({ where }: { where: { entityId: string } }) =>
        ((h.rows as EntityRow[]).find((r) => r.id === where.entityId)?.fields ?? []).map((f, i) => ({
          ...f, precision: null, scale: null, nullable: !f.isKey, fieldNumber: null, description: "", classification: null, aliases: [], sortOrder: i,
        })),
    },
    entityVersion: { findUnique: async () => null },
  },
}));
vi.mock("@/services/entity.service", () => ({
  getEntityById: async (id: string) => {
    const row = (h.rows as EntityRow[]).find((r) => r.id === id);
    if (!row) return { success: false, error: { code: "NOT_FOUND", message: "Entity not found" } };
    return {
      success: true,
      data: {
        id: row.id, tenantId: row.tenantId, name: row.name, description: "", status: "DRAFT", version: 1, domainId: `d-${row.domain}`, metadata: {},
        domain: { id: `d-${row.domain}`, name: row.domain, slug: row.domain.toLowerCase() },
      },
    };
  },
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetFromData: h.emitStandalone,
}));

import { POST as emitPost } from "@/app/api/v1/schemas/[id]/emit/route";
import { POST as validatePost } from "@/app/api/v1/schemas/[id]/validate/route";
import { bundleEmittedFiles, type EmittedFile } from "@/lib/typespec-official/closure-emit";

const CLOSURE_TARGETS = ["json-schema", "openapi3", "protobuf", "avro", "java-pojo"];

const idField = (entity: string): FieldRow => ({ id: `${entity}.id`, name: "id", type: "string", isKey: true, decorators: {} });
const qualified = (id: string, q: string): Decorators => ({ referencedEntityId: id, referencedEntityName: q.split("/")[2], referencedQualifiedName: q });

function entity(id: string, name: string, fields: FieldRow[], over: Partial<EntityRow> = {}): EntityRow {
  return { id, tenantId: "tenant-1", name, domain: "Sales", product: "Crm", fields: [idField(id), ...fields], ...over };
}

function stockWorld() {
  h.rows = [
    entity("a", "Order", [{ id: "a.customer", name: "customer", type: "reference", isKey: false, decorators: qualified("b", "Sales/Crm/Customer") }]),
    entity("b", "Customer", [{ id: "b.name", name: "name", type: "string", isKey: false, decorators: {} }]),
  ];
}

const call = (route: typeof emitPost, id: string) =>
  route(new Request(`http://localhost/api/v1/schemas/${id}`, { method: "POST" }) as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.findMany.mockImplementation(async ({ where }: { where: { tenantId: string } }) =>
    (h.rows as EntityRow[])
      .filter((r) => r.tenantId === where.tenantId)
      .map((r) => ({
        id: r.id, name: r.name, description: "", status: "DRAFT", version: 1, domainId: `d-${r.domain}`, metadata: {}, latestVersionId: null,
        domain: { id: `d-${r.domain}`, name: r.domain, slug: r.domain.toLowerCase() }, product: { name: r.product },
      }))
  );
  h.emitStandalone.mockImplementation(async (_entity: unknown, _fields: unknown, key: string) => ({ output: `-- ${key} DDL`, validationStatus: "VALID", warnings: [], errors: [] }));
});

describe("POST /api/v1/schemas/:id/emit", () => {
  it("emits one file per entity for every closure target, `output` being their bundled string, and one DDL string for the DB targets", async () => {
    stockWorld();
    const response = await call(emitPost, "a");
    const body = await response.json();
    expect(response.status).toBe(200);

    type TargetBody = { target: string; output: string; files?: EmittedFile[]; validationStatus: string };
    const targets = body.data.targets as TargetBody[];
    for (const key of CLOSURE_TARGETS) {
      const target = targets.find((t) => t.target === key) as TargetBody;
      expect(target.validationStatus, `${key}: ${JSON.stringify(target)}`).not.toBe("INVALID");
      expect(target.files, key).toBeDefined();
      // Order references Customer: both entities have a file of their own on every one of these targets.
      expect(new Set(target.files!.map((f) => f.entityId)), key).toEqual(new Set(["a", "b"]));
      expect(target.files!.every((f) => f.target === key)).toBe(true);
      expect(target.output).toBe(bundleEmittedFiles(target.files!));
    }
    expect((targets.find((t) => t.target === "json-schema") as TargetBody).files!.map((f) => f.path)).toEqual(["Customer.json", "Order.json"]);

    for (const key of ["bigquery", "spanner", "postgresql"]) {
      const target = targets.find((t) => t.target === key) as TargetBody;
      expect(target).toMatchObject({ output: `-- ${key} DDL` });
      expect(target.files).toBeUndefined();
    }

    // One list of every file of the run, each tagged by its target.
    const all = body.data.files as EmittedFile[];
    expect(new Set(all.map((f) => f.target))).toEqual(new Set(CLOSURE_TARGETS));
    expect(all.length).toBe(targets.reduce((n, t) => n + (t.files?.length ?? 0), 0));

    // What the run used: the draft state of both entities, so it is a preview.
    expect(body.data.resolution).toMatchObject({ mode: "draft", preview: true });
    expect(body.data.resolution.entities.map((e: { ref: { entity: string } }) => e.ref.entity)).toEqual(["Order", "Customer"]);
    expect(body.data.typespec).toContain("model Order");
  }, 120_000);

  it("keeps the closure inside the entity's own tenant", async () => {
    stockWorld();
    h.rows.push(entity("x", "Customer", [], { tenantId: "tenant-2", product: "Other" }));
    const response = await call(emitPost, "a");
    expect(response.status).toBe(200);
    expect(h.findMany).toHaveBeenCalledTimes(1);
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }));
    // The tenant index is read on every request: it must not carry the (large) metadata with every stored schema version.
    expect(h.findMany.mock.calls[0][0].select).not.toHaveProperty("metadata");
  }, 120_000);

  it("answers an ambiguous bare-name reference with a structured error listing the candidates, and emits no closure target", async () => {
    h.rows = [
      entity("a", "Order", [{ id: "a.addr", name: "addr", type: "reference", isKey: false, decorators: { referencedEntityName: "Address" } }]),
      entity("x1", "Address", [], { product: "Crm" }),
      entity("x2", "Address", [], { domain: "Billing", product: "Invoices" }),
    ];
    const response = await call(emitPost, "a");
    const body = await response.json();
    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("AMBIGUOUS_REFERENCE");
    expect(body.error.message).toContain("Billing / Invoices / Address");
    expect(body.error.details).toMatchObject({
      field: "addr",
      name: "Address",
      entityId: "a",
      fieldId: "a.addr",
      candidates: [
        { entityId: "x2", domain: "Billing", product: "Invoices", entity: "Address" },
        { entityId: "x1", domain: "Sales", product: "Crm", entity: "Address" },
      ],
    });
  });

  it("answers an unknown entity with 404", async () => {
    h.rows = [];
    expect((await call(emitPost, "missing")).status).toBe(404);
  });
});

describe("POST /api/v1/schemas/:id/validate", () => {
  it("validates every closure target against the entity's closure and lists the files", async () => {
    stockWorld();
    const response = await call(validatePost, "a");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.valid, JSON.stringify(body.data.targets)).toBe(true);
    const jsonSchema = body.data.targets.find((t: { target: string }) => t.target === "json-schema");
    expect(jsonSchema.status).not.toBe("INVALID");
    expect((jsonSchema.files as EmittedFile[]).map((f) => f.entityId).sort()).toEqual(["a", "b"]);
    expect(body.data.resolution).toMatchObject({ mode: "draft", preview: true });
  }, 120_000);

  it("answers an ambiguous bare-name reference with the same structured error as emit", async () => {
    h.rows = [
      entity("a", "Order", [{ id: "a.addr", name: "addr", type: "reference", isKey: false, decorators: { referencedEntityName: "Address" } }]),
      entity("x1", "Address", [], { product: "Crm" }),
      entity("x2", "Address", [], { product: "Other" }),
    ];
    const response = await call(validatePost, "a");
    const body = await response.json();
    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({ code: "AMBIGUOUS_REFERENCE", details: { field: "addr", entityId: "a", fieldId: "a.addr" } });
  });
});
