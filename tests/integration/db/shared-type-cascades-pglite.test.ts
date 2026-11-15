import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPgliteDb, type TestDb } from "../../helpers/pglite-db";
import { cascadeEnumToFields, cascadeScalarToFields } from "@/services/imported-links";

vi.mock("@/lib/db", () => ({ prisma: {} }));
let db: TestDb;
beforeAll(async () => { db = await createPgliteDb(); }, 60_000);
afterAll(async () => { await db?.close(); });

it.each(["enum", "scalar"] as const)("a product %s cascade leaves sibling products untouched and invalidates only its own source", async (kind) => {
  const p = db.prisma;
  const user = await p.user.create({ data: { email: `cascade-${kind}@example.test` } });
  const domain = await p.domain.create({ data: { name: kind, slug: kind, tenantId: "tenant_default" } });
  const products = await Promise.all(["a", "b"].map((name) => p.product.create({ data: { domainId: domain.id, name, slug: name } })));
  const entities = await Promise.all(products.map((product) => p.entity.create({ data: {
    tenantId: "tenant_default", domainId: domain.id, productId: product.id, name: "Record", slug: "record",
    ownerId: user.id, hasUnpublishedChanges: false, typespecSource: "model Record { value: string; }",
    metadata: { keep: "preserved", sourceStale: false },
  } })));
  const fields = await Promise.all(entities.map((entity) => p.field.create({ data: {
    entityId: entity.id, name: "value", slug: "value", sortOrder: 0, type: kind === "enum" ? "enum" : "string", aliases: ["A"],
    decorators: kind === "enum" ? { enumName: "Shared", typespec: { validation: { pattern: "A" } } } : { scalarName: "Shared", typespec: { validation: { maxLength: 2 } } },
  } })));
  const beforeSibling = await p.field.findUniqueOrThrow({ where: { id: fields[1].id } });
  await p.$transaction(async (tx) => {
    if (kind === "enum") await cascadeEnumToFields(tx, { domainId: domain.id, productId: products[0].id, enum: { name: "Shared", values: ["A", "B"] } });
    else await cascadeScalarToFields(tx, { domainId: domain.id, productId: products[0].id, scalar: { name: "Shared", baseType: "string", constraints: { maxLength: 3 } } });
  });
  const own = await p.entity.findUniqueOrThrow({ where: { id: entities[0].id } });
  const sibling = await p.entity.findUniqueOrThrow({ where: { id: entities[1].id } });
  expect(own.hasUnpublishedChanges).toBe(true);
  expect(own.metadata).toMatchObject({ keep: "preserved", sourceStale: true });
  expect(sibling.hasUnpublishedChanges).toBe(false);
  expect(sibling.metadata).toMatchObject({ keep: "preserved", sourceStale: false });
  expect(await p.field.findUniqueOrThrow({ where: { id: fields[1].id } })).toEqual(beforeSibling);
});
