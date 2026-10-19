import { beforeEach, describe, expect, it, vi } from "vitest";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";

// Model definitions (reusable models, `ModelDefinition` + `ModelFieldDefinition`) are not entities, but a model spread into an entity carries
// its fields into the entity's payload: a field named like a parser-unsafe key (`PARSER_UNSAFE_KEYS`) is refused when a person adds or renames
// one, and an import renames it (and the model, if it is the model that has the name) and says so.

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: { findUnique: vi.fn() },
    domain: { findUnique: vi.fn() },
    modelDefinition: { findUnique: vi.fn() },
    modelFieldDefinition: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  mockTx: {
    modelDefinition: { create: vi.fn(), findFirst: vi.fn() },
    decoratorDefinition: { create: vi.fn(), findFirst: vi.fn() },
    entity: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    product: { findUnique: vi.fn(), create: vi.fn() },
    domain: { findUnique: vi.fn() },
    serviceDefinition: { create: vi.fn() },
    sharedEnum: { create: vi.fn() },
    customScalar: { create: vi.fn() },
    unionType: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/services/name-registry.service", () => ({ assertNameAvailable: mockAssertNameAvailable }));

import { addModelFieldAction, createDomainAssetsFromImportAction, updateModelFieldAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";

const [UNSAFE] = [...PARSER_UNSAFE_KEYS];
const FIELD_MESSAGE = `"${UNSAFE}" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.`;
const field = (name: string) => ({ name, type: "string", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
  mockPrisma.modelDefinition.findUnique.mockResolvedValue({ domain: { tenantId: "tenant-1" }, _count: { fields: 2 } });
  mockPrisma.modelFieldDefinition.findUnique.mockResolvedValue({ name: "email", model: { domain: { tenantId: "tenant-1" } } });
  mockPrisma.modelFieldDefinition.create.mockResolvedValue({ id: "mf-1" });
  mockPrisma.modelFieldDefinition.update.mockResolvedValue({ id: "mf-1" });
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockTx.modelDefinition.create.mockImplementation(async ({ data }) => ({ id: `model-${data.name}` }));
  mockTx.modelDefinition.findFirst.mockResolvedValue(null);
  mockTx.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
  mockTx.product.findUnique.mockResolvedValue({ id: "prd-default", domainId: "domain-1", domain: { tenantId: "tenant-1" } });
  mockTx.product.create.mockResolvedValue({ id: "prd-default" });
  mockTx.entity.findMany.mockResolvedValue([]);
  mockTx.entity.findFirst.mockResolvedValue(null);
  mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
});

describe("addModelFieldAction", () => {
  it.each([UNSAFE, `  ${UNSAFE} `])("refuses a field named %j, before it reads or writes anything", async (name) => {
    expect(await addModelFieldAction("m-1", { name, type: "string" })).toEqual({ error: FIELD_MESSAGE, code: "VALIDATION_ERROR" });
    expect(mockPrisma.modelDefinition.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.modelFieldDefinition.create).not.toHaveBeenCalled();
  });

  it("accepts the look-alikes", async () => {
    for (const name of [UNSAFE.toLowerCase(), `${UNSAFE}2`]) expect(await addModelFieldAction("m-1", { name, type: "string" }), name).toEqual({ success: true });
    expect(mockPrisma.modelFieldDefinition.create).toHaveBeenCalledTimes(2);
  });
});

describe("updateModelFieldAction (rename)", () => {
  it.each([UNSAFE, ` ${UNSAFE} `])("refuses renaming a field to %j, and writes nothing", async (name) => {
    expect(await updateModelFieldAction("mf-1", { name })).toEqual({ error: FIELD_MESSAGE, code: "VALIDATION_ERROR" });
    expect(mockPrisma.modelFieldDefinition.update).not.toHaveBeenCalled();
  });

  it("accepts a rename to a look-alike, and an update that keeps the name an old field already has", async () => {
    expect(await updateModelFieldAction("mf-1", { name: UNSAFE.toLowerCase() })).toEqual({ success: true });
    mockPrisma.modelFieldDefinition.findUnique.mockResolvedValue({ name: UNSAFE, model: { domain: { tenantId: "tenant-1" } } });
    expect(await updateModelFieldAction("mf-1", { name: UNSAFE, description: "legacy" })).toEqual({ success: true });
    expect(mockPrisma.modelFieldDefinition.update).toHaveBeenCalledTimes(2);
  });

  it("an update without a name is not looked at", async () => {
    expect(await updateModelFieldAction("mf-1", { description: "x" })).toEqual({ success: true });
  });
});

describe("the bulk import's models loop", () => {
  const importModels = (models: Array<{ name: string; extends?: string; fields: ReturnType<typeof field>[] }>) =>
    createDomainAssetsFromImportAction({
      domainId: "domain-1", models: models.map((m) => ({ description: "", ...m })), entities: [], sharedEnums: [], customScalars: [], unionTypes: [], services: [], decoratorDefinitions: [],
    });

  it("renames a model field that is reserved, and says so", async () => {
    const result = await importModels([{ name: "Address", fields: [field("id"), field(UNSAFE)] }]);
    expect(result.modelsCreated).toBe(1);
    expect(result.errors).toEqual([`The field "${UNSAFE}" was renamed to "${UNSAFE}_1": the name is reserved. It belongs to the model "Address".`]);
    const created = mockTx.modelDefinition.create.mock.calls[0][0].data.fields.create as Array<{ name: string }>;
    expect(created.map((f) => f.name)).toEqual(["id", `${UNSAFE}_1`]);
  });

  it("renames a model that is reserved, a model that extends it follows, and both are reported", async () => {
    const result = await importModels([
      { name: UNSAFE, fields: [field("id")] },
      { name: "Child", extends: UNSAFE, fields: [field("x")] },
    ]);
    expect(result.modelsCreated).toBe(2);
    expect(result.errors).toEqual([`The model "${UNSAFE}" was renamed to "${UNSAFE}_1": the name is reserved.`]);
    const data = mockTx.modelDefinition.create.mock.calls.map(([arg]) => arg.data as { name: string; extendsModelName: string | null });
    expect(data.map((d) => [d.name, d.extendsModelName])).toEqual([[`${UNSAFE}_1`, null], ["Child", `${UNSAFE}_1`]]);
  });

  it("leaves ordinary models and the look-alikes alone", async () => {
    const result = await importModels([{ name: UNSAFE.toLowerCase(), fields: [field(`${UNSAFE}2`)] }]);
    expect(result.errors).toEqual([]);
    expect(mockTx.modelDefinition.create.mock.calls[0][0].data.name).toBe(UNSAFE.toLowerCase());
  });
});
