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
  valueSchema: { type: "object", properties: { data_class: { type: "string" }, data_category: { type: "string", enum: ["Intrinsic", "ConsumerPersonal"] } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "class{class}" },
  requiredWhen: "never",
  pack: "paypal",
};
const listMock = vi.fn();
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: (...a: unknown[]) => listMock(...a) }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));

import { createField } from "@/services/field.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const ctx: ServiceContext = { userId: "user-1", userRole: "AUTHOR", prisma: prisma as unknown as ServiceContext["prisma"] };
const stored = (v: unknown) => ({ typespec: { extensions: { openapi: { "x-abc": v } } } });

function entityIn(policyTemplate: unknown) {
  return { id: "ent-1", tenantId: "t-1", domain: { policyTemplate }, product: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation((async (ops: Promise<unknown>[]) => Promise.all(ops)) as never);
  vi.mocked(prisma.field.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.field.create).mockResolvedValue({ id: "fld-1" } as never);
  listMock.mockResolvedValue({ success: true, data: [DEF] });
});

const written = () => (vi.mocked(prisma.field.create).mock.calls[0][0] as { data: { decorators?: unknown } }).data.decorators;
const policy = (d: unknown) => ({ metadataAttributes: { "x-abc": { default: d } } });

describe("createField applies domain policy defaults", () => {
  it("fills the domain default and derives data_class on top", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityIn(policy({ data_category: "Intrinsic" })) as never);
    await createField("ent-1", { name: "note", type: "string" }, ctx);
    expect(written()).toEqual(stored({ data_category: "Intrinsic", data_class: "class3" }));
  });

  it("ignores an invalid default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityIn(policy({ data_category: "Nope" })) as never);
    await createField("ent-1", { name: "note", type: "string" }, ctx);
    expect(JSON.stringify(written() ?? {})).not.toContain("Nope");
    warn.mockRestore();
  });

  it("leaves a domain without a policy unaffected", async () => {
    vi.mocked(prisma.entity.findUnique).mockResolvedValue(entityIn(null) as never);
    await createField("ent-1", { name: "note", type: "string" }, ctx);
    expect(JSON.stringify(written() ?? {})).not.toContain("data_category");
  });
});
