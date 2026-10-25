/**
 * The TypeSpec Save (the sync that rewrites the field rows from the entity's source) keeps what a JSON Schema import put there: the null of
 * a type (`a: string | null`, required, vs `a?: string | null`, optional) and, once the union work lands, a union field. Rows are built
 * like the import does (import -> payload -> field rows), the source is generated from them and saved back through the real action (real
 * compiler, mocked Prisma): a no-op save changes nothing; an edit changes only what it says.
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
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { importAndPersist, type Imported, type Row } from "../helpers/import-persist";

vi.setConfig({ testTimeout: 60_000 });

let imported: Imported;
let rows: Row[];
let source: string;

/** Import `schema`, persist it as rows, and generate the entity's source from them. */
async function load(schema: unknown): Promise<void> {
  imported = await importAndPersist(schema, "Evt");
  rows = imported.rows;
  source = generateTypeSpec(compileEntity(imported.entity, imported.fields));
}

/** The rows the DB would hold: what the import created, with ids. */
const dbRows = () =>
  rows.map((r, i) => ({
    id: `f${i}`, entityId: "ent-1", name: r.name, slug: r.name, type: r.type, nullable: r.nullable, isKey: r.name === "id", sortOrder: i,
    fieldNumber: i + 1, description: (r.description as string) ?? "", classification: (r.classification as string) ?? null,
    decorators: JSON.parse(JSON.stringify(r.decorators ?? {})),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.field.update.mockResolvedValue({ id: "upd" });
  mockPrisma.field.findMany.mockImplementation(async (arg?: { select?: unknown }) => (arg?.select ? dbRows().map((r) => ({ name: r.name, type: r.type, decorators: r.decorators })) : dbRows()));
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1", metadata: imported?.metadata ?? {} });
});

const save = (text: string) => compileAndApplyTypeSpecSourceAction("ent-1", text);
const updates = () =>
  Object.fromEntries(
    mockPrisma.field.update.mock.calls.map(([arg]) => [(arg as { where: { id: string } }).where.id, (arg as { data: Record<string, unknown> }).data]),
  );
const idOf = (name: string) => dbRows().find((r) => r.name === name)!.id;
type Data = { type: string; nullable: boolean; decorators: Record<string, unknown> };

describe("a nullable type survives a Save (F2b)", () => {
  const SCHEMA = {
    title: "Evt", type: "object", required: ["id", "reqNull"],
    properties: {
      id: { type: "string" },
      reqNull: { type: ["string", "null"] },
      optNull: { type: ["integer", "null"] },
      opt: { type: "string" },
    },
  };

  it("the generated source tells required + nullable from optional + nullable", async () => {
    await load(SCHEMA);
    expect(source).toMatch(/^\s*reqNull: string \| null;/m);
    expect(source).toMatch(/^\s*optNull\?: integer \| null;/m);
    expect(source).toMatch(/^\s*opt\?: string;/m);
  });

  it("a no-op save changes no row", async () => {
    await load(SCHEMA);
    const res = await save(source);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.success).toBe(true);
    expect(res.applied).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
  });

  it("an unrelated edit (a new field) leaves the nullable fields as they are", async () => {
    await load(SCHEMA);
    const res = await save(source.replace(/\n}\s*$/m, "\n  brand_new: string;\n}"));
    expect(res.success).toBe(true);
    expect(res.applied).toMatchObject({ added: 1, updated: 0 });
  });

  it("making the required nullable field optional keeps the null type and loses `required`", async () => {
    await load(SCHEMA);
    const res = await save(source.replace("reqNull: string | null;", "reqNull?: string | null;"));
    expect(res.success).toBe(true);
    const d = updates()[idOf("reqNull")] as Data;
    expect(d).toMatchObject({ type: "string", nullable: true });
    expect(d.decorators).toMatchObject({ nullableType: true });
    expect(d.decorators).not.toHaveProperty("requiredNullable");
    expect(Object.keys(updates())).toEqual([idOf("reqNull")]);
  });

  it("dropping the `| null` makes it a plain required string", async () => {
    await load(SCHEMA);
    const res = await save(source.replace("reqNull: string | null;", "reqNull: string;"));
    expect(res.success).toBe(true);
    const d = updates()[idOf("reqNull")] as Data;
    expect(d).toMatchObject({ type: "string", nullable: false });
    expect(d.decorators).not.toHaveProperty("nullableType");
    expect(d.decorators).not.toHaveProperty("requiredNullable");
  });

  it("making an optional plain field nullable-typed writes the null type, still optional", async () => {
    await load(SCHEMA);
    const res = await save(source.replace("opt?: string;", "opt?: string | null;"));
    expect(res.success).toBe(true);
    const d = updates()[idOf("opt")] as Data;
    expect(d.nullable).toBe(true);
    expect(d.decorators).toMatchObject({ nullableType: true });
    expect(d.decorators).not.toHaveProperty("requiredNullable");
  });
});
