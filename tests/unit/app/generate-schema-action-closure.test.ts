import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 7: generateSchemaAction for a closure target (JSON Schema, OpenAPI, Protobuf, Avro, Java) loads the entity's reference
// closure (draft or published mode), emits it as one file per entity, stores `files` + `resolution` on the schema version and, after
// a successful emission, upgrades the ROOT's legacy name-only references that resolved to exactly one entity. Prisma is a stateful
// in-memory fake (the repo's pattern for the entity actions); the TypeSpec compile is replaced (closure-emit has its own tests), the
// reference loader, the bundling, the pick action and the stored shape are the real ones.

type Decorators = Record<string, unknown>;
type FieldRow = { id: string; entityId: string; name: string; type: string; decorators: Decorators; sortOrder: number };
type VersionRow = { id: string; entityId: string; major: number; minor: number; sequence: number; fieldSnapshot: unknown[] };
type EntityRow = {
  id: string;
  tenantId: string;
  name: string;
  domain?: string;
  product?: string;
  version: number;
  metadata: Record<string, unknown>;
  latestVersionId: string | null;
  fields: FieldRow[];
};

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getActiveTenantId: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  emitClosure: vi.fn(),
  emitOfficial: vi.fn(),
  store: { entities: [] as unknown[], versions: [] as unknown[] },
  prisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    entityVersion: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: vi.fn() }));
vi.mock("@/services/type-mapping.service", () => ({ getOverridesForEntity: vi.fn().mockResolvedValue({ success: true, data: [] }) }));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: h.emitClosure,
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetForEntity: h.emitOfficial,
}));

import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
import { bundleEmittedFiles } from "@/lib/typespec-official/closure-emit";
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import type { SchemaVersion } from "@/types/schema-version";

const p = h.prisma;
const entities = () => h.store.entities as EntityRow[];
const versions = () => h.store.versions as VersionRow[];
const entityOf = (id: string) => entities().find((e) => e.id === id);
const fieldOf = (id: string) => entities().flatMap((e) => e.fields).find((f) => f.id === id);

const legacy = (name: string): Decorators => ({ referencedEntityName: name });
const qualified = (id: string, q: string, pin?: string): Decorators => ({
  referencedEntityId: id,
  referencedEntityName: q.split("/")[2],
  referencedQualifiedName: q,
  ...(pin ? { referencedEntityVersion: pin } : {}),
});

function entity(id: string, name: string, fields: Array<[string, Decorators]> = [], over: Partial<EntityRow> = {}): EntityRow {
  return {
    id,
    tenantId: "tenant-1",
    name,
    version: 1,
    metadata: {},
    latestVersionId: null,
    fields: fields.map(([fieldName, decorators], i) => ({ id: `${id}.${fieldName}`, entityId: id, name: fieldName, type: "reference", decorators, sortOrder: i })),
    ...over,
  };
}

/** A published version of `id` whose snapshot is the given reference fields. */
function publish(id: string, major: number, minor: number, fields: Array<[string, Decorators]>): VersionRow {
  return {
    id: `${id}-v${major}.${minor}`,
    entityId: id,
    major,
    minor,
    sequence: major * 10 + minor,
    fieldSnapshot: fields.map(([name, decorators], i) => ({
      id: `${id}.${name}`, name, type: "reference", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
      description: "", classification: null, aliases: [], decorators, sortOrder: i,
    })),
  };
}

const FILES = [
  { path: "Order.json", content: '{"title":"Order"}\n', target: "json-schema", entityId: "a" },
  { path: "Customer.json", content: '{"title":"Customer"}', target: "json-schema", entityId: "b" },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.store.entities = [];
  h.store.versions = [];
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-1");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  p.auditLog.create.mockResolvedValue({ id: "audit-1" });
  p.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  p.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const e = entityOf(where.id);
    return e
      ? {
          id: e.id, tenantId: e.tenantId, name: e.name, version: e.version, metadata: e.metadata,
          domain: e.domain ? { name: e.domain } : null, product: e.product ? { name: e.product } : null,
          fields: e.fields.map((f) => ({ id: f.id, name: f.name, type: f.type })),
        }
      : null;
  });
  p.entity.findMany.mockImplementation(async ({ where }: { where: { tenantId: string } }) =>
    entities()
      .filter((e) => e.tenantId === where.tenantId)
      .map((e) => ({
        id: e.id, name: e.name, description: "", status: "DRAFT", version: e.version, domainId: e.domain ? `d-${e.domain}` : null, metadata: e.metadata,
        latestVersionId: e.latestVersionId,
        domain: e.domain ? { id: `d-${e.domain}`, name: e.domain, slug: `${e.domain}-slug` } : null,
        product: e.product ? { name: e.product } : null,
      }))
  );
  p.entity.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { metadata: Record<string, unknown> } }) => {
    const e = entityOf(where.id);
    if (e) e.metadata = data.metadata;
    return { id: where.id };
  });
  p.field.findMany.mockImplementation(async ({ where }: { where: { entityId: string } }) =>
    (entityOf(where.entityId)?.fields ?? []).map((f) => ({
      ...f, precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [],
    }))
  );
  p.field.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => fieldOf(where.id) ?? null);
  p.field.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { decorators: Decorators } }) => {
    const f = fieldOf(where.id);
    if (f) f.decorators = data.decorators;
    return { id: where.id };
  });
  p.entityVersion.findUnique.mockImplementation(async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } } }) => {
    if (where.id) return versions().find((v) => v.id === where.id) ?? null;
    const k = where.entityId_major_minor!;
    return versions().find((v) => v.entityId === k.entityId && v.major === k.major && v.minor === k.minor) ?? null;
  });
  h.emitClosure.mockResolvedValue({ success: true, data: { files: FILES, warnings: [], entityFiles: { a: ["Order.json"], b: ["Customer.json"] } } });
  h.emitOfficial.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});

const closureGiven = () => h.emitClosure.mock.calls[0][0] as { entities: Array<{ entityId: string; source: string; version?: string; fields: Array<{ name: string }> }> };
const storedVersion = (id: string, target: string) => ((entityOf(id)?.metadata.schemaVersions as Record<string, SchemaVersion[]>)[target] ?? [])[0];
const decoratorWrites = () => p.field.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: { decorators: Decorators } });

describe("generateSchemaAction: ambiguous references", () => {
  const ambiguous = () => {
    h.store.entities = [
      entity("a", "Order", [["addr", legacy("Address")]]),
      entity("x1", "Address", [], { domain: "d1", product: "p1" }),
      entity("x2", "Address", [], { domain: "d2", product: "p2" }),
    ];
  };

  it("answers needsReference with the candidates and the field to pick for, and writes nothing", async () => {
    ambiguous();
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toEqual({
      needsReference: {
        field: "addr",
        name: "Address",
        candidates: [
          { entityId: "x1", domain: "d1", product: "p1", entity: "Address" },
          { entityId: "x2", domain: "d2", product: "p2", entity: "Address" },
        ],
        entityId: "a",
        fieldId: "a.addr",
      },
    });
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
    expect(p.field.update).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it("succeeds with the same call once the pick action saved the qualified reference", async () => {
    ambiguous();
    expect(await actions.generateSchemaAction("a", "json-schema")).toHaveProperty("needsReference");

    const picked = await actions.setFieldReferenceAction("a", "a.addr", { entityId: "x2" });
    expect(picked.success).toBe(true);

    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(closureGiven().entities.map((e) => e.entityId)).toEqual(["a", "x2"]);
  });

  it("points at the member that holds the ambiguous field, not at the root", async () => {
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("c", "_tenant/_tenant/Customer")]]),
      entity("c", "Customer", [["addr", legacy("Address")]]),
      entity("x1", "Address", [], { domain: "d1", product: "p1" }),
      entity("x2", "Address", [], { domain: "d2", product: "p2" }),
    ];
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ needsReference: { field: "addr", entityId: "c", fieldId: "c.addr" } });
  });
});

describe("generateSchemaAction: draft and published modes", () => {
  // Order -> Customer. Customer's published 1.0 has no reference; its saved draft references Address (never published).
  const world = () => {
    h.store.versions = [publish("a", 1, 0, [["cust", qualified("b", "_tenant/_tenant/Customer")]]), publish("b", 1, 0, [])];
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer")]], { latestVersionId: "a-v1.0" }),
      entity("b", "Customer", [["addr", qualified("c", "_tenant/_tenant/Address")]], { latestVersionId: "b-v1.0" }),
      entity("c", "Address"),
    ];
  };

  it("defaults to draft: references resolve to the latest saved rows, the version is a preview listing the draft entities", async () => {
    world();
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(closureGiven().entities.map((e) => [e.entityId, e.source])).toEqual([["a", "draft"], ["b", "draft"], ["c", "draft"]]);

    const resolution = storedVersion("a", "json-schema").resolution;
    expect(resolution).toMatchObject({ mode: "draft", preview: true });
    expect(resolution?.entities.map((e) => [e.ref.entity, e.source])).toEqual([["Order", "draft"], ["Customer", "draft"], ["Address", "draft"]]);
    expect((result as { schemaVersion: SchemaVersion }).schemaVersion.resolution).toEqual(resolution);
  });

  it("published mode uses each entity's latest PUBLISHED content, never a draft, and is not a preview", async () => {
    world();
    const result = await actions.generateSchemaAction("a", "json-schema", { mode: "published" });
    expect(result).toMatchObject({ success: true });
    // Customer's saved draft references Address; its published 1.0 does not, so Address is not in the closure at all.
    expect(closureGiven().entities.map((e) => [e.entityId, e.source, e.version])).toEqual([["a", "published", "1.0"], ["b", "published", "1.0"]]);
    const resolution = storedVersion("a", "json-schema").resolution;
    expect(resolution).toMatchObject({ mode: "published", preview: false });
    expect(resolution?.entities.some((e) => e.source === "draft")).toBe(false);
  });

  it("published mode refuses a referenced entity that was never published, naming it, and stores nothing", async () => {
    h.store.versions = [publish("a", 1, 0, [["cust", qualified("b", "_tenant/_tenant/Customer")]])];
    h.store.entities = [
      entity("a", "Order", [], { latestVersionId: "a-v1.0" }),
      entity("b", "Customer", [["street", qualified("c", "_tenant/_tenant/Street")]]),
    ];
    const result = await actions.generateSchemaAction("a", "json-schema", { mode: "published" });
    expect(result).toMatchObject({ code: "NEVER_PUBLISHED", error: expect.stringContaining("Customer") });
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
  });

  it("a pin overrides the mode: the pinned published version is used in a draft generation and is recorded as pinned", async () => {
    h.store.versions = [publish("b", 1, 0, []), publish("b", 1, 1, [["x", qualified("c", "_tenant/_tenant/Address")]])];
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer", "1.0")]]),
      entity("b", "Customer", [["addr", qualified("c", "_tenant/_tenant/Address")]], { latestVersionId: "b-v1.1" }),
      entity("c", "Address"),
    ];
    await actions.generateSchemaAction("a", "json-schema");
    expect(closureGiven().entities.map((e) => [e.entityId, e.source, e.version])).toEqual([["a", "draft", undefined], ["b", "pinned", "1.0"]]);
    expect(storedVersion("a", "json-schema").resolution?.entities[1]).toMatchObject({ source: "pinned", version: "1.0" });
  });

  it("refuses a mode other than draft or published", async () => {
    world();
    const result = await actions.generateSchemaAction("a", "json-schema", { mode: "latest" as never });
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(p.entity.findMany).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
  });
});

describe("generateSchemaAction: result and storage", () => {
  beforeEach(() => {
    h.store.entities = [entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer")]]), entity("b", "Customer")];
  });

  it("stores the structured files and an `output` that is exactly their bundled string", async () => {
    const result = (await actions.generateSchemaAction("a", "json-schema")) as { success: true; schemaVersion: SchemaVersion; validationStatus: string };
    expect(result.success).toBe(true);
    expect(result.schemaVersion.files).toEqual(FILES);
    expect(result.schemaVersion.output).toBe(bundleEmittedFiles(FILES));
    expect(result.schemaVersion.output).toBe('===== Order.json =====\n{"title":"Order"}\n\n===== Customer.json =====\n{"title":"Customer"}');
    expect(storedVersion("a", "json-schema")).toMatchObject({ version: 1, status: "draft", files: FILES, output: bundleEmittedFiles(FILES) });
    expect(result.validationStatus).toBe("VALID");
  });

  it("returns the emitter's warnings", async () => {
    h.emitClosure.mockResolvedValue({ success: true, data: { files: FILES, warnings: ["Order and Customer share a namespace"], entityFiles: {} } });
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true, validationStatus: "WARNING", warnings: ["Order and Customer share a namespace"] });
  });

  it("passes the active tenant to the closure and emits for the requested target", async () => {
    await actions.generateSchemaAction("a", "avro");
    expect(p.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" } }));
    expect(h.emitClosure).toHaveBeenCalledWith(expect.anything(), "avro");
  });

  it("answers an emission failure as the error string and stores nothing", async () => {
    h.emitClosure.mockResolvedValue({ success: false, error: { code: "EMISSION_INVALID", message: "x", details: { errors: ["Order: bad name"], warnings: [] } } });
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toEqual({ error: "Order: bad name" });
    expect(p.entity.update).not.toHaveBeenCalled();
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("answers an entity of another tenant like a missing one before loading anything", async () => {
    entityOf("a")!.tenantId = "tenant-2";
    expect(await actions.generateSchemaAction("a", "json-schema")).toMatchObject({ code: "NOT_FOUND" });
    expect(p.entity.findMany).not.toHaveBeenCalled();
  });

  it("keeps the DB targets on their own path: no closure, no files, no resolution", async () => {
    entityOf("a")!.fields.push({ id: "a.id", entityId: "a", name: "id", type: "string", decorators: {}, sortOrder: 9 });
    p.field.findMany.mockResolvedValue([{ name: "id", isKey: true, nullable: false, type: "string", decorators: {} }]);
    const result = await actions.generateSchemaAction("a", "bigquery");
    expect(result).toMatchObject({ success: true });
    expect(h.emitOfficial).toHaveBeenCalledWith("a", "bigquery");
    expect(p.entity.findMany).not.toHaveBeenCalled();
    expect(h.emitClosure).not.toHaveBeenCalled();
    const stored = storedVersion("a", "bigquery");
    expect(stored.output).toBe("DDL");
    expect(stored).not.toHaveProperty("files");
    expect(stored).not.toHaveProperty("resolution");
  });
});

describe("generateSchemaAction: legacy reference upgrade", () => {
  beforeEach(() => {
    h.store.entities = [
      entity("a", "Order", [["cust", { ...legacy("Customer"), cardinality: "many-to-one" }]]),
      entity("b", "Customer", [], { domain: "Sales", product: "Crm" }),
    ];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("writes the qualified form after a successful emission: id and qualified name added, other keys kept, no version", async () => {
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(decoratorWrites()).toEqual([
      {
        where: { id: "a.cust" },
        data: {
          decorators: {
            cardinality: "many-to-one",
            referencedEntityId: "b",
            referencedEntityName: "Customer",
            referencedQualifiedName: "Sales/Crm/Customer",
          },
        },
      },
    ]);
    // The same meaning, only qualified: not an edit of the draft.
    expect(p.$executeRawUnsafe).not.toHaveBeenCalledWith(MARK_DRAFT_CHANGED_SQL, "a");
    // The version stored by that very generation was resolved from the bare name (the stored result is not rewritten).
    expect(closureGiven().entities.map((e) => e.entityId)).toEqual(["a", "b"]);
  });

  it("is idempotent: a second generation finds a qualified reference and writes nothing", async () => {
    await actions.generateSchemaAction("a", "json-schema");
    p.field.update.mockClear();
    await actions.generateSchemaAction("a", "json-schema");
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("never writes when the emission failed or a reference is ambiguous", async () => {
    h.emitClosure.mockResolvedValue({ success: false, error: { code: "EMISSION_INVALID", message: "x", details: { errors: ["bad"], warnings: [] } } });
    await actions.generateSchemaAction("a", "json-schema");
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("fails soft: a failed upgrade does not fail the generation", async () => {
    p.field.update.mockRejectedValue(new Error("connection reset"));
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(storedVersion("a", "json-schema")).toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("does not skip the rest when one upgrade fails", async () => {
    entityOf("a")!.fields.push({ id: "a.other", entityId: "a", name: "other", type: "reference", decorators: legacy("Customer"), sortOrder: 5 });
    p.field.update.mockRejectedValueOnce(new Error("deadlock"));
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(p.field.update).toHaveBeenCalledTimes(2);
  });

  it("leaves a viewer's generation read-only: no upgrade is written without the edit role the pick action requires", async () => {
    h.getEffectiveRole.mockResolvedValue({ success: true, data: "VIEWER" });
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("skips a field that was picked (or changed) between the load and the write", async () => {
    h.emitClosure.mockImplementation(async () => {
      fieldOf("a.cust")!.decorators = qualified("b", "Sales/Crm/Customer", "1.0");
      return { success: true, data: { files: FILES, warnings: [], entityFiles: {} } };
    });
    await actions.generateSchemaAction("a", "json-schema");
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("upgrades only the root's own fields: a referenced entity's legacy reference stays as it is", async () => {
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "Sales/Crm/Customer")]]),
      entity("b", "Customer", [["addr", legacy("Address")]], { domain: "Sales", product: "Crm" }),
      entity("c", "Address"),
    ];
    const result = await actions.generateSchemaAction("a", "json-schema");
    expect(result).toMatchObject({ success: true });
    expect(closureGiven().entities.map((e) => e.entityId)).toEqual(["a", "b", "c"]);
    expect(p.field.update).not.toHaveBeenCalled();
  });

  it("never rewrites a published generation (its content is a frozen snapshot)", async () => {
    h.store.versions = [publish("a", 1, 0, [["cust", legacy("Customer")]]), publish("b", 1, 0, [])];
    entityOf("a")!.latestVersionId = "a-v1.0";
    entityOf("b")!.latestVersionId = "b-v1.0";
    const result = await actions.generateSchemaAction("a", "json-schema", { mode: "published" });
    expect(result).toMatchObject({ success: true });
    expect(p.field.update).not.toHaveBeenCalled();
  });
});
