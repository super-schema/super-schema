/**
 * Task 8: publishEntity judges the entity against its REAL reference closure (the entity at its saved rows, everything it references
 * at its latest published version or pin, never a draft), records the version of every referenced entity it used on the published
 * version, blocks with a message naming the entity, and previews the same blockers. Prisma is a stateful in-memory fake; audit is
 * a pass-through; the TypeSpec compiler is a spy (the real closure source it is handed is asserted), everything else is real code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Decorators = Record<string, unknown>;
type FieldRow = { id: string; entityId: string; name: string; type: string; decorators: Decorators; sortOrder: number };
type VersionRow = { id: string; entityId: string; major: number; minor: number; sequence: number; fieldSnapshot: unknown[]; compatReport?: unknown };
type EntityRow = {
  id: string;
  tenantId: string;
  name: string;
  domain: string;
  product: string;
  typespecSource: string | null;
  metadata: Record<string, unknown>;
  hasUnpublishedChanges: boolean;
  latestVersionId: string | null;
  fields: FieldRow[];
};

const h = vi.hoisted(() => ({
  compile: vi.fn(),
  store: { entities: [] as unknown[], versions: [] as unknown[] },
  created: [] as Array<Record<string, unknown>>,
  afterCompile: null as null | (() => void),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({
  withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  AuditUserMissingError: class extends Error {},
}));
vi.mock("@/lib/compiler/typespec-compiler", () => ({ compileTypeSpecWithGovernance: h.compile }));

import { publishEntity, previewPublish, loadReferenceStaleness } from "@/services/entity-version.service";
import { readReferencedVersions } from "@/lib/entity-versioning/referenced-versions";
import type { ServiceContext } from "@/types/service-context";

const entities = () => h.store.entities as EntityRow[];
const versions = () => h.store.versions as VersionRow[];
const entityOf = (id: string) => entities().find((e) => e.id === id);

const qref = (id: string, name: string, pin?: string): Decorators => ({
  referencedEntityId: id,
  referencedEntityName: name,
  referencedQualifiedName: `Sales/Orders/${name}`,
  ...(pin ? { referencedEntityVersion: pin } : {}),
});

function entity(id: string, name: string, fields: Array<[string, string, Decorators?]> = [], over: Partial<EntityRow> = {}): EntityRow {
  return {
    id,
    tenantId: "tenant-1",
    name,
    domain: "Sales",
    product: "Orders",
    typespecSource: null, // never saved on the TypeSpec tab: publish regenerates and compiles
    metadata: {},
    hasUnpublishedChanges: true,
    latestVersionId: null,
    fields: fields.map(([fieldName, type, decorators], i) => ({ id: `${id}.${fieldName}`, entityId: id, name: fieldName, type, decorators: decorators ?? {}, sortOrder: i })),
    ...over,
  };
}

const snapshotOf = (e: EntityRow) =>
  e.fields.map((f) => ({
    id: f.id, name: f.name, type: f.type, precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
    description: "", classification: null, aliases: [], decorators: f.decorators, sortOrder: f.sortOrder,
  }));

/** Marks `id` as published at major.minor with the given frozen fields; its saved rows are untouched (they may differ: a draft). */
function publishAs(id: string, major: number, minor: number, frozen: Array<[string, string, Decorators?]> = []): VersionRow {
  const owner = entityOf(id) as EntityRow;
  const row: VersionRow = {
    id: `${id}-v${major}.${minor}`, entityId: id, major, minor, sequence: major * 10 + minor,
    fieldSnapshot: snapshotOf(entity(id, owner.name, frozen)),
  };
  versions().push(row);
  owner.latestVersionId = row.id;
  owner.hasUnpublishedChanges = false;
  return row;
}

function fakePrisma() {
  const rowOf = (e: EntityRow) => ({
    id: e.id, tenantId: e.tenantId, name: e.name, description: "", status: "DRAFT", version: 1, hasUnpublishedChanges: e.hasUnpublishedChanges,
    typespecSource: e.typespecSource, metadata: e.metadata, domainId: `d-${e.domain}`, productId: `p-${e.product}`, latestVersionId: e.latestVersionId,
    domain: { id: `d-${e.domain}`, name: e.domain, slug: `${e.domain}-slug` }, product: { name: e.product },
  });
  const latestOf = (e: EntityRow) => versions().find((v) => v.id === e.latestVersionId) ?? null;

  const entityApi = {
    findUnique: vi.fn(async (args: { where: { id: string }; include?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      const e = entityOf(args.where.id);
      if (!e) return null;
      if (args.select?.metadata) return { metadata: e.metadata }; // the closure's per-member metadata read
      if (args.select?.latestVersion) {
        const latest = latestOf(e);
        return { tenantId: e.tenantId, latestVersion: latest ? { compatReport: latest.compatReport ?? {}, major: latest.major, minor: latest.minor } : null };
      }
      const latest = latestOf(e);
      return {
        ...rowOf(e),
        fields: e.fields.map((f) => ({ ...f, slug: f.name, precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [] })),
        latestVersion: latest ? { id: latest.id, major: latest.major, minor: latest.minor, sequence: latest.sequence, fieldSnapshot: latest.fieldSnapshot } : null,
      };
    }),
    findMany: vi.fn(async (args: { where: { tenantId?: string; id?: { in: string[] } } }) => {
      if (args.where.id?.in) {
        return entities()
          .filter((e) => args.where.id!.in.includes(e.id))
          .map((e) => {
            const latest = latestOf(e);
            return { id: e.id, name: e.name, latestVersionId: e.latestVersionId, latestVersion: latest ? { major: latest.major, minor: latest.minor } : null };
          });
      }
      // The entity's line and the closure's tenant index: every entity of the tenant (all share one domain and product here).
      return entities().filter((e) => e.tenantId === args.where.tenantId).map(rowOf);
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(entityOf(where.id) as object, data);
      return { id: where.id };
    }),
  };
  const fieldApi = {
    findMany: vi.fn(async ({ where }: { where: { entityId: string } }) =>
      (entityOf(where.entityId)?.fields ?? []).map((f) => ({
        ...f, precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [],
      }))
    ),
  };
  const versionApi = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; entityId_major_minor?: { entityId: string; major: number; minor: number } } }) => {
      if (where.id) return versions().find((v) => v.id === where.id) ?? null;
      const k = where.entityId_major_minor!;
      return versions().find((v) => v.entityId === k.entityId && v.major === k.major && v.minor === k.minor) ?? null;
    }),
    // The edges' targets: `where: { OR: [{ entityId, major, minor }, ...] }`.
    findMany: vi.fn(async ({ where }: { where: { OR: Array<{ entityId: string; major: number; minor: number }> } }) =>
      versions().filter((v) => where.OR.some((k) => k.entityId === v.entityId && k.major === v.major && k.minor === v.minor))
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      h.created.push(data);
      const row: VersionRow = {
        id: `${data.entityId}-v${data.major}.${data.minor}`, entityId: data.entityId as string, major: data.major as number, minor: data.minor as number,
        sequence: data.sequence as number, fieldSnapshot: data.fieldSnapshot as unknown[], compatReport: data.compatReport,
      };
      versions().push(row);
      return {
        id: row.id, entityId: row.entityId, major: row.major, minor: row.minor, sequence: row.sequence, changeKind: data.changeKind, changeSummary: null,
        publishedById: "u1", publishedAt: new Date("2026-10-23T00:00:00Z"), publishedBy: { name: "U" },
      };
    }),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    entity: entityApi,
    field: fieldApi,
    entityVersion: versionApi,
    schemaReference: { createMany: vi.fn() },
  };
  return { prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }, tx };
}

const ctxFor = (prisma: unknown) => ({ userId: "u1", userRole: "AUTHOR", prisma }) as unknown as ServiceContext;
const compiledSource = () => h.compile.mock.calls[0][0] as string;
const createdReport = () => h.created[0].compatReport;

beforeEach(() => {
  vi.clearAllMocks();
  h.store.entities = [];
  h.store.versions = [];
  h.created = [];
  h.afterCompile = null;
  h.compile.mockImplementation(async () => {
    h.afterCompile?.();
    return { success: true, diagnostics: [] };
  });
});

// Order references Customer. Customer's PUBLISHED 1.0 has `name`; its saved rows have since gained `secretDraft`.
function orderAndCustomer(orderFieldDecorators: Decorators = qref("cust", "Customer")) {
  h.store.entities = [
    entity("order", "Order", [["id", "string"], ["buyer", "reference", orderFieldDecorators]]),
    entity("cust", "Customer", [["name", "string"], ["secretDraft", "string"]]),
  ];
  publishAs("cust", 1, 0, [["name", "string"]]);
}

describe("publishEntity: the gate compiles the real closure", () => {
  it("compiles the order with Customer's PUBLISHED content, never its draft, and with no stand-in model", async () => {
    orderAndCustomer();
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(true);

    expect(h.compile).toHaveBeenCalledTimes(1);
    const source = compiledSource();
    expect(source).toContain("namespace SuperSchemaClosure.Sales.Orders.Order");
    expect(source).toContain("namespace SuperSchemaClosure.Sales.Orders.Customer");
    expect(source).toContain("name"); // Customer's published field
    expect(source).not.toContain("secretDraft"); // its draft-only field
    expect(source).not.toMatch(/model Customer \{\}/); // no stub
    expect(source).toContain("buyer?: SuperSchemaClosure.Sales.Orders.Customer.Customer");
  });

  it("what is frozen is still the entity's own text, never the closure document", async () => {
    orderAndCustomer();
    const { prisma } = fakePrisma();
    await publishEntity("order", {}, ctxFor(prisma));
    const frozen = h.created[0].resolvedSource as string;
    expect(frozen).toContain("model Order");
    expect(frozen).not.toContain("SuperSchemaClosure");
    expect(frozen).not.toContain("secretDraft");
  });

  it("an entity that references nothing publishes as before: one compile of its own closure, an empty record", async () => {
    h.store.entities = [entity("order", "Order", [["id", "string"]])];
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(true);
    expect(h.compile).toHaveBeenCalledTimes(1);
    expect(createdReport()).toEqual({ referencedVersions: [] });
  });

  it("a fresh stored source of an entity that references nothing is not compiled (unchanged)", async () => {
    h.store.entities = [entity("order", "Order", [["id", "string"]], { typespecSource: "model Order { id: string; }\n" })];
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(h.compile).not.toHaveBeenCalled();
    expect(h.created[0].resolvedSource).toBe("model Order { id: string; }\n");
  });

  it("a fresh stored source of an entity WITH references is still gated by the closure compile", async () => {
    orderAndCustomer();
    entityOf("order")!.typespecSource = "model Order { id: string; buyer?: Customer; }\n";
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(h.compile).toHaveBeenCalledTimes(1);
    expect(compiledSource()).toContain("namespace SuperSchemaClosure.Sales.Orders.Customer");
    expect(h.created[0].resolvedSource).toBe("model Order { id: string; buyer?: Customer; }\n");
  });

  it("blocks with the compiler's diagnostic when the closure does not compile, creating nothing", async () => {
    orderAndCustomer();
    h.compile.mockResolvedValueOnce({ success: false, diagnostics: [{ severity: "error", code: "invalid-ref", message: "Unknown identifier Thing" }] });
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(!res.success && res.error.code).toBe("PUBLISH_BLOCKED");
    expect(!res.success && res.error.message).toContain("Unknown identifier Thing");
    expect(h.created).toHaveLength(0);
  });
});

describe("publishEntity: blocked while a closure member cannot be published against", () => {
  it("a referenced entity that was never published: named, nothing created, nothing compiled", async () => {
    h.store.entities = [entity("order", "Order", [["buyer", "reference", qref("cust", "Customer")]]), entity("cust", "Customer", [["name", "string"]])];
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PUBLISH_BLOCKED");
    expect(res.error.message).toContain("Customer");
    expect(res.error.message).toMatch(/Publish Customer first/);
    expect(h.created).toHaveLength(0);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it("an entity only reachable through a published one (Order -> Customer -> Address, Address draft-only) is named", async () => {
    h.store.entities = [
      entity("order", "Order", [["buyer", "reference", qref("cust", "Customer")]]),
      entity("cust", "Customer", [["addr", "reference", qref("addr", "Address")]]),
      entity("addr", "Address", [["street", "string"]]),
    ];
    publishAs("cust", 1, 0, [["addr", "reference", qref("addr", "Address")]]);
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PUBLISH_BLOCKED");
    expect(res.error.message).toContain("Address");
    expect(res.error.message).toContain("never been published");
    expect(h.created).toHaveLength(0);
  });

  it("a pin whose version is gone names the field, the entity and the version", async () => {
    orderAndCustomer(qref("cust", "Customer", "9.9"));
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("PUBLISH_BLOCKED");
    expect(res.error.message).toContain('"buyer"');
    expect(res.error.message).toContain("9.9");
    expect(res.error.message).toContain("Sales / Orders / Customer");
    expect(h.created).toHaveLength(0);
  });

  it("a closure blocker is previewed too, so the dialog shows it before the user tries", async () => {
    h.store.entities = [
      entity("order", "Order", [["buyer", "reference", qref("cust", "Customer")]]),
      entity("cust", "Customer", [["addr", "reference", qref("addr", "Address")]]),
      entity("addr", "Address"),
    ];
    publishAs("cust", 1, 0, [["addr", "reference", qref("addr", "Address")]]);
    const { prisma } = fakePrisma();
    const res = await previewPublish("order", ctxFor(prisma));
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.blockers).toEqual([expect.objectContaining({ kind: "CLOSURE_BLOCKED", code: "NEVER_PUBLISHED", entityId: "addr" })]);
  });
});

describe("publishEntity: records the versions it used", () => {
  it("records the latest published version of each referenced entity, unpinned", async () => {
    orderAndCustomer();
    publishAs("cust", 1, 2, [["name", "string"]]); // latest is now 1.2
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(readReferencedVersions(createdReport())).toEqual([
      { ref: { entityId: "cust", domain: "Sales", product: "Orders", entity: "Customer" }, version: "1.2", pinned: false },
    ]);
  });

  it("records a pinned version as pinned, even when a newer one is published", async () => {
    orderAndCustomer(qref("cust", "Customer", "1.0"));
    publishAs("cust", 1, 2, [["name", "string"], ["extra", "string"]]);
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(readReferencedVersions(createdReport())).toEqual([
      { ref: { entityId: "cust", domain: "Sales", product: "Orders", entity: "Customer" }, version: "1.0", pinned: true },
    ]);
    // The compile saw the pinned version's content, not 1.2's.
    expect(compiledSource()).not.toContain("extra");
  });

  it("records the whole transitive closure, root excluded, in closure order", async () => {
    h.store.entities = [
      entity("order", "Order", [["buyer", "reference", qref("cust", "Customer")]]),
      entity("cust", "Customer", [["addr", "reference", qref("addr", "Address")]]),
      entity("addr", "Address", [["street", "string"]]),
    ];
    publishAs("addr", 2, 1, [["street", "string"]]);
    publishAs("cust", 1, 0, [["addr", "reference", qref("addr", "Address")]]);
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(readReferencedVersions(createdReport()).map((r) => [r.ref.entity, r.version, r.pinned])).toEqual([
      ["Customer", "1.0", false],
      ["Address", "2.1", false],
    ]);
  });

  it("keeps the record next to the other compatReport bookkeeping, as a plain JSON object", async () => {
    orderAndCustomer();
    const { prisma } = fakePrisma();
    await publishEntity("order", {}, ctxFor(prisma));
    expect(JSON.parse(JSON.stringify(createdReport()))).toEqual({
      referencedVersions: [{ ref: { entityId: "cust", domain: "Sales", product: "Orders", entity: "Customer" }, version: "1.0", pinned: false }],
    });
  });

  it("aborts with a retryable CONFLICT when a referenced entity publishes a newer version between the compile and the lock", async () => {
    orderAndCustomer();
    h.afterCompile = () => {
      publishAs("cust", 1, 1, [["name", "string"]]); // lands after phase 1 compiled against 1.0
    };
    const { prisma } = fakePrisma();
    const res = await publishEntity("order", {}, ctxFor(prisma));
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error.code).toBe("CONFLICT");
    expect(res.error.message).toMatch(/referenced entity/i);
    expect(h.created).toHaveLength(0);

    // The retry compiles and records 1.1.
    h.afterCompile = null;
    const retried = await publishEntity("order", {}, ctxFor(prisma));
    expect(retried.success).toBe(true);
    expect(readReferencedVersions(createdReport())[0].version).toBe("1.1");
  });
});

describe("publishEntity: the SchemaReference edges agree with the recorded versions", () => {
  /** The (fromId, toId) rows the publish wrote. */
  const edges = (tx: { schemaReference: { createMany: ReturnType<typeof vi.fn> } }) =>
    tx.schemaReference.createMany.mock.calls.flatMap((c) => (c[0] as { data: Array<{ fromId: string; toId: string; role: string; isDraft: boolean }> }).data);

  it("an unpinned direct reference points at the latest published version, the one recorded", async () => {
    orderAndCustomer();
    publishAs("cust", 1, 2, [["name", "string"]]);
    const { prisma, tx } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(edges(tx)).toEqual([expect.objectContaining({ fromId: "order-v1.0", toId: "cust-v1.2", role: "FIELD", isDraft: false })]);
    expect(readReferencedVersions(createdReport())[0]).toMatchObject({ version: "1.2", pinned: false });
  });

  it("a PINNED direct reference points at the pinned version, not at the latest published one", async () => {
    orderAndCustomer(qref("cust", "Customer", "1.0"));
    publishAs("cust", 1, 2, [["name", "string"], ["extra", "string"]]);
    const { prisma, tx } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(edges(tx).map((e) => e.toId)).toEqual(["cust-v1.0"]);
    expect(readReferencedVersions(createdReport())[0]).toMatchObject({ version: "1.0", pinned: true });
  });

  it("every edge names exactly the version recorded for its entity (pinned and unpinned side by side)", async () => {
    h.store.entities = [
      entity("order", "Order", [["a", "reference", qref("cust", "Customer", "1.0")], ["b", "reference", qref("addr", "Address")]]),
      entity("cust", "Customer", [["name", "string"]]),
      entity("addr", "Address", [["street", "string"]]),
    ];
    publishAs("cust", 1, 0, [["name", "string"]]);
    publishAs("cust", 1, 1, [["name", "string"]]);
    publishAs("addr", 3, 0, [["street", "string"]]);
    const { prisma, tx } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);

    const recorded = readReferencedVersions(createdReport());
    const edgeLabels = edges(tx).map((e) => {
      const v = versions().find((row) => row.id === e.toId)!;
      return [v.entityId, `${v.major}.${v.minor}`];
    });
    expect(edgeLabels.sort()).toEqual(recorded.map((r) => [r.ref.entityId, r.version]).sort());
    expect(edgeLabels.sort()).toEqual([["addr", "3.0"], ["cust", "1.0"]]);
  });

  it("a direct reference the closure did not use (found only through the relationships metadata) keeps the latest published version", async () => {
    h.store.entities = [
      entity("order", "Order", [["id", "string"]], { metadata: { relationships: [{ fieldId: "order.id", targetEntityId: "cust" }] } }),
      entity("cust", "Customer", [["name", "string"]]),
    ];
    publishAs("cust", 1, 4, [["name", "string"]]);
    const { prisma, tx } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(readReferencedVersions(createdReport())).toEqual([]);
    expect(edges(tx).map((e) => e.toId)).toEqual(["cust-v1.4"]);
  });

  it("writes no edge when nothing is referenced", async () => {
    h.store.entities = [entity("order", "Order", [["id", "string"]])];
    const { prisma, tx } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    expect(tx.schemaReference.createMany).not.toHaveBeenCalled();
  });
});

describe("loadReferenceStaleness", () => {
  const publishOrder = async () => {
    const { prisma } = fakePrisma();
    expect((await publishEntity("order", {}, ctxFor(prisma))).success).toBe(true);
    return prisma;
  };

  it("is empty while the referenced entity's latest published version is the recorded one", async () => {
    orderAndCustomer();
    const prisma = await publishOrder();
    expect(await loadReferenceStaleness(prisma as never, "order")).toEqual({ success: true, data: [] });
  });

  it("reports an unpinned reference once the referenced entity publishes a newer version", async () => {
    orderAndCustomer();
    const prisma = await publishOrder();
    publishAs("cust", 1, 1, [["name", "string"]]);
    const res = await loadReferenceStaleness(prisma as never, "order");
    expect(res).toEqual({
      success: true,
      data: [{ ref: { entityId: "cust", domain: "Sales", product: "Orders", entity: "Customer" }, recorded: "1.0", latest: "1.1" }],
    });
  });

  it("never reports a pinned reference", async () => {
    orderAndCustomer(qref("cust", "Customer", "1.0"));
    const prisma = await publishOrder();
    publishAs("cust", 2, 0, [["name", "string"]]);
    expect(await loadReferenceStaleness(prisma as never, "order")).toEqual({ success: true, data: [] });
  });

  it("a version published before references were recorded has nothing to be stale about", async () => {
    h.store.entities = [entity("order", "Order"), entity("cust", "Customer")];
    publishAs("cust", 1, 0);
    publishAs("order", 1, 0); // compatReport {} (the pre-Task-8 shape)
    const { prisma } = fakePrisma();
    publishAs("cust", 2, 0);
    expect(await loadReferenceStaleness(prisma as never, "order")).toEqual({ success: true, data: [] });
  });

  it("a never-published entity has no staleness", async () => {
    h.store.entities = [entity("order", "Order")];
    const { prisma } = fakePrisma();
    expect(await loadReferenceStaleness(prisma as never, "order")).toEqual({ success: true, data: [] });
  });

  it("a missing entity is NOT_FOUND", async () => {
    const { prisma } = fakePrisma();
    const res = await loadReferenceStaleness(prisma as never, "nope");
    expect(!res.success && res.error.code).toBe("NOT_FOUND");
  });
});
