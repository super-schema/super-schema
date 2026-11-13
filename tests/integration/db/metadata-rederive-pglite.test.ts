// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { createMetadataAttribute } from "@/services/metadata-attribute.service";
import { rederiveForLevel } from "@/services/metadata-rederive.service";

const db = () => holder.db!.prisma;
let n = 0;

const stored = (v: Record<string, string>) => ({ typespec: { extensions: { openapi: { "x-securityClassification": v } } } });

afterAll(async () => {
  await holder.db?.close();
});
beforeEach(async () => {
  await db().field.deleteMany();
  await db().entity.deleteMany();
  await db().metadataAttributeDefinition.deleteMany();
  await db().classificationLevel.deleteMany({ where: { isSystem: false } });
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

async function seed(classification: string) {
  const tenant = await db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });
  const user = await db().user.create({ data: { email: `u${n}@example.test` } });
  const entity = await db().entity.create({ data: { name: `E${n}`, slug: `e${n}`, tenantId: tenant.id, ownerId: user.id } });
  const field = await db().field.create({
    data: {
      entityId: entity.id, name: "amount", slug: "amount", type: "string", sortOrder: 0, classification,
      decorators: stored({ data_class: "class3", data_category: "Intrinsic" }),
    },
  });
  const def = await createMetadataAttribute(tenant.id, {
    key: "x-securityClassification",
    label: "Security classification",
    valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
    targets: ["field"],
    placement: "abc-primitive",
    derive: { data_class: "class{class}" },
    requiredWhen: "primitive",
  });
  expect(def.success).toBe(true);
  return { field, entity };
}

describe("rederiveForLevel on PGlite", () => {
  it("re-derives data_class of fields on a custom level after its class changes 3 -> 2, keeping the category", async () => {
    const { field } = await seed("FINANCIAL");
    await db().classificationLevel.create({
      data: { name: "FINANCIAL", displayColor: "#000", bgColor: "#fff", textColor: "#000", classNumber: 3 },
    });
    await db().classificationLevel.update({ where: { name: "FINANCIAL" }, data: { classNumber: 2 } });

    await rederiveForLevel("FINANCIAL");

    const after = await db().field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.decorators).toEqual(stored({ data_class: "class2", data_category: "Intrinsic" }));
  });

  it("leaves fields of other levels alone", async () => {
    const { field } = await seed("INTERNAL");
    await db().classificationLevel.create({
      data: { name: "FINANCIAL", displayColor: "#000", bgColor: "#fff", textColor: "#000", classNumber: 2 },
    });
    await rederiveForLevel("FINANCIAL");
    const after = await db().field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.decorators).toEqual(stored({ data_class: "class3", data_category: "Intrinsic" }));
  });
});
