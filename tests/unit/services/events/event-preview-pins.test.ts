import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { ok } from "@/types/result";
import type { Assignment } from "@/types/schemas/rbac";
import type { ArtifactRenderer, ArtifactSubject } from "@/services/events/artifact-renderer";
import { emitEventDocumentPreview } from "@/services/events/event-emit.service";

/**
 * A preview renders the pins of a document the user has not saved, and those pins are the client's words. Each must name an entity of the
 * event's own tenant, a version of it when pinned, and an entity the caller's roles cover; anything else is refused before a render, with the
 * save's own message for an unknown id, so a foreign or unreadable id is indistinguishable from a missing one.
 */

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const EVENT = "event-1";
const PRODUCT = "product-1";

/** A VIEWER of domain D1 (tenant A): reads the entities of D1 and nothing of D2 or of tenant B. */
const VIEWER_OF_D1: Assignment[] = [{ role: "VIEWER", scope: { kind: "DOMAIN", tenantId: TENANT_A, domainId: "domain-1" } }];

const ENTITIES = [
  { id: "E1", name: "Order", tenantId: TENANT_A, domainId: "domain-1", productId: PRODUCT, product: { domainId: "domain-1" }, metadata: {} },
  { id: "E2", name: "Ledger", tenantId: TENANT_A, domainId: "domain-2", productId: null, product: null, metadata: {} },
  { id: "X", name: "Foreign", tenantId: TENANT_B, domainId: "domain-b", productId: null, product: null, metadata: {} },
];
const VERSIONS = [
  { id: "V1", entityId: "E1", entity: { tenantId: TENANT_A } },
  { id: "V2", entityId: "E2", entity: { tenantId: TENANT_A } },
  { id: "VX", entityId: "X", entity: { tenantId: TENANT_B } },
];

/** The database the preview reads: the event (of tenant A, in PRODUCT), and entities and versions filtered by the tenant they are asked in. */
function fakePrisma() {
  const event = {
    id: EVENT, name: "checkout", specType: "asyncapi@3.0", document: emptyEventDocument("checkout"), tenantId: TENANT_A,
    domainId: "domain-1", productId: PRODUCT, product: { slug: "checkout" }, latestVersion: null,
  };
  const inIds = <T extends { id: string }>(rows: T[], ids: string[] | undefined) => rows.filter((r) => (ids ?? []).includes(r.id));
  return {
    eventSpec: { findUnique: vi.fn(async () => event) },
    product: { findUnique: vi.fn(async () => ({ id: PRODUCT, domainId: "domain-1", domain: { tenantId: TENANT_A } })) },
    trait: { findMany: vi.fn(async () => []) },
    eventSpecVersion: { findMany: vi.fn(async () => []) },
    entity: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; tenantId?: string } }) =>
        inIds(ENTITIES, where.id?.in).filter((e) => where.tenantId === undefined || e.tenantId === where.tenantId)),
    },
    entityVersion: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; entity?: { tenantId: string } } }) =>
        inIds(VERSIONS, where.id?.in).filter((v) => where.entity === undefined || v.entity.tenantId === where.entity.tenantId)),
    },
  };
}

/** A renderer that answers every subject with a small Avro record and records the subjects it was asked for. */
function stubRenderer() {
  const subjects: ArtifactSubject[] = [];
  const renderer: ArtifactRenderer = {
    async render(subject) {
      subjects.push(subject);
      return ok({ artifact: { format: "avro" as const, schema: { type: "record", name: "Order", fields: [] } }, warnings: [] });
    },
  };
  return { renderer, subjects };
}

const ctxOf = (assignments: Assignment[] | undefined, prisma: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments, prisma }) as never;

/** A document with one Kafka/Avro channel and one send operation per message (the shape the integration tests use). */
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

const preview = (doc: EventDocument, ctx: unknown, renderer: ArtifactRenderer) => emitEventDocumentPreview(EVENT, PRODUCT, doc, ctx as never, { renderer, validators: [] });

type Problem = { pointer: string; message: string };
function problemsOf(result: Awaited<ReturnType<typeof preview>>): Problem[] {
  if (result.success) throw new Error("expected a refusal");
  expect(result.error.code).toBe("VALIDATION_ERROR");
  return (result.error.details as { problems: Problem[] }).problems;
}

describe("event preview: the pins of an unsaved document", () => {
  it("renders a pinned version of an entity of this tenant that the caller can read", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const out = await preview(document({ key: "order-created", payload: { entityId: "E1", entityVersionId: "V1" } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(out.success).toBe(true);
    if (out.success) expect(out.data.document).not.toBeNull();
    expect(subjects).toEqual([{ kind: "version", entityVersionId: "V1", tenantId: TENANT_A }]);
  });

  it("renders the current draft of a readable entity of this tenant", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const out = await preview(document({ key: "order-created", payload: { entityId: "E1", entityVersionId: null } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(out.success).toBe(true);
    expect(subjects).toEqual([{ kind: "draft", entityId: "E1", tenantId: TENANT_A }]);
  });

  it("refuses a pin of another tenant's entity exactly as it refuses an unknown id, and renders nothing", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const foreign = await preview(document({ key: "order-created", payload: { entityId: "X", entityVersionId: "VX" } }), ctxOf(VIEWER_OF_D1, prisma), renderer);
    const unknown = await preview(document({ key: "order-created", payload: { entityId: "ghost", entityVersionId: null } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(problemsOf(foreign)).toEqual([{ pointer: "/messages/0/payload/entityId", message: 'Entity "X" not found in this tenant' }]);
    expect(problemsOf(unknown)).toEqual([{ pointer: "/messages/0/payload/entityId", message: 'Entity "ghost" not found in this tenant' }]);
    expect(foreign.success).toBe(false);
    expect(unknown.success).toBe(false);
    // the same words for both, with only the id the caller sent in them
    const wording = (message: string) => message.replace(/"[^"]*"/g, '"<id>"');
    if (!foreign.success && !unknown.success) expect(wording(foreign.error.message)).toBe(wording(unknown.error.message));
    if (!foreign.success) expect(foreign.error.message).toBe('The event references 1 unknown or invalid item(s): Entity "X" not found in this tenant');
    expect(subjects).toEqual([]);
  });

  it("refuses a foreign entity named as a draft (no version pinned) as the same unknown id, and does not render its draft", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const out = await preview(document({ key: "order-created", payload: { entityId: "X", entityVersionId: null } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(problemsOf(out)).toEqual([{ pointer: "/messages/0/payload/entityId", message: 'Entity "X" not found in this tenant' }]);
    expect(subjects).toEqual([]);
  });

  it("refuses a version of another tenant pinned to an entity of this one, as a version that is not the entity's", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const foreignVersion = await preview(document({ key: "order-created", payload: { entityId: "E1", entityVersionId: "VX" } }), ctxOf(VIEWER_OF_D1, prisma), renderer);
    const missingVersion = await preview(document({ key: "order-created", payload: { entityId: "E1", entityVersionId: "nope" } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(problemsOf(foreignVersion)).toEqual([{ pointer: "/messages/0/payload/entityVersionId", message: '"VX" is not a published version of Order' }]);
    expect(problemsOf(missingVersion)).toEqual([{ pointer: "/messages/0/payload/entityVersionId", message: '"nope" is not a published version of Order' }]);
    expect(subjects).toEqual([]);
  });

  it("refuses an entity of this tenant that the caller's roles do not cover, pinned or as a draft, as an unknown id", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const pinned = await preview(document({ key: "order-created", payload: { entityId: "E2", entityVersionId: "V2" } }), ctxOf(VIEWER_OF_D1, prisma), renderer);
    const draft = await preview(document({ key: "order-created", payload: { entityId: "E2", entityVersionId: null } }), ctxOf(VIEWER_OF_D1, prisma), renderer);

    const refusal = [{ pointer: "/messages/0/payload/entityId", message: 'Entity "E2" not found in this tenant' }];
    expect(problemsOf(pinned)).toEqual(refusal);
    expect(problemsOf(draft)).toEqual(refusal);
    expect(subjects).toEqual([]);
  });

  it("reads nothing for a caller whose context carries no assignments: every pin is refused", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();

    const out = await preview(document({ key: "order-created", payload: { entityId: "E1", entityVersionId: "V1" } }), ctxOf(undefined, prisma), renderer);

    expect(problemsOf(out)).toEqual([{ pointer: "/messages/0/payload/entityId", message: 'Entity "E1" not found in this tenant' }]);
    expect(subjects).toEqual([]);
  });

  it("reports every refused pin at its own pointer, together, and renders nothing", async () => {
    const prisma = fakePrisma();
    const { renderer, subjects } = stubRenderer();
    const doc = document(
      { key: "order-created", payload: { entityId: "E1", entityVersionId: "V1" } },
      { key: "foreign-created", payload: { entityId: "X", entityVersionId: "VX" } },
      { key: "ledger-created", payload: { entityId: "E2", entityVersionId: null } },
    );

    const out = await preview(doc, ctxOf(VIEWER_OF_D1, prisma), renderer);

    expect(problemsOf(out)).toEqual([
      { pointer: "/messages/1/payload/entityId", message: 'Entity "X" not found in this tenant' },
      { pointer: "/messages/2/payload/entityId", message: 'Entity "E2" not found in this tenant' },
    ]);
    // the message names them (the builder's preview shows only the message)
    if (!out.success) expect(out.error.message).toBe('The event references 2 unknown or invalid item(s): Entity "X" not found in this tenant; Entity "E2" not found in this tenant');
    expect(subjects).toEqual([]);
  });
});
