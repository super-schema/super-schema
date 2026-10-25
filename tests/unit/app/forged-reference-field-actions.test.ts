import { beforeEach, describe, expect, it, vi } from "vitest";

// A reference field stores `decorators.referencedEntityId`; publish pins it and the renderers load it. A client that forges the id of ANOTHER
// tenant's entity must be refused at store time (addFieldAction, updateFieldAction); a stored id the field already holds stays editable.

const { mockPrisma, mockGetActiveTenantId } = vi.hoisted(() => ({
  mockGetActiveTenantId: vi.fn(),
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));

import { FOREIGN_REFERENCE_MESSAGE } from "@/lib/references/foreign-reference-guard";
import { addFieldAction, updateFieldAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const TENANT_OF: Record<string, string | undefined> = { "ent-1": "tenant-1", "ent-mine": "tenant-1", "ent-foreign": "tenant-2" };
const OWN_FIELD = (decorators: unknown = {}) => ({ id: "fld-1", entityId: "ent-1", name: "owner", slug: "owner", type: "reference", decorators, entity: { tenantId: "tenant-1" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTenantId.mockResolvedValue("tenant-1");
  mockPrisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (TENANT_OF[where.id] ? { tenantId: TENANT_OF[where.id] } : null));
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD());
  mockPrisma.field.create.mockResolvedValue({ id: "fld-new" });
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

const noWrite = () => {
  expect(mockPrisma.field.create).not.toHaveBeenCalled();
  expect(mockPrisma.field.update).not.toHaveBeenCalled();
  expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
};

describe("addFieldAction: the referenced entity must be in the active tenant", () => {
  it("refuses another tenant's entity id with a generic validation error, and writes nothing", async () => {
    const r = await addFieldAction("ent-1", "buyer", "reference", { decorators: { referencedEntityId: "ent-foreign", referencedQualifiedName: "d/p/Secret" } });
    expect(r).toEqual({ error: FOREIGN_REFERENCE_MESSAGE, code: "VALIDATION_ERROR" });
    noWrite();
  });

  it("answers an id that names nothing exactly like a foreign one (a foreign entity is not revealed)", async () => {
    const foreign = await addFieldAction("ent-1", "buyer", "reference", { decorators: { referencedEntityId: "ent-foreign" } });
    const ghost = await addFieldAction("ent-1", "buyer", "reference", { decorators: { referencedEntityId: "ent-ghost" } });
    expect(ghost).toEqual(foreign);
  });

  it("stores a reference to an entity of the active tenant", async () => {
    const r = await addFieldAction("ent-1", "buyer", "reference", { decorators: { referencedEntityId: "ent-mine", referencedQualifiedName: "d/p/Mine" } });
    expect(r).toMatchObject({ success: true });
    expect(mockPrisma.field.create).toHaveBeenCalledTimes(1);
  });

  it("does not look at decorators that name no entity", async () => {
    const r = await addFieldAction("ent-1", "plain", "string", { decorators: { typespec: {} } });
    expect(r).toMatchObject({ success: true });
  });
});

describe("updateFieldAction: a new or changed referenced entity must be in the active tenant", () => {
  it("refuses another tenant's id and writes nothing", async () => {
    const r = await updateFieldAction("fld-1", { decorators: { referencedEntityId: "ent-foreign" } });
    expect(r).toEqual({ error: FOREIGN_REFERENCE_MESSAGE, code: "VALIDATION_ERROR" });
    noWrite();
  });

  it("refuses re-pointing a field from an own entity to a foreign one", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD({ referencedEntityId: "ent-mine" }));
    const r = await updateFieldAction("fld-1", { decorators: { referencedEntityId: "ent-foreign" } });
    expect(r).toMatchObject({ code: "VALIDATION_ERROR", error: FOREIGN_REFERENCE_MESSAGE });
    noWrite();
  });

  it("accepts re-pointing to another entity of the active tenant", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD({ referencedEntityId: "ent-1" }));
    expect(await updateFieldAction("fld-1", { decorators: { referencedEntityId: "ent-mine" } })).toEqual({ success: true });
  });

  it("an id the field already holds is not re-checked: a field whose target was deleted stays editable", async () => {
    mockPrisma.field.findUnique.mockResolvedValue(OWN_FIELD({ referencedEntityId: "ent-deleted" }));
    expect(await updateFieldAction("fld-1", { decorators: { referencedEntityId: "ent-deleted", semantics: { description: "x" } } })).toEqual({ success: true });
    expect(mockPrisma.field.update).toHaveBeenCalledTimes(1);
  });

  it("an update without decorators never looks up an entity", async () => {
    mockPrisma.entity.findUnique.mockClear();
    expect(await updateFieldAction("fld-1", { description: "x" })).toEqual({ success: true });
    expect(mockPrisma.entity.findUnique).not.toHaveBeenCalled();
  });
});

// The creating paths: an entity created WITH its fields (the wizard, an enterprise entity, a bulk import) stores each field's decorators too.
import { createDomainAssetsFromImportAction, createEntityWithFieldsAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { createTenantEntityAction } from "@/app/(dashboard)/schemas/enterprise/actions";

describe("entity creation with fields: the referenced entity must be in the active tenant", () => {
  const field = (referencedEntityId: string) =>
    ({ name: "buyer", type: "reference", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, decorators: { referencedEntityId } }) as never;

  beforeEach(() => {
    (mockPrisma as unknown as Record<string, unknown>).domain = { findUnique: vi.fn(async () => ({ tenantId: "tenant-1" })) };
    (mockPrisma as unknown as Record<string, unknown>).tenant = { findUnique: vi.fn(async () => ({ id: "tenant-1" })) };
    (mockPrisma as unknown as Record<string, unknown>).user = { findUnique: vi.fn(async () => ({ id: "user-1" })) };
  });

  it("createEntityWithFieldsAction refuses a foreign id and creates nothing", async () => {
    const r = await createEntityWithFieldsAction("dom-1", { name: "Order", description: "", fields: [field("ent-foreign")] });
    expect(r).toEqual({ error: FOREIGN_REFERENCE_MESSAGE, code: "VALIDATION_ERROR" });
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("createTenantEntityAction refuses a foreign id and creates nothing", async () => {
    const r = await createTenantEntityAction({ name: "Order", description: "", fields: [field("ent-foreign")] });
    expect(r).toEqual({ error: FOREIGN_REFERENCE_MESSAGE });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("createDomainAssetsFromImportAction refuses a foreign id inside an imported entity and creates nothing", async () => {
    const r = await createDomainAssetsFromImportAction({
      domainId: "dom-1", models: [], sharedEnums: [], customScalars: [], unionTypes: [], services: [], decoratorDefinitions: [],
      entities: [{ name: "Order", fields: [field("ent-foreign")] }],
    } as never);
    expect(r.errors).toEqual([FOREIGN_REFERENCE_MESSAGE]);
    expect(r.entitiesCreated).toBe(0);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
