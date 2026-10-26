import { beforeEach, describe, expect, it, vi } from "vitest";

// Already-stored forged data: a field of tenant A whose decorators carry the id of tenant B's PUBLISHED entity. The publish preview, the publish
// and the pin edge it writes must never read that entity's name or latest version.

const h = vi.hoisted(() => ({ closure: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({
  withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  AuditUserMissingError: class AuditUserMissingError extends Error {},
}));
vi.mock("@/lib/entity-versioning/publish-closure", () => ({ loadPublishClosure: h.closure }));
vi.mock("@/lib/entity-versioning/resolve-source", () => ({
  needsRegeneration: () => false,
  compileClosure: async () => ({ success: true, data: "" }),
  compileRegeneratedSource: async () => ({ success: true, data: "" }),
  confirmRegeneratedSource: async () => ({ success: true, data: undefined }),
  freezableStoredSource: (source: string) => ({ source, upgraded: false }),
}));

import { previewPublish, publishEntity } from "@/services/entity-version.service";

type Row = Record<string, unknown>;
const FOREIGN: Row = { id: "eB", name: "SecretCustomer", tenantId: "tenant-B", latestVersionId: "vB1" };
const OWN_TARGET: Row = { id: "eC", name: "Address", tenantId: "tenant-A", latestVersionId: "vC1" };
const FIELD = (referencedEntityId: string) => ({
  id: "f1", name: "buyer", type: "reference", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: 1, description: "",
  classification: null, aliases: [], sortOrder: 0, decorators: { referencedEntityId },
});

function fakeDb(referencedEntityId: string) {
  const rows: Record<string, Row> = { eB: FOREIGN, eC: OWN_TARGET };
  const owner = {
    id: "eA", name: "Order", tenantId: "tenant-A", status: "DRAFT", version: 0, hasUnpublishedChanges: true, typespecSource: "model Order {}", metadata: {},
    domainId: null, productId: null, fields: [FIELD(referencedEntityId)], latestVersion: null,
  };
  const db = {
    entity: {
      findUnique: vi.fn(async () => owner),
      // honours the filters it is given, like the database: an id outside `tenantId` is simply not there
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; tenantId?: string } }) =>
        (where.id?.in ?? []).map((id) => rows[id]).filter((r): r is Row => !!r && (where.tenantId === undefined || r.tenantId === where.tenantId))),
      update: vi.fn(async () => ({ id: "eA" })),
    },
    entityVersion: {
      findMany: vi.fn(async () => [{ id: "vC1", entityId: "eC", major: 1, minor: 0 }]),
      create: vi.fn(async () => ({ id: "vNew", entityId: "eA", major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u1", publishedAt: new Date(0), publishedBy: { name: "U" } })),
    },
    schemaReference: { createMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}

const ctx = (db: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma: db }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.closure.mockResolvedValue({ success: true, data: { closure: { entities: [] }, referencedVersions: [] } });
});

describe("publish preview and publish never read another tenant's entity named by stored decorators", () => {
  it("the preview scopes the target lookup to the owner's tenant and shows the forged id as a missing reference, not the foreign name", async () => {
    const db = fakeDb("eB");
    const r = await previewPublish("eA", ctx(db));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(db.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-A" }) }));
    expect(r.data.pins).toEqual([]);
    expect(JSON.stringify(r.data)).not.toContain("SecretCustomer");
    expect(r.data.blockers).toEqual([expect.objectContaining({ kind: "MISSING_REFERENCE", entityId: "eB" })]);
  });

  it("a reference to an entity of the same tenant is still pinned", async () => {
    const db = fakeDb("eC");
    const r = await previewPublish("eA", ctx(db));
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.blockers).toEqual([]);
    expect(r.data.pins).toEqual([{ entityId: "eC", entityName: "Address", versionId: "vC1" }]);
  });

  it("the publish is blocked and writes no version and no SchemaReference edge to the foreign entity's version", async () => {
    const db = fakeDb("eB");
    const r = await publishEntity("eA", {}, ctx(db));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.code).toBe("PUBLISH_BLOCKED");
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.schemaReference.createMany).not.toHaveBeenCalled();
    expect(db.entityVersion.create).not.toHaveBeenCalled();
  });

  it("a legitimate publish writes its edge through a version lookup that is bound to the owner's tenant", async () => {
    h.closure.mockResolvedValue({
      success: true,
      data: {
        closure: { root: { entity: { name: "Order", description: "", status: "DRAFT", metadata: {} } }, entities: [{}, {}] },
        referencedVersions: [{ ref: { entityId: "eC", domain: "d", product: "p", entity: "Address" }, version: "1.0", pinned: false }],
      },
    });
    const db = fakeDb("eC");
    const r = await publishEntity("eA", {}, ctx(db));
    if (!r.success) throw new Error(r.error.message);
    expect(db.entityVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ entity: { tenantId: "tenant-A" } }) }));
    expect(db.schemaReference.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ fromId: "vNew", toId: "vC1" })] }));
  });
});
