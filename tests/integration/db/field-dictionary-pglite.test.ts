// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import {
  createFieldDictionaryEntry,
  deleteFieldDictionaryEntry,
  dictionaryFormOptions,
  listFieldDictionary,
  updateFieldDictionaryEntry,
} from "@/services/field-dictionary.service";
import { createMetadataAttribute } from "@/services/metadata-attribute.service";

const db = () => holder.db!.prisma;
let n = 0;
const mkTenant = () => db().tenant.create({ data: { name: `T${++n}`, slug: `t${n}` } });
const input = (name: string, extra: object = {}) => ({ name, type: "string", ...extra });

afterAll(async () => {
  await holder.db?.close();
});
beforeEach(async () => {
  await db().field.deleteMany();
  await db().entity.deleteMany();
  await db().user.deleteMany({ where: { email: "dict-owner@example.test" } });
  await db().fieldDictionaryEntry.deleteMany();
  await db().metadataAttributeDefinition.deleteMany();
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

describe("field dictionary service on PGlite", () => {
  it("form options: the standard and custom classification levels by class, and the tenant's custom scalars and shared enums (U9)", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    await db().classificationLevel.deleteMany({ where: { isSystem: false } });
    await db().classificationLevel.create({ data: { name: "FINANCIAL", displayColor: "#000", bgColor: "#fff", textColor: "#000", classNumber: 2 } });
    await db().customScalar.create({ data: { tenantId: a.id, name: "Currency", baseType: "string" } });
    await db().sharedEnum.create({ data: { tenantId: a.id, name: "Status", values: ["A"] } });
    await db().sharedEnum.create({ data: { tenantId: a.id, name: "Status", values: ["B"] } }); // same name in another domain: listed once
    await db().customScalar.create({ data: { tenantId: b.id, name: "Other", baseType: "string" } });
    const options = await dictionaryFormOptions(a.id);
    expect(options.customTypes).toEqual(["Currency", "Status"]);
    const names = options.levels.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(["NEVER_STORED", "PII", "SENSITIVE", "INTERNAL", "PUBLIC", "FINANCIAL"]));
    expect(new Set(names).size).toBe(names.length);
    expect(options.levels.find((l) => l.name === "FINANCIAL")?.classNumber).toBe(2);
    // Ordered by class number.
    const classes = options.levels.map((l) => l.classNumber);
    expect([...classes].sort((x, y) => x - y)).toEqual(classes);
  });

  it("scopes by tenant; the same name is allowed in another tenant", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    expect((await createFieldDictionaryEntry(a.id, input("email"))).success).toBe(true);
    expect((await createFieldDictionaryEntry(b.id, input("email"))).success).toBe(true);
    const list = await listFieldDictionary(a.id);
    expect(list.success && list.data).toHaveLength(1);
    const other = await listFieldDictionary(b.id);
    expect(other.success && other.data[0].tenantId).toBe(b.id);
  });

  it("DUPLICATE_NAME within a tenant; names are case-sensitive", async () => {
    const a = await mkTenant();
    await createFieldDictionaryEntry(a.id, input("email"));
    const dup = await createFieldDictionaryEntry(a.id, input("email"));
    expect(!dup.success && dup.error.code).toBe("DUPLICATE_NAME");
    expect((await createFieldDictionaryEntry(a.id, input("Email"))).success).toBe(true);
  });

  it("ALIAS_CONFLICT when an alias equals another entry's name or alias (case-insensitively)", async () => {
    const a = await mkTenant();
    await createFieldDictionaryEntry(a.id, input("customer_id", { aliases: ["custId"] }));
    const byName = await createFieldDictionaryEntry(a.id, input("acct", { aliases: ["CUSTOMER_ID"] }));
    expect(!byName.success && byName.error.code).toBe("ALIAS_CONFLICT");
    const byAlias = await createFieldDictionaryEntry(a.id, input("acct", { aliases: ["custid"] }));
    expect(!byAlias.success && byAlias.error.code).toBe("ALIAS_CONFLICT");
    const nameAsAlias = await createFieldDictionaryEntry(a.id, input("custId"));
    expect(!nameAsAlias.success && nameAsAlias.error.code).toBe("ALIAS_CONFLICT");
    const b = await mkTenant();
    expect((await createFieldDictionaryEntry(b.id, input("acct", { aliases: ["custId"] }))).success).toBe(true);
  });

  it("update keeps its own aliases, rejects a clash, and cannot reach another tenant's entry", async () => {
    const a = await mkTenant();
    const b = await mkTenant();
    const one = await createFieldDictionaryEntry(a.id, input("one", { aliases: ["uno"] }));
    const two = await createFieldDictionaryEntry(a.id, input("two"));
    if (!one.success || !two.success) throw new Error("setup");
    expect((await updateFieldDictionaryEntry(a.id, one.data.id, { description: "d" })).success).toBe(true);
    const clash = await updateFieldDictionaryEntry(a.id, two.data.id, { aliases: ["UNO"] });
    expect(!clash.success && clash.error.code).toBe("ALIAS_CONFLICT");
    const dup = await updateFieldDictionaryEntry(a.id, two.data.id, { name: "one" });
    expect(!dup.success && dup.error.code).toBe("DUPLICATE_NAME");
    const cross = await updateFieldDictionaryEntry(b.id, one.data.id, { description: "x" });
    expect(!cross.success && cross.error.code).toBe("NOT_FOUND");
    const del = await deleteFieldDictionaryEntry(b.id, one.data.id);
    expect(!del.success && del.error.code).toBe("NOT_FOUND");
  });

  it("validates a default attribute against its definition; an unknown key is allowed", async () => {
    const a = await mkTenant();
    await createMetadataAttribute(a.id, { key: "x-tier", label: "Tier", valueSchema: { type: "string", enum: ["gold"] }, targets: ["field"] });
    const bad = await createFieldDictionaryEntry(a.id, input("e1", { attributes: { "x-tier": "bronze" } }));
    expect(!bad.success && bad.error.code).toBe("INVALID_ATTRIBUTE_VALUE");
    expect((await createFieldDictionaryEntry(a.id, input("e2", { attributes: { "x-tier": "gold" } }))).success).toBe(true);
    expect((await createFieldDictionaryEntry(a.id, input("e3", { attributes: { "x-unknown": 1 } }))).success).toBe(true);
  });

  it("deleting an entry sets Field.dictionaryEntryId to null and keeps the field", async () => {
    const a = await mkTenant();
    const e = await createFieldDictionaryEntry(a.id, input("email"));
    if (!e.success) throw new Error("setup");
    const user = await db().user.create({ data: { email: "dict-owner@example.test" } });
    const entity = await db().entity.create({ data: { name: "Cust", slug: "cust", tenantId: a.id, ownerId: user.id } });
    const field = await db().field.create({
      data: { entityId: entity.id, name: "email", slug: "email", type: "string", sortOrder: 0, dictionaryEntryId: e.data.id },
    });
    expect((await deleteFieldDictionaryEntry(a.id, e.data.id)).success).toBe(true);
    const after = await db().field.findUnique({ where: { id: field.id } });
    expect(after).not.toBeNull();
    expect(after!.dictionaryEntryId).toBeNull();
  });
});
