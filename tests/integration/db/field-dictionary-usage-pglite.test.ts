// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { createFieldDictionaryEntry, dictionaryUsage } from "@/services/field-dictionary.service";
import { createMetadataAttribute } from "@/services/metadata-attribute.service";

const db = () => holder.db!.prisma;
let n = 0;
const mkTenant = () => db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });

afterAll(async () => {
  await holder.db?.close();
});
beforeEach(async () => {
  await db().field.deleteMany();
  await db().entity.deleteMany();
  await db().user.deleteMany({ where: { email: "dict-usage@example.test" } });
  await db().fieldDictionaryEntry.deleteMany();
  await db().metadataAttributeDefinition.deleteMany();
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

async function setup() {
  const t = await mkTenant();
  const user = await db().user.create({ data: { email: "dict-usage@example.test" } });
  const entity = await db().entity.create({ data: { name: "Customer", slug: "customer", tenantId: t.id, ownerId: user.id } });
  const entity2 = await db().entity.create({ data: { name: "Order", slug: "order", tenantId: t.id, ownerId: user.id } });
  return { t, entity, entity2 };
}
const mkField = (entityId: string, name: string, extra: object = {}) =>
  db().field.create({ data: { entityId, name, slug: name, type: "string", sortOrder: 0, ...extra } });
const ext = (openapi: object) => ({ typespec: { extensions: { openapi } } });

describe("dictionaryUsage on PGlite", () => {
  it("lists linked fields with drift; an unlinked field with the same name is not listed", async () => {
    const { t, entity, entity2 } = await setup();
    const e = await createFieldDictionaryEntry(t.id, { name: "email", type: "string", description: "Email" });
    if (!e.success) throw new Error("setup");
    const same = await mkField(entity.id, "email", { description: "Email", dictionaryEntryId: e.data.id });
    const changed = await mkField(entity2.id, "email", { description: "Billing email", dictionaryEntryId: e.data.id });
    await mkField(entity2.id, "email2", { description: "Email" });
    const r = await dictionaryUsage(t.id, e.data.id);
    if (!r.success) throw new Error(r.error.message);
    expect(r.data).toHaveLength(2);
    expect(r.data.find((u) => u.fieldId === same.id)).toMatchObject({ entityName: "Customer", entitySlug: "customer", drift: [] });
    expect(r.data.find((u) => u.fieldId === changed.id)).toMatchObject({ entityName: "Order", drift: ["description"] });
  });

  it("reports type, classification and attribute drift; a derived member difference is not drift", async () => {
    const { t, entity } = await setup();
    await createMetadataAttribute(t.id, { key: "x-tier", label: "Tier", valueSchema: { type: "string" }, targets: ["field"] });
    await createMetadataAttribute(t.id, {
      key: "x-sec",
      label: "Sec",
      targets: ["field"],
      valueSchema: { type: "object", properties: { owner: { type: "string" }, data_class: { type: "string" } } },
      derive: { data_class: "{class}" },
    });
    const e = await createFieldDictionaryEntry(t.id, {
      name: "ssn",
      type: "string",
      classification: "PII",
      attributes: { "x-tier": "gold", "x-sec": { owner: "a" } },
    });
    if (!e.success) throw new Error("setup");
    const derivedOnly = await mkField(entity.id, "ssn", {
      classification: "PII",
      dictionaryEntryId: e.data.id,
      decorators: ext({ "x-tier": "gold", "x-sec": { owner: "a", data_class: "PII" } }),
    });
    const all = await mkField(entity.id, "ssn2", {
      type: "integer",
      classification: "SENSITIVE",
      dictionaryEntryId: e.data.id,
      decorators: ext({ "x-tier": "silver", "x-sec": { owner: "a" } }),
    });
    const r = await dictionaryUsage(t.id, e.data.id);
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.find((u) => u.fieldId === derivedOnly.id)!.drift).toEqual([]);
    expect(r.data.find((u) => u.fieldId === all.id)!.drift).toEqual(["type", "classification", "attributes"]);
  });

  it("NOT_FOUND for another tenant's entry", async () => {
    const { t } = await setup();
    const other = await mkTenant();
    const e = await createFieldDictionaryEntry(t.id, { name: "email", type: "string" });
    if (!e.success) throw new Error("setup");
    const r = await dictionaryUsage(other.id, e.data.id);
    expect(!r.success && r.error.code).toBe("NOT_FOUND");
  });
});
