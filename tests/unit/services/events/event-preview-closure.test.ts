import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { entityReader } from "@/lib/access/entity-reader";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import type { Assignment } from "@/types/schemas/rbac";
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";
import { emitEventDocumentPreview } from "@/services/events/event-emit.service";

/**
 * A preview renders every schema its pins reach, and a schema reaches the entities it refers to (FIELD edges of a version, the references of a
 * draft). The caller's roles must cover each of them, not only the pinned entity: a readable pin whose schema refers to an entity of another
 * domain renders nothing, as the entity emission refuses the same closure (REFERENCE_NOT_READABLE). The fake database honours the tenant and
 * id filters it is given, like the real one.
 */

const TENANT = "tenant-a";
const EVENT = "event-1";
const PRODUCT = "product-1";

/** A VIEWER of domain D1 (tenant A): reads the entities of D1 and nothing of D2. */
const VIEWER_OF_D1: Assignment[] = [{ role: "VIEWER", scope: { kind: "DOMAIN", tenantId: TENANT, domainId: "domain-1" } }];
const canRead = entityReader(VIEWER_OF_D1);

const D1_PLACE = { tenantId: TENANT, domainId: "domain-1", productId: PRODUCT, product: { domainId: "domain-1" } };
const D2_PLACE = { tenantId: TENANT, domainId: "domain-2", productId: null, product: null };

/** Entities: `Order` and `Invoice` and `Shipment` are readable by the viewer; `Ledger` (domain 2) is not. */
const ENTITIES: Record<string, Record<string, unknown>> = {
  E1: { id: "E1", name: "Order", latestVersionId: "V1", metadata: {}, ...D1_PLACE },
  E3: { id: "E3", name: "Customer", latestVersionId: "V3", metadata: {}, ...D1_PLACE },
  E4: { id: "E4", name: "Invoice", latestVersionId: "V4", metadata: {}, ...D1_PLACE },
  E5: { id: "E5", name: "Shipment", latestVersionId: null, metadata: {}, ...D1_PLACE },
  E2: { id: "E2", name: "Ledger", latestVersionId: "V2", metadata: {}, ...D2_PLACE },
  /** Refund (E7, domain 1) refers to Audit (E6, domain 2), which has no published version: an unpublished reference of another domain. */
  E6: { id: "E6", name: "Audit", latestVersionId: null, metadata: {}, ...D2_PLACE },
  E7: { id: "E7", name: "Refund", latestVersionId: null, metadata: {}, ...D1_PLACE },
  /** Statement (E10, domain 1) pins nothing of domain 2 itself; its version refers to Settlement (E8, domain 2), whose source has no model of that name. */
  E8: { id: "E8", name: "Settlement", latestVersionId: "V8", metadata: {}, ...D2_PLACE },
  E10: { id: "E10", name: "Statement", latestVersionId: "V10", metadata: {}, ...D1_PLACE },
};

/** Published versions: `V1` (Order) refers to a readable Customer; `V4` (Invoice) refers to Ledger of domain 2. */
const VERSIONS: Record<string, Record<string, unknown>> = {
  V1: { id: "V1", entityId: "E1", major: 1, minor: 0, resolvedSource: "model Order {\n  id: string;\n  customer: Customer;\n}\n", fieldSnapshot: [], entity: { name: "Order", ...D1_PLACE } },
  V3: { id: "V3", entityId: "E3", major: 1, minor: 0, resolvedSource: "model Customer {\n  name: string;\n}\n", fieldSnapshot: [], entity: { name: "Customer", ...D1_PLACE } },
  V4: { id: "V4", entityId: "E4", major: 1, minor: 0, resolvedSource: "model Invoice {\n  id: string;\n  ledger: Ledger;\n}\n", fieldSnapshot: [], entity: { name: "Invoice", ...D1_PLACE } },
  V2: { id: "V2", entityId: "E2", major: 1, minor: 0, resolvedSource: "model Ledger {\n  total: string;\n}\n", fieldSnapshot: [], entity: { name: "Ledger", ...D2_PLACE } },
  /** Settlement's source has two models and none named Settlement: finding its root model fails, and that failure names both. */
  V8: { id: "V8", entityId: "E8", major: 1, minor: 0, resolvedSource: "model Batch {\n  total: string;\n}\nmodel Netting {\n  id: string;\n}\n", fieldSnapshot: [], entity: { name: "Settlement", ...D2_PLACE } },
  V10: { id: "V10", entityId: "E10", major: 1, minor: 0, resolvedSource: "model Statement {\n  settlement: Settlement;\n}\n", fieldSnapshot: [], entity: { name: "Statement", ...D1_PLACE } },
};

/** FIELD edges: the versions each version refers to. */
const EDGES: Record<string, string[]> = { V1: ["V3"], V4: ["V2"], V10: ["V8"] };

/** A draft (E5, Shipment) whose field refers to Ledger by id (a decorator); it has no published version of its own. */
const SHIPMENT_DRAFT: Record<string, unknown> = {
  ...ENTITIES.E5,
  typespecSource: "model Shipment {\n  ledger: Ledger;\n}\n",
  fields: [{ id: "f1", name: "ledger", fieldNumber: 1, decorators: { referencedEntityId: "E2" } }],
};

/** A draft (E7, Refund) whose field refers to Audit (E6) of another domain, which is not published: the name must not reach the caller. */
const REFUND_DRAFT: Record<string, unknown> = {
  ...ENTITIES.E7,
  typespecSource: "model Refund {\n  audit: Audit;\n}\n",
  fields: [{ id: "f2", name: "audit", fieldNumber: 1, decorators: { referencedEntityId: "E6" } }],
};
const DRAFTS = [SHIPMENT_DRAFT, REFUND_DRAFT];

/** One fake database for the renderer and the event services. Every lookup honours the `tenantId` / `entity.tenantId` it is given. */
function fakePrisma() {
  const event = {
    id: EVENT, name: "checkout", specType: "asyncapi@3.0", document: emptyEventDocument("checkout"), tenantId: TENANT,
    domainId: "domain-1", productId: PRODUCT, product: { slug: "checkout" }, latestVersion: null,
  };
  const inIds = <T extends { id: string }>(rows: T[], ids: string[] | undefined) => rows.filter((r) => (ids ?? []).includes(r.id));
  const entityRows = Object.values(ENTITIES);
  return {
    eventSpec: { findUnique: vi.fn(async () => event) },
    product: { findUnique: vi.fn(async () => ({ id: PRODUCT, domainId: "domain-1", domain: { tenantId: TENANT } })) },
    trait: { findMany: vi.fn(async () => []) },
    eventSpecVersion: { findMany: vi.fn(async () => []) },
    schemaReference: {
      findMany: vi.fn(async ({ where }: { where: { fromId: string } }) => (EDGES[where.fromId] ?? []).map((toId) => ({ toId }))),
    },
    entity: {
      // a draft root is read inside its tenant; the namespace lookup is not
      findUnique: vi.fn(async ({ where }: { where: { id: string; tenantId?: string } }) => {
        if (where.tenantId !== undefined) {
          const draft = DRAFTS.find((d) => d.id === where.id);
          return draft && where.tenantId === TENANT ? draft : null;
        }
        return { tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } };
      }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; tenantId?: string } }) =>
        inIds(entityRows as Array<{ id: string; tenantId: string }>, where.id?.in).filter((e) => where.tenantId === undefined || e.tenantId === where.tenantId)),
    },
    entityVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string; entity?: { tenantId: string } } }) => {
        const v = VERSIONS[where.id];
        return v && (where.entity === undefined || (v.entity as { tenantId: string }).tenantId === where.entity.tenantId) ? v : null;
      }),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; entity?: { tenantId: string } } }) =>
        inIds(Object.values(VERSIONS) as Array<{ id: string; entityId: string; entity: { tenantId: string } }>, where.id?.in)
          .filter((v) => where.entity === undefined || v.entity.tenantId === where.entity.tenantId)),
    },
  };
}

/** An Avro record for the root, as the emitter would write it. */
const emitRecord = (name: string) => vi.fn<EmitFiles>(async () => ({ success: true, data: [{ relativePath: `${name}.avsc.json`, content: `{"type":"record","name":"${name}","fields":[]}` }] }));

/** A document with one Kafka/Avro channel and one send operation per message (the shape the other preview tests use). */
function document(...messages: Array<{ key: string; payload: EntityPin }>): EventDocument {
  const messageKeys = messages.map((m) => m.key);
  return {
    ...emptyEventDocument("checkout"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], bindings: { kafka: { partitions: 12 } }, format: "avro", messageKeys }],
    messages: messages.map((m) => ({ key: m.key, contentType: "avro/binary", payload: m.payload, traitKeys: [] })),
    operations: [{ key: "publishOrders", action: "send", channelKey: "orders", messageKeys, traitKeys: [] }],
  };
}

const ctxOf = (assignments: Assignment[] | undefined, prisma: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments, prisma }) as never;

/** The preview with the REAL renderer over the fake database, the emitter stubbed: nothing reaches the emitter for a refused closure. */
function previewWith(emitFiles: EmitFiles, prisma: ReturnType<typeof fakePrisma>, doc: EventDocument, assignments: Assignment[] = VIEWER_OF_D1) {
  const renderer = createArtifactRenderer({ db: prisma as never, emitFiles });
  return emitEventDocumentPreview(EVENT, PRODUCT, doc, ctxOf(assignments, prisma), { renderer, validators: [] });
}

describe("event preview: the schemas the pins reach are read by the caller's roles too", () => {
  it("renders a readable pin whose schema refers only to entities the caller covers, closure included", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Order");

    const out = await previewWith(emitFiles, prisma, document({ key: "order-created", payload: { entityId: "E1", entityVersionId: "V1" } }));

    expect(out.success).toBe(true);
    if (out.success) expect(out.data.document).not.toBeNull();
    expect(emitFiles).toHaveBeenCalledTimes(1);
    expect(emitFiles.mock.calls[0]![1]).toContain("model Customer");
  });

  it("refuses a readable pin whose version refers to an entity of another domain: nothing is emitted, and the message names no one", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Invoice");

    const out = await previewWith(emitFiles, prisma, document({ key: "invoice-created", payload: { entityId: "E4", entityVersionId: "V4" } }));

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.document).toBeNull();
    expect(out.data.json).toBeNull();
    // the refusal at the payload, and the resolver's note that the message therefore has no payload
    expect(out.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "REFERENCE_NOT_READABLE", pointer: "/messages/0/payload" }),
    ]));
    const text = JSON.stringify(out.data.diagnostics);
    expect(text).not.toMatch(/Ledger|E2|V2/);
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("refuses a readable pin whose closure reaches an entity of another domain with no root model of its name: the entity and its models are not named", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Statement");

    const out = await previewWith(emitFiles, prisma, document({ key: "statement-created", payload: { entityId: "E10", entityVersionId: "V10" } }));

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.document).toBeNull();
    expect(out.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REFERENCE_NOT_READABLE", pointer: "/messages/0/payload" }),
    ]));
    expect(JSON.stringify(out.data.diagnostics)).not.toMatch(/Settlement|Batch|Netting|ROOT_MODEL|E8|V8/);
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("refuses the current draft of a readable entity whose field refers to an entity of another domain", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Shipment");

    const out = await previewWith(emitFiles, prisma, document({ key: "shipment-created", payload: { entityId: "E5", entityVersionId: null } }));

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.document).toBeNull();
    expect(out.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REFERENCE_NOT_READABLE", pointer: "/messages/0/payload" }),
    ]));
    expect(JSON.stringify(out.data.diagnostics)).not.toMatch(/Ledger|E2/);
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("refuses the current draft of a readable entity whose UNPUBLISHED reference is of another domain: the reference's name is not told", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Refund");

    const out = await previewWith(emitFiles, prisma, document({ key: "refund-created", payload: { entityId: "E7", entityVersionId: null } }));

    expect(out.success).toBe(true);
    if (!out.success) return;
    expect(out.data.document).toBeNull();
    expect(out.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REFERENCE_NOT_READABLE", pointer: "/messages/0/payload" }),
    ]));
    expect(JSON.stringify(out.data.diagnostics)).not.toMatch(/Audit|E6/);
    expect(emitFiles).not.toHaveBeenCalled();
  });

  it("CACHE: a render cached for a caller without a read scope is not served to a caller whose roles do not cover its closure", async () => {
    const prisma = fakePrisma();
    const emitFiles = emitRecord("Invoice");
    const renderer = createArtifactRenderer({ db: prisma as never, emitFiles });
    const subject = { kind: "version" as const, entityVersionId: "V4", tenantId: TENANT };

    const unscoped = await renderer.render(subject, "avro");
    expect(unscoped.success).toBe(true);
    const scoped = await renderer.render(subject, "avro", canRead);

    expect(scoped.success).toBe(false);
    if (!scoped.success) expect(scoped.error.code).toBe("REFERENCE_NOT_READABLE");
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });
});
