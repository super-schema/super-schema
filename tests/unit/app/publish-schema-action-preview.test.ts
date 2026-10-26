import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 8 (carried over from Task 7): publishSchemaAction must not publish a stored schema version whose referenced entities were
// resolved at DRAFT state (a page-generated closure version is a preview). It refuses, naming them and saying how to fix it; a version
// regenerated in published mode publishes; a stand-alone version, a version with no references and a DB / native version (no
// `resolution`) publish exactly as before; `regenerateFromPublished` regenerates in published mode and publishes the result.
// Prisma is a stateful in-memory fake (the repo's pattern for the entity actions); the TypeSpec compile is replaced; the reference
// loader, the bundling and the stored shape are the real ones.

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
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
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
import type { SchemaVersion } from "@/types/schema-version";

const p = h.prisma;
const entities = () => h.store.entities as EntityRow[];
const versions = () => h.store.versions as VersionRow[];
const entityOf = (id: string) => entities().find((e) => e.id === id);
const stored = (id: string, target: string) => (entityOf(id)?.metadata.schemaVersions as Record<string, SchemaVersion[]>)[target];

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
  p.field.findUnique.mockResolvedValue(null);
  p.entityVersion.findUnique.mockImplementation(async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } } }) => {
    if (where.id) return versions().find((v) => v.id === where.id) ?? null;
    const k = where.entityId_major_minor!;
    return versions().find((v) => v.entityId === k.entityId && v.major === k.major && v.minor === k.minor) ?? null;
  });
  h.emitClosure.mockResolvedValue({ success: true, data: { files: FILES, warnings: [], entityFiles: { a: ["Order.json"], b: ["Customer.json"] } } });
  h.emitOfficial.mockResolvedValue({ output: "DDL", validationStatus: "VALID", warnings: [], errors: [] });
});

/** Order -> Customer; Customer's published 1.0 has no reference, its saved draft references Address (never published). */
function world() {
  h.store.versions = [publish("a", 1, 0, [["cust", qualified("b", "_tenant/_tenant/Customer")]]), publish("b", 1, 0, [])];
  h.store.entities = [
    entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer")]], { latestVersionId: "a-v1.0" }),
    entity("b", "Customer", [["addr", qualified("c", "_tenant/_tenant/Address")]], { latestVersionId: "b-v1.0" }),
    entity("c", "Address"),
  ];
}

const statusOf = (id: string, target: string, version: number) => stored(id, target).find((v) => v.version === version)?.status;

describe("publishSchemaAction refuses a preview that resolved referenced entities at draft state", () => {
  it("a page-generated closure version whose references are drafts is refused, naming them and saying how to fix it, and nothing is written", async () => {
    world();
    expect(await actions.generateSchemaAction("a", "json-schema")).toMatchObject({ success: true }); // draft mode: Customer and Address at draft
    p.entity.update.mockClear();
    p.auditLog.create.mockClear();

    const result = await actions.publishSchemaAction("a", "json-schema", 1);

    expect(result).toMatchObject({ code: "PREVIEW_NOT_PUBLISHABLE", needsPublishedRegeneration: true });
    const refusal = result as { error: string; draftEntities: Array<{ entityId: string; entity: string }> };
    expect(refusal.error).toContain("_tenant / _tenant / Customer");
    expect(refusal.error).toContain("_tenant / _tenant / Address");
    expect(refusal.error).not.toContain("Order"); // the root is not a draft reference
    expect(refusal.error).toMatch(/Publish any of them that are not yet published, then regenerate/);
    expect(refusal.error).toMatch(/published mode/);
    expect(refusal.error).toMatch(/unpublished edits to this entity itself are not included/);
    expect(refusal.draftEntities.map((e) => e.entity)).toEqual(["Customer", "Address"]);
    expect(p.entity.update).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
    expect(statusOf("a", "json-schema", 1)).toBe("draft");
  });

  it("a version regenerated in published mode (resolution.preview false) is publishable", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema");
    expect(await actions.publishSchemaAction("a", "json-schema", 1)).toMatchObject({ code: "PREVIEW_NOT_PUBLISHABLE" });

    // Customer's published 1.0 does not reference Address, so the published-mode closure is just Order and Customer.
    const regenerated = await actions.generateSchemaAction("a", "json-schema", { mode: "published" });
    expect(regenerated).toMatchObject({ success: true });
    const version = (regenerated as { schemaVersion: SchemaVersion }).schemaVersion;
    expect(version.resolution).toMatchObject({ mode: "published", preview: false });

    const result = await actions.publishSchemaAction("a", "json-schema", version.version);
    expect(result).toEqual({ success: true });
    expect(statusOf("a", "json-schema", version.version)).toBe("published");
    expect(stored("a", "json-schema").find((v) => v.version === version.version)?.publishedAt).toBeDefined();
  });

  it("a stand-alone / zero-reference version generated from the page (root at draft, nothing else) publishes exactly as before", async () => {
    h.store.entities = [entity("a", "Order")];
    await actions.generateSchemaAction("a", "json-schema");
    expect(stored("a", "json-schema")[0].resolution).toMatchObject({ mode: "draft", preview: true }); // preview counts the root
    expect(await actions.publishSchemaAction("a", "json-schema", 1)).toEqual({ success: true });
    expect(statusOf("a", "json-schema", 1)).toBe("published");
  });

  it("a draft-mode version whose references are all published or pinned publishes", async () => {
    h.store.versions = [publish("b", 1, 0, []), publish("b", 1, 1, [])];
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer", "1.0")]]),
      entity("b", "Customer", [], { latestVersionId: "b-v1.1" }),
    ];
    await actions.generateSchemaAction("a", "json-schema");
    expect(stored("a", "json-schema")[0].resolution?.entities.map((e) => [e.ref.entity, e.source])).toEqual([["Order", "draft"], ["Customer", "pinned"]]);
    expect(await actions.publishSchemaAction("a", "json-schema", 1)).toEqual({ success: true });
  });

  it("a DB / native version (no resolution) publishes as before", async () => {
    h.store.entities = [entity("a", "Order")];
    entityOf("a")!.metadata = { schemaVersions: { bigquery: [{ version: 1, status: "draft", output: "DDL", generatedAt: "t", entityVersion: 1 }] } };
    expect(stored("a", "bigquery")[0].resolution).toBeUndefined();
    expect(await actions.publishSchemaAction("a", "bigquery", 1)).toEqual({ success: true });
    expect(statusOf("a", "bigquery", 1)).toBe("published");
  });

  it("a stored version with malformed resolution data publishes (nothing to refuse) instead of failing", async () => {
    h.store.entities = [entity("a", "Order")];
    entityOf("a")!.metadata = {
      schemaVersions: { "json-schema": [{ version: 1, status: "draft", output: "x", generatedAt: "t", entityVersion: 1, resolution: { mode: "draft", preview: true, entities: "junk" } }] },
    };
    expect(await actions.publishSchemaAction("a", "json-schema", 1)).toEqual({ success: true });
  });

  it("the refusal does not touch the other versions or the stored version it refused", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema");
    const before = JSON.stringify(entityOf("a")!.metadata);
    await actions.publishSchemaAction("a", "json-schema", 1);
    expect(JSON.stringify(entityOf("a")!.metadata)).toBe(before);
  });

  it("an unknown version and a version that is not a draft keep their own errors (checked before the preview rule)", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema");
    expect(await actions.publishSchemaAction("a", "json-schema", 9)).toEqual({ error: "Version 9 not found" });
  });
});

describe("publishSchemaAction with regenerateFromPublished", () => {
  it("regenerates the target in published mode and publishes the regenerated version, never the preview", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema"); // a preview, version 1 (draft)
    expect(await actions.publishSchemaAction("a", "json-schema", 1)).toMatchObject({ code: "PREVIEW_NOT_PUBLISHABLE" });

    const result = await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: true });

    expect(result).toEqual({ success: true });
    const published = stored("a", "json-schema").find((v) => v.status === "published");
    expect(published?.resolution).toMatchObject({ mode: "published", preview: false });
    expect(published?.resolution?.entities.some((e) => e.source === "draft")).toBe(false);
    // The closure that was emitted last is the published one: Order and Customer at 1.0, no Address.
    const last = h.emitClosure.mock.calls.at(-1)![0] as { entities: Array<{ entityId: string; source: string }> };
    expect(last.entities.map((e) => [e.entityId, e.source])).toEqual([["a", "published"], ["b", "published"]]);
  });

  it("refuses with the generation's own message, naming the entity, when a referenced entity was never published; nothing is published", async () => {
    h.store.versions = [publish("a", 1, 0, [["cust", qualified("b", "_tenant/_tenant/Customer")]])];
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer")]], { latestVersionId: "a-v1.0" }),
      entity("b", "Customer"),
    ];
    await actions.generateSchemaAction("a", "json-schema");

    const result = await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: true });

    expect(result).toMatchObject({ code: "NEVER_PUBLISHED" });
    expect((result as { error: string }).error).toContain("_tenant / _tenant / Customer");
    expect(stored("a", "json-schema").some((v) => v.status === "published")).toBe(false);
  });

  it("an ambiguous bare name frozen in a published member found while regenerating is a refusal that says to publish the member again, with NO pick to ask for", async () => {
    // Order -> Customer. Customer's saved draft references Address (so the page-generated preview succeeds, with draft references);
    // its PUBLISHED 1.0 holds a bare-name reference to "Dup", which two entities share: regenerating from the published versions cannot guess,
    // and a pick cannot help (the frozen snapshot keeps the bare name; only a new version of Customer carries the pick): final wave 2b, G2.
    h.store.versions = [
      publish("a", 1, 0, [["cust", qualified("b", "_tenant/_tenant/Customer")]]),
      publish("b", 1, 0, [["dup", { referencedEntityName: "Dup" }]]),
    ];
    h.store.entities = [
      entity("a", "Order", [["cust", qualified("b", "_tenant/_tenant/Customer")]], { latestVersionId: "a-v1.0" }),
      entity("b", "Customer", [["addr", qualified("c", "_tenant/_tenant/Address")]], { latestVersionId: "b-v1.0" }),
      entity("c", "Address"),
      entity("x1", "Dup", [], { domain: "d1", product: "p1" }),
      entity("x2", "Dup", [], { domain: "d2", product: "p2" }),
    ];
    expect(await actions.generateSchemaAction("a", "json-schema")).toMatchObject({ success: true });
    p.entity.update.mockClear();

    const result = await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: true });

    const generated = await actions.generateSchemaAction("a", "json-schema", { mode: "published" });
    expect(generated).not.toHaveProperty("needsReference"); // generating alone asks nothing either
    expect(generated).toMatchObject({ code: "AMBIGUOUS_REFERENCE" });
    expect(result).toMatchObject({ code: "AMBIGUOUS_REFERENCE" });
    expect(result).not.toHaveProperty("needsReference");
    expect((result as { error: string }).error).toContain('This published version of Customer refers to "Dup" by name');
    expect((result as { error: string }).error).toMatch(/Publish Customer again/);
    expect(p.entity.update).not.toHaveBeenCalled();
    expect(stored("a", "json-schema").some((v) => v.status === "published")).toBe(false);
  });

  it("is ignored when the version is publishable as it is (no regeneration, no extra version)", async () => {
    h.store.entities = [entity("a", "Order")];
    await actions.generateSchemaAction("a", "json-schema");
    h.emitClosure.mockClear();
    expect(await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: true })).toEqual({ success: true });
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(stored("a", "json-schema")).toHaveLength(1);
  });

  it("anything but `true` does not regenerate", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema");
    h.emitClosure.mockClear();
    const result = await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: "yes" } as never);
    expect(result).toMatchObject({ code: "PREVIEW_NOT_PUBLISHABLE" });
    expect(h.emitClosure).not.toHaveBeenCalled();
  });

  it("another tenant's entity is still not found, before anything is regenerated", async () => {
    world();
    await actions.generateSchemaAction("a", "json-schema");
    h.emitClosure.mockClear();
    p.entity.update.mockClear();
    h.getActiveTenantId.mockResolvedValue("tenant-2");
    const result = await actions.publishSchemaAction("a", "json-schema", 1, { regenerateFromPublished: true });
    expect(result).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(h.emitClosure).not.toHaveBeenCalled();
    expect(p.entity.update).not.toHaveBeenCalled();
  });
});
