/**
 * Derive-on-save in the TypeSpec Source save (`applyTypeSpecFields`): a field the source classifies PII gets its derived attribute member
 * written with the row, and re-applying the unchanged source writes nothing. The compiler is REAL; only the attribute definitions are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, listMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  mockPrisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/services/metadata-attribute.service", () => ({ listMetadataAttributes: listMock }));
vi.mock("@/services/classification-scale.service", () => ({ loadCustomClassMap: async () => new Map<string, number>() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

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

const fld = (name: string, classification: string | null, i: number, decorators: Record<string, unknown> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: i > 0, isKey: i === 0,
  fieldNumber: null, description: "", classification, aliases: [], decorators, sortOrder: i,
});
const entityRow = { id: "ent-1", name: "Customer", description: "Customers", status: "DRAFT", version: 1, domainId: null, metadata: {}, domain: null };
const sourceOf = (fields: PrismaFieldInput[]) => generateTypeSpec(compileEntity(entityRow, fields));

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.field.update.mockResolvedValue({ id: "f" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  listMock.mockResolvedValue({ success: true, data: [DEF] });
});

describe("compileAndApplyTypeSpecSourceAction derives attribute members", () => {
  it("writes data_class class2 with a new PII field", async () => {
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", sourceOf([fld("id", null, 0), fld("email", "PII", 1)]));
    expect(res.error).toBeUndefined();
    expect(res.applied).toMatchObject({ added: 2 });
    expect(listMock).toHaveBeenCalledTimes(1);
    const created = Object.fromEntries(mockPrisma.field.create.mock.calls.map(([arg]) => [arg.data.name, arg.data]));
    expect(created.email.decorators.typespec.extensions.openapi["x-abc"]).toEqual({ data_class: "class2" });
    expect(created.id.decorators.typespec.extensions.openapi["x-abc"]).toEqual({ data_class: "class3" });
  });

  it("re-applying the source of the stored (already derived) rows updates nothing", async () => {
    const stored = [
      fld("id", null, 0, { typespec: { extensions: { openapi: { "x-abc": { data_class: "class3" } } } } }),
      // `governance.classification` is what a sync of the source records for a classified field (independent of the derivation).
      fld("email", "PII", 1, { governance: { classification: "PII" }, typespec: { extensions: { openapi: { "x-abc": { data_class: "class2" } } } } }),
    ];
    mockPrisma.field.findMany.mockResolvedValue(stored.map((f) => ({ ...f, entityId: "ent-1", fieldNumber: f.sortOrder + 1 })));
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", sourceOf(stored));
    expect(res.error).toBeUndefined();
    expect(res.applied).toMatchObject({ added: 0, updated: 0 });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.field.create).not.toHaveBeenCalled();
  });
});
