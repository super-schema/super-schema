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
  },
  mockCompile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: mockCompile }));

import {
  addFieldAction,
  updateFieldAction,
  deleteFieldAction,
  applyTypeSpecAction,
  updateEntityDescriptionAction,
  updateEntityMetadataAction,
  updateEntityRelationshipsAction,
  compileAndApplyTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const MARK = { where: { id: "ent-1" }, data: { hasUnpublishedChanges: true }, select: { id: true } };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.findMany.mockResolvedValue([]);
});

describe("draft-mutating entity actions set hasUnpublishedChanges", () => {
  it("addFieldAction", async () => {
    mockPrisma.field.create.mockResolvedValue({ id: "fld-1", entityId: "ent-1" });
    expect(await addFieldAction("ent-1", "email", "string")).toMatchObject({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("updateFieldAction", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email" });
    mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
    expect(await updateFieldAction("fld-1", { description: "Primary email" })).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("deleteFieldAction", async () => {
    mockPrisma.field.findUnique.mockResolvedValue({ id: "fld-1", entityId: "ent-1", name: "email", type: "string" });
    mockPrisma.field.delete.mockResolvedValue({ id: "fld-1" });
    expect(await deleteFieldAction("fld-1")).toEqual({ success: true });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("applyTypeSpecAction marks only when something changed", async () => {
    await applyTypeSpecAction("ent-1", []);
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();

    mockPrisma.field.create.mockResolvedValue({ id: "fld-2" });
    await applyTypeSpecAction("ent-1", [{ name: "phone", type: "string", isOptional: true, isKey: false, decorators: {} }]);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith(MARK);
  });

  it("updateEntityDescriptionAction writes the flag with the description", async () => {
    await updateEntityDescriptionAction("ent-1", "Orders placed online");
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { description: "Orders placed online", hasUnpublishedChanges: true },
    });
  });

  it("updateEntityRelationshipsAction writes the flag with the relationships", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: {} });
    const relationships = [{ targetEntityId: "cust", fieldId: "fld-1", cardinality: "many-to-one" as const }];
    await updateEntityRelationshipsAction("ent-1", relationships);
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { relationships }, hasUnpublishedChanges: true },
    });
  });

  it("updateEntityMetadataAction flags tag edits but not bookkeeping keys", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ metadata: { tags: ["a"] } });
    await updateEntityMetadataAction("ent-1", { tags: ["a", "b"] });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a", "b"] }, hasUnpublishedChanges: true },
    });

    await updateEntityMetadataAction("ent-1", { schemaVersions: { avro: [] } });
    expect(mockPrisma.entity.update).toHaveBeenLastCalledWith({
      where: { id: "ent-1" },
      data: { metadata: { tags: ["a"], schemaVersions: { avro: [] } } },
    });
  });

  it("compileAndApplyTypeSpecSourceAction saves source and flag together", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null });
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
  });
});
