import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    field: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    $transaction: vi.fn(),
  },
}));

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
const listMock = vi.fn();
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: (...a: unknown[]) => listMock(...a) }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));

import { createField, updateField } from "@/services/field.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const ctx: ServiceContext = { userId: "user-1", userRole: "AUTHOR", prisma: prisma as unknown as ServiceContext["prisma"] };
const stored = (v: unknown) => ({ typespec: { extensions: { openapi: { "x-abc": v } } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => Promise.all(ops)) as never);
  vi.mocked(prisma.entity.findUnique).mockResolvedValue({ id: "ent-1", tenantId: "t-1" } as never);
  vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.field.create).mockResolvedValue({ id: "fld-1" } as never);
  vi.mocked(prisma.field.update).mockResolvedValue({ id: "fld-1" } as never);
  listMock.mockResolvedValue({ success: true, data: [DEF] });
});

const written = (call: "create" | "update") => {
  const arg = vi.mocked(prisma.field[call]).mock.calls[0][0] as { data: { decorators?: unknown } };
  return arg.data.decorators;
};

describe("updateField derives attribute members", () => {
  it("persists the re-derived value when the classification changes", async () => {
    vi.mocked(prisma.field.findUnique).mockResolvedValue({
      id: "fld-1", entityId: "ent-1", name: "email", type: "string", classification: "PII",
      decorators: stored({ data_class: "class2", data_category: "ConsumerPersonal" }),
    } as never);
    const result = await updateField("fld-1", { classification: "PUBLIC" }, ctx);
    expect(result.success).toBe(true);
    expect(listMock).toHaveBeenCalledWith("t-1", "field", expect.anything());
    expect(written("update")).toEqual(stored({ data_class: "class5", data_category: "ConsumerPersonal" }));
  });

  it("derives on top of decorators sent with the edit (DecoratorSchema keeps only its own keys, so no typespec value arrives)", async () => {
    vi.mocked(prisma.field.findUnique).mockResolvedValue({
      id: "fld-1", entityId: "ent-1", name: "email", type: "string", classification: "PII", decorators: {},
    } as never);
    await updateField("fld-1", { decorators: { structure: { key: true } } }, ctx);
    expect(written("update")).toEqual({ structure: { key: true }, ...stored({ data_class: "class2" }) });
  });

  it("writes no decorators when the tenant has no attributes and none were sent", async () => {
    listMock.mockResolvedValue({ success: true, data: [] });
    vi.mocked(prisma.field.findUnique).mockResolvedValue({
      id: "fld-1", entityId: "ent-1", name: "email", type: "string", classification: "PII", decorators: {},
    } as never);
    await updateField("fld-1", { classification: "PUBLIC" }, ctx);
    expect(written("update")).toBeUndefined();
  });
});

describe("createField derives attribute members", () => {
  it("adds the derived value to a new unclassified primitive", async () => {
    await createField("ent-1", { name: "note", type: "string" }, ctx);
    expect(written("create")).toEqual(stored({ data_class: "class3" }));
  });
});
