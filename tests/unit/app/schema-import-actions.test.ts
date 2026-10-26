import { describe, expect, it, vi, beforeEach } from "vitest";
import { sessionPrincipalModule } from "../../helpers/access-mocks";

const { mockAuth, mockPrisma, mockTx, mockAssertNameAvailable } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
    },
    // The domain-ownership check runs before the transaction opens.
    domain: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockTx: {
    modelDefinition: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    decoratorDefinition: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    entity: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    domain: {
      findUnique: vi.fn(),
    },
    serviceDefinition: {
      create: vi.fn(),
    },
    sharedEnum: {
      create: vi.fn(),
    },
    customScalar: {
      create: vi.fn(),
    },
    unionType: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
  mockAssertNameAvailable: vi.fn(),
}));

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

vi.mock("@/services/name-registry.service", () => ({
  assertNameAvailable: mockAssertNameAvailable,
}));

import { createDomainAssetsFromImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

describe("schema import actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "missing-user", email: "stale@example.com" },
    });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
    mockTx.modelDefinition.create.mockImplementation(async ({ data }) => ({
      id: `model-${data.name}`,
    }));
    mockTx.entity.create.mockImplementation(async ({ data }) => ({
      id: `entity-${data.name}`,
    }));
    mockTx.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
    mockPrisma.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
    mockTx.product.findUnique.mockResolvedValue({
      id: "prd-default",
      domainId: "domain-1",
      domain: { tenantId: "tenant-1" },
    });
    mockTx.product.create.mockResolvedValue({ id: "prd-default" });
    mockAssertNameAvailable.mockResolvedValue({ success: true, data: undefined });
    mockTx.sharedEnum.create.mockImplementation(async ({ data }) => ({ id: `enum-${data.name}` }));
    mockTx.customScalar.create.mockImplementation(async ({ data }) => ({ id: `scalar-${data.name}` }));
    mockTx.unionType.create.mockImplementation(async ({ data }) => ({ id: `union-${data.name}` }));
    mockTx.entity.findMany.mockResolvedValue([]);
    mockTx.entity.findFirst.mockResolvedValue(null);
    mockTx.modelDefinition.findFirst.mockResolvedValue(null);
    mockTx.decoratorDefinition.findFirst.mockResolvedValue(null);
    mockTx.decoratorDefinition.create.mockResolvedValue({ id: "decorator-1" });
    mockTx.serviceDefinition.create.mockImplementation(async ({ data }) => ({
      id: `service-${data.name}`,
    }));
  });

  it("rejects imports before opening a transaction when the session user no longer exists (nobody: not authenticated)", async () => {
    sessionPrincipalModule.getPrincipal.mockResolvedValueOnce(null);

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
      ],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    });

    expect(result).toMatchObject({
      modelsCreated: 0,
      entitiesCreated: 0,
      errors: ["Not authenticated"],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates entities only for explicit entity registrations, not every selected model", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
        {
          name: "Address",
          description: "",
          fields: [],
        },
      ],
      entities: [
        {
          name: "Customer",
          description: "",
          fields: [],
        },
      ],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    });

    expect(result.modelsCreated).toBe(2);
    expect(result.entitiesCreated).toBe(1);
    expect(result.errors).toEqual([]);
    expect(mockTx.modelDefinition.create).toHaveBeenCalledTimes(2);
    expect(mockTx.entity.create).toHaveBeenCalledTimes(1);
    expect(mockTx.entity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Customer",
          ownerId: "user-1",
          tenantId: "tenant-1",
        }),
      })
    );
  });

  it("renames an imported field the AsyncAPI parser cannot read (hasOwnProperty) and reports it with the other import notes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });

    const field = (name: string) => ({ name, type: "string", nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null });
    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      models: [],
      entities: [{ name: "Customer", description: "", fields: [field("id"), field("hasOwnProperty"), field("hasownproperty-x")] }],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    });

    expect(result.entitiesCreated).toBe(1);
    expect(result.errors).toEqual(['The field "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved. It belongs to the entity "Customer".']);
    const written = mockTx.entity.create.mock.calls[0][0].data.fields.create as Array<{ name: string }>;
    expect(written.map((f) => f.name)).toEqual(["id", "hasOwnProperty_1", "hasownproperty-x"]);
  });

  it("resolves an entity-scoped service against an entity that already existed before this import", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockTx.entity.findMany.mockResolvedValue([
      { id: "entity-existing-1", name: "Order", productId: "prd-existing" },
    ]);

    const result = await createDomainAssetsFromImportAction({
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [
        {
          name: "OrderApi",
          scope: "entity",
          entityName: "Order",
          operations: [],
        },
      ],
      decoratorDefinitions: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.servicesCreated).toBe(1);
    expect(mockTx.entity.findMany).toHaveBeenCalledWith({
      where: { domainId: "domain-1", name: { in: ["Order"] } },
      select: { id: true, name: true, productId: true },
    });
    // The API lives at the referenced entity's own product scope.
    expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "ENTITY",
          entityId: "entity-existing-1",
          tenantId: "tenant-1",
          domainId: "domain-1",
          productId: "prd-existing",
        }),
      })
    );
    expect(mockAssertNameAvailable).toHaveBeenCalledWith(mockTx, {
      name: "OrderApi",
      tenantId: "tenant-1",
      domainId: "domain-1",
      productId: "prd-existing",
    });
  });

  describe("name registry and per-item skips", () => {
    const emptyPayload = {
      domainId: "domain-1",
      namespace: "Test",
      models: [],
      entities: [],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    };
    const DOMAIN_SCOPE = { tenantId: "tenant-1", domainId: "domain-1", productId: null };
    const PRODUCT_SCOPE = { tenantId: "tenant-1", domainId: "domain-1", productId: "prd-default" };

    const registryConflict = (
      message: string,
      hit: { kind: string; domainId: string | null; productId: string | null }
    ) => ({
      success: false,
      error: { code: "NAME_CONFLICT", message, details: { conflict: { id: "x", name: "x", tenantId: "tenant-1", ...hit } } },
    });
    const registryDbError = (message: string) => ({ success: false, error: { code: "DB_ERROR", message } });

    const rolledBack = (errors: string[]) => ({
      modelsCreated: 0,
      entitiesCreated: 0,
      enumsCreated: 0,
      scalarsCreated: 0,
      unionsCreated: 0,
      servicesCreated: 0,
      decoratorsCreated: 0,
      entityIds: [],
      modelIds: [],
      errors,
    });

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
      mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    });

    it("resolves and validates scope before the first create, then takes the tenant lock before the first registry check", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        models: [{ name: "Customer", fields: [] }],
        sharedEnums: [{ name: "Status", values: ["A"] }],
      });

      // per-asset registry checks make big imports slow; the tx must outlast Prisma's 5s default
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: expect.any(Number) })
      );
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.$executeRaw.mock.calls[0].slice(1)).toEqual(["tenant-1"]);
      const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
      expect(order(mockTx.product.findUnique)).toBeLessThan(order(mockTx.modelDefinition.create));
      expect(order(mockTx.$executeRaw)).toBeLessThan(order(mockAssertNameAvailable));
    });

    it("stores an imported entity's model tags as metadata.tags (Story 16.6 x-tags round trip)", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        entities: [
          { name: "Customer", tags: ["sales", "core"], fields: [] },
          { name: "Plain", fields: [] },
        ],
      });

      const created = mockTx.entity.create.mock.calls.map(([arg]) => arg.data);
      expect(created.find((d) => d.name === "Customer")?.metadata).toEqual({ tags: ["sales", "core"] });
      expect(created.find((d) => d.name === "Plain")).not.toHaveProperty("metadata");
    });

    describe("the import format is recorded on the entity (R4: what a message's Auto follows)", () => {
      const createdMetadata = () => Object.fromEntries(mockTx.entity.create.mock.calls.map(([arg]) => [arg.data.name, arg.data.metadata]));

      it.each(["avro", "protobuf", "json-schema", "typespec", "openapi", "bigquery-ddl"])("stores %s as metadata.sourceFormat", async (sourceFormat) => {
        await createDomainAssetsFromImportAction({ ...emptyPayload, sourceFormat, entities: [{ name: "Customer", fields: [] }] });
        expect(createdMetadata()).toEqual({ Customer: { sourceFormat } });
      });

      it("keeps the model tags next to it", async () => {
        await createDomainAssetsFromImportAction({
          ...emptyPayload, sourceFormat: "avro",
          entities: [{ name: "Customer", tags: ["sales", "core"], fields: [] }, { name: "Plain", fields: [] }],
        });
        expect(createdMetadata()).toEqual({
          Customer: { tags: ["sales", "core"], sourceFormat: "avro" },
          Plain: { sourceFormat: "avro" },
        });
      });

      it("applies to every entity of the import, and only to entities", async () => {
        await createDomainAssetsFromImportAction({
          ...emptyPayload, sourceFormat: "protobuf",
          models: [{ name: "Shape", fields: [] }],
          entities: [{ name: "A", fields: [] }, { name: "B", fields: [] }],
        });
        expect(createdMetadata()).toEqual({ A: { sourceFormat: "protobuf" }, B: { sourceFormat: "protobuf" } });
        expect(mockTx.modelDefinition.create.mock.calls[0][0].data).not.toHaveProperty("metadata");
      });

      it("trims the format and records nothing for a blank or non-string one", async () => {
        await createDomainAssetsFromImportAction({ ...emptyPayload, sourceFormat: "  avro  ", entities: [{ name: "Trimmed", fields: [] }] });
        expect(createdMetadata()).toEqual({ Trimmed: { sourceFormat: "avro" } });
        mockTx.entity.create.mockClear();
        const bads: unknown[] = ["", "   ", 7, null, {}, ["avro"]];
        for (const [i, bad] of bads.entries()) {
          await createDomainAssetsFromImportAction({ ...emptyPayload, sourceFormat: bad as string, entities: [{ name: `Bad${i}`, fields: [] }] });
        }
        expect(mockTx.entity.create).toHaveBeenCalledTimes(bads.length);
        for (const data of mockTx.entity.create.mock.calls.map(([arg]) => arg.data)) expect(data).not.toHaveProperty("metadata");
      });
    });

    it("checks data types and domain APIs at domain level and entities at product level", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "Status", values: ["A"] }],
        customScalars: [{ name: "Money", baseType: "decimal" }],
        unionTypes: [{ name: "Either", memberTypes: ["A"] }],
        entities: [{ name: "Customer", fields: [] }],
        services: [{ name: "CustomerApi", operations: [] }],
      });

      expect(mockAssertNameAvailable.mock.calls.map(([, candidate]) => candidate)).toEqual([
        { name: "Status", ...DOMAIN_SCOPE },
        { name: "Money", ...DOMAIN_SCOPE },
        { name: "Either", ...DOMAIN_SCOPE },
        { name: "Customer", ...PRODUCT_SCOPE },
        { name: "CustomerApi", ...DOMAIN_SCOPE },
      ]);
      mockAssertNameAvailable.mock.calls.forEach(([tx]) => expect(tx).toBe(mockTx));
    });

    it("trims data-type and API names before BOTH the registry check and the write (the registry compares trimmed names)", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "  Status ", values: ["A"] }],
        customScalars: [{ name: "Money ", baseType: "decimal" }],
        unionTypes: [{ name: " Either", memberTypes: ["A"] }],
        services: [{ name: "CustomerApi  ", operations: [] }],
      });

      expect(mockAssertNameAvailable.mock.calls.map(([, candidate]) => candidate.name)).toEqual(["Status", "Money", "Either", "CustomerApi"]);
      expect(mockTx.sharedEnum.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "Status" }) });
      expect(mockTx.customScalar.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "Money" }) });
      expect(mockTx.unionType.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "Either" }) });
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "CustomerApi" }) });
    });

    it("places a service for an entity created in this import at that entity's product scope", async () => {
      await createDomainAssetsFromImportAction({
        ...emptyPayload,
        entities: [{ name: "Order", fields: [] }],
        services: [{ name: "OrderApi", scope: "entity", entityName: "Order", operations: [] }],
      });

      expect(mockAssertNameAvailable).toHaveBeenLastCalledWith(mockTx, { name: "OrderApi", ...PRODUCT_SCOPE });
      expect(mockTx.serviceDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scope: "ENTITY", entityId: "entity-Order", ...PRODUCT_SCOPE }),
        })
      );
    });

    it("skips models and enums that already exist, creates the rest, and counts only created rows", async () => {
      mockTx.modelDefinition.findFirst.mockImplementation(async ({ where }) =>
        where.name === "Customer" ? { id: "model-existing" } : null
      );
      mockAssertNameAvailable.mockImplementation(async (_tx, candidate) =>
        candidate.name === "Status"
          ? registryConflict('"Status" is already used by Enum "Status" at Domain level.', {
              kind: "sharedEnum",
              domainId: "domain-1",
              productId: null,
            })
          : { success: true, data: undefined }
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        models: [
          { name: "Customer", fields: [] },
          { name: "Address", fields: [] },
        ],
        sharedEnums: [
          { name: "Status", values: ["A"] },
          { name: "Color", values: ["R"] },
        ],
        entities: [{ name: "Customer", fields: [] }],
      });

      expect(result.errors).toEqual([
        'Model "Customer" already exists — skipped',
        'Enum "Status" already exists — skipped',
      ]);
      expect(result.modelsCreated).toBe(1);
      expect(result.modelIds).toEqual(["model-Address"]);
      expect(result.enumsCreated).toBe(1);
      expect(result.entitiesCreated).toBe(1);
      expect(mockTx.modelDefinition.findFirst).toHaveBeenCalledWith({
        where: { name: "Customer", domainId: "domain-1" },
        select: { id: true },
      });
      expect(mockTx.modelDefinition.create).toHaveBeenCalledTimes(1);
      expect(mockTx.sharedEnum.create).toHaveBeenCalledTimes(1);
      expect(mockTx.sharedEnum.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: "Color" }),
      });
    });

    it("skips an already-registered decorator definition", async () => {
      mockTx.decoratorDefinition.findFirst.mockResolvedValue({ id: "decorator-existing" });

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        decoratorDefinitions: [{ name: "pii", signature: "()", targetTypes: ["ModelProperty"] }],
      });

      expect(result.errors).toEqual(['Decorator "pii" already exists — skipped']);
      expect(result.decoratorsCreated).toBe(0);
      expect(mockTx.decoratorDefinition.findFirst).toHaveBeenCalledWith({
        where: { name: "pii", domainId: "domain-1" },
        select: { id: true },
      });
      expect(mockTx.decoratorDefinition.create).not.toHaveBeenCalled();
    });

    it("skips an entity whose slug already exists in the target product", async () => {
      mockTx.entity.findFirst.mockImplementation(async ({ where }) =>
        where.slug === "order-id" ? { id: "entity-existing" } : null
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        entities: [
          { name: "Order Id", fields: [] },
          { name: "Customer", fields: [] },
        ],
      });

      expect(result.errors).toEqual(['Entity "Order Id" already exists — skipped']);
      expect(result.entitiesCreated).toBe(1);
      expect(mockTx.entity.findFirst).toHaveBeenCalledWith({
        where: { slug: "order-id", productId: "prd-default" },
        select: { id: true },
      });
      expect(mockTx.entity.create).toHaveBeenCalledTimes(1);
      expect(mockTx.entity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: "Customer" }) })
      );
    });

    it("skips an entity with a reserved URL segment slug (e.g., Specs) and creates others", async () => {
      mockTx.entity.findFirst.mockResolvedValue(null);

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        entities: [
          { name: "Specs", fields: [] }, // reserved slug "specs"
          { name: "Order", fields: [] }, // OK
        ],
      });

      expect(result.errors).toEqual([
        expect.stringContaining("specs"),
      ]);
      expect(result.entitiesCreated).toBe(1);
      expect(mockTx.entity.create).toHaveBeenCalledTimes(1);
      expect(mockTx.entity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: "Order" }) })
      );
    });

    it("reports a cross-kind or cross-level conflict with the registry message and keeps importing", async () => {
      mockAssertNameAvailable.mockImplementation(async (_tx, candidate) =>
        candidate.name === "Customer"
          ? registryConflict('"Customer" is already used by Enum "Customer" at Enterprise level.', {
              kind: "sharedEnum",
              domainId: null,
              productId: null,
            })
          : { success: true, data: undefined }
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        entities: [
          { name: "Customer", fields: [] },
          { name: "Order", fields: [] },
        ],
      });

      expect(result.errors).toEqual(['"Customer" is already used by Enum "Customer" at Enterprise level.']);
      expect(result.entitiesCreated).toBe(1);
      expect(result.entityIds).toEqual(["entity-Order"]);
    });

    it("treats two assets sharing a name inside one batch as a conflict and skips the later one", async () => {
      const taken = new Map<string, string>();
      mockTx.sharedEnum.create.mockImplementation(async ({ data }) => {
        taken.set(data.name.toLowerCase(), "sharedEnum");
        return { id: `enum-${data.name}` };
      });
      mockAssertNameAvailable.mockImplementation(async (_tx, candidate) =>
        taken.has(candidate.name.toLowerCase())
          ? registryConflict(`"${candidate.name}" taken`, {
              kind: taken.get(candidate.name.toLowerCase()) as string,
              domainId: "domain-1",
              productId: null,
            })
          : { success: true, data: undefined }
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        sharedEnums: [{ name: "Status", values: ["A"] }],
        customScalars: [{ name: "status", baseType: "string" }],
      });

      // different kinds -> the registry's own message, not the "already exists" skip wording
      expect(result.errors).toEqual(['"status" taken']);
      expect(result.enumsCreated).toBe(1);
      expect(result.scalarsCreated).toBe(0);
      expect(mockTx.customScalar.create).not.toHaveBeenCalled();
    });

    it("rolls back with zero counters and a generic cause (not the driver text) when the registry check fails mid-import", async () => {
      mockTx.sharedEnum.create.mockResolvedValue({ id: "enum-Status" });
      mockAssertNameAvailable.mockImplementation(async (_tx, candidate) =>
        candidate.name === "Money"
          ? registryDbError("connection lost")
          : candidate.name === "Skipped"
            ? registryConflict('"Skipped" is already used', { kind: "sharedEnum", domainId: "domain-1", productId: null })
            : { success: true, data: undefined }
      );

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        models: [{ name: "Address", fields: [] }],
        sharedEnums: [
          { name: "Skipped", values: [] },
          { name: "Status", values: ["A"] },
        ],
        customScalars: [{ name: "Money", baseType: "decimal" }],
        unionTypes: [{ name: "Either", memberTypes: ["A"] }],
      });

      // the cause comes first, then what the import had said before it aborted
      expect(result).toEqual(rolledBack([GENERIC_ACTION_ERROR, 'Enum "Skipped" already exists — skipped']));
      expect(mockTx.unionType.create).not.toHaveBeenCalled();
    });

    it("rolls back with zero counters and a generic cause when an unexpected database error escapes a create", async () => {
      mockTx.sharedEnum.create.mockRejectedValue(new Error("deadlock detected"));

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        models: [{ name: "Address", fields: [] }],
        sharedEnums: [{ name: "Status", values: ["A"] }],
      });

      expect(result).toEqual(rolledBack([GENERIC_ACTION_ERROR]));
    });

    it("rolls back with zero counters and creates nothing when the explicit product belongs to another domain", async () => {
      mockTx.product.findUnique.mockResolvedValue({
        id: "prd-other",
        domainId: "other-domain",
        domain: { tenantId: "tenant-1" },
      });

      const result = await createDomainAssetsFromImportAction({
        ...emptyPayload,
        productId: "prd-other",
        models: [{ name: "Address", fields: [] }],
        decoratorDefinitions: [{ name: "pii", signature: "()", targetTypes: [] }],
        sharedEnums: [{ name: "Status", values: ["A"] }],
        entities: [{ name: "Customer", fields: [] }],
      });

      expect(result).toEqual(rolledBack(["Product does not belong to this domain"]));
      expect(mockTx.modelDefinition.create).not.toHaveBeenCalled();
      expect(mockTx.decoratorDefinition.create).not.toHaveBeenCalled();
      expect(mockTx.sharedEnum.create).not.toHaveBeenCalled();
      expect(mockTx.entity.create).not.toHaveBeenCalled();
      expect(mockAssertNameAvailable).not.toHaveBeenCalled();
    });
  });

  describe("source format and field numbers (Story 15.8)", () => {
    const basePayload = {
      domainId: "domain-1",
      models: [],
      entities: [],
      sharedEnums: [],
      customScalars: [],
      unionTypes: [],
      services: [],
      decoratorDefinitions: [],
    };
    const protoField = {
      name: "status",
      type: "enum",
      nullable: true,
      isKey: false,
      description: "",
      classification: null,
      precision: null,
      scale: null,
      fieldNumber: 3,
      decorators: { governance: { protobufFieldNumber: 3 } },
    };

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "user-1", email: "user@example.com" } });
      mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
    });

    it("records the payload's real source format on imported models", async () => {
      await createDomainAssetsFromImportAction({
        ...basePayload,
        sourceFormat: "protobuf",
        namespace: "shop.orders.v1",
        models: [{ name: "Order", fields: [protoField] }],
      });

      expect(mockTx.modelDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Order",
            sourceFormat: "protobuf",
            sourceNamespace: "shop.orders.v1",
          }),
        })
      );
    });

    it("keeps typespec as the model source format when the payload names none", async () => {
      await createDomainAssetsFromImportAction({
        ...basePayload,
        models: [{ name: "Order", fields: [] }],
      });

      expect(mockTx.modelDefinition.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sourceFormat: "typespec" }) })
      );
    });

    it("persists protobuf field numbers on imported entity fields", async () => {
      await createDomainAssetsFromImportAction({
        ...basePayload,
        sourceFormat: "protobuf",
        entities: [{ name: "Order", fields: [protoField] }],
      });

      const data = mockTx.entity.create.mock.calls[0][0].data;
      expect(data.fields.create[0]).toMatchObject({ name: "status", fieldNumber: 3 });
    });
  });
});
