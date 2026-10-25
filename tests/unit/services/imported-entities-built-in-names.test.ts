import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities } from "@/services/imported-entities";

// FINAL WAVE 2b, G6: an import creates entities the same way every other path does, so an entity named like a built-in type
// (`url`, `int32`, `String`) is not created: it is skipped with the reason, like a reserved URL segment, and the rest is imported.

function run(names: string[]) {
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  const skipped: string[] = [];
  const done = createImportedEntities(tx, {
    entities: names.map((name) => ({ name, fields: [] })),
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p",
    ownerId: "u",
    isNameFree: async () => true,
    skip: (message) => skipped.push(message),
    refs: new Map(),
  });
  return { done, create, skipped };
}

describe("createImportedEntities: a built-in type name", () => {
  it("skips an entity named like a built-in type, with the reason, and imports the others", async () => {
    const r = run(["Order", "url", "String", "Customer"]);
    const created = await r.done;
    expect(created.map((c) => c.name)).toEqual(["Order", "Customer"]);
    expect(r.create).toHaveBeenCalledTimes(2);
    expect(r.skipped).toEqual([
      '"url" is a built-in type name in TypeSpec; choose another name.',
      '"String" is a built-in type name in TypeSpec/Java/Protobuf/Avro; choose another name.',
    ]);
  });
});
