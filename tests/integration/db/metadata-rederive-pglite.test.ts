// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { createMetadataAttribute } from "@/services/metadata-attribute.service";
import { loadDerivationContext, rederiveForLevel, rederiveTenant } from "@/services/metadata-rederive.service";
import { updateClassification } from "@/services/classification-taxonomy.service";
import type { ServiceContext } from "@/types/service-context";

const ADMIN = { userId: "admin-1", userRole: "ADMIN", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma: null } as unknown as ServiceContext;

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

  it("changes a custom level's class and re-derives its fields in ONE transaction, with no query outside it (C4)", async () => {
    const { field } = await seed("FINANCIAL");
    const level = await db().classificationLevel.create({
      data: { name: "FINANCIAL", displayColor: "#000", bgColor: "#fff", textColor: "#000", classNumber: 3 },
    });
    // PGlite has one connection: a global-client query inside the interactive transaction would never return.
    const res = await Promise.race([
      updateClassification({ id: level.id, classNumber: 2 }, ADMIN),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
    ]);
    expect(res).not.toBe("hung");
    expect(res).toMatchObject({ success: true });
    const after = await db().field.findUniqueOrThrow({ where: { id: field.id } });
    expect(after.decorators).toEqual(stored({ data_class: "class2", data_category: "Intrinsic" }));
  });

  it("derives with the field's domain policy: a domain override of requiredWhen applies on re-derive (C6)", async () => {
    const tenant = await db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });
    const user = await db().user.create({ data: { email: `u${n}@example.test` } });
    const strict = await db().domain.create({
      data: { tenantId: tenant.id, name: "Strict", slug: `strict${n}`, policyTemplate: { metadataAttributes: { "x-securityClassification": { requiredWhen: "primitive" } } } },
    });
    const loose = await db().domain.create({ data: { tenantId: tenant.id, name: "Loose", slug: `loose${n}` } });
    const mk = async (domainId: string, name: string) => {
      const product = await db().product.create({ data: { domainId, name: `P${name}`, slug: `p${name.toLowerCase()}${n}` } });
      const entity = await db().entity.create({ data: { name, slug: name.toLowerCase(), tenantId: tenant.id, ownerId: user.id, domainId, productId: product.id } });
      return db().field.create({ data: { entityId: entity.id, name: "amount", slug: "amount", type: "string", sortOrder: 0, classification: "PII", decorators: {} } });
    };
    const inStrict = await mk(strict.id, "A");
    const inLoose = await mk(loose.id, "B");
    const def = await createMetadataAttribute(tenant.id, {
      key: "x-securityClassification", label: "S",
      valueSchema: { type: "object", properties: { data_class: { type: "string" } } },
      targets: ["field"], placement: "abc-primitive", derive: { data_class: "class{class}" }, requiredWhen: "never",
    });
    expect(def.success).toBe(true);
    await rederiveTenant(tenant.id);
    expect((await db().field.findUniqueOrThrow({ where: { id: inStrict.id } })).decorators).toEqual(stored({ data_class: "class2" }));
    expect((await db().field.findUniqueOrThrow({ where: { id: inLoose.id } })).decorators).toEqual({});
    // The single-field writers (update, TypeSpec apply, reference set, imports) load their context for the field's entity or domain.
    const forStrict = await loadDerivationContext(tenant.id, db(), { entityId: inStrict.entityId });
    const forLoose = await loadDerivationContext(tenant.id, db(), { entityId: inLoose.entityId });
    const forDomain = await loadDerivationContext(tenant.id, db(), { domainId: strict.id });
    expect(forStrict?.defs[0].requiredWhen).toBe("primitive");
    expect(forDomain?.defs[0].requiredWhen).toBe("primitive");
    expect(forLoose?.defs[0].requiredWhen).toBe("never");
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
