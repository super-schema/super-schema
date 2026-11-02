import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities } from "@/services/imported-entities";

describe("createImportedEntities: the creation of each entity is audited", () => {
  it("writes an Entity CREATE row in the same transaction, under the importing user and the tenant", async () => {
    const auditCreate = vi.fn<(args: { data: Record<string, unknown> }) => Promise<object>>(async () => ({}));
    const entityCreate = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}`, name: data.name, productId: "p" }));
    const tx = {
      auditLog: { create: auditCreate },
      field: { findMany: vi.fn(async () => []) },
      entity: { create: entityCreate, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) },
    } as unknown as Prisma.TransactionClient;

    const created = await createImportedEntities(tx, {
      entities: [{ name: "Order", fields: [] }],
      productScope: { tenantId: "t1", domainId: "d", productId: "p" },
      productId: "p",
      ownerId: "u1",
      isNameFree: async () => true,
      skip: () => {},
      refs: new Map(),
    });

    expect(created).toEqual([{ id: "id-Order", name: "Order" }]);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId: "u1",
      tenantId: "t1",
      afterState: { id: "id-Order", name: "Order" },
    });
  });

  it("writes one Entity CREATE row per entity created", async () => {
    const auditCreate = vi.fn<(args: { data: Record<string, unknown> }) => Promise<object>>(async () => ({}));
    const tx = {
      auditLog: { create: auditCreate },
      field: { findMany: vi.fn(async () => []) },
      entity: {
        create: vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}`, name: data.name, productId: "p" })),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(async () => []),
      },
    } as unknown as Prisma.TransactionClient;

    await createImportedEntities(tx, {
      entities: [
        { name: "Order", fields: [] },
        { name: "Customer", fields: [] },
      ],
      productScope: { tenantId: "t1", domainId: "d", productId: "p" },
      productId: "p",
      ownerId: "u1",
      isNameFree: async () => true,
      skip: () => {},
      refs: new Map(),
    });

    expect(auditCreate.mock.calls.map((call) => call[0].data.afterState)).toEqual([
      expect.objectContaining({ id: "id-Order" }),
      expect.objectContaining({ id: "id-Customer" }),
    ]);
  });
});
