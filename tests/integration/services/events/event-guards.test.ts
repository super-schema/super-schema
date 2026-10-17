import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ok, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const { access } = vi.hoisted(() => ({ access: { userId: "", isAdmin: true } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "session-user", email: "admin@example.test" } })) }));
vi.mock("@/lib/access-control", () => ({ resolveGlobalAdminAccess: vi.fn(async () => ({ ...access })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The domain action scopes every by-id row to the active tenant, which comes from a request cookie: pin it to the fixtures' tenant.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant_default" }));

import { deleteDomainAction } from "@/app/(dashboard)/schemas/actions";
import type { SchemaArtifact } from "@/lib/event-specs/types";
import { collectDocumentEdges } from "@/lib/events/document/edges";
import { emptyEventDocument, type DocMessage, type DocTrait, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { deleteEntity, updateEntity } from "@/services/entity.service";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import {
  eventsInUseError,
  findCrossProductEventRefs,
  findEntityEventReferrers,
  findEventVersionReferrers,
  findLibraryTraitEventReferrers,
  MAX_EVENT_REFERRERS,
  MAX_REFERRER_SCAN,
  withEventsInUse,
  type EventReferrerUsage,
} from "@/services/events/event-guards";
import { createEvent, deleteEvent, updateEventDocument } from "@/services/events/event.service";
import { publishEvent } from "@/services/events/event-publish.service";
import { deleteTrait } from "@/services/events/trait.service";
import { deleteProduct } from "@/services/product.service";
import { createForeignTenant } from "./foreign-tenant";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, resolvedChannel, resolvedMessage, stamp, TENANT, testContext, unwrap } from "./helpers";

const prisma = connectTestDb();
const domainIds: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  await cleanupDomains(prisma, domainIds);
  await prisma.$disconnect();
});

type Scope = Awaited<ReturnType<typeof createProductScope>>;
type Published = Awaited<ReturnType<Scope["publishedEntity"]>>;

async function setup(label = "evg") {
  const ctx = await testContext(prisma);
  access.userId = ctx.userId;
  const scope = await createProductScope(prisma, ctx, label);
  domainIds.push(scope.domain.id);
  const owner = { level: "PRODUCT" as const, productId: scope.product.id };
  const order = await scope.publishedEntity("Order");
  return { ctx, scope, owner, order };
}

/** A second product (own domain) in the same tenant. */
async function otherProduct(ctx: ServiceContext, label = "con") {
  const scope = await createProductScope(prisma, ctx, label);
  domainIds.push(scope.domain.id);
  return { scope, owner: { level: "PRODUCT" as const, productId: scope.product.id } };
}

const level = (sc: Scope) => ({ tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id });
const where = (sc: Scope) => `(${sc.domain.name}/${sc.product.name})`;

const pinOf = (e: Pick<Published, "entity" | "version">): EntityPin => ({ entityId: e.entity.id, entityVersionId: e.version.id });
const unpinnedOf = (e: Pick<Published, "entity">): EntityPin => ({ entityId: e.entity.id, entityVersionId: null });
const msg = (key: string, payload: EntityPin, extra: Partial<DocMessage> = {}): DocMessage => ({ key, payload, traitKeys: [], ...extra });
const docWith = (messages: DocMessage[], traits: DocTrait[] = []): EventDocument => ({ ...emptyEventDocument("svc"), messages, traits });
const withRefs = (versionId: string): EventDocument => ({
  ...emptyEventDocument("svc"),
  externalRefs: [{ key: "ext", eventVersionId: versionId, kind: "message", itemKey: "M" }],
});

const fail = (r: Result<unknown>): ServiceError => {
  if (r.success) throw new Error("expected a failure Result");
  return r.error;
};
const referrersOf = (e: ServiceError) => (e.details as { referrers: Array<Record<string, unknown>>; truncated: boolean }).referrers;
const draftEdges = (eventId: string) => prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: eventId } });

const RESOLVED = { channels: [resolvedChannel("orders")], messages: [resolvedMessage("M")] };

/** The artifact renderer of the real publish, replaced by a stand-in (no TypeSpec compile): every pin renders as a tiny record. */
const stubRenderer: ArtifactRenderer = {
  async render(_subject, format) {
    const artifact: SchemaArtifact =
      format === "avro"
        ? { format: "avro", schema: { type: "record", name: "Order", fields: [{ name: "id", type: "string" }] } }
        : { format: "json-schema", dialect: "draft-07", schema: { type: "object", title: "Order", properties: { id: { type: "string" } } } };
    return ok({ artifact, warnings: [] });
  },
};
/** A complete document `publishEvent` accepts: one Kafka/Avro channel and a send operation for a message pinned to the entity's version. */
const publishableDoc = (order: Pick<Published, "entity" | "version">): EventDocument => ({
  ...emptyEventDocument("checkout-service"),
  servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
  channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["order-created"] }],
  messages: [{ key: "order-created", contentType: "avro/binary", payload: pinOf(order), traitKeys: [] }],
  operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
});
/** A document that receives the producer's `order-created` message through an external reference to its published version. */
const consumerDoc = (producerVersionId: string): EventDocument => ({
  ...emptyEventDocument("fraud-scorer"),
  servers: [{ key: "kafka-in", protocol: "kafka", host: "kafka-in.internal:9092" }],
  channels: [{ key: "inbox", address: "fraud.inbox.v1", protocol: "kafka", serverKeys: ["kafka-in"], format: "avro", messageKeys: ["payment-received"] }],
  externalRefs: [{ key: "payment-received", eventVersionId: producerVersionId, kind: "message", itemKey: "order-created" }],
  operations: [{ key: "consumePayment", action: "receive", channelKey: "inbox", messageKeys: ["payment-received"], traitKeys: [] }],
});

async function newEvent(ctx: ServiceContext, sc: Scope, name: string) {
  return unwrap(await createEvent(sc.product.id, { name: `${name}-${sc.s}` }, ctx));
}

/**
 * A published version seeded directly: its row plus the non-draft edges publish writes (`fromKind: EVENT_SPEC_VERSION`) from the
 * document. Used for what a real publish cannot produce on demand: `resolvedSpec: null` (a version published before document v2),
 * a hand-picked `frozenTraits` / `sourceDocument`, or a cross-tenant row. The lifecycle test goes through the real `publishEvent`.
 */
async function publishDirect(
  ctx: ServiceContext,
  eventId: string,
  doc: EventDocument,
  opts: { frozenTraits?: unknown[]; resolvedSpec?: Prisma.InputJsonValue | null; sourceDocument?: unknown } = {}
) {
  const { frozenTraits = [], resolvedSpec = RESOLVED, sourceDocument = doc } = opts;
  const version = await createEventSpecVersion(prisma, {
    eventSpecId: eventId, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: sourceDocument as Prisma.InputJsonValue,
    frozenTraits: frozenTraits as Prisma.InputJsonValue,
    changeKind: "INITIAL", publishedById: ctx.userId, ...(resolvedSpec === null ? {} : { resolvedSpec }),
  });
  const edges = collectDocumentEdges(doc);
  if (edges.length > 0) {
    await prisma.schemaReference.createMany({
      data: edges.map((e) => ({ fromKind: "EVENT_SPEC_VERSION" as const, fromId: version.id, role: e.role, toKind: e.toKind, toId: e.toId, isDraft: false })),
    });
  }
  await prisma.eventSpec.update({ where: { id: eventId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
  return version;
}

/** An event saved through the service (draft edges) and then published directly. */
async function publishedEvent(ctx: ServiceContext, sc: Scope, name: string, doc: EventDocument, opts: Parameters<typeof publishDirect>[3] = {}) {
  const event = await newEvent(ctx, sc, name);
  unwrap(await updateEventDocument(event.id, doc, { level: "PRODUCT", productId: sc.product.id }, ctx));
  const version = await publishDirect(ctx, event.id, doc, opts);
  return { event, version };
}

/** An event row written directly (the service refuses cross-tenant references), with the draft edges a save would write. */
async function rawEvent(at: { tenantId: string; domainId: string; productId: string }, name: string, doc: EventDocument) {
  const event = await prisma.eventSpec.create({ data: { name, document: doc as unknown as Prisma.InputJsonValue, ...at } });
  const edges = collectDocumentEdges(doc);
  if (edges.length > 0) {
    await prisma.schemaReference.createMany({
      data: edges.map((e) => ({ fromKind: "EVENT_SPEC" as const, fromId: event.id, role: e.role, toKind: e.toKind, toId: e.toId, isDraft: true })),
    });
  }
  return event;
}

/** A Proxy over a Prisma object whose listed members are replaced; everything else is the real thing. */
function replacing<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, { get: (t, p) => (typeof p === "string" && p in overrides ? overrides[p] : Reflect.get(t, p)) });
}
const connectionLost = () => Promise.reject(new Error("connection lost: host=db.internal table=event_specs"));
const asPrisma = (p: object) => p as unknown as PrismaClient;

describe("event pin-integrity guards", () => {
  it("blocks deleting an entity pinned by a draft event, naming the event", async () => {
    const { ctx, scope, owner, order } = await setup();
    const spare = await scope.publishedEntity("Spare");
    const event = await newEvent(ctx, scope, "checkout");
    unwrap(await updateEventDocument(event.id, docWith([msg("OrderCreated", pinOf(order))]), owner, ctx));
    expect(await draftEdges(event.id)).toHaveLength(1);

    const blocked = fail(await deleteEntity(order.entity.id, ctx));
    expect(blocked.code).toBe("IN_USE");
    expect(blocked.message).toBe(`Entity "Order" cannot be deleted: it is pinned by event ${event.name} ${where(scope)}.`);
    expect(blocked.details).toEqual({
      referrers: [{ eventId: event.id, name: event.name, domain: scope.domain.name, product: scope.product.name, referencedVersions: ["1.0"], draft: true, published: false }],
      truncated: false,
    });
    expect(blocked.suggestedFix).toBe(`Remove the pin from "${event.name}" first, or keep the entity.`);
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(1);

    // The guard function reports the same event with its draft / published state and the pinned version label.
    expect(await findEntityEventReferrers(prisma, order.entity)).toEqual([
      { eventId: event.id, eventName: event.name, domainName: scope.domain.name, productName: scope.product.name, published: false, draft: true, referencedVersions: ["1.0"] },
    ]);

    // An entity no event names is not blocked by this guard, and deleting it works.
    expect(await findEntityEventReferrers(prisma, spare.entity)).toEqual([]);
    unwrap(await deleteEntity(spare.entity.id, ctx));

    // Saving a draft without the pin releases the entity.
    unwrap(await updateEventDocument(event.id, emptyEventDocument("no pin"), owner, ctx));
    expect(await findEntityEventReferrers(prisma, order.entity)).toEqual([]);
    unwrap(await deleteEntity(order.entity.id, ctx));
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(0);
  }, 60_000);

  it("still blocks after the event is published, and unblocks after the pin is removed and the draft saved (published edges keep protecting until the version is gone → expect still blocked by the published version)", async () => {
    const { ctx, scope, owner, order } = await setup();
    const event = await newEvent(ctx, scope, "published");
    const doc = docWith([msg("OrderCreated", pinOf(order))]);
    unwrap(await updateEventDocument(event.id, doc, owner, ctx));
    const version = await publishDirect(ctx, event.id, doc);

    // Draft AND published edges point at the version: one referrer, flagged both ways.
    let found = await findEntityEventReferrers(prisma, order.entity);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ eventId: event.id, draft: true, published: true, referencedVersions: ["1.0"] });
    expect(fail(await deleteEntity(order.entity.id, ctx)).code).toBe("IN_USE");

    // The pin is removed from the draft and the draft saved: the draft edge goes, the published one stays.
    unwrap(await updateEventDocument(event.id, emptyEventDocument("pin removed"), owner, ctx));
    expect(await draftEdges(event.id)).toEqual([]);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id, toId: order.version.id } })).toBe(1);
    found = await findEntityEventReferrers(prisma, order.entity);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ eventId: event.id, draft: false, published: true, referencedVersions: ["1.0"] });

    const stillBlocked = fail(await deleteEntity(order.entity.id, ctx));
    expect(stillBlocked.code).toBe("IN_USE");
    expect(stillBlocked.message).toBe(`Entity "Order" cannot be deleted: it is pinned by event ${event.name} ${where(scope)}.`);
    expect(stillBlocked.suggestedFix).toBe(
      `Published versions cannot be changed, so delete event "${event.name}" (which removes its published versions) first, or keep the entity.`
    );
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(1);

    // Only deleting the event (its versions and their edges go with it) frees the entity.
    unwrap(await deleteEvent(event.id, owner, ctx));
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id } })).toBe(0);
    unwrap(await deleteEntity(order.entity.id, ctx));
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(0);
  }, 60_000);

  it("protects an entity named only by an unpinned pin", async () => {
    const { ctx, scope, owner, order } = await setup();
    const meta = await scope.publishedEntity("Meta");
    const keyed = await scope.publishedEntity("Keyed");
    const traitHeaders = await scope.publishedEntity("TraitHeaders");
    const event = await newEvent(ctx, scope, "unpinned");
    // Unpinned pins save (preview only) and write NO edge: only the document names the entities.
    const doc = docWith(
      [msg("OrderCreated", unpinnedOf(order), { headers: unpinnedOf(meta), keyPin: unpinnedOf(keyed) })],
      [{ key: "audit", kind: "MESSAGE", spec: {}, headers: unpinnedOf(traitHeaders) }]
    );
    unwrap(await updateEventDocument(event.id, doc, owner, ctx));
    expect(await draftEdges(event.id)).toEqual([]);

    // One entity per pin site: messages[].payload, messages[].headers, messages[].keyPin and local traits[].headers.
    for (const [site, entity] of [["payload", order], ["headers", meta], ["keyPin", keyed], ["trait headers", traitHeaders]] as const) {
      const found = await findEntityEventReferrers(prisma, entity.entity);
      expect(found, site).toEqual([
        { eventId: event.id, eventName: event.name, domainName: scope.domain.name, productName: scope.product.name, published: false, draft: true, referencedVersions: [] },
      ]);
      const blocked = fail(await deleteEntity(entity.entity.id, ctx));
      expect(blocked.code, site).toBe("IN_USE");
      expect(blocked.message, site).toBe(`Entity "${entity.entity.name}" cannot be deleted: it is pinned by event ${event.name} ${where(scope)}.`);
    }

    // Saving a document that names fewer entities releases the others; the one still named stays protected.
    unwrap(await updateEventDocument(event.id, docWith([msg("OrderCreated", unpinnedOf(order))]), owner, ctx));
    expect(await findEntityEventReferrers(prisma, meta.entity)).toEqual([]);
    unwrap(await deleteEntity(meta.entity.id, ctx));
    expect(fail(await deleteEntity(order.entity.id, ctx)).code).toBe("IN_USE");
  }, 60_000);

  it("does not block an entity pinned in another tenant (tenant isolation)", async () => {
    const { ctx, scope, owner, order } = await setup();
    const foreign = await createForeignTenant(prisma, ctx);
    cleanups.push(foreign.cleanup);
    const foreignAt = { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id };

    // Tenant A records that another tenant's events must never be able to hold: an entity, a library trait, a published event.
    const trait = await prisma.trait.create({ data: { tenantId: TENANT, domainId: scope.domain.id, name: `lt-${scope.s}`, kind: "MESSAGE" } });
    const target = await publishedEvent(ctx, scope, "target", emptyEventDocument("target"));

    // Foreign events (rows written directly: the service refuses cross-tenant references) that name all of them, drafts and published.
    const foreignDoc: EventDocument = {
      ...docWith([msg("M", pinOf(order))], [{ key: "lt", kind: "MESSAGE", libraryTraitId: trait.id }]),
      externalRefs: [{ key: "ext", eventVersionId: target.version.id, kind: "message", itemKey: "M" }],
    };
    const foreignEvent = await rawEvent(foreignAt, `foreign-${scope.s}`, foreignDoc);
    await publishDirect(ctx, foreignEvent.id, foreignDoc, { frozenTraits: [{ id: trait.id }] });
    const foreignUnpinned = await rawEvent(foreignAt, `foreign-unpinned-${scope.s}`, docWith([msg("M", unpinnedOf(order))]));

    // Asked as tenant A, none of it is found (the unpinned JSON scan included).
    expect(await findEntityEventReferrers(prisma, order.entity)).toEqual([]);
    expect(await findLibraryTraitEventReferrers(prisma, { id: trait.id, tenantId: TENANT })).toEqual([]);
    expect(await findEventVersionReferrers(prisma, target.event.id)).toEqual([]);
    expect(await findCrossProductEventRefs(prisma, { kind: "product", productId: scope.product.id, tenantId: TENANT })).toEqual([]);
    expect(await findCrossProductEventRefs(prisma, { kind: "domain", domainId: scope.domain.id, tenantId: TENANT })).toEqual([]);

    // Control: the seeded rows are real. The same lookups scoped to the foreign tenant do find them (only the tenant filter hides them).
    const asForeign = await findEntityEventReferrers(prisma, { id: order.entity.id, tenantId: foreign.tenant.id });
    expect(asForeign.map((r) => r.eventId).sort()).toEqual([foreignEvent.id, foreignUnpinned.id].sort());
    expect((await findLibraryTraitEventReferrers(prisma, { id: trait.id, tenantId: foreign.tenant.id })).map((r) => r.eventId)).toEqual([foreignEvent.id]);

    // The other direction: a tenant A event naming a foreign entity is not a referrer of it.
    await rawEvent(level(scope), `local-${scope.s}`, docWith([msg("M", unpinnedOf({ entity: foreign.entity }))]));
    expect(await findEntityEventReferrers(prisma, foreign.entity)).toEqual([]);

    // The services agree: nothing in tenant A is held by the foreign events.
    unwrap(await deleteTrait(trait.id, { level: "DOMAIN", domainId: scope.domain.id }, ctx));
    unwrap(await deleteEvent(target.event.id, owner, ctx));
    unwrap(await deleteEntity(order.entity.id, ctx));
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(0);
  }, 60_000);

  it("blocks deleting a library trait used by an event document", async () => {
    const { ctx, scope, owner } = await setup();
    const trait = await prisma.trait.create({ data: { tenantId: TENANT, domainId: scope.domain.id, name: `audit-${scope.s}`, kind: "MESSAGE" } });
    const traitOwner = { level: "DOMAIN" as const, domainId: scope.domain.id };
    const event = await newEvent(ctx, scope, "uses-trait");
    const doc: EventDocument = { ...emptyEventDocument("svc"), traits: [{ key: "audit", kind: "MESSAGE", libraryTraitId: trait.id }] };
    unwrap(await updateEventDocument(event.id, doc, owner, ctx));

    const blocked = fail(await deleteTrait(trait.id, traitOwner, ctx));
    expect(blocked.code).toBe("IN_USE");
    expect(blocked.message).toBe(`Trait "${trait.name}" cannot be deleted: it is used by event ${event.name} ${where(scope)}.`);
    expect(referrersOf(blocked)).toEqual([
      { eventId: event.id, name: event.name, domain: scope.domain.name, product: scope.product.name, referencedVersions: [], draft: true, published: false },
    ]);
    expect(await prisma.trait.count({ where: { id: trait.id } })).toBe(1);

    // Published: the version's source document and its frozen traits keep protecting the trait after the draft drops it.
    const version = await publishDirect(ctx, event.id, doc, { frozenTraits: [{ id: trait.id, name: trait.name, kind: "MESSAGE" }] });
    unwrap(await updateEventDocument(event.id, emptyEventDocument("dropped"), owner, ctx));
    let found = await findLibraryTraitEventReferrers(prisma, { id: trait.id, tenantId: TENANT });
    expect(found).toEqual([
      { eventId: event.id, eventName: event.name, domainName: scope.domain.name, productName: scope.product.name, published: true, draft: false, referencedVersions: ["1.0"] },
    ]);
    const stillBlocked = fail(await deleteTrait(trait.id, traitOwner, ctx));
    expect(stillBlocked.code).toBe("IN_USE");
    expect(stillBlocked.suggestedFix).toContain(`delete event "${event.name}"`);

    // A version that only froze the trait (no libraryTraitId left in its source) is found through `frozenTraits` ...
    const frozenOnly = await publishedEvent(ctx, scope, "frozen-only", emptyEventDocument("f"), { frozenTraits: [{ id: trait.id }] });
    // ... but a version without a resolved spec (published before document v2) is the legacy guard's business, not named here.
    const legacy = await publishedEvent(ctx, scope, "legacy-shape", emptyEventDocument("l"), { frozenTraits: [{ id: trait.id }], resolvedSpec: null });
    found = await findLibraryTraitEventReferrers(prisma, { id: trait.id, tenantId: TENANT });
    expect(found.map((r) => r.eventId).sort()).toEqual([event.id, frozenOnly.event.id].sort());
    expect(found.map((r) => r.eventId)).not.toContain(legacy.event.id);

    // Both the event with the library trait in its source and the one that only froze it are named, in one IN_USE.
    const several = fail(await deleteTrait(trait.id, traitOwner, ctx));
    expect(several.code).toBe("IN_USE");
    expect(several.message).toContain("it is used by events");
    expect(several.message).toContain(`${event.name} ${where(scope)}`);
    expect(several.message).toContain(`${frozenOnly.event.name} ${where(scope)}`);
    expect(several.details).toMatchObject({ truncated: false });
    expect(referrersOf(several).map((r) => r.eventId).sort()).toEqual([event.id, frozenOnly.event.id].sort());

    // Deleting the events (their versions go too) frees the trait.
    for (const e of [event, frozenOnly.event, legacy.event]) unwrap(await deleteEvent(e.id, owner, ctx));
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id } })).toBe(0);
    expect(await findLibraryTraitEventReferrers(prisma, { id: trait.id, tenantId: TENANT })).toEqual([]);
    unwrap(await deleteTrait(trait.id, traitOwner, ctx));
    expect(await prisma.trait.count({ where: { id: trait.id } })).toBe(0);
  }, 60_000);

  it("blocks deleting an event whose published version is externally referenced and names the referrer", async () => {
    const { ctx, scope, owner } = await setup();
    const consumers = await otherProduct(ctx);
    const target = await publishedEvent(ctx, scope, "target", emptyEventDocument("target"));

    // A draft referrer (saved through the service: EVENT_SPEC edge) and a published-only referrer (its version holds the edge).
    const draftConsumer = await newEvent(ctx, consumers.scope, "draft-consumer");
    unwrap(await updateEventDocument(draftConsumer.id, withRefs(target.version.id), consumers.owner, ctx));
    const published = await publishedEvent(ctx, consumers.scope, "published-consumer", withRefs(target.version.id));
    unwrap(await updateEventDocument(published.event.id, emptyEventDocument("c"), consumers.owner, ctx));

    const found = await findEventVersionReferrers(prisma, target.event.id);
    expect(found).toEqual([
      { eventId: draftConsumer.id, eventName: draftConsumer.name, domainName: consumers.scope.domain.name, productName: consumers.scope.product.name, published: false, draft: true, referencedVersions: ["1.0"] },
      { eventId: published.event.id, eventName: published.event.name, domainName: consumers.scope.domain.name, productName: consumers.scope.product.name, published: true, draft: false, referencedVersions: ["1.0"] },
    ]);

    // deleteEvent is expressed through the same query: its failure is exactly the guard's error (the A6 message and details shape).
    const blocked = fail(await deleteEvent(target.event.id, owner, ctx));
    expect(blocked).toEqual(eventsInUseError("Event", target.event.name, found));
    expect(blocked.code).toBe("IN_USE");
    expect(blocked.message).toBe(
      `Event "${target.event.name}" cannot be deleted: its published versions are referenced by ${draftConsumer.name} ${where(consumers.scope)}, ${published.event.name} ${where(consumers.scope)}.`
    );
    expect(referrersOf(blocked)).toEqual([
      { eventId: draftConsumer.id, name: draftConsumer.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: true, published: false },
      { eventId: published.event.id, name: published.event.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: false, published: true },
    ]);
    expect(await prisma.eventSpecVersion.count({ where: { id: target.version.id } })).toBe(1);

    // Removing the draft reference leaves the published referrer in the way; deleting that referrer frees the event.
    unwrap(await updateEventDocument(draftConsumer.id, emptyEventDocument("c"), consumers.owner, ctx));
    const stillBlocked = fail(await deleteEvent(target.event.id, owner, ctx));
    expect(stillBlocked.message).toContain(published.event.name);
    expect(stillBlocked.message).not.toContain(draftConsumer.name);
    unwrap(await deleteEvent(published.event.id, consumers.owner, ctx));
    expect(await findEventVersionReferrers(prisma, target.event.id)).toEqual([]);
    expect(unwrap(await deleteEvent(target.event.id, owner, ctx))).toEqual({ id: target.event.id });
  }, 60_000);

  it("protects what a REAL publish pins and references: the entity, the event and the product all refuse to go", async () => {
    const { ctx, scope, owner, order } = await setup("life");
    const consumers = await otherProduct(ctx, "life-con");

    // A producer pinned to Order 1.0, published through the real `publishEvent` (stub renderer: no TypeSpec compile).
    const producer = await newEvent(ctx, scope, "producer");
    unwrap(await updateEventDocument(producer.id, publishableDoc(order), owner, ctx));
    const producerVersion = unwrap(await publishEvent(producer.id, scope.product.id, {}, ctx, { renderer: stubRenderer }));
    // The draft lets go of the pin: only what publish wrote protects the entity from here on.
    unwrap(await updateEventDocument(producer.id, emptyEventDocument("no pin"), owner, ctx));
    expect(await draftEdges(producer.id)).toEqual([]);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: producerVersion.id, toKind: "ENTITY_VERSION", toId: order.version.id } })).toBe(1);

    // 1. deleteEntity: pinned by the published version.
    const pinned = fail(await deleteEntity(order.entity.id, ctx));
    expect(pinned.code).toBe("IN_USE");
    expect(pinned.message).toBe(`Entity "Order" cannot be deleted: it is pinned by event ${producer.name} ${where(scope)}.`);
    expect(referrersOf(pinned)).toEqual([
      { eventId: producer.id, name: producer.name, domain: scope.domain.name, product: scope.product.name, referencedVersions: ["1.0"], draft: false, published: true },
    ]);
    expect(pinned.suggestedFix).toContain("Published versions cannot be changed");
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(1);

    // A consumer in another product receives the producer's message through an external ref, and is published for real as well.
    const consumer = await newEvent(ctx, consumers.scope, "consumer");
    unwrap(await updateEventDocument(consumer.id, consumerDoc(producerVersion.id), consumers.owner, ctx));
    const consumerVersion = unwrap(await publishEvent(consumer.id, consumers.scope.product.id, {}, ctx, { renderer: stubRenderer }));
    unwrap(await updateEventDocument(consumer.id, emptyEventDocument("no ref"), consumers.owner, ctx));
    expect(await draftEdges(consumer.id)).toEqual([]);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: consumerVersion.id, toKind: "EVENT_SPEC_VERSION", toId: producerVersion.id } })).toBe(1);

    // 2. deleteEvent: the producer's published version is referenced by the consumer's published version.
    const eventBlocked = fail(await deleteEvent(producer.id, owner, ctx));
    expect(eventBlocked.code).toBe("IN_USE");
    expect(eventBlocked.message).toBe(
      `Event "${producer.name}" cannot be deleted: its published versions are referenced by ${consumer.name} ${where(consumers.scope)}.`
    );
    expect(referrersOf(eventBlocked)).toEqual([
      { eventId: consumer.id, name: consumer.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: false, published: true },
    ]);
    expect(await prisma.eventSpec.count({ where: { id: producer.id } })).toBe(1);

    // 3. deleteProduct / deleteDomainAction: the producer's product owns that event, so the delete was never open (its content blocks
    // it, VALIDATION_ERROR), and the event guard adds who references it from outside.
    const productBlocked = fail(await deleteProduct(scope.product.id, ctx));
    expect(productBlocked.message).toContain(`other products' events reference its events: ${consumer.name} ${where(consumers.scope)}`);
    expect((productBlocked.details as { events: { referrers: Array<{ eventId: string; published: boolean }> } }).events.referrers).toMatchObject([{ eventId: consumer.id, published: true }]);
    expect(await findCrossProductEventRefs(prisma, { kind: "product", productId: scope.product.id, tenantId: TENANT })).toMatchObject([{ eventId: consumer.id, published: true, draft: false }]);
    expect(await deleteDomainAction(scope.domain.id)).toMatchObject({ error: expect.stringContaining(`${consumer.name} ${where(consumers.scope)}`) });
    expect(await prisma.product.count({ where: { id: scope.product.id } })).toBe(1);

    // Deleting the consumer (its version and edges go with it) releases the producer; deleting the producer releases the entity.
    unwrap(await deleteEvent(consumer.id, consumers.owner, ctx));
    expect(await findCrossProductEventRefs(prisma, { kind: "product", productId: scope.product.id, tenantId: TENANT })).toEqual([]);
    unwrap(await deleteEvent(producer.id, owner, ctx));
    unwrap(await deleteEntity(order.entity.id, ctx));
    expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(0);
  }, 120_000);

  it("blocks deleting a product whose published event is referenced from another product", async () => {
    const ctx = await testContext(prisma);
    access.userId = ctx.userId;
    const scope = await createProductScope(prisma, ctx, "own");
    domainIds.push(scope.domain.id);
    const consumers = await otherProduct(ctx);
    const target = await publishedEvent(ctx, scope, "target", emptyEventDocument("target"));
    const consumer = await newEvent(ctx, consumers.scope, "consumer");
    unwrap(await updateEventDocument(consumer.id, withRefs(target.version.id), consumers.owner, ctx));

    const product = { kind: "product" as const, productId: scope.product.id, tenantId: TENANT };
    const domain = { kind: "domain" as const, domainId: scope.domain.id, tenantId: TENANT };
    const expectedRefs = [
      { eventId: consumer.id, eventName: consumer.name, domainName: consumers.scope.domain.name, productName: consumers.scope.product.name, published: false, draft: true, referencedVersions: ["1.0"] },
    ];
    expect(await findCrossProductEventRefs(prisma, product)).toEqual(expectedRefs);
    expect(await findCrossProductEventRefs(prisma, domain)).toEqual(expectedRefs);
    // The consumers' own scopes hold no referenced version, and an event inside the scope is not "outside" it.
    expect(await findCrossProductEventRefs(prisma, { kind: "product", productId: consumers.scope.product.id, tenantId: TENANT })).toEqual([]);

    // Product delete: the long-standing content blocker (the product owns an event spec) now also names the referrer.
    const blocked = fail(await deleteProduct(scope.product.id, ctx));
    expect(blocked.code).toBe("VALIDATION_ERROR");
    expect(blocked.message).toBe(
      `Delete the product's 1 event before removing it. Product "${scope.product.name}" cannot be deleted: other products' events reference its events: ${consumer.name} ${where(consumers.scope)}.`
    );
    expect(blocked.details).toEqual({
      events: {
        referrers: [{ eventId: consumer.id, name: consumer.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: true, published: false }],
        truncated: false,
      },
    });
    expect(blocked.suggestedFix).toContain("Remove or move the product's entities");
    expect(await prisma.product.count({ where: { id: scope.product.id } })).toBe(1);

    // Domain delete (server action) names it too.
    const domainBlocked = await deleteDomainAction(scope.domain.id);
    expect(domainBlocked).toMatchObject({ error: expect.stringContaining(`${consumer.name} ${where(consumers.scope)}`) });
    expect(domainBlocked).toMatchObject({ error: expect.stringContaining(`Domain "${scope.domain.name}" cannot be deleted: other domains' events reference its events`) });
    expect(await prisma.domain.count({ where: { id: scope.domain.id } })).toBe(1);

    // With the reference gone, both fall back to their unchanged messages.
    unwrap(await updateEventDocument(consumer.id, emptyEventDocument("c"), consumers.owner, ctx));
    expect(await findCrossProductEventRefs(prisma, product)).toEqual([]);
    const plain = fail(await deleteProduct(scope.product.id, ctx));
    expect(plain.message).toBe("Delete the product's 1 event before removing it");
    expect(plain.details).toBeUndefined();
    const plainDomain = (await deleteDomainAction(scope.domain.id)) as { error: string };
    expect(plainDomain.error).not.toContain("reference its events");
  }, 60_000);

  it("finds an outside referrer even when more than MAX_REFERRER_SCAN edges from inside the scope sort first", async () => {
    const ctx = await testContext(prisma);
    access.userId = ctx.userId;
    const scope = await createProductScope(prisma, ctx, "crowd");
    domainIds.push(scope.domain.id);
    const consumers = await otherProduct(ctx, "crowd-out");
    const target = await publishedEvent(ctx, scope, "target", emptyEventDocument("target"));
    const s = stamp();

    // More inside drafts than one scan reads, all pointing at the target's version, ids sorting BEFORE the one outside referrer
    // (the scan is ordered by fromId): the inside edges alone fill the whole scan unless the query itself leaves them out.
    const insideIds = Array.from({ length: MAX_REFERRER_SCAN + 5 }, (_, i) => `a-${s}-${String(i).padStart(3, "0")}`);
    await prisma.eventSpec.createMany({
      data: insideIds.map((id) => ({ id, name: id, document: emptyEventDocument(id) as unknown as Prisma.InputJsonValue, ...level(scope) })),
    });
    const edgeTo = (fromId: string) => ({ fromKind: "EVENT_SPEC" as const, fromId, role: "MESSAGE" as const, toKind: "EVENT_SPEC_VERSION" as const, toId: target.version.id, isDraft: true });
    await prisma.schemaReference.createMany({ data: insideIds.map(edgeTo) });
    const outsideId = `z-${s}`;
    const outside = await prisma.eventSpec.create({
      data: { id: outsideId, name: `outside-${s}`, document: withRefs(target.version.id) as unknown as Prisma.InputJsonValue, ...level(consumers.scope) },
    });
    await prisma.schemaReference.create({ data: edgeTo(outsideId) });

    const product = { kind: "product" as const, productId: scope.product.id, tenantId: TENANT };
    const domain = { kind: "domain" as const, domainId: scope.domain.id, tenantId: TENANT };
    for (const guarded of [product, domain]) {
      const found = await findCrossProductEventRefs(prisma, guarded);
      expect(found.map((r) => r.eventId), guarded.kind).toEqual([outside.id]);
      expect(found.truncated, guarded.kind).toBe(false);
    }

    // The guard blocks: the product delete names the outside event, and so does the domain action.
    const blocked = fail(await deleteProduct(scope.product.id, ctx));
    expect(blocked.message).toContain(`other products' events reference its events: ${outside.name} ${where(consumers.scope)}`);
    expect((blocked.details as { events: { referrers: Array<{ eventId: string }>; truncated: boolean } }).events).toMatchObject({ referrers: [{ eventId: outside.id }], truncated: false });
    expect(await deleteDomainAction(scope.domain.id)).toMatchObject({ error: expect.stringContaining(`${outside.name} ${where(consumers.scope)}`) });
    expect(await prisma.product.count({ where: { id: scope.product.id } })).toBe(1);
    expect(await prisma.domain.count({ where: { id: scope.domain.id } })).toBe(1);
  }, 60_000);

  it("fails closed when the scan hit its limit and nothing could be named", async () => {
    const ctx = await testContext(prisma);
    access.userId = ctx.userId;
    const scope = await createProductScope(prisma, ctx, "closed");
    domainIds.push(scope.domain.id);
    const target = await publishedEvent(ctx, scope, "target", emptyEventDocument("target"));
    const s = stamp();

    // More edges than one scan reads whose referrers no longer exist (the edge table has no FK): a full scan, but not one name.
    const staleIds = Array.from({ length: MAX_REFERRER_SCAN + 5 }, (_, i) => `stale-${s}-${String(i).padStart(3, "0")}`);
    await prisma.schemaReference.createMany({
      data: staleIds.map((fromId) => ({ fromKind: "EVENT_SPEC" as const, fromId, role: "MESSAGE" as const, toKind: "EVENT_SPEC_VERSION" as const, toId: target.version.id, isDraft: true })),
    });
    cleanups.push(async () => {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC", fromId: { in: staleIds } } });
    });

    const product = { kind: "product" as const, productId: scope.product.id, tenantId: TENANT };
    const found = await findCrossProductEventRefs(prisma, product);
    expect([...found]).toEqual([]);
    expect(found.truncated).toBe(true);

    // An empty-but-truncated answer is "unknown", never "none": the guard reports it as in use instead of letting the delete through.
    const unknown = eventsInUseError("Product", "P", found);
    expect(unknown?.code).toBe("IN_USE");
    expect(unknown?.message).toBe('Product "P" cannot be deleted: events may still reference it (too many references to check).');
    expect(unknown?.details).toEqual({ referrers: [], truncated: true });
    expect(unknown?.suggestedFix).toBe("Remove the references that point at it first, then try again, or keep the product.");
    const blocked = fail(await deleteProduct(scope.product.id, ctx));
    expect((blocked.details as { events: { referrers: unknown[]; truncated: boolean } }).events).toEqual({ referrers: [], truncated: true });
    expect(blocked.message).toContain("events may still reference it (too many references to check)");
  }, 60_000);

  it("returns a bounded referrer list (truncated flag) for an entity pinned by 60 events", async () => {
    const { ctx, scope, order } = await setup();
    const s = stamp();
    const ids = Array.from({ length: 60 }, (_, i) => `bounded-${s}-${String(i).padStart(2, "0")}`);
    await prisma.eventSpec.createMany({
      data: ids.map((id) => ({ id, name: id, document: emptyEventDocument(id) as unknown as Prisma.InputJsonValue, ...level(scope) })),
    });
    await prisma.schemaReference.createMany({
      data: ids.map((id) => ({ fromKind: "EVENT_SPEC" as const, fromId: id, role: "PAYLOAD" as const, toKind: "ENTITY_VERSION" as const, toId: order.version.id, isDraft: true })),
    });

    const found = await findEntityEventReferrers(prisma, order.entity);
    expect(found).toHaveLength(MAX_EVENT_REFERRERS);
    expect(found.truncated).toBe(true);
    expect(found.map((r) => r.eventName)).toEqual(ids.slice(0, MAX_EVENT_REFERRERS)); // deterministic: by name, then id

    const error = eventsInUseError("Entity", "Order", found);
    expect(error?.code).toBe("IN_USE");
    expect((error?.details as { truncated: boolean }).truncated).toBe(true);
    expect(referrersOf(error!)).toHaveLength(MAX_EVENT_REFERRERS);
    // Five are named, the rest only counted ("45+": the list itself was cut).
    expect(error?.message).toContain(`${ids[4]} (`);
    expect(error?.message).not.toContain(`${ids[5]} (`);
    expect(error?.message).toContain("and 45+ more.");

    // The delete itself is blocked with the same bounded answer.
    const blocked = fail(await deleteEntity(order.entity.id, ctx));
    expect(blocked.code).toBe("IN_USE");
    expect((blocked.details as { truncated: boolean }).truncated).toBe(true);
    expect(referrersOf(blocked)).toHaveLength(MAX_EVENT_REFERRERS);

    // Control: a short list is complete and not flagged.
    await prisma.eventSpec.deleteMany({ where: { id: { in: ids.slice(2) } } });
    await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC", fromId: { in: ids.slice(2) } } });
    const short = await findEntityEventReferrers(prisma, order.entity);
    expect(short).toHaveLength(2);
    expect(short.truncated).toBe(false);
    expect(eventsInUseError("Entity", "Order", short)?.message).toBe(
      `Entity "Order" cannot be deleted: it is pinned by events ${ids[0]} ${where(scope)}, ${ids[1]} ${where(scope)}.`
    );
  }, 60_000);

  it("maps an unexpected database failure to a DB_ERROR Result", async () => {
    const { ctx, scope, owner, order } = await setup();
    const target = await publishedEvent(ctx, scope, "db-error", emptyEventDocument("t")); // has a version, so the edge scan runs
    const evented = await createProductScope(prisma, ctx, "dbe");
    domainIds.push(evented.domain.id);
    await newEvent(ctx, evented, "owned"); // the product owns an event spec, so the cross-product lookup runs
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // deleteEvent: the referrer query runs inside the delete's transaction.
      const brokenEdges: ServiceContext = {
        ...ctx,
        prisma: asPrisma(
          replacing(prisma, {
            $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
              prisma.$transaction((tx) => fn(replacing(tx, { schemaReference: replacing(tx.schemaReference, { findMany: connectionLost }) })), options),
          })
        ),
      };
      // deleteProduct: a product that owns an event spec but has no pins or messages, so only the new guard reads event versions.
      const brokenVersions: ServiceContext = { ...ctx, prisma: asPrisma(replacing(prisma, { eventSpecVersion: replacing(prisma.eventSpecVersion, { findMany: connectionLost }) })) };
      const results = [await deleteEvent(target.event.id, owner, brokenEdges), await deleteProduct(evented.product.id, brokenVersions)];
      for (const r of results) {
        expect(r.success).toBe(false);
        expect(fail(r).code).toBe("DB_ERROR");
        // Generic text only: the driver message (host, table) never reaches the Result.
        expect(JSON.stringify(r)).not.toMatch(/connection lost|db\.internal|event_specs/);
      }
      expect(await prisma.eventSpec.count({ where: { id: target.event.id } })).toBe(1);
      expect(await prisma.product.count({ where: { id: evented.product.id } })).toBe(1);

      // The finders do not swallow a failure: the service wrappers above are what turn it into a Result.
      const brokenJson = asPrisma(replacing(prisma, { eventSpec: replacing(prisma.eventSpec, { findMany: connectionLost }) }));
      await expect(findEntityEventReferrers(brokenJson, order.entity)).rejects.toThrow("connection lost");
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("blocks retiring an entity whose latest version is pinned by a draft or published event, but not older versions or other transitions", async () => {
    const { ctx, scope, owner } = await setup();
    const retire = (id: string) => updateEntity(id, { status: "RETIRED" }, ctx);
    const setStatus = (id: string, status: "ACTIVE" | "DEPRECATED") => prisma.entity.update({ where: { id }, data: { status } });
    const statusOf = async (id: string) => (await prisma.entity.findUniqueOrThrow({ where: { id } })).status;

    // A draft pin on the LATEST version blocks the retire, with the message of the delete guard.
    const alpha = await scope.publishedEntity("Alpha");
    await setStatus(alpha.entity.id, "DEPRECATED");
    const draftEvent = await newEvent(ctx, scope, "retire-draft");
    unwrap(await updateEventDocument(draftEvent.id, docWith([msg("A", pinOf(alpha))]), owner, ctx));
    const blocked = fail(await retire(alpha.entity.id));
    expect(blocked.code).toBe("IN_USE");
    expect(blocked.message).toBe(`Entity "Alpha" cannot be retired: its latest version is pinned by event ${draftEvent.name} ${where(scope)}.`);
    expect(referrersOf(blocked)).toEqual([
      { eventId: draftEvent.id, name: draftEvent.name, domain: scope.domain.name, product: scope.product.name, referencedVersions: ["1.0"], draft: true, published: false },
    ]);
    expect(await statusOf(alpha.entity.id)).toBe("DEPRECATED");
    unwrap(await updateEventDocument(draftEvent.id, emptyEventDocument("none"), owner, ctx));
    expect(unwrap(await retire(alpha.entity.id)).status).toBe("RETIRED");

    // A published pin on the latest version blocks it too, after the draft no longer pins.
    const beta = await scope.publishedEntity("Beta");
    await setStatus(beta.entity.id, "DEPRECATED");
    const published = await publishedEvent(ctx, scope, "retire-published", docWith([msg("B", pinOf(beta))]));
    unwrap(await updateEventDocument(published.event.id, emptyEventDocument("none"), owner, ctx));
    const publishedBlock = fail(await retire(beta.entity.id));
    expect(publishedBlock.code).toBe("IN_USE");
    expect(publishedBlock.message).toBe(`Entity "Beta" cannot be retired: its latest version is pinned by event ${published.event.name} ${where(scope)}.`);
    expect(publishedBlock.suggestedFix).toContain("Published versions cannot be changed");
    expect(await statusOf(beta.entity.id)).toBe("DEPRECATED");

    // A pin on an OLDER version only does not block: the entity moved on and the event keeps its pinned version.
    const gamma = await scope.publishedEntity("Gamma");
    const v2 = await prisma.entityVersion.create({
      data: { entityId: gamma.entity.id, major: 2, minor: 0, sequence: 2, resolvedSource: "", fieldSnapshot: [], changeKind: "MAJOR", publishedById: ctx.userId },
    });
    await prisma.entity.update({ where: { id: gamma.entity.id }, data: { latestVersionId: v2.id, status: "DEPRECATED" } });
    const olderEvent = await newEvent(ctx, scope, "retire-older");
    unwrap(await updateEventDocument(olderEvent.id, docWith([msg("G", pinOf(gamma))]), owner, ctx));
    expect(await findEntityEventReferrers(prisma, gamma.entity)).toHaveLength(1); // still protected from deletion
    expect(unwrap(await retire(gamma.entity.id)).status).toBe("RETIRED");

    // An unpinned pin has no version, hence none on the latest one: it protects deletion but does not block the retire.
    const delta = await scope.publishedEntity("Delta");
    await setStatus(delta.entity.id, "DEPRECATED");
    const unpinnedEvent = await newEvent(ctx, scope, "retire-unpinned");
    unwrap(await updateEventDocument(unpinnedEvent.id, docWith([msg("D", unpinnedOf(delta))]), owner, ctx));
    expect(unwrap(await retire(delta.entity.id)).status).toBe("RETIRED");

    // Only the retire is guarded: an ACTIVE -> DEPRECATED transition of a pinned entity is untouched.
    const epsilon = await scope.publishedEntity("Epsilon");
    await setStatus(epsilon.entity.id, "ACTIVE");
    const activeEvent = await newEvent(ctx, scope, "retire-active");
    unwrap(await updateEventDocument(activeEvent.id, docWith([msg("E", pinOf(epsilon))]), owner, ctx));
    expect(unwrap(await updateEntity(epsilon.entity.id, { status: "DEPRECATED" }, ctx)).status).toBe("DEPRECATED");
  }, 90_000);

  it("merges with the trait foreign-key guard: names the trait and the event together, and leaves the trait answer untouched without events", async () => {
    const { ctx, scope, owner, order } = await setup();
    // A library trait whose headers pin holds the entity: a NO ACTION foreign key, found by the entity pin guard.
    const trait = await prisma.trait.create({
      data: { tenantId: TENANT, domainId: scope.domain.id, kind: "MESSAGE", name: `Headers-${scope.s}`, headersEntityId: order.entity.id, headersEntityVersionId: order.version.id },
    });

    // Trait pin only: the pin guard's message, details and remedy, byte for byte.
    const only = fail(await deleteEntity(order.entity.id, ctx));
    expect(only.code).toBe("IN_USE");
    expect(only.message).toBe(`Entity "Order" cannot be deleted: it is used by Trait "${trait.name}".`);
    expect(only.details).toEqual({ traits: [{ id: trait.id, name: trait.name }], entities: [] });
    expect(only.suggestedFix).toBe("Re-pin or delete those traits first, then delete the entity.");

    // Both: one error, the event named after the trait holder, both remedies kept.
    const event = await newEvent(ctx, scope, "both");
    unwrap(await updateEventDocument(event.id, docWith([msg("OrderCreated", pinOf(order))]), owner, ctx));
    const both = fail(await deleteEntity(order.entity.id, ctx));
    expect(both.code).toBe("IN_USE");
    expect(both.message).toBe(`Entity "Order" cannot be deleted: it is used by Trait "${trait.name}", and it is pinned by event ${event.name} ${where(scope)}.`);
    expect(both.details).toMatchObject({
      traits: [{ id: trait.id, name: trait.name }],
      entities: [],
      events: { truncated: false },
    });
    expect(referrersOf({ ...both, details: (both.details as { events: object }).events })).toHaveLength(1);
    expect(both.suggestedFix).toContain("Re-pin or delete those traits first");
    expect(both.suggestedFix).toContain(`Remove the pin from "${event.name}" first`);
  }, 60_000);
});

describe("eventsInUseError", () => {
  const ref = (n: number): EventReferrerUsage => ({
    eventId: `e${n}`, eventName: `ev${n}`, domainName: "dom", productName: "prod", published: n % 2 === 0, draft: n % 2 === 1, referencedVersions: [],
  });
  const refs = (count: number) => Array.from({ length: count }, (_, i) => ref(i + 1));

  it("is null for an empty list", () => {
    for (const kind of ["Entity", "Trait", "Event", "Product", "Domain"] as const) expect(eventsInUseError(kind, "X", [])).toBeNull();
  });

  it("fails closed for an empty list whose scan hit its limit, words it per kind, and merges it with another blocker", () => {
    const unknown = Object.defineProperty([] as EventReferrerUsage[], "truncated", { value: true, enumerable: false });
    for (const kind of ["Entity", "Trait", "Event", "Product", "Domain"] as const) {
      const error = eventsInUseError(kind, "X", unknown);
      expect(error?.code, kind).toBe("IN_USE");
      expect(error?.message, kind).toBe(`${kind} "X" cannot be deleted: events may still reference it (too many references to check).`);
      expect(error?.details, kind).toEqual({ referrers: [], truncated: true });
    }
    expect(eventsInUseError("Entity", "Order", unknown, "retired")?.message).toBe('Entity "Order" cannot be retired: events may still reference it (too many references to check).');
    // An empty list that was NOT cut short is still "no referrer".
    expect(eventsInUseError("Entity", "Order", Object.defineProperty([], "truncated", { value: false, enumerable: false }))).toBeNull();

    const existing = { code: "IN_USE" as const, message: 'Entity "Order" cannot be deleted: it is used by Trait "T".', suggestedFix: "Re-pin or delete those traits first." };
    const merged = withEventsInUse(existing, "Entity", "Order", unknown);
    expect(merged?.code).toBe("IN_USE");
    expect(merged?.message).toBe('Entity "Order" cannot be deleted: it is used by Trait "T", and events may still reference it (too many references to check).');
    expect(merged?.details).toEqual({ events: { referrers: [], truncated: true } });
    expect(withEventsInUse(null, "Entity", "Order", unknown)?.code).toBe("IN_USE");
  });

  it("names up to five referrers as name (domain/product) and counts the rest", () => {
    const error = eventsInUseError("Entity", "Order", refs(7));
    expect(error?.code).toBe("IN_USE");
    expect(error?.message).toBe(
      'Entity "Order" cannot be deleted: it is pinned by events ev1 (dom/prod), ev2 (dom/prod), ev3 (dom/prod), ev4 (dom/prod), ev5 (dom/prod), and 2 more.'
    );
    expect(referrersOf(error!)).toHaveLength(7);
    expect((error?.details as { truncated: boolean }).truncated).toBe(false);
  });

  it("flags a list longer than the bound as truncated, trims it, and says '+'", () => {
    const error = eventsInUseError("Trait", "T", refs(MAX_EVENT_REFERRERS + 3));
    expect((error?.details as { truncated: boolean }).truncated).toBe(true);
    expect(referrersOf(error!)).toHaveLength(MAX_EVENT_REFERRERS);
    expect(error?.message).toContain(`and ${MAX_EVENT_REFERRERS - 5}+ more.`);
  });

  it("words each kind, and retire separately from delete", () => {
    expect(eventsInUseError("Event", "E", refs(1))?.message).toBe('Event "E" cannot be deleted: its published versions are referenced by ev1 (dom/prod).');
    expect(eventsInUseError("Trait", "T", refs(1))?.message).toBe('Trait "T" cannot be deleted: it is used by event ev1 (dom/prod).');
    expect(eventsInUseError("Product", "P", refs(1))?.message).toBe('Product "P" cannot be deleted: other products\' events reference its events: ev1 (dom/prod).');
    expect(eventsInUseError("Domain", "D", refs(1))?.message).toBe('Domain "D" cannot be deleted: other domains\' events reference its events: ev1 (dom/prod).');
    expect(eventsInUseError("Entity", "Order", refs(1), "retired")?.message).toBe('Entity "Order" cannot be retired: its latest version is pinned by event ev1 (dom/prod).');
  });

  it("points at the published referrer when there is one, and at the drafts otherwise", () => {
    expect(eventsInUseError("Entity", "Order", [ref(1), ref(2)])?.suggestedFix).toBe(
      'Published versions cannot be changed, so delete event "ev2" (which removes its published versions) and the other referrers listed first, or keep the entity.'
    );
    expect(eventsInUseError("Entity", "Order", [ref(1)])?.suggestedFix).toBe('Remove the pin from "ev1" first, or keep the entity.');
    expect(eventsInUseError("Entity", "Order", [ref(1), ref(3)])?.suggestedFix).toBe("Remove the pin from the drafts listed first, or keep the entity.");
  });
});
