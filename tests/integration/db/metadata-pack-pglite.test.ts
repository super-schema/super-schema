// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { installMetadataPack, installedPacks, uninstallMetadataPack } from "@/services/metadata-pack.service";
import { createMetadataAttribute, listMetadataAttributes } from "@/services/metadata-attribute.service";

const db = () => holder.db!.prisma;
const PACK = "paypal-security-classification";
let n = 0;

afterAll(async () => {
  await holder.db?.close();
});
beforeEach(async () => {
  await db().field.deleteMany();
  await db().entity.deleteMany();
  await db().metadataAttributeDefinition.deleteMany();
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

async function seed() {
  const tenant = await db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });
  const user = await db().user.create({ data: { email: `u${n}@example.test` } });
  const entity = await db().entity.create({ data: { name: `E${n}`, slug: `e${n}`, tenantId: tenant.id, ownerId: user.id } });
  const mk = (name: string, classification: string | null) =>
    db().field.create({ data: { entityId: entity.id, name, slug: name, type: "string", sortOrder: 0, classification } });
  const pii = await mk("email", "PII");
  const pub = await mk("title", "PUBLIC");
  const none = await mk("note", null);
  return { tenant, pii, pub, none };
}

const valueOf = async (id: string) => {
  const f = await db().field.findUniqueOrThrow({ where: { id } });
  return (f.decorators as { typespec?: { extensions?: { openapi?: Record<string, unknown> } } } | null)?.typespec?.extensions?.openapi?.["x-securityClassification"];
};

describe("metadata packs on PGlite", () => {
  it("install writes the definition and derives data_class for every primitive field", async () => {
    const { tenant, pii, pub, none } = await seed();
    const r = await installMetadataPack(tenant.id, PACK);
    expect(r.success).toBe(true);
    const defs = await db().metadataAttributeDefinition.findMany({ where: { tenantId: tenant.id } });
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ key: "x-securityClassification", pack: PACK });
    expect(await valueOf(pii.id)).toMatchObject({ data_class: "class2" });
    expect(await valueOf(pub.id)).toMatchObject({ data_class: "class5" });
    expect(await valueOf(none.id)).toMatchObject({ data_class: "class3" });
    expect(await installedPacks(tenant.id)).toEqual([PACK]);
  });

  it("a second install is idempotent", async () => {
    const { tenant } = await seed();
    await installMetadataPack(tenant.id, PACK);
    const again = await installMetadataPack(tenant.id, PACK);
    expect(again.success).toBe(true);
    expect(await db().metadataAttributeDefinition.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("refuses with KEY_CONFLICT and writes nothing when a tenant-owned row has the key", async () => {
    const { tenant, pii } = await seed();
    const own = await createMetadataAttribute(tenant.id, {
      key: "x-securityClassification", label: "Mine", valueSchema: { type: "string" }, targets: ["field"],
    });
    expect(own.success).toBe(true);
    const r = await installMetadataPack(tenant.id, PACK);
    expect(r).toMatchObject({ success: false, error: { code: "KEY_CONFLICT" } });
    const rows = await db().metadataAttributeDefinition.findMany({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Mine", pack: null });
    expect(await valueOf(pii.id)).toBeUndefined();
    expect(await installedPacks(tenant.id)).toEqual([]);
  });

  it("an unknown pack is NOT_FOUND", async () => {
    const { tenant } = await seed();
    expect(await installMetadataPack(tenant.id, "nope")).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("uninstall removes the definition and leaves field values", async () => {
    const { tenant, pii } = await seed();
    await installMetadataPack(tenant.id, PACK);
    const r = await uninstallMetadataPack(tenant.id, PACK);
    expect(r.success).toBe(true);
    const listed = await listMetadataAttributes(tenant.id);
    expect(listed.success && listed.data).toEqual([]);
    expect(await valueOf(pii.id)).toMatchObject({ data_class: "class2" });
    expect(await installedPacks(tenant.id)).toEqual([]);
  });

  it("is scoped by tenant", async () => {
    const a = await seed();
    const b = await seed();
    await installMetadataPack(a.tenant.id, PACK);
    expect(await installedPacks(b.tenant.id)).toEqual([]);
    expect(await valueOf(b.pii.id)).toBeUndefined();
  });

  it("pack rows take option numbers from the same per-tenant counter, keep theirs on reinstall, and never reuse one", async () => {
    const { tenant } = await seed();
    const own = await createMetadataAttribute(tenant.id, { key: "x-own", label: "Own", valueSchema: { type: "string" }, targets: ["field"] });
    expect(own.success && own.data.protobufOptionNumber).toBe(50000);
    await installMetadataPack(tenant.id, PACK);
    const numberOf = async () =>
      (await db().metadataAttributeDefinition.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: "x-securityClassification" } } }))
        .protobufOptionNumber;
    expect(await numberOf()).toBe(50001);
    await installMetadataPack(tenant.id, PACK);
    expect(await numberOf()).toBe(50001);
    await uninstallMetadataPack(tenant.id, PACK);
    await installMetadataPack(tenant.id, PACK);
    expect(await numberOf()).toBe(50002);
    const next = await createMetadataAttribute(tenant.id, { key: "x-next", label: "Next", valueSchema: { type: "string" }, targets: ["field"] });
    expect(next.success && next.data.protobufOptionNumber).toBe(50003);
  });
});
