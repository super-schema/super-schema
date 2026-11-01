/**
 * Task 16 acceptance: saving the entity's own TypeSpec source (the sync that rewrites the field rows) is LOSSLESS for the user event
 * schema. Rows are built exactly like jsonschema-user-event-e2e (import -> payload -> field inputs), the source is generated from them
 * and saved back through the real action (real compiler, mocked Prisma): a no-op save changes nothing; an edit changes only what it says.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { Prisma } from "@/generated/prisma/client";

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
vi.mock("@/lib/access/principal", async () => (await import("../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import { compileAndApplyTypeSpecSourceAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { parseTypeSpec } from "@/lib/compiler/typespec-parser";
import { mergeSyncedField } from "@/lib/typespec-sync/merge-fields";
import { SET_ENTITY_EXTENSIONS_SQL, CLEAR_ENTITY_EXTENSIONS_SQL } from "@/lib/entity-versioning/draft-state";

const DATE_REF = "common_components/v4/schema/json/openapi-2.0/date_time.json";
const USER_EVENT = {
  type: "object",
  description: "A user event containing user level customer id information used to link a user across different tenants.",
  "x-owner-team": { name: "payments", tier: 1 },
  properties: {
    component: {
      type: "string", description: "Name of the source component logging the user event(s).", minLength: 1, maxLength: 100,
      pattern: "^([A-Za-z0-9-_])+$", "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    tenant: {
      type: "string", description: "Name of the adjacency to Acme.", minLength: 1, maxLength: 100, pattern: "^[a-z0-9_]+$",
      "x-securityClassification": { data_class: "class4", data_category: "OrgCompany" },
    },
    created_time: {
      description: "Event creation timestamp.", $ref: DATE_REF,
      "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" },
    },
    user_links: {
      type: "array", description: "List of list of users and their customer ids along with tenant information.",
      minItems: 1, maxItems: 100, items: { $ref: "user_links.json" },
    },
  },
  required: ["user_links", "created_time", "tenant"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any> & { name: string; type: string; nullable: boolean; decorators: Record<string, any> };

let rows: Row[];
let metadata: Record<string, unknown> | undefined;
let source: string;

async function persist(): Promise<void> {
  const parsed = parseJsonSchemaDocument(JSON.stringify(USER_EVENT));
  if (!parsed.success) throw new Error(parsed.error.message);
  const payload = buildImportAssetsPayload(toAssetImportResult(parsed.data), {
    domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  payload.entities[0].name = "UserEvent";
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: [payload.entities[0] as unknown as ImportedEntityInput],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p", ownerId: "u", sourceFormat: "jsonschema", isNameFree: async () => true, skip: () => {}, refs: new Map(),
  });
  const data = create.mock.calls[0][0].data as unknown as { metadata?: Record<string, unknown>; fields: { create: Row[] } };
  rows = data.fields.create;
  metadata = data.metadata;
}

const entityInput = (): PrismaEntityInput => ({
  id: "ent-1", name: "UserEvent", description: "", status: "DRAFT", version: 1, domainId: "d", metadata,
  domain: { id: "d", name: "Sales", slug: "sales" },
});
const fieldInputs = (): PrismaFieldInput[] =>
  rows.map((r, i) => ({
    id: `f${i}`, name: r.name, type: r.type, precision: null, scale: null, nullable: r.nullable, isKey: false, fieldNumber: null,
    description: (r.description as string) ?? "", classification: (r.classification as string) ?? null, aliases: [],
    decorators: r.decorators, sortOrder: i,
  })) as PrismaFieldInput[];

/** The rows the DB would hold: what the import created, with ids. */
const dbRows = () =>
  rows.map((r, i) => ({
    id: `f${i}`, entityId: "ent-1", name: r.name, slug: r.name, type: r.type, nullable: r.nullable, isKey: false, sortOrder: i,
    fieldNumber: null, description: (r.description as string) ?? "", classification: (r.classification as string) ?? null,
    decorators: JSON.parse(JSON.stringify(r.decorators)),
  }));

beforeAll(async () => {
  await persist();
  source = generateTypeSpec(compileEntity(entityInput(), fieldInputs()));
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
  mockPrisma.field.create.mockResolvedValue({ id: "new" });
  mockPrisma.field.update.mockResolvedValue({ id: "upd" });
  mockPrisma.field.findMany.mockImplementation(async (arg?: { select?: unknown }) => (arg?.select ? dbRows().map((r) => ({ name: r.name })) : dbRows()));
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1", metadata });
});

const save = (text: string) => compileAndApplyTypeSpecSourceAction("ent-1", text);
const updates = () =>
  Object.fromEntries(
    mockPrisma.field.update.mock.calls.map(([arg]) => [(arg as { where: { id: string } }).where.id, (arg as { data: Record<string, unknown> }).data]),
  );
const extensionSql = () =>
  mockPrisma.$executeRawUnsafe.mock.calls.filter(([sql]) => sql === SET_ENTITY_EXTENSIONS_SQL || sql === CLEAR_ENTITY_EXTENSIONS_SQL);

describe("the generated source of the user event entity", () => {
  it("carries the raw refs as extensions and the vendor blocks (precondition)", () => {
    expect(source).toContain(DATE_REF);
    expect(source).toContain("user_links.json");
    expect(source).toContain("x-owner-team");
    expect(metadata).toMatchObject({ custom: { extensions: { "x-owner-team": { name: "payments", tier: 1 } } } });
  });
});

describe("no-op save", () => {
  it("compiles, changes no field row and writes no entity extensions", async () => {
    const res = await save(source);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(res.success).toBe(true);
    expect(res.applied).toEqual({ added: 0, updated: 0, removed: [] });
    expect(mockPrisma.field.update).not.toHaveBeenCalled();
    expect(mockPrisma.field.create).not.toHaveBeenCalled();
    expect(mockPrisma.field.delete).not.toHaveBeenCalled();
    expect(extensionSql()).toEqual([]);
  }, 60_000);

  it("the pure merge of every parsed field reproduces its stored row exactly (compiler path and regex path)", async () => {
    const parsed = parseTypeSpec(source)!;
    for (const pf of parsed.fields) {
      const existing = dbRows().find((r) => r.name === pf.name)!;
      const m = mergeSyncedField(existing, { ...pf, decorators: pf.decorators as unknown as Record<string, unknown> });
      expect({ type: m.type, nullable: m.nullable, classification: m.classification, decorators: m.decorators }, pf.name).toEqual({
        type: existing.type, nullable: existing.nullable, classification: existing.classification, decorators: existing.decorators,
      });
    }
  });
});

describe("edits change only what they say", () => {
  const edited = (from: string, to: string) => {
    expect(source).toContain(from);
    return source.replaceAll(from, to);
  };

  it("changing one field's type updates that field alone, clears its marker, and keeps the data category of the others", async () => {
    const line = source.split("\n").find((l) => /^\s*created_time\??:/.test(l))!;
    expect(line).toMatch(/unknown/);
    const res = await save(source.replace(line, line.replace("unknown", "utcDateTime")));
    expect(res.success).toBe(true);
    const u = updates();
    expect(Object.keys(u)).toEqual(["f2"]);
    const decorators = u.f2 && (u.f2 as { decorators: Record<string, Record<string, unknown>> }).decorators;
    expect(u.f2).toMatchObject({ type: "utcDateTime" });
    expect(decorators.danglingRef).toBeUndefined();
    expect(decorators.referencedEntityName).toBeUndefined();
    expect(decorators.governance).toEqual({ dataClass: "class4", dataCategory: "Intrinsic" });
  }, 60_000);

  it("renaming the $ref value updates the marker's raw ref", async () => {
    const res = await save(edited(DATE_REF, "other/Clock.json"));
    expect(res.success).toBe(true);
    const d = (updates().f2 as { decorators: { danglingRef: unknown; referencedEntityName: string } }).decorators;
    expect(d.danglingRef).toMatchObject({ ref: "other/Clock.json" });
    expect(d.referencedEntityName).toBe("Clock");
    expect(Object.keys(updates())).toEqual(["f2"]);
  }, 60_000);

  it("removing a field deletes it; adding a field creates it; the others are untouched", async () => {
    const lines = source.split("\n");
    const at = lines.findIndex((l) => /^\s*component\??:/.test(l));
    // drop the property line and its decorator lines above it, add a new one
    let start = at;
    while (start > 0 && /^\s*(@|#)/.test(lines[start - 1])) start--;
    const without = [...lines.slice(0, start), ...lines.slice(at + 1)].join("\n");
    const added = without.replace(/\n}\s*$/m, "\n  brand_new: string;\n}");
    const res = await save(added);
    expect(res.success).toBe(true);
    expect(res.applied).toMatchObject({ added: 1, updated: 0, removed: ["component"] });
  }, 60_000);

  it("a model extension edited in the source is written to metadata.custom.extensions; removed it is cleared", async () => {
    const res = await save(edited("tier: 1", "tier: 2"));
    expect(res.success).toBe(true);
    expect(extensionSql().map(([sql, , value]) => [sql, value])).toEqual([[SET_ENTITY_EXTENSIONS_SQL, JSON.stringify({ "x-owner-team": { name: "payments", tier: 2 } })]]);

    vi.clearAllMocks();
    mockPrisma.auditLog.create.mockResolvedValue({ id: "a" });
    mockPrisma.entity.update.mockResolvedValue({ id: "ent-1" });
    mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
    mockPrisma.field.findMany.mockImplementation(async (arg?: { select?: unknown }) => (arg?.select ? dbRows().map((r) => ({ name: r.name })) : dbRows()));
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", typespecSource: null, tenantId: "tenant-1", metadata });
    const stripped = source.split("\n").filter((l) => !l.includes("x-owner-team")).join("\n");
    const res2 = await save(stripped);
    expect(res2.success).toBe(true);
    expect(extensionSql().map(([sql]) => sql)).toEqual([CLEAR_ENTITY_EXTENSIONS_SQL]);
  }, 60_000);
});

describe("hostile text", () => {
  it("a $ref with quotes, backslashes, ${x} and a newline survives a save verbatim", async () => {
    const hostile = 'a"b\\c${x}\nd';
    const base = rows.map((r) => ({ ...r, decorators: JSON.parse(JSON.stringify(r.decorators)) }));
    const baseCreated = base.find((r) => r.name === "created_time")!;
    baseCreated.decorators.danglingRef = { ...baseCreated.decorators.danglingRef, ref: hostile };
    const saved = rows;
    rows = base as Row[];
    const text = generateTypeSpec(compileEntity(entityInput(), fieldInputs()));
    rows = saved;
    const res = await save(text);
    expect(res.success).toBe(true);
    const created = dbRows().find((r) => r.name === "created_time")!;
    const d = (updates()[created.id] as { decorators: { danglingRef: { ref: string } } }).decorators;
    expect(d.danglingRef.ref).toBe(hostile);
  }, 60_000);
});

describe("resolved references are stable across a save", () => {
  const withResolved = () => {
    const saved = rows;
    const extra = [
      { name: "owner", type: "reference", nullable: false, isKey: false, description: "", classification: null,
        decorators: { referencedEntityName: "Customer", governance: { dataCategory: "PII-ish" }, typespec: { extensions: { openapi: { "x-keep": { a: 1 } } } } } },
      { name: "owners", type: "array", nullable: true, isKey: false, description: "", classification: null,
        decorators: { arrayElementType: "reference", referencedEntityName: "Customer", governance: { dataCategory: "x" } } },
    ] as unknown as Row[];
    rows = [...saved, ...extra];
    const text = generateTypeSpec(compileEntity(entityInput(), fieldInputs()));
    return { text, restore: () => { rows = saved; } };
  };
  // The model the generated source refers to must exist for the real compiler.
  const declared = (text: string) => `${text}\nmodel Customer {\n  id: string;\n}\n`;

  it("a resolved reference and an array of references round trip with zero writes", async () => {
    const { text, restore } = withResolved();
    try {
      const res = await save(declared(text));
      expect(res.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(res.success).toBe(true);
      expect(res.applied).toEqual({ added: 0, updated: 0, removed: [] });
      expect(mockPrisma.field.update).not.toHaveBeenCalled();
    } finally {
      mockPrisma.field.findMany.mockImplementation(async (arg?: { select?: unknown }) => (arg?.select ? dbRows().map((r) => ({ name: r.name })) : dbRows()));
    }
    restore();
  }, 60_000);

  it("a changed target name updates the field and clears the old target; the rest stays", async () => {
    const saved = rows;
    const { text, restore } = withResolved();
    const extended = rows;
    mockPrisma.field.findMany.mockImplementation(async (arg?: { select?: unknown }) => {
      const r = extended.map((x, i) => ({ id: `f${i}`, entityId: "ent-1", slug: x.name, sortOrder: i, fieldNumber: null, isKey: false, description: "", classification: null, ...x, decorators: JSON.parse(JSON.stringify(x.decorators)) }));
      return arg?.select ? r.map((x) => ({ name: x.name })) : r;
    });
    try {
      const res = await save(`${text}\nmodel Customer {\n  id: string;\n}\nmodel Order {\n  id: string;\n}\n`.replace(/^(\s*)owner(\??): Customer;/m, "$1owner$2: Order;"));
      expect(res.success).toBe(true);
      const u = updates();
      const ownerId = `f${extended.findIndex((r) => r.name === "owner")}`;
      expect(Object.keys(u)).toEqual([ownerId]);
      const d = (u[ownerId] as { type: string; decorators: Record<string, unknown> });
      expect(d.type).toBe("Order");
      expect(d.decorators.referencedEntityName).toBeUndefined();
      expect(d.decorators.governance).toEqual({ dataCategory: "PII-ish" });
      expect(d.decorators.typespec).toEqual({ extensions: { openapi: { "x-keep": { a: 1 } } } });
    } finally {
      restore();
      void saved;
    }
  }, 60_000);
});
