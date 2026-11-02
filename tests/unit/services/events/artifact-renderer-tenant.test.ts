import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

/**
 * Already-stored forged data must not make the payload preview read another tenant's rows: a draft whose field decorators carry the id of a
 * foreign entity, and a published version with a stored SchemaReference edge to a foreign entity's version. The fake database honours the
 * `tenantId` filters it is given, like the real one.
 */
type V = { id: string; entityId: string; major: number; minor: number; resolvedSource: string; fieldSnapshot: unknown; entity: { name: string; tenantId: string } };
const versions: Record<string, V> = {
  vOrder: { id: "vOrder", entityId: "eOrder", major: 1, minor: 0, entity: { name: "Order", tenantId: "tenant-A" }, resolvedSource: "model Order {\n  id: string;\n  home: Address;\n}\n", fieldSnapshot: [{ name: "id", fieldNumber: 1 }] },
  vAddress: { id: "vAddress", entityId: "eAddress", major: 1, minor: 0, entity: { name: "Address", tenantId: "tenant-A" }, resolvedSource: "model Address {\n  street: string;\n}\n", fieldSnapshot: [] },
  vSecret: { id: "vSecret", entityId: "eSecret", major: 3, minor: 0, entity: { name: "Secret", tenantId: "tenant-B" }, resolvedSource: "model Secret {\n  pan: string;\n}\n", fieldSnapshot: [] },
};
const entities: Record<string, { id: string; name: string; tenantId: string; latestVersionId: string | null }> = {
  eAddress: { id: "eAddress", name: "Address", tenantId: "tenant-A", latestVersionId: "vAddress" },
  eSecret: { id: "eSecret", name: "Secret", tenantId: "tenant-B", latestVersionId: "vSecret" },
};
function fakeDb(pins: Record<string, string[]>, draftTarget = "eAddress") {
  const draft = {
    id: "eOrder", name: "Order", tenantId: "tenant-A", domainId: null, productId: null, metadata: {},
    typespecSource: "model Order {\n  id: string;\n  home: Address;\n}\n",
    fields: [{ id: "f1", name: "home", fieldNumber: 1, decorators: { referencedEntityId: draftTarget } }],
    tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" },
  };
  // the draft roots by entity id: the caller's own `Order`, and a foreign `Secret` whose draft must never render for tenant A
  const drafts: Record<string, Record<string, unknown>> = {
    eOrder: draft,
    eSecret: { ...draft, id: "eSecret", name: "Secret", tenantId: "tenant-B", typespecSource: "model Secret {\n  pan: string;\n}\n", fields: [] },
  };
  return {
    entityVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string; entity?: { tenantId: string } } }) => {
        const v = versions[where.id];
        return v && (where.entity === undefined || v.entity.tenantId === where.entity.tenantId) ? v : null;
      }),
    },
    schemaReference: { findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (pins[where.fromId] ?? []).map((toId) => ({ toId }))) },
    entity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string; tenantId?: string } }) => {
        const row = drafts[where.id];
        return row && (where.tenantId === undefined || row.tenantId === where.tenantId) ? row : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; tenantId?: string } }) =>
        (where.id?.in ?? []).map((id) => entities[id]).filter((e) => e && (where.tenantId === undefined || e.tenantId === where.tenantId))),
    },
  };
}

const emitOk = () =>
  vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Order.avsc.json", content: '{"type":"record","name":"Order","fields":[]}' }] }));
const emitSecret = () =>
  vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: "Secret.avsc.json", content: '{"type":"record","name":"Secret","fields":[]}' }] }));

describe("artifact renderer: another tenant's rows are never read", () => {
  it("DRAFT path: a field naming a foreign entity id renders nothing and never loads its version", async () => {
    const db = fakeDb({}, "eSecret");
    const emitFiles = emitOk();
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "draft", entityId: "eOrder", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("UNRESOLVED_REFERENCE");
    expect(db.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-A" }) }));
    expect(db.entityVersion.findUnique).not.toHaveBeenCalled();
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("DRAFT path: a field naming an entity of the same tenant renders with that entity's published version", async () => {
    const emitFiles = emitOk();
    const r = await createArtifactRenderer({ db: fakeDb({}) as never, emitFiles }).render({ kind: "draft", entityId: "eOrder", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(true);
    expect(emitFiles.mock.calls[0]![1]).toContain("model Address");
  });

  it("PUBLISHED path: a stored SchemaReference edge to a foreign version fails as not found and its source never reaches the emitter", async () => {
    const db = fakeDb({ vOrder: ["vAddress", "vSecret"] });
    const emitFiles = emitOk();
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "version", entityVersionId: "vOrder", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
    expect(emitFiles).not.toHaveBeenCalled();
    // the lookup of every dependency is bound to the root version's tenant
    expect(db.entityVersion.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vSecret", entity: { tenantId: "tenant-A" } } }));
  });

  it("PUBLISHED path: an edge to a version of the same tenant renders", async () => {
    const emitFiles = emitOk();
    const r = await createArtifactRenderer({ db: fakeDb({ vOrder: ["vAddress"] }) as never, emitFiles }).render({ kind: "version", entityVersionId: "vOrder", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(true);
    expect(emitFiles.mock.calls[0]![1]).toContain("model Address");
    expect(emitFiles.mock.calls[0]![1]).not.toContain("Secret");
  });

  it("VERSION root: a version of another tenant, named as the root, is not found and its source never reaches the emitter", async () => {
    const db = fakeDb({});
    const emitFiles = emitSecret();
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "version", entityVersionId: "vSecret", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
    expect(db.entityVersion.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "vSecret", entity: { tenantId: "tenant-A" } } }));
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("DRAFT root: an entity of another tenant, named as the root, is not found and its draft never renders", async () => {
    const db = fakeDb({});
    const emitFiles = emitSecret();
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render({ kind: "draft", entityId: "eSecret", tenantId: "tenant-A" }, "avro");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
    expect(db.entity.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "eSecret", tenantId: "tenant-A" } }));
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("CACHE: a version rendered for its own tenant is not handed to another tenant from the render cache", async () => {
    const emitFiles = emitSecret();
    const renderer = createArtifactRenderer({ db: fakeDb({}) as never, emitFiles });
    const own = await renderer.render({ kind: "version", entityVersionId: "vSecret", tenantId: "tenant-B" }, "avro");
    expect(own.success).toBe(true);
    const foreign = await renderer.render({ kind: "version", entityVersionId: "vSecret", tenantId: "tenant-A" }, "avro");
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.error.code).toBe("NOT_FOUND");
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });

  it("a subject without its tenant is refused before anything is read", async () => {
    const db = fakeDb({});
    const emitFiles = emitOk();
    const untyped = { kind: "version", entityVersionId: "vOrder" } as never;
    const r = await createArtifactRenderer({ db: db as never, emitFiles }).render(untyped, "avro");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("NOT_FOUND");
    expect(db.entityVersion.findUnique).not.toHaveBeenCalled();
    expect(emitFiles).not.toHaveBeenCalled();
  });
});
