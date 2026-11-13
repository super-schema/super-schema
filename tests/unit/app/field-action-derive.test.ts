import { beforeEach, describe, expect, it, vi } from "vitest";

// Derive-on-save in the field actions that write rows directly (updateFieldAction, addFieldAction): a classification change
// re-derives the stored attribute members; a tenant without definitions persists the decorators exactly as before.

const { mockPrisma, mockGetActiveTenantId, listMock } = vi.hoisted(() => ({
  mockGetActiveTenantId: vi.fn(),
  listMock: vi.fn(),
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: listMock }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));

import { addFieldAction, updateFieldAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const DEF = {
  key: "x-abc",
  label: "ABC",
  description: "",
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string" } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "class{class}" },
  requiredWhen: "primitive",
  pack: "paypal",
};
const stored = (v: Record<string, string>) => ({ typespec: { extensions: { openapi: { "x-abc": v } } } });

const FIELD = {
  id: "fld-1", entityId: "ent-1", name: "email", slug: "email", type: "string", classification: "PII", description: "",
  decorators: stored({ data_class: "class2", data_category: "ConsumerPersonal" }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTenantId.mockResolvedValue("tenant-1");
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.field.findUnique.mockImplementation(async (args: { select?: { entity?: unknown } }) =>
    args.select?.entity ? { ...FIELD, entity: { tenantId: "tenant-1" } } : FIELD,
  );
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: "tenant-1" });
  mockPrisma.field.findFirst.mockResolvedValue(null);
  mockPrisma.field.update.mockResolvedValue({ id: "fld-1" });
  mockPrisma.field.create.mockResolvedValue({ id: "fld-2" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  listMock.mockResolvedValue({ success: true, data: [DEF] });
});

const updateData = () => (mockPrisma.field.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;

describe("updateFieldAction derives attribute members", () => {
  it("persists the re-derived data_class when only the classification changes, keeping the category", async () => {
    expect(await updateFieldAction("fld-1", { classification: "PUBLIC" })).toEqual({ success: true });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith("tenant-1", "field");
    expect(updateData().decorators).toEqual(stored({ data_class: "class5", data_category: "ConsumerPersonal" }));
  });

  it("with no definitions the persisted decorators are unchanged (not written at all for a classification-only edit)", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    expect(await updateFieldAction("fld-1", { classification: "PUBLIC" })).toEqual({ success: true });
    expect(updateData()).toEqual({ classification: "PUBLIC" });
    expect(updateData()).not.toHaveProperty("decorators");
  });

  it("with no definitions, decorators sent by the client are persisted as sent", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    const sent = { structure: { key: true } };
    await updateFieldAction("fld-1", { decorators: sent });
    expect(updateData().decorators).toEqual(sent);
  });
});

describe("addFieldAction derives attribute members", () => {
  it("adds the derived value to a new unclassified primitive", async () => {
    const r = await addFieldAction("ent-1", "note", "string");
    expect(r).toMatchObject({ success: true });
    const data = (mockPrisma.field.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.decorators).toEqual(stored({ data_class: "class3" }));
  });

  it("with no definitions writes no decorators, as before", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    await addFieldAction("ent-1", "note", "string");
    const data = (mockPrisma.field.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("decorators");
  });
});
