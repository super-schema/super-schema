import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 12: generation asks for a missing primary key instead of failing, and setEntityPrimaryKeyAction saves the answer.
// Prisma is mocked (the repo's pattern for the entity actions, see by-id-entity-actions-tenant.test.ts): no database is touched.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getActiveTenantId: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  emitOfficial: vi.fn(),
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/typespec-official/emitter.service", () => ({ emitOfficialTypeSpecTargetForEntity: h.emitOfficial }));
vi.mock("@/services/type-mapping.service", () => ({ getOverridesForEntity: vi.fn().mockResolvedValue({ success: true, data: [] }) }));

import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const p = h.prisma;
const FIELDS = [
  { id: "f1", name: "tenant", isKey: false, nullable: false, type: "string", precision: null, scale: null, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
  { id: "f2", name: "note", isKey: false, nullable: true, type: "string" },
  { id: "f3", name: "seq", isKey: false, nullable: false, type: "int32" },
];
const MISSING_KEY_DIAGNOSTIC = "@typespec/bigquery/missing-primary-key: Table 'ImportedEntity' must have at least one @primaryKey property.";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-1");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  p.auditLog.create.mockResolvedValue({ id: "audit-1" });
  p.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1", name: "ImportedEntity", version: 1, metadata: {} });
  p.entity.update.mockResolvedValue({ id: "ent-1" });
  p.field.findMany.mockResolvedValue(FIELDS);
  p.field.updateMany.mockResolvedValue({ count: 1 });
  p.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  h.emitOfficial.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});

describe("setEntityPrimaryKeyAction", () => {
  it("rejects an unauthenticated caller before touching anything", async () => {
    h.auth.mockResolvedValue(null);
    expect(await actions.setEntityPrimaryKeyAction("ent-1", ["tenant"])).toEqual({ error: "Not authenticated" });
    expect(p.field.updateMany).not.toHaveBeenCalled();
  });

  it("answers an entity of another tenant like a missing one and writes nothing", async () => {
    p.entity.findUnique.mockResolvedValue({ tenantId: "tenant-2" });
    const result = await actions.setEntityPrimaryKeyAction("ent-1", ["tenant"]);
    expect(result).toMatchObject({ code: "NOT_FOUND" });
    expect(p.field.updateMany).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    ["unknown name", ["nope"]],
    ["one unknown among known", ["tenant", "nope"]],
    ["duplicate", ["tenant", "tenant"]],
    ["blank", [""]],
    ["non-string", [1 as unknown as string]],
    ["more than 16", Array.from({ length: 17 }, (_, i) => `f${i}`)],
    ["not an array", "tenant" as unknown as string[]],
  ])("rejects %s", async (_label, names) => {
    const result = await actions.setEntityPrimaryKeyAction("ent-1", names);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("sets exactly the requested flags, clears the others, flags unpublished changes and revalidates", async () => {
    const result = await actions.setEntityPrimaryKeyAction("ent-1", ["tenant", "seq"]);
    expect(result).toEqual({ success: true, primaryKey: ["tenant", "seq"] });
    expect(p.field.updateMany).toHaveBeenCalledWith({ where: { entityId: "ent-1", name: { in: ["tenant", "seq"] } }, data: { isKey: true } });
    expect(p.field.updateMany).toHaveBeenCalledWith({ where: { entityId: "ent-1", name: { notIn: ["tenant", "seq"] } }, data: { isKey: false } });
    expect(p.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas");
  });

  it("returns a generic failure (no database text) when the write throws", async () => {
    p.$transaction.mockRejectedValue(new Error("Invalid `prisma.field.updateMany()` invocation in /Users/dev/x.ts"));
    const result = await actions.setEntityPrimaryKeyAction("ent-1", ["tenant"]);
    expect(result).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/prisma|Users\/dev/);
  });
});

describe("setEntityPrimaryKeyAction: key type eligibility", () => {
  it.each(["array", "map", "object", "json", "union"])("rejects a %s field, naming the field and its type", async (type) => {
    p.field.findMany.mockResolvedValue([...FIELDS, { id: "f9", name: "links", isKey: false, type, decorators: {} }]);
    const result = await actions.setEntityPrimaryKeyAction("ent-1", ["tenant", "links"]);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((result as { error: string }).error).toContain('Field "links"');
    expect((result as { error: string }).error).toContain(`type ${type}`);
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a field that holds an unresolved reference, whatever its type", async () => {
    p.field.findMany.mockResolvedValue([...FIELDS, { id: "f9", name: "created_time", isKey: false, type: "reference", decorators: { danglingRef: { ref: "date_time.json" } } }]);
    const result = await actions.setEntityPrimaryKeyAction("ent-1", ["created_time"]);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.stringify(result)).toContain("created_time");
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("still accepts a scalar and a reference to an existing entity", async () => {
    p.field.findMany.mockResolvedValue([...FIELDS, { id: "f9", name: "owner", isKey: false, type: "reference", decorators: { referencedEntityName: "Customer" } }]);
    expect(await actions.setEntityPrimaryKeyAction("ent-1", ["tenant", "owner"])).toMatchObject({ success: true });
  });
});

describe("generateSchemaAction: needs input", () => {
  it.each(["bigquery", "postgresql", "spanner"])("%s with no key answers needsInput and never calls the emitter", async (target) => {
    const result = await actions.generateSchemaAction("ent-1", target);
    expect(result).toMatchObject({ needsInput: [{ code: "primary-key", candidates: ["tenant", "note", "seq"], suggested: ["tenant"] }] });
    expect("error" in result).toBe(false);
    expect(h.emitOfficial).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
  });

  it("emits when a key is flagged", async () => {
    p.field.findMany.mockResolvedValue([{ ...FIELDS[0], isKey: true }, FIELDS[1]]);
    const result = await actions.generateSchemaAction("ent-1", "bigquery");
    expect(h.emitOfficial).toHaveBeenCalledWith("ent-1", "bigquery");
    expect(result).toMatchObject({ success: true });
  });

  it("does not look at fields or ask for a target without requirements", async () => {
    await actions.generateSchemaAction("ent-1", "avro");
    expect(h.emitOfficial).toHaveBeenCalledWith("ent-1", "avro");
  });

  it("turns a missing-primary-key diagnostic that slipped past the pre-check into needsInput", async () => {
    p.field.findMany.mockResolvedValue([{ ...FIELDS[0], isKey: true }, FIELDS[1]]);
    h.emitOfficial.mockResolvedValue({ output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: MISSING_KEY_DIAGNOSTIC }] });
    const result = await actions.generateSchemaAction("ent-1", "bigquery");
    expect(result).toMatchObject({ needsInput: [{ code: "primary-key" }] });
    expect("error" in result).toBe(false);
  });

  it("keeps other emitter failures as the error string", async () => {
    p.field.findMany.mockResolvedValue([{ ...FIELDS[0], isKey: true }]);
    h.emitOfficial.mockResolvedValue({ output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: "@typespec/spanner/invalid-interleave-pk: nope" }] });
    expect(await actions.generateSchemaAction("ent-1", "spanner")).toEqual({ error: "@typespec/spanner/invalid-interleave-pk: nope" });
  });
});

describe("getSchemaGenerationRequirementsAction", () => {
  it("is not available to an unauthenticated caller or another tenant", async () => {
    h.auth.mockResolvedValue(null);
    expect(await actions.getSchemaGenerationRequirementsAction("ent-1", "bigquery")).toEqual({ error: "Not authenticated" });
    h.auth.mockResolvedValue({ user: { id: "user-1" } });
    p.entity.findUnique.mockResolvedValue({ tenantId: "tenant-2" });
    expect(await actions.getSchemaGenerationRequirementsAction("ent-1", "bigquery")).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports the missing key before emitting, and nothing for other targets", async () => {
    expect(await actions.getSchemaGenerationRequirementsAction("ent-1", "bigquery")).toMatchObject({ needsInput: [{ code: "primary-key" }] });
    expect(await actions.getSchemaGenerationRequirementsAction("ent-1", "avro")).toEqual({ needsInput: [] });
    expect(h.emitOfficial).not.toHaveBeenCalled();
  });
});
