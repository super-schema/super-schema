/**
 * Story 16.6 — the TypeSpec Source tab save path (`compileAndApplyTypeSpecSourceAction`) compiles for real.
 * It must accept the canonical source of a tagged entity with classified fields, and write the app's
 * classification levels back to the field rows. A stored pre-16.6 source with legacy `@tag` lines is
 * upgraded when the tab loads it, so it can be saved too.
 *
 * Prisma, auth and Next are mocked; the compiler is REAL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
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
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  compileAndApplyTypeSpecSourceAction,
  getTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

const fld = (name: string, classification: string | null, i: number): PrismaFieldInput => ({
  id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: i > 0, isKey: i === 0,
  fieldNumber: null, description: "", classification, aliases: [], decorators: {}, sortOrder: i,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.findMany.mockResolvedValue([]);
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe("TypeSpec Source tab save accepts the canonical source of a tagged + classified entity", () => {
  it("compiles it for real, saves it, and writes the classification levels to the fields", async () => {
    const source = generateTypeSpec(
      compileEntity(
        {
          id: "ent-1", name: "Customer", description: "Customers", status: "DRAFT", version: 1, domainId: null,
          metadata: { tags: ["sales", "core"] }, domain: null,
        },
        [fld("id", null, 0), fld("email", "PII", 1), fld("note", "SENSITIVE", 2), fld("code", "TOP_SECRET", 3)]
      )
    );
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null });

    const res = await compileAndApplyTypeSpecSourceAction("ent-1", source);

    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.applied).toMatchObject({ added: 4 });

    const created = Object.fromEntries(
      mockPrisma.field.create.mock.calls.map(([arg]) => [arg.data.name, arg.data.classification])
    );
    expect(created).toEqual({ id: null, email: "PII", note: "SENSITIVE", code: "TOP_SECRET" });
    expect(mockPrisma.entity.update).toHaveBeenCalledWith({
      where: { id: "ent-1" },
      data: { typespecSource: source, hasUnpublishedChanges: true },
    });
  }, 60_000);
});

describe("getTypeSpecSourceAction upgrades a stored legacy @tag source", () => {
  it("returns the stored source rewritten into the valid governance decorators", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({
      id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, domain: null,
      metadata: null,
      typespecSource: ['@tag("sales")', "model Order {", '  @tag("classification:PII")', "  email?: string;", "}", ""].join("\n"),
    });

    const res = await getTypeSpecSourceAction("ent-1");

    expect(res).toEqual({
      success: true,
      generated: false,
      source: [
        'import "@superschema/typespec-enterprise";',
        'import "@typespec/openapi";',
        "",
        '@TypeSpec.OpenAPI.extension("x-tags", #["sales"])',
        "model Order {",
        "  @Enterprise.dataClassification(Enterprise.DataClassification.PII)",
        "  email?: string;",
        "}",
        "",
      ].join("\n"),
    });
  });
});
