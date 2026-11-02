import { beforeEach, describe, expect, it, vi } from "vitest";

// The TypeSpec preview's Apply writes the fields its TEXT means, through the same server pipeline as the Source tab save: the real compiler,
// the entity's own model, the enums and the references the text declares, and the names a field may be typed with (a standard type, a
// declared enum / scalar / union, or an entity of the tenant). What the browser parsed is never stored, and the Apply does not store the text.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { applyTypeSpecAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";

/** The entity under edit: `Order`, in the tenant's domain `dom-1`. */
const ORDER = { id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, tenantId: "tenant-1", domainId: "dom-1", productId: null, domain: { id: "dom-1", name: "Sales", slug: "sales" }, product: null, metadata: {}, typespecSource: null, latestVersionId: null };

/** The tenant's other entities, as the reference loader reads them (a `Customer` in the same domain). */
const TENANT_ENTITIES = [
  { ...ORDER, id: "ent-1" },
  { ...ORDER, id: "ent-cust", name: "Customer" },
];

const stored = (name: string, type = "string", id = `fld-${name}`) => ({
  id, entityId: "ent-1", name, slug: name, type, nullable: false, isKey: false, description: "", classification: null, decorators: {},
  sortOrder: 0, fieldNumber: 1, precision: null, scale: null,
});

const nothingWritten = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.findUnique.mockResolvedValue(ORDER);
  // The loader's tenant read honours the `where` the caller built (the tenant, and the domains / products the caller may read).
  mockPrisma.entity.findMany.mockImplementation(async ({ where }: { where: { tenantId: string; OR?: Array<Record<string, { in: string[] }>> } }) =>
    TENANT_ENTITIES.filter((e) => e.tenantId === where.tenantId && (where.OR === undefined || where.OR.some((c) => ("domainId" in c ? c.domainId.in.includes(e.domainId) : c.productId.in.includes(e.productId ?? ""))))),
  );
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("applyTypeSpecAction: an enum the text declares keeps its definition and its binding", () => {
  const ENUM_SOURCE = "enum OrderStatus { Open, Closed }\nmodel Order { status: OrderStatus; }\n";

  it("a new enum field is created as an enum field named by the declared enum, with its symbols", async () => {
    expect(await applyTypeSpecAction("ent-1", ENUM_SOURCE)).toEqual({ added: 1, updated: 0, removed: [] });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.field.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "status", type: "enum", decorators: { enumName: "OrderStatus", typespec: { validation: { pattern: "Open|Closed" } } } });
  });

  it("an existing string field becomes that enum field, and the Apply stores nothing of the text itself", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("status")]);
    expect(await applyTypeSpecAction("ent-1", ENUM_SOURCE)).toEqual({ added: 0, updated: 1, removed: [] });
    expect(mockPrisma.field.update.mock.calls[0][0].data).toMatchObject({ type: "enum", decorators: { enumName: "OrderStatus" } });
    // The rows are the truth after an Apply: the text is not stored, the draft is flagged changed and its source marked stale.
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
  });

  it("an enum field the text leaves as it is keeps its stored enum binding (no edit to write)", async () => {
    mockPrisma.field.findMany.mockResolvedValue([
      { ...stored("status", "enum"), decorators: { enumName: "OrderStatus", typespec: { validation: { pattern: "Open|Closed" } } } },
    ]);
    expect(await applyTypeSpecAction("ent-1", ENUM_SOURCE)).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });
});

describe("applyTypeSpecAction: the names a field is typed with", () => {
  it("a field typed with an entity of the tenant is stored as a reference to it", async () => {
    expect(await applyTypeSpecAction("ent-1", "model Order { buyer: Customer; }")).toEqual({ added: 1, updated: 0, removed: [] });
    const data = mockPrisma.field.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "buyer", type: "reference", decorators: { referencedEntityId: "ent-cust", referencedEntityName: "Customer" } });
  });

  it("a declared scalar is stored as the base type it stands for, never as the scalar's own name", async () => {
    expect(await applyTypeSpecAction("ent-1", "scalar Price extends decimal;\nmodel Order { total: Price; }")).toEqual({ added: 1, updated: 0, removed: [] });
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "total", type: "decimal" });
  });

  it("a name that is not declared and is no entity of the tenant is refused by the compiler, and nothing is written", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Order { price: Money; }");
    expect(result).toMatchObject({ added: 0, updated: 0, removed: [] });
    expect(result.error).toContain("Unknown identifier Money");
    nothingWritten();
  });

  it("a field typed with another model of the text (not an entity) is refused, never stored as that model name", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Order { address: Address; }\nmodel Address { street: string; }\n");
    expect(result.error).toBe('Field "address" is typed "Address", which is not a type of this app: use a TypeSpec standard type, an enum or union the source declares, or an entity of the tenant.');
    nothingWritten();
  });
});

describe("applyTypeSpecAction: the entity's own model", () => {
  it("is the model named after the entity, even when a helper model is declared above it", async () => {
    const source = "model Address { street: string; }\nmodel Order { status: string; }\n";
    expect(await applyTypeSpecAction("ent-1", source)).toEqual({ added: 1, updated: 0, removed: [] });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.field.create.mock.calls[0][0].data).toMatchObject({ name: "status" });
  });

  it("is refused when several models are declared and none is the entity's (nothing is read as the entity, nothing removed)", async () => {
    mockPrisma.field.findMany.mockResolvedValue([stored("status")]);
    const result = await applyTypeSpecAction("ent-1", "model Address { street: string; }\nmodel Buyer { id: string; }\n");
    expect(result).toEqual({ added: 0, updated: 0, removed: [], error: expect.stringContaining('declares no model for this entity') });
    nothingWritten();
  });
});

describe("applyTypeSpecAction: removals are confirmed and limited to the fields the text does not name", () => {
  beforeEach(() => {
    mockPrisma.field.findMany.mockResolvedValue([stored("status", "string", "fld-status"), stored("legacy", "string", "fld-legacy")]);
  });

  it("removes nothing when no removal was confirmed (the field the text omits stays)", async () => {
    expect(await applyTypeSpecAction("ent-1", "model Order { status: string; }")).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  });

  it("removes a confirmed field the text does not name", async () => {
    expect(await applyTypeSpecAction("ent-1", "model Order { status: string; }", ["legacy"])).toEqual({ added: 0, updated: 0, removed: ["legacy"] });
    expect(mockPrisma.field.delete).toHaveBeenCalledWith({ where: { id: "fld-legacy" } });
  });

  it("never removes a field the text names, even when it is listed", async () => {
    expect(await applyTypeSpecAction("ent-1", "model Order { status: string; }", ["status"])).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
  });
});

describe("applyTypeSpecAction: a text that does not compile", () => {
  it("writes nothing and answers the compiler's error", async () => {
    const result = await applyTypeSpecAction("ent-1", "model Order { status: string }\nmodel {");
    expect(result.error).toMatch(/^The TypeSpec does not compile/);
    nothingWritten();
  });
});
