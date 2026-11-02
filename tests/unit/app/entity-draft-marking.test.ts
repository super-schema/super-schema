import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockCompile } = vi.hoisted(() => ({
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    // The row lock a metadata write takes first (`SELECT ... FOR UPDATE`).
    $queryRaw: vi.fn(async () => [{ id: "ent-1" }]),
    $transaction: vi.fn(),
  },
  mockCompile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: mockCompile }));

import { MARK_DRAFT_CHANGED_SQL, CLEAR_SOURCE_STALE_SQL } from "@/lib/entity-versioning/draft-state";
import {
  addFieldAction,
  updateFieldAction,
  deleteFieldAction,
  applyTypeSpecAction,
  updateEntityDescriptionAction,
  updateEntityMetadataAction,
  updateEntityRelationshipsAction,
  compileAndApplyTypeSpecSourceAction,
  getTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

/** Draft edits flag the draft changed AND the stored typespecSource stale in one statement. */
const expectFieldsEdited = () =>
  expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "ent-1");

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.findMany.mockResolvedValue([]);
  // The entity of the active tenant (the by-id ownership guard reads it).
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1", metadata: {} });
  // $transaction([...]) batch form: resolve every operation. The interactive form (a callback) runs it on this same client.
  mockPrisma.$transaction.mockImplementation(async (ops: unknown) =>
    typeof ops === "function" ? (ops as (tx: unknown) => unknown)(mockPrisma) : Promise.all(ops as unknown[])
  );
});

describe("draft-mutating entity actions set hasUnpublishedChanges", () => {
  it("addFieldAction marks the draft changed and the source stale", async () => {
    mockPrisma.field.create.mockResolvedValue({ id: "fld-1", entityId: "ent-1" });
    expect(await addFieldAction("ent-1", "email", "string")).toMatchObject({ success: true });
    expectFieldsEdited();
  });

  it("updateFieldAction marks the draft changed and the source stale", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email", entity: { tenantId: "tenant-1" } });
    mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
    expect(await updateFieldAction("fld-1", { description: "Primary email" })).toEqual({ success: true });
    expectFieldsEdited();
  });

  it("deleteFieldAction marks the draft changed and the source stale", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email", type: "string", entity: { tenantId: "tenant-1" } });
    mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
    expect(await deleteFieldAction("fld-1")).toEqual({ success: true });
    expectFieldsEdited();
  });

  it("applyTypeSpecAction (preview apply) marks the source stale only when something changed", async () => {
    await applyTypeSpecAction("ent-1", []);
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();

    mockPrisma.field.create.mockResolvedValue({ id: "fld-2" });
    await applyTypeSpecAction("ent-1", [{ name: "phone", type: "string", isOptional: true, isKey: false, decorators: {} }]);
    expectFieldsEdited();
  });

  it("updateEntityDescriptionAction writes the description and marks the draft changed + source stale in ONE $transaction batch (R45)", async () => {
    await updateEntityDescriptionAction("ent-1", "Orders placed online");
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { description: "Orders placed online" },
    });
    expectFieldsEdited();
    // One atomic batch of exactly those two operations: the description can never land without the mark.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("updateEntityRelationshipsAction writes the relationships with the draft flag and sourceStale in one update", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: {}, tenantId: "tenant-1" });
    const relationships = [{ targetEntityId: "cust", fieldId: "fld-1", cardinality: "many-to-one" as const }];
    await updateEntityRelationshipsAction("ent-1", relationships);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { relationships, sourceStale: true }, hasUnpublishedChanges: true },
    });
  });

  it("updateEntityMetadataAction marks tag edits stale but leaves bookkeeping-only edits fresh", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { tags: ["a"] }, tenantId: "tenant-1" });
    await updateEntityMetadataAction("ent-1", { tags: ["a", "b"] });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a", "b"], sourceStale: true }, hasUnpublishedChanges: true },
    });

    await updateEntityMetadataAction("ent-1", { schemaVersions: { avro: [] } });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a"], schemaVersions: { avro: [] } } },
    });
  });

  it("updateEntityMetadataAction never lets an already-stale source go fresh, even on a bookkeeping-only edit", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { tags: ["a"], sourceStale: true }, tenantId: "tenant-1" });
    await updateEntityMetadataAction("ent-1", { schemaVersions: { avro: [] } });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true } },
    });
  });

  it("updateEntityMetadataAction keeps the stored custom.extensions when a client sends custom, and never stores an extensions it sends (regression)", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { custom: { color: "red", extensions: { "x-team": "iot" } } }, tenantId: "tenant-1" });
    await updateEntityMetadataAction("ent-1", { custom: { color: "blue", extensions: { "x-evil": true } } });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: {
        metadata: { custom: { color: "blue", extensions: { "x-team": "iot" } }, sourceStale: true },
        hasUnpublishedChanges: true,
      },
    });
  });

  it("updateEntityMetadataAction clears the custom properties sent as null and still keeps the stored extensions", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { custom: { color: "red", extensions: { "x-team": "iot" } } }, tenantId: "tenant-1" });
    await updateEntityMetadataAction("ent-1", { custom: null });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: {
        metadata: { custom: { extensions: { "x-team": "iot" } }, sourceStale: true },
        hasUnpublishedChanges: true,
      },
    });
  });

  it("compileAndApplyTypeSpecSourceAction saves source + draft flag and clears sourceStale atomically", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1" });
    mockCompile.mockResolvedValue({
      success: true,
      diagnostics: [],
      document: { models: [{ name: "Order", fields: [] }] },
      fieldGovernance: {},
    });
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Order {}");
    expect(res.success).toBe(true);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { typespecSource: "model Order {}", hasUnpublishedChanges: true },
    });
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(CLEAR_SOURCE_STALE_SQL, "ent-1");
    // Both writes go through one $transaction([...]) batch, and the clear runs after any stale marking.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it("compileAndApplyTypeSpecSourceAction leaves sourceStale alone when the source does not compile", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1" });
    mockCompile.mockResolvedValue({ success: false, diagnostics: [{ severity: "error", code: "x", message: "bad" }] });
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model {");
    expect(res.success).toBe(false);
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
  });
});

describe("getTypeSpecSourceAction", () => {
  const entityRow = (over: Record<string, unknown>) => ({
    id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, domain: null, tenantId: "tenant-1",
    metadata: null, typespecSource: "model Order { hand: string; }", ...over,
  });

  it("returns the stored source as-is when it is fresh", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow({}));
    expect(await getTypeSpecSourceAction("ent-1")).toEqual({
      success: true, source: "model Order { hand: string; }", generated: false,
    });
  });

  it("regenerates from the field rows when sourceStale, so the tab never shows (or re-saves) a source that lacks field-editor edits", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow({ metadata: { sourceStale: true } }));
    mockPrisma.field.findMany.mockResolvedValue([
      { id: "f1", name: "note", type: "string", precision: null, scale: null, nullable: true, isKey: false,
        fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
    ]);
    const res = await getTypeSpecSourceAction("ent-1");
    expect(res).toMatchObject({ success: true, generated: true });
    expect("source" in res && res.source).toContain("note");
    expect("source" in res && res.source).not.toContain("hand");
  });
});
