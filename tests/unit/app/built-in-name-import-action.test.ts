import { beforeEach, describe, expect, it, vi } from "vitest";

// FINAL FIX WAVE 4, I1: the bulk import action renames an entity that is named like a built-in type (`Duration`, `Record`, `Date` ...) BEFORE it
// creates anything, so the unions and the services of the same import, which are created first, already name the new name. Nothing is
// skipped, nothing dangles, and the import's messages carry one note per rename.

const { mockAuth, mockPrisma, mockTx } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  const registry = emptyRegistryDelegates();
  return {
    mockAuth: vi.fn(),
    mockPrisma: { user: { findUnique: vi.fn() }, domain: { findUnique: vi.fn() }, $transaction: vi.fn() },
    mockTx: {
      ...registry,
      modelDefinition: { create: vi.fn(), findFirst: vi.fn() },
      decoratorDefinition: { create: vi.fn(), findFirst: vi.fn() },
      entity: { ...registry.entity, create: vi.fn(), findFirst: vi.fn() },
      product: { findUnique: vi.fn(), create: vi.fn() },
      domain: { findUnique: vi.fn() },
      serviceDefinition: { ...registry.serviceDefinition, create: vi.fn() },
      sharedEnum: { ...registry.sharedEnum, create: vi.fn() },
      customScalar: { ...registry.customScalar, create: vi.fn() },
      unionType: { ...registry.unionType, create: vi.fn() },
      $executeRaw: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { createDomainAssetsFromImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const field = (name: string, type = "string", decorators?: Record<string, unknown>) => ({
  name, type, nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, ...(decorators ? { decorators } : {}),
});
const payload = (over: Record<string, unknown>) => ({
  domainId: "domain-1", models: [], entities: [], sharedEnums: [], customScalars: [], unionTypes: [], services: [], decoratorDefinitions: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockTx.modelDefinition.findFirst.mockResolvedValue(null);
  mockTx.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
  mockTx.product.findUnique.mockResolvedValue({ id: "prd-default", domainId: "domain-1", domain: { tenantId: "tenant-1" } });
  mockTx.product.create.mockResolvedValue({ id: "prd-default" });
  mockTx.entity.findFirst.mockResolvedValue(null);
  mockTx.entity.create.mockImplementation(async ({ data }) => ({ id: `entity-${data.name}` }));
  mockTx.unionType.create.mockResolvedValue({ id: "union-1" });
  mockTx.serviceDefinition.create.mockResolvedValue({ id: "service-1" });
});

describe("createDomainAssetsFromImportAction: an entity named like a built-in type", () => {
  it("creates it renamed, rewrites the references of the same import, and reports the rename (nothing is skipped)", async () => {
    const result = await createDomainAssetsFromImportAction(
      payload({
        sourceFormat: "json-schema",
        entities: [
          { name: "Duration", description: "", fields: [field("seconds", "int32")] },
          { name: "Order", description: "", fields: [field("timeout", "reference", { referencedEntityName: "Duration" })] },
        ],
      })
    );
    expect(result.entitiesCreated).toBe(2);
    expect(result.errors).toEqual(['The entity "Duration" was renamed to "Duration2" because "Duration" is a built-in type name in TypeSpec/Java; every reference to it now says "Duration2".']);
    const written = mockTx.entity.create.mock.calls.map(([arg]) => arg.data as { name: string; fields: { create: Array<{ decorators: Record<string, unknown> }> } });
    expect(written.map((d) => d.name)).toEqual(["Duration2", "Order"]);
    expect(written[1]!.fields.create[0]!.decorators).toEqual({ referencedEntityName: "Duration2" });
  });

  it("the union and the service that name the entity are created already naming the new name (they are created before the entities)", async () => {
    const result = await createDomainAssetsFromImportAction(
      payload({
        sourceFormat: "typespec",
        entities: [{ name: "Record", description: "", fields: [field("id")] }, { name: "Order", description: "", fields: [field("r", "Record")] }],
        unionTypes: [{ name: "Either", memberTypes: ["Record", "string"] }],
        services: [{ name: "RecordApi", scope: "entity", entityName: "Record", operations: [{ name: "get", returnType: "Record", params: [] }] }],
      })
    );
    expect(result).toMatchObject({ entitiesCreated: 2, unionsCreated: 1, servicesCreated: 1 });
    expect(mockTx.unionType.create.mock.calls[0]![0].data.memberTypes).toEqual(["Record2", "string"]);
    const service = mockTx.serviceDefinition.create.mock.calls[0]![0].data;
    // the service is the entity's own API: it found the entity by its new name
    expect(service).toMatchObject({ scope: "ENTITY", entityId: "entity-Record2" });
    expect(service.operations.create[0].responses.create[0].type).toBe("Record2");
    const order = mockTx.entity.create.mock.calls[1]![0].data as { fields: { create: Array<{ type: string }> } };
    expect(order.fields.create[0]!.type).toBe("Record2");
  });

  it("an import with no built-in name is untouched and has no note", async () => {
    const result = await createDomainAssetsFromImportAction(payload({ entities: [{ name: "Order", description: "", fields: [field("id")] }] }));
    expect(result.entitiesCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
