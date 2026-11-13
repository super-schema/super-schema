// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import {
  createMetadataAttribute,
  deleteMetadataAttribute,
  listMetadataAttributes,
  updateMetadataAttribute,
} from "@/services/metadata-attribute.service";

const db = () => holder.db!.prisma;
let n = 0;
const mkTenant = () => db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });
const input = (key: string, extra: object = {}) => ({ key, label: key, valueSchema: { type: "string" }, targets: ["field"], ...extra });

afterAll(async () => {
  await holder.db?.close();
});
beforeEach(async () => {
  await db().metadataAttributeDefinition.deleteMany();
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

describe("metadata attribute service on PGlite", () => {
  it("scopes by tenant and filters by target", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    expect((await createMetadataAttribute(a.id, input("x-one"))).success).toBe(true);
    expect((await createMetadataAttribute(a.id, input("x-ent", { targets: ["entity"] }))).success).toBe(true);
    expect((await createMetadataAttribute(b.id, input("x-one"))).success).toBe(true);
    const all = await listMetadataAttributes(a.id);
    expect(all.success && all.data.map((d) => d.key).sort()).toEqual(["x-ent", "x-one"]);
    const ent = await listMetadataAttributes(a.id, "entity");
    expect(ent.success && ent.data.map((d) => d.key)).toEqual(["x-ent"]);
    const other = await listMetadataAttributes(b.id);
    expect(other.success && other.data).toHaveLength(1);
  });

  it("DUPLICATE_KEY within a tenant only", async () => {
    const a = await mkTenant();
    await createMetadataAttribute(a.id, input("x-dup"));
    const r = await createMetadataAttribute(a.id, input("x-dup"));
    expect(!r.success && r.error.code).toBe("DUPLICATE_KEY");
  });

  it("INVALID_VALUE_SCHEMA and validation errors", async () => {
    const a = await mkTenant();
    const r = await createMetadataAttribute(a.id, input("x-bad", { valueSchema: { type: "string", oneOf: [] } }));
    expect(!r.success && r.error.code).toBe("INVALID_VALUE_SCHEMA");
    const k = await createMetadataAttribute(a.id, input("noprefix"));
    expect(!k.success && k.error.code).toBe("VALIDATION_ERROR");
  });

  it("updates and deletes within the tenant; other tenants get NOT_FOUND", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const c = await createMetadataAttribute(a.id, input("x-u"));
    if (!c.success) throw new Error("create");
    const u = await updateMetadataAttribute(a.id, c.data.id, { label: "New" });
    expect(u.success && u.data.label).toBe("New");
    const bad = await updateMetadataAttribute(a.id, c.data.id, { valueSchema: { type: "x" } as never });
    expect(!bad.success && bad.error.code).toBe("INVALID_VALUE_SCHEMA");
    const cross = await updateMetadataAttribute(b.id, c.data.id, { label: "Hack" });
    expect(!cross.success && cross.error.code).toBe("NOT_FOUND");
    const crossDel = await deleteMetadataAttribute(b.id, c.data.id);
    expect(!crossDel.success && crossDel.error.code).toBe("NOT_FOUND");
    expect((await deleteMetadataAttribute(a.id, c.data.id)).success).toBe(true);
  });

  it("PACK_OWNED on update/delete of pack rows", async () => {
    const a = await mkTenant();
    const row = await db().metadataAttributeDefinition.create({
      data: { tenantId: a.id, key: "x-packed", label: "P", valueSchema: { type: "string" }, targets: ["field"], pack: "paypal" },
    });
    const u = await updateMetadataAttribute(a.id, row.id, { label: "Z" });
    expect(!u.success && u.error.code).toBe("PACK_OWNED");
    const d = await deleteMetadataAttribute(a.id, row.id);
    expect(!d.success && d.error.code).toBe("PACK_OWNED");
  });

  it("assigns Protobuf option numbers from 50000 per tenant and never reuses one, not even the highest after a delete", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const num = async (tenantId: string, key: string) => {
      const r = await createMetadataAttribute(tenantId, input(key));
      if (!r.success) throw new Error(r.error.message);
      return r.data.protobufOptionNumber;
    };
    expect(await num(a.id, "x-a1")).toBe(50000);
    const second = await createMetadataAttribute(a.id, input("x-a2"));
    if (!second.success) throw new Error("create");
    expect(second.data.protobufOptionNumber).toBe(50001);
    expect(await num(b.id, "x-b1")).toBe(50000);
    // Deleting the highest number does not give it back.
    expect((await deleteMetadataAttribute(a.id, second.data.id)).success).toBe(true);
    expect(await num(a.id, "x-a3")).toBe(50002);
    // A refused create (duplicate key) consumes nothing.
    expect((await createMetadataAttribute(a.id, input("x-a3"))).success).toBe(false);
    expect(await num(a.id, "x-a4")).toBe(50003);
    // An update keeps the number.
    const listed = await listMetadataAttributes(a.id);
    const a1 = listed.success ? listed.data.find((d) => d.key === "x-a1") : undefined;
    const u = await updateMetadataAttribute(a.id, a1!.id, { label: "Renamed" });
    expect(u.success && u.data.protobufOptionNumber).toBe(50000);
  });

  it("concurrent creates in one tenant get distinct numbers", async () => {
    const a = await mkTenant();
    const results = await Promise.all(["x-c1", "x-c2", "x-c3", "x-c4"].map((k) => createMetadataAttribute(a.id, input(k))));
    const numbers = results.map((r) => (r.success ? r.data.protobufOptionNumber : null));
    expect([...numbers].sort()).toEqual([50000, 50001, 50002, 50003]);
  });

  it("refuses a create once the tenant has used every number up to 99999", async () => {
    const a = await mkTenant();
    await db().metadataAttributeCounter.create({ data: { tenantId: a.id, nextProtobufOption: 99999 } });
    const last = await createMetadataAttribute(a.id, input("x-last"));
    expect(last.success && last.data.protobufOptionNumber).toBe(99999);
    const over = await createMetadataAttribute(a.id, input("x-over"));
    expect(!over.success && over.error.code).toBe("PROTOBUF_OPTION_NUMBERS_EXHAUSTED");
    expect(await db().metadataAttributeDefinition.count({ where: { tenantId: a.id, key: "x-over" } })).toBe(0);
  });
});
