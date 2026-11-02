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
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import {
  compileAndApplyTypeSpecSourceAction,
  getTypeSpecSourceAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { CLEAR_SOURCE_STALE_SQL, SET_ENTITY_TAGS_SQL } from "@/lib/entity-versioning/draft-state";

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
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });

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

describe("TypeSpec Source tab save applies the model's x-tags to metadata.tags (R53)", () => {
  const entityRow = (tags: string[] | undefined) => ({
    id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1", metadata: tags === undefined ? null : { tags },
  });
  const sourceWithTags = (tags: string[]) =>
    generateTypeSpec(
      compileEntity(
        {
          id: "ent-1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: null,
          metadata: { tags }, domain: null,
        },
        [fld("id", null, 0)]
      )
    );
  const tagWrites = () =>
    mockPrisma.$executeRawUnsafe.mock.calls.filter(([sql]) => sql === SET_ENTITY_TAGS_SQL);

  it("persists a tag edit made in the source, in the same transaction as the source and the stale clear", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(["old"]));
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", sourceWithTags(["sales", "core"]));
    expect(res.success).toBe(true);
    expect(tagWrites()).toEqual([[SET_ENTITY_TAGS_SQL, "ent-1", '["sales","core"]']]);
    // update + tags + clear in one batch, tags before the stale clear.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    const sqls = mockPrisma.$executeRawUnsafe.mock.calls.map(([sql]) => sql);
    expect(sqls.indexOf(SET_ENTITY_TAGS_SQL)).toBeLessThan(sqls.indexOf(CLEAR_SOURCE_STALE_SQL));
  }, 60_000);

  it("clears the entity's tags when the saved source carries none", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(["old"]));
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n}\n");
    expect(res.success).toBe(true);
    expect(tagWrites()).toEqual([[SET_ENTITY_TAGS_SQL, "ent-1", "[]"]]);
  }, 60_000);

  it("leaves metadata alone when the source's tags equal the stored ones (or both are empty)", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(["sales", "core"]));
    await compileAndApplyTypeSpecSourceAction("ent-1", sourceWithTags(["sales", "core"]));
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(undefined));
    await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n}\n");
    expect(tagWrites()).toEqual([]);
  }, 60_000);
});

describe("TypeSpec Source tab save refuses a field the AsyncAPI parser cannot read (PARSER_UNSAFE_KEYS)", () => {
  const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';

  it("a new field named hasOwnProperty: the save is refused with the reserved-name message and nothing is written, not even the source", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n  hasOwnProperty: string;\n}\n");
    // The message names the model that holds the field (as the spread case below does).
    expect(res).toMatchObject({ success: false, error: `Model "Customer": ${MESSAGE}` });
    expect(mockPrisma.field.create).not.toHaveBeenCalled();
    expect(mockPrisma.entity.update).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  }, 60_000);

  it("a field that was there before (an entity created before the rule) does not stop the source from being saved", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });
    mockPrisma.field.findMany.mockResolvedValue([{ id: "f-1", entityId: "ent-1", name: "hasOwnProperty", sortOrder: 0, fieldNumber: 1, type: "string", nullable: true, isKey: false, description: "", classification: null, decorators: {} }]);
    const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  hasOwnProperty?: string;\n  id: string;\n}\n");
    expect(res.success).toBe(true);
  }, 60_000);

  describe("every model of the source is looked at, not only the first", () => {
    const entityRow = () => mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", name: "Customer", typespecSource: null, tenantId: "tenant-1" });
    const nothingWritten = () => {
      expect(mockPrisma.field.create).not.toHaveBeenCalled();
      expect(mockPrisma.entity.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    };

    it("a field of a SECOND model (a nested type the entity refers to) is refused, and nothing is written", async () => {
      entityRow();
      const source = "model Customer {\n  id: string;\n  address: Address;\n}\nmodel Address {\n  hasOwnProperty: string;\n}\n";
      const res = await compileAndApplyTypeSpecSourceAction("ent-1", source);
      // the message says WHICH model holds the field
      expect(res).toMatchObject({ success: false, error: `Model "Address": ${MESSAGE}` });
      nothingWritten();
    });

    it("a field that comes in through a spread (...Base) is a field of the model that spreads it, and the message names that model", async () => {
      entityRow();
      const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n  ...Base;\n}\nmodel Base {\n  hasOwnProperty: string;\n}\n");
      expect(res).toMatchObject({ success: false, error: `Model "Customer": ${MESSAGE}` });
      nothingWritten();
    });

    it("a second model, an enum, a scalar or a union NAMED hasOwnProperty is refused as a reserved NAME, and nothing is written", async () => {
      const NAME_MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.';
      for (const [kind, declared] of [
        ["Model", "model hasOwnProperty {\n  street: string;\n}\n"],
        ["Enum", "enum hasOwnProperty {\n  A,\n  B,\n}\n"],
        ["Scalar", "scalar hasOwnProperty extends string;\n"],
        ["Union", "union hasOwnProperty {\n  string,\n  int32,\n}\n"],
      ]) {
        entityRow();
        const res = await compileAndApplyTypeSpecSourceAction("ent-1", `model Customer {\n  id: string;\n}\n${declared}`);
        expect(res, declared).toMatchObject({ success: false, error: `${kind} "hasOwnProperty": ${NAME_MESSAGE}` });
      }
      nothingWritten();
    });

    it("the look-alikes in a second model are fine", async () => {
      entityRow();
      const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n}\nmodel Address {\n  hasownproperty: string;\n  HasOwnProperty: string;\n}\n");
      expect(res.success).toBe(true);
    });

    // KNOWN GAP, pinned so a change in what the parsed document exposes is noticed: an INLINE model (`address: { ... }`) has no name, so
    // `ParsedTypeSpecDocument.models` does not list it and its property names are not visible here. The emit guard is the safety net.
    it("an inline anonymous model's fields are NOT exposed by the parsed document: the save goes through (the emit guard catches them later)", async () => {
      entityRow();
      const res = await compileAndApplyTypeSpecSourceAction("ent-1", "model Customer {\n  id: string;\n  address: { hasOwnProperty: string };\n}\n");
      expect(res.success).toBe(true);
    });
  });
});

describe("getTypeSpecSourceAction upgrades a stored legacy @tag source", () => {
  it("returns the stored source rewritten into the valid governance decorators", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({
      id: "ent-1", name: "Order", description: "", status: "DRAFT", version: 1, domainId: null, domain: null, tenantId: "tenant-1",
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
