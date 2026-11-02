import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";

// The bulk schema import gives each entity its URL name (its slug), as every other create does. A name with no letter or digit in any script has
// none: such an entity is skipped with a message (a stored empty slug would open the product page, and the next one would be refused as taken).
// A non-Latin name has a URL name of its own, so two of them are both created.

async function importEntities(names: string[]) {
  const auditCreate = vi.fn(async () => ({}));
  const create = vi.fn(async ({ data }: { data: { name: string; slug: string } }) => ({ id: `id-${data.name}` }));
  const tx = {
    field: { findMany: vi.fn(async () => []) },
    entity: { create, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn(async () => []) },
    auditLog: { create: auditCreate },
  } as unknown as Prisma.TransactionClient;
  const skipped: string[] = [];
  await createImportedEntities(tx, {
    entities: names.map((name): ImportedEntityInput => ({ name, fields: [] })),
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    isNameFree: async () => true,
    skip: (message) => skipped.push(message),
    refs: new Map(),
  });
  return {
    created: create.mock.calls.map(([args]) => args.data),
    audited: auditCreate.mock.calls.length,
    skipped,
  };
}

describe("createImportedEntities: the URL name of an imported entity", () => {
  it("skips a name with no letter or digit, with a message, and creates nothing for it", async () => {
    const { created, audited, skipped } = await importEntities(["_", "!!!", "Orders"]);

    expect(created.map((data) => data.name)).toEqual(["Orders"]);
    // Only the entity that is created is audited; a skipped name leaves no audit row.
    expect(audited).toBe(1);
    expect(skipped).toEqual([
      'Entity "_" must contain at least one letter or digit — skipped',
      'Entity "!!!" must contain at least one letter or digit — skipped',
    ]);
  });

  it("gives two non-Latin names a URL name each, so both are created with distinct slugs", async () => {
    const { created, skipped } = await importEntities(["名前", "年齢"]);

    expect(skipped).toEqual([]);
    expect(created.map((data) => data.slug)).toEqual([expect.stringMatching(/^item-[0-9a-z]+$/), expect.stringMatching(/^item-[0-9a-z]+$/)]);
    expect(created[0].slug).not.toBe(created[1].slug);
  });
});
