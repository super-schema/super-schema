import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createEventSpecVersion, createProductScope, resolvedChannel, resolvedMessage, stamp, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { propertiesNameLower } from "@/features/events/builder/labels";
import { createEvent, deleteEvent, getEvent, renameEvent, updateEventDocument } from "@/services/events/event.service";
import { emptyEventDocument, type DocExternalRef, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";

// The user's words for a trait (builder/labels.ts): the save validation's texts are checked against them, so a renamed label fails here.
const MESSAGE_PROPERTIES = propertiesNameLower("MESSAGE");
const OPERATION_PROPERTIES = propertiesNameLower("OPERATION");
const prisma = connectTestDb();
const domainIds: string[] = [];
const tenantTraitIds: string[] = [];
afterAll(async () => {
  await cleanupDomains(prisma, domainIds);
  await cleanupTenantTraits(prisma, tenantTraitIds);
  await prisma.$disconnect();
});

type Scope = Awaited<ReturnType<typeof createProductScope>>;

async function setup() {
  const ctx = await testContext(prisma);
  const scope = await createProductScope(prisma, ctx);
  domainIds.push(scope.domain.id);
  const owner = { level: "PRODUCT" as const, productId: scope.product.id };
  const entity = await scope.publishedEntity("Order");
  return { ctx, scope, owner, entity };
}

/** A second product (own domain) in the same tenant. */
async function otherProduct(ctx: ServiceContext, label = "oth") {
  const scope = await createProductScope(prisma, ctx, label);
  domainIds.push(scope.domain.id);
  return { scope, owner: { level: "PRODUCT" as const, productId: scope.product.id } };
}

const withMessage = (entityId: string, versionId: string | null): EventDocument => ({
  ...emptyEventDocument("svc"),
  channels: [{ key: "orders", address: "o", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", payload: { entityId, entityVersionId: versionId }, traitKeys: [] }],
  operations: [{ key: "pub", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});
const withTraits = (traits: EventDocument["traits"]): EventDocument => ({ ...emptyEventDocument("svc"), traits });
const withRefs = (externalRefs: DocExternalRef[]): EventDocument => ({ ...emptyEventDocument("svc"), externalRefs });

const failureCode = (r: Result<unknown>) => (r.success ? null : r.error.code);
const problemsOf = (r: Result<unknown>): DocumentProblem[] =>
  r.success ? [] : ((r.error.details as { problems?: DocumentProblem[] } | undefined)?.problems ?? []);
const draftEdges = (eventId: string) =>
  prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: eventId }, orderBy: [{ role: "asc" }, { toKind: "asc" }, { toId: "asc" }] });
const storedDocument = async (eventId: string) => (await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } })).document;

/** An event with one published version (1.0); `resolvedSpec: null` is a version published before document v2. */
async function seedPublishedEvent(sc: Scope, ctx: ServiceContext, name: string, resolvedSpec: Prisma.InputJsonValue | null) {
  const event = unwrap(await createEvent(sc.product.id, { name: `${name}-${sc.s}` }, ctx));
  const version = await createEventSpecVersion(prisma, {
    eventSpecId: event.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: {}, frozenTraits: [],
    changeKind: "INITIAL", publishedById: ctx.userId, ...(resolvedSpec === null ? {} : { resolvedSpec }),
  });
  await prisma.eventSpec.update({ where: { id: event.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
  return { event, version };
}
const RESOLVED = { channels: [resolvedChannel("orders")], messages: [resolvedMessage("M")] };

/** A Proxy over a Prisma object whose listed members are replaced; everything else is the real thing. */
function replacing<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, { get: (t, p) => (typeof p === "string" && p in overrides ? overrides[p] : Reflect.get(t, p)) });
}
const connectionLost = () => Promise.reject(new Error("connection lost: host=db.internal table=event_specs"));
const asPrisma = (p: object) => p as unknown as PrismaClient;

describe("event.service", () => {
  it("creates an empty v2 event and reads it back", async () => {
    const { ctx, scope } = await setup();
    const name = `checkout-${scope.s}`;
    const created = unwrap(await createEvent(scope.product.id, { name, description: "d" }, ctx));
    expect(created.document.documentVersion).toBe(2);
    expect(created.document.info).toEqual({ title: name, description: "d" });
    expect(created).toMatchObject({
      name, specType: "asyncapi@3.0", latestVersionLabel: null, hasUnpublishedChanges: true,
      tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id,
    });
    const read = unwrap(await getEvent(created.id, ctx));
    expect(read).toEqual(created);
    expect(read.name).toBe(name);
  });

  it("uses the title for info.title when given and rejects malformed create input", async () => {
    const { ctx, scope } = await setup();
    const titled = unwrap(await createEvent(scope.product.id, { name: `titled-${scope.s}`, title: "  Payments  " }, ctx));
    expect(titled.document.info).toEqual({ title: "Payments" });

    expect(failureCode(await createEvent(scope.product.id, { name: "has space" }, ctx))).toBe("VALIDATION_ERROR");
    expect(failureCode(await createEvent(scope.product.id, { name: `t-${scope.s}`, title: 5 as unknown as string }, ctx))).toBe("VALIDATION_ERROR");
    expect(failureCode(await createEvent(scope.product.id, null as never, ctx))).toBe("VALIDATION_ERROR");
    expect(failureCode(await createEvent("", { name: `p-${scope.s}` }, ctx))).toBe("VALIDATION_ERROR");
    expect(failureCode(await createEvent("no-such-product", { name: `p-${scope.s}` }, ctx))).toBe("NOT_FOUND");
    expect(failureCode(await createEvent(scope.product.id, { name: titled.name.toUpperCase() }, ctx))).toBe("NAME_CONFLICT");
  });

  it("reports unknown and malformed ids from getEvent as failures", async () => {
    const { ctx } = await setup();
    expect(failureCode(await getEvent("no-such-event", ctx))).toBe("NOT_FOUND");
    expect(failureCode(await getEvent("", ctx))).toBe("VALIDATION_ERROR");
  });

  it("saves a document with pins and writes draft edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e1-${scope.s}` }, ctx));
    const saved = unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    expect(saved.hasUnpublishedChanges).toBe(true);
    expect(saved.document.messages[0].payload).toEqual({ entityId: entity.entity.id, entityVersionId: entity.version.id });
    const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } });
    expect(edges.map((e) => [e.role, e.toKind, e.toId, e.isDraft])).toEqual([["PAYLOAD", "ENTITY_VERSION", entity.version.id, true]]);
    expect(unwrap(await getEvent(ev.id, ctx)).document).toEqual(saved.document);
  });

  it("writes an edge for every pin kind: payload, headers, key and a local trait's headers", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const headers = await scope.publishedEntity("Headers");
    const key = await scope.publishedEntity("OrderKey");
    const traitHeaders = await scope.publishedEntity("TraitHeaders");
    const ev = unwrap(await createEvent(scope.product.id, { name: `pins-${scope.s}` }, ctx));
    const doc: EventDocument = {
      ...withMessage(entity.entity.id, entity.version.id),
      messages: [{
        key: "OrderCreated", payload: { entityId: entity.entity.id, entityVersionId: entity.version.id },
        headers: { entityId: headers.entity.id, entityVersionId: headers.version.id },
        keyPin: { entityId: key.entity.id, entityVersionId: key.version.id },
        traitKeys: ["T"],
      }],
      traits: [{ key: "T", kind: "MESSAGE", spec: {}, headers: { entityId: traitHeaders.entity.id, entityVersionId: traitHeaders.version.id } }],
    };
    unwrap(await updateEventDocument(ev.id, doc, owner, ctx));
    const edges = (await draftEdges(ev.id)).map((e) => `${e.role}:${e.toId}`).sort();
    expect(edges).toEqual([
      `HEADERS:${headers.version.id}`, `HEADERS:${traitHeaders.version.id}`, `KEY:${key.version.id}`, `PAYLOAD:${entity.version.id}`,
    ].sort());
  });

  it("accepts a pin to an entity of another product in the same tenant", async () => {
    const { ctx, scope, owner } = await setup();
    const other = await otherProduct(ctx);
    const theirs = await other.scope.publishedEntity("Shared");
    const ev = unwrap(await createEvent(scope.product.id, { name: `cross-${scope.s}` }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(theirs.entity.id, theirs.version.id), owner, ctx));
    expect((await draftEdges(ev.id)).map((e) => e.toId)).toEqual([theirs.version.id]);
  });

  it("replaces edges on every save and drops them when the pin is removed", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e2-${scope.s}` }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    const second = await scope.publishedEntity("Second");
    unwrap(await updateEventDocument(ev.id, withMessage(second.entity.id, second.version.id), owner, ctx));
    expect((await draftEdges(ev.id)).map((e) => e.toId)).toEqual([second.version.id]);
    unwrap(await updateEventDocument(ev.id, emptyEventDocument("svc"), owner, ctx));
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
  });

  it("accepts an unpinned pin as a draft but records no edge", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e3-${scope.s}` }, ctx));
    const saved = unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, null), owner, ctx));
    expect(saved.document.messages[0].payload).toEqual({ entityId: entity.entity.id, entityVersionId: null });
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
  });

  it("marks a published event as having unpublished changes on every save and keeps its latest version label", async () => {
    const { ctx, scope, owner } = await setup();
    const { event } = await seedPublishedEvent(scope, ctx, "pub", null);
    const before = unwrap(await getEvent(event.id, ctx));
    expect(before).toMatchObject({ latestVersionLabel: "1.0", hasUnpublishedChanges: false });
    const saved = unwrap(await updateEventDocument(event.id, emptyEventDocument("again"), owner, ctx));
    expect(saved).toMatchObject({ latestVersionLabel: "1.0", hasUnpublishedChanges: true });
    expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: event.id } })).hasUnpublishedChanges).toBe(true);
  });

  it("rejects every problem at once with JSON-pointer details", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e4-${scope.s}` }, ctx));
    const doc: EventDocument = {
      ...withMessage("no-such-entity", null),
      messages: [{
        key: "OrderCreated", payload: { entityId: "no-such-entity", entityVersionId: null },
        headers: { entityId: entity.entity.id, entityVersionId: "no-such-version" },
        keyPin: { entityId: "no-such-key-entity", entityVersionId: null }, traitKeys: [],
      }],
      traits: [{ key: "L", kind: "MESSAGE", libraryTraitId: "no-such-trait" }],
      externalRefs: [{ key: "x", eventVersionId: "no-such-event-version", kind: "message", itemKey: "M" }],
    };
    const r = await updateEventDocument(ev.id, doc, owner, ctx);
    expect(failureCode(r)).toBe("VALIDATION_ERROR");
    expect(problemsOf(r)).toEqual([
      { pointer: "/messages/0/payload/entityId", message: 'Entity "no-such-entity" not found in this tenant' },
      { pointer: "/messages/0/headers/entityVersionId", message: '"no-such-version" is not a published version of Order' },
      { pointer: "/messages/0/keyPin/entityId", message: 'Entity "no-such-key-entity" not found in this tenant' },
      { pointer: "/traits/0/libraryTraitId", message: `Library ${MESSAGE_PROPERTIES} "no-such-trait" not found` },
      { pointer: "/externalRefs/0/eventVersionId", message: 'Event version "no-such-event-version" not found' },
    ]);
    // Nothing was written.
    expect((await storedDocument(ev.id) as { messages: unknown[] }).messages).toEqual([]);
  });

  it("passes document parse problems through and keeps the previously saved draft and edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `parse-${scope.s}` }, ctx));
    const good = unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));

    const legacy = await updateEventDocument(ev.id, { info: { title: "old" }, servers: [], operations: [] }, owner, ctx);
    expect(failureCode(legacy)).toBe("VALIDATION_ERROR");
    expect(problemsOf(legacy).map((p) => p.pointer)).toContain("/documentVersion");

    const badKey = await updateEventDocument(ev.id, { ...withMessage(entity.entity.id, null), channels: [{ ...withMessage("x", null).channels[0], key: "has space" }] }, owner, ctx);
    expect(problemsOf(badKey).map((p) => p.pointer)).toContain("/channels/0/key");

    expect(failureCode(await updateEventDocument(ev.id, "not an object", owner, ctx))).toBe("VALIDATION_ERROR");
    expect(unwrap(await getEvent(ev.id, ctx)).document).toEqual(good.document);
    expect((await draftEdges(ev.id)).map((e) => e.toId)).toEqual([entity.version.id]);
  });

  it("rejects a pin to an entity of another tenant and a version that belongs to another entity", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const other = await scope.publishedEntity("Other");
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      foreign = await createForeignTenantFixture(prisma, ctx);
      const ev = unwrap(await createEvent(scope.product.id, { name: `e5-${scope.s}` }, ctx));

      const wrongVersion = await updateEventDocument(ev.id, withMessage(entity.entity.id, other.version.id), owner, ctx);
      expect(failureCode(wrongVersion)).toBe("VALIDATION_ERROR");
      expect(problemsOf(wrongVersion)).toEqual([
        { pointer: "/messages/0/payload/entityVersionId", message: `"${other.version.id}" is not a published version of Order` },
      ]);

      // The foreign entity reads exactly like a missing one: no name, no tenant hint.
      const crossTenant = await updateEventDocument(ev.id, withMessage(foreign.entity.id, foreign.version.id), owner, ctx);
      expect(problemsOf(crossTenant)).toEqual([
        { pointer: "/messages/0/payload/entityId", message: `Entity "${foreign.entity.id}" not found in this tenant` },
      ]);
      expect(JSON.stringify(crossTenant)).not.toContain("Foreign");

      // The right entity with the foreign tenant's version is a version mismatch, not a leak.
      const foreignVersion = await updateEventDocument(ev.id, withMessage(entity.entity.id, foreign.version.id), owner, ctx);
      expect(problemsOf(foreignVersion).map((p) => p.pointer)).toEqual(["/messages/0/payload/entityVersionId"]);
      expect(await draftEdges(ev.id)).toEqual([]);
    } finally {
      await foreign?.cleanup();
    }
  });

  it("rejects a library trait from another domain, another tenant's trait and a kind mismatch", async () => {
    const { ctx, scope, owner } = await setup();
    const sibling = await otherProduct(ctx, "sib");
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      foreign = await createForeignTenantFixture(prisma, ctx);
      const ev = unwrap(await createEvent(scope.product.id, { name: `e8-${scope.s}` }, ctx));
      const trait = (name: string, kind: "MESSAGE" | "OPERATION", placement: { domainId?: string; productId?: string }) =>
        prisma.trait.create({ data: { name: `${name}-${scope.s}`, kind, tenantId: TENANT, ...placement } });
      const otherDomain = await trait("SibTrait", "MESSAGE", { domainId: sibling.scope.domain.id });
      const operationTrait = await trait("OpTrait", "OPERATION", { domainId: scope.domain.id });

      const r = await updateEventDocument(ev.id, withTraits([
        { key: "A", kind: "MESSAGE", libraryTraitId: otherDomain.id },
        { key: "B", kind: "MESSAGE", libraryTraitId: foreign.trait.id },
        { key: "C", kind: "MESSAGE", libraryTraitId: operationTrait.id },
      ]), owner, ctx);
      expect(failureCode(r)).toBe("VALIDATION_ERROR");
      const reasons = `only tenant-level ${MESSAGE_PROPERTIES} and ${MESSAGE_PROPERTIES} of the event's own domain can be used`;
      expect(problemsOf(r)).toEqual([
        { pointer: "/traits/0/libraryTraitId", message: `Library ${MESSAGE_PROPERTIES} "${otherDomain.name}" are not available to this event: ${reasons}` },
        { pointer: "/traits/1/libraryTraitId", message: `Library ${MESSAGE_PROPERTIES} "${foreign.trait.id}" not found` },
        { pointer: "/traits/2/libraryTraitId", message: `Library "${operationTrait.name}" is a set of ${OPERATION_PROPERTIES}, but "C" is declared as a set of ${MESSAGE_PROPERTIES}` },
      ]);
      expect(JSON.stringify(r)).not.toContain(foreign.trait.name);
      expect((await storedDocument(ev.id) as { traits: unknown[] }).traits).toEqual([]);
    } finally {
      await foreign?.cleanup();
    }
  });

  it("accepts tenant-level and own-domain library traits of the matching kind", async () => {
    const { ctx, scope, owner } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e9-${scope.s}` }, ctx));
    const tenantTrait = await prisma.trait.create({ data: { name: `TenantTrait-${scope.s}`, kind: "MESSAGE", tenantId: TENANT } });
    tenantTraitIds.push(tenantTrait.id);
    const domainTrait = await prisma.trait.create({ data: { name: `DomainOp-${scope.s}`, kind: "OPERATION", tenantId: TENANT, domainId: scope.domain.id } });
    const doc = withTraits([
      { key: "fromTenant", kind: "MESSAGE", libraryTraitId: tenantTrait.id },
      { key: "fromDomain", kind: "OPERATION", libraryTraitId: domainTrait.id },
    ]);
    const saved = unwrap(await updateEventDocument(ev.id, doc, owner, ctx));
    expect(saved.document.traits).toEqual(doc.traits);
    expect(await draftEdges(ev.id)).toEqual([]);
  });

  it("rejects an external ref to an unknown, own, pre-v2 or foreign event version or to a missing item", async () => {
    const { ctx, scope, owner } = await setup();
    const other = await otherProduct(ctx);
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      foreign = await createForeignTenantFixture(prisma, ctx);
      const foreignEvent = await prisma.eventSpec.create({
        data: { name: `fev-${foreign.s}`, document: {}, tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      const foreignVersion = await createEventSpecVersion(prisma, {
        eventSpecId: foreignEvent.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: {}, frozenTraits: [],
        resolvedSpec: RESOLVED, changeKind: "INITIAL", publishedById: ctx.userId,
      });
      const target = await seedPublishedEvent(other.scope, ctx, "target", RESOLVED);
      const preV2 = await seedPublishedEvent(other.scope, ctx, "legacy", null);
      const own = await seedPublishedEvent(scope, ctx, "own", RESOLVED);

      const ref = (key: string, eventVersionId: string, kind: "channel" | "message", itemKey: string): DocExternalRef => ({ key, eventVersionId, kind, itemKey });
      const r = await updateEventDocument(own.event.id, withRefs([
        ref("unknown", "no-such-version", "message", "M"),
        ref("self", own.version.id, "message", "M"),
        ref("legacy", preV2.version.id, "message", "M"),
        ref("missing", target.version.id, "message", "Nope"),
        ref("wrongKind", target.version.id, "message", "orders"),
        ref("foreign", foreignVersion.id, "message", "M"),
      ]), owner, ctx);
      expect(failureCode(r)).toBe("VALIDATION_ERROR");
      expect(problemsOf(r)).toEqual([
        { pointer: "/externalRefs/0/eventVersionId", message: 'Event version "no-such-version" not found' },
        { pointer: "/externalRefs/1/eventVersionId", message: "An event cannot reference its own version" },
        { pointer: "/externalRefs/2", message: `Version 1.0 of "${preV2.event.name}" cannot be referenced: it has no resolved spec (published before event documents v2)` },
        { pointer: "/externalRefs/3/itemKey", message: `Version 1.0 of "${target.event.name}" has no message "Nope"` },
        { pointer: "/externalRefs/4/itemKey", message: `Version 1.0 of "${target.event.name}" has no message "orders"` },
        { pointer: "/externalRefs/5/eventVersionId", message: `Event version "${foreignVersion.id}" not found` },
      ]);
      expect(JSON.stringify(r)).not.toContain(foreignEvent.name);
      expect(await draftEdges(own.event.id)).toEqual([]);
    } finally {
      await foreign?.cleanup();
    }
  });

  it("accepts an external ref to a published version of another or the same product with a known item and records MESSAGE edges", async () => {
    const { ctx, scope, owner } = await setup();
    const other = await otherProduct(ctx);
    const theirs = await seedPublishedEvent(other.scope, ctx, "theirs", RESOLVED);
    const sibling = await seedPublishedEvent(scope, ctx, "sibling", { channels: [], messages: [resolvedMessage("S")] });
    const ev = unwrap(await createEvent(scope.product.id, { name: `consumer-${scope.s}` }, ctx));

    const doc: EventDocument = {
      ...emptyEventDocument("consumer"),
      externalRefs: [
        { key: "ordersChannel", eventVersionId: theirs.version.id, kind: "channel", itemKey: "orders" },
        { key: "orderMessage", eventVersionId: theirs.version.id, kind: "message", itemKey: "M" },
        { key: "siblingMessage", eventVersionId: sibling.version.id, kind: "message", itemKey: "S" },
      ],
    };
    const saved = unwrap(await updateEventDocument(ev.id, doc, owner, ctx));
    expect(saved.document.externalRefs).toEqual(doc.externalRefs);
    const edges = await draftEdges(ev.id);
    expect(edges.map((e) => [e.role, e.toKind, e.toId, e.isDraft]).sort()).toEqual(
      [["MESSAGE", "EVENT_SPEC_VERSION", theirs.version.id, true], ["MESSAGE", "EVENT_SPEC_VERSION", sibling.version.id, true]].sort()
    );
  });

  it("renames with name-registry uniqueness and refuses a duplicate in the same line", async () => {
    const { ctx, scope, owner } = await setup();
    const a = unwrap(await createEvent(scope.product.id, { name: `alpha-${scope.s}` }, ctx));
    const b = unwrap(await createEvent(scope.product.id, { name: `beta-${scope.s}` }, ctx));
    const taken = await renameEvent(a.id, b.name, owner, ctx);
    expect(failureCode(taken)).toBe("NAME_CONFLICT");
    expect(failureCode(await renameEvent(a.id, b.name.toUpperCase(), owner, ctx))).toBe("NAME_CONFLICT");
    expect(unwrap(await renameEvent(a.id, `gamma-${scope.s}`, owner, ctx)).name).toBe(`gamma-${scope.s}`);
    // Renaming to its own current name is not a conflict with itself.
    expect(unwrap(await renameEvent(a.id, `gamma-${scope.s}`, owner, ctx)).name).toBe(`gamma-${scope.s}`);
    expect(failureCode(await renameEvent(a.id, "has space", owner, ctx))).toBe("VALIDATION_ERROR");
    expect(failureCode(await renameEvent(a.id, 7, owner, ctx))).toBe("VALIDATION_ERROR");
    expect(unwrap(await getEvent(a.id, ctx)).name).toBe(`gamma-${scope.s}`);
  });

  it("keeps the document and edges when an event is renamed", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `keep-${scope.s}` }, ctx));
    const saved = unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    const renamed = unwrap(await renameEvent(ev.id, `kept-${scope.s}`, owner, ctx));
    expect(renamed.document).toEqual(saved.document);
    expect((await draftEdges(ev.id)).map((e) => e.toId)).toEqual([entity.version.id]);
  });

  it("enforces ownership: another product's owner cannot write, an unknown owner is not found", async () => {
    const { ctx, scope } = await setup();
    const stranger = await otherProduct(ctx, "str");
    const ev = unwrap(await createEvent(scope.product.id, { name: `e6-${scope.s}` }, ctx));

    const update = await updateEventDocument(ev.id, emptyEventDocument("x"), stranger.owner, ctx);
    expect(failureCode(update)).toBe("FORBIDDEN");
    // The failure names the id the caller supplied, never the row's own name.
    expect(update.success ? "" : update.error.message).not.toContain(ev.name);
    expect(failureCode(await renameEvent(ev.id, `stolen-${scope.s}`, stranger.owner, ctx))).toBe("FORBIDDEN");
    expect(failureCode(await deleteEvent(ev.id, stranger.owner, ctx))).toBe("FORBIDDEN");
    expect(failureCode(await updateEventDocument(ev.id, emptyEventDocument("x"), { level: "PRODUCT", productId: "someone-else" }, ctx))).toBe("NOT_FOUND");
    expect(failureCode(await updateEventDocument("no-such-event", emptyEventDocument("x"), stranger.owner, ctx))).toBe("NOT_FOUND");

    const unchanged = unwrap(await getEvent(ev.id, ctx));
    expect(unchanged.name).toBe(ev.name);
    expect(unchanged.document).toEqual(ev.document);
  });

  it("reads a stored v1 document as DATA_CORRUPT, refuses to rename it, and lets a v2 save replace it", async () => {
    const { ctx, scope, owner } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `v1-${scope.s}` }, ctx));
    await prisma.eventSpec.update({ where: { id: ev.id }, data: { document: { info: { title: "old" }, servers: [], operations: [] } } });

    const read = await getEvent(ev.id, ctx);
    expect(failureCode(read)).toBe("DATA_CORRUPT");
    expect(read.success ? "" : read.error.message).not.toContain(ev.name);
    expect(failureCode(await renameEvent(ev.id, `v1-renamed-${scope.s}`, owner, ctx))).toBe("DATA_CORRUPT");
    expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: ev.id } })).name).toBe(ev.name); // rolled back

    const healed = unwrap(await updateEventDocument(ev.id, emptyEventDocument("new"), owner, ctx));
    expect(healed.document.documentVersion).toBe(2);
    expect(unwrap(await getEvent(ev.id, ctx)).document.info.title).toBe("new");
  });

  it("blocks deleting an event whose published version is referenced by another event, naming the referrers", async () => {
    const { ctx, scope, owner } = await setup();
    const consumers = await otherProduct(ctx, "con");
    const target = await seedPublishedEvent(scope, ctx, "target", RESOLVED);
    // The target also has an edge of its own; it must survive a blocked delete.
    const entity = await scope.publishedEntity("Order2");
    unwrap(await updateEventDocument(target.event.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));

    // A draft referrer: saved through the service, so it has an EVENT_SPEC edge.
    const draftConsumer = unwrap(await createEvent(consumers.scope.product.id, { name: `draft-consumer-${consumers.scope.s}` }, ctx));
    unwrap(await updateEventDocument(draftConsumer.id, withRefs([{ key: "orders", eventVersionId: target.version.id, kind: "channel", itemKey: "orders" }]), consumers.owner, ctx));
    // A published referrer: its own version holds the edge.
    const published = await seedPublishedEvent(consumers.scope, ctx, "published-consumer", RESOLVED);
    const publishedEdge = await prisma.schemaReference.create({
      data: { fromKind: "EVENT_SPEC_VERSION", fromId: published.version.id, role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: target.version.id, isDraft: false },
    });

    const blocked = await deleteEvent(target.event.id, owner, ctx);
    expect(failureCode(blocked)).toBe("IN_USE");
    const where = `(${consumers.scope.domain.name}/${consumers.scope.product.name})`;
    const message = blocked.success ? "" : blocked.error.message;
    expect(message).toContain(`${draftConsumer.name} ${where}`);
    expect(message).toContain(`${published.event.name} ${where}`);
    const referrers = (blocked.success ? [] : (blocked.error.details as { referrers: Array<Record<string, unknown>> }).referrers).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    expect(referrers).toEqual([
      { eventId: draftConsumer.id, name: draftConsumer.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: true, published: false },
      { eventId: published.event.id, name: published.event.name, domain: consumers.scope.domain.name, product: consumers.scope.product.name, referencedVersions: ["1.0"], draft: false, published: true },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    expect(await prisma.eventSpec.count({ where: { id: target.event.id } })).toBe(1);
    expect(await prisma.eventSpecVersion.count({ where: { id: target.version.id } })).toBe(1);
    expect(await draftEdges(target.event.id)).toHaveLength(1);

    // Removing the draft reference leaves the published referrer in the way; removing that edge frees the event.
    unwrap(await updateEventDocument(draftConsumer.id, emptyEventDocument("c"), consumers.owner, ctx));
    const stillBlocked = await deleteEvent(target.event.id, owner, ctx);
    expect(failureCode(stillBlocked)).toBe("IN_USE");
    expect(stillBlocked.success ? "" : stillBlocked.error.message).not.toContain(draftConsumer.name);
    expect(stillBlocked.success ? "" : stillBlocked.error.message).toContain(published.event.name);

    await prisma.schemaReference.delete({ where: { id: publishedEdge.id } });
    expect(unwrap(await deleteEvent(target.event.id, owner, ctx))).toEqual({ id: target.event.id });
    expect(await prisma.eventSpec.count({ where: { id: target.event.id } })).toBe(0);
    expect(await prisma.eventSpecVersion.count({ where: { id: target.version.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: target.event.id } })).toBe(0);
  });

  it("ignores an edge whose referrer no longer exists and an event's own edges to its versions", async () => {
    const { ctx, scope, owner } = await setup();
    const target = await seedPublishedEvent(scope, ctx, "stale", RESOLVED);
    const ghostId = `ghost-${stamp()}`;
    await prisma.schemaReference.createMany({
      data: [
        { fromKind: "EVENT_SPEC", fromId: ghostId, role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: target.version.id, isDraft: true },
        { fromKind: "EVENT_SPEC_VERSION", fromId: target.version.id, role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: target.version.id, isDraft: false },
      ],
    });
    try {
      expect(unwrap(await deleteEvent(target.event.id, owner, ctx))).toEqual({ id: target.event.id });
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromId: ghostId } });
    }
    expect(await prisma.eventSpec.count({ where: { id: target.event.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: target.version.id } })).toBe(0);
  });

  it("deletes an unreferenced event with its edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e7-${scope.s}` }, ctx));
    unwrap(await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, ctx));
    unwrap(await deleteEvent(ev.id, owner, ctx));
    expect(await prisma.eventSpec.count({ where: { id: ev.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: ev.id } })).toBe(0);
    expect(failureCode(await getEvent(ev.id, ctx))).toBe("NOT_FOUND");
  });

  it("deletes a published event through the immutable-version triggers and removes its version edges", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const { event, version } = await seedPublishedEvent(scope, ctx, "published", RESOLVED);
    await prisma.schemaReference.create({
      data: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: entity.version.id, isDraft: false },
    });
    expect(unwrap(await deleteEvent(event.id, owner, ctx))).toEqual({ id: event.id });
    expect(await prisma.eventSpecVersion.count({ where: { id: version.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id } })).toBe(0);
  });

  it("maps an unexpected database failure to a DB_ERROR Result instead of throwing", async () => {
    const { ctx, scope, owner } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e10-${scope.s}` }, ctx));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const brokenEventReads: ServiceContext = { ...ctx, prisma: asPrisma(replacing(prisma, { eventSpec: replacing(prisma.eventSpec, { findUnique: connectionLost }) })) };
      const brokenProductReads: ServiceContext = { ...ctx, prisma: asPrisma(replacing(prisma, { product: replacing(prisma.product, { findUnique: connectionLost }) })) };
      const results = [
        await getEvent(ev.id, brokenEventReads),
        await updateEventDocument(ev.id, emptyEventDocument("x"), owner, brokenEventReads),
        await renameEvent(ev.id, `renamed-${scope.s}`, owner, brokenEventReads),
        await deleteEvent(ev.id, owner, brokenEventReads),
        await createEvent(scope.product.id, { name: `e11-${scope.s}` }, brokenProductReads),
      ];
      for (const r of results) {
        expect(failureCode(r)).toBe("DB_ERROR");
        // Generic text only: the driver message (host, table) never reaches the Result.
        expect(JSON.stringify(r)).not.toMatch(/connection lost|db\.internal|event_specs/);
      }
      expect(await prisma.eventSpec.count({ where: { id: ev.id } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls the document back when writing its edges fails, and reports DB_ERROR", async () => {
    const { ctx, scope, owner, entity } = await setup();
    const ev = unwrap(await createEvent(scope.product.id, { name: `e12-${scope.s}` }, ctx));
    const before = unwrap(await updateEventDocument(ev.id, emptyEventDocument("before"), owner, ctx));
    const failingEdges = replacing(prisma, {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
        prisma.$transaction((tx) => fn(replacing(tx, { schemaReference: replacing(tx.schemaReference, { createMany: connectionLost }) })), options),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const r = await updateEventDocument(ev.id, withMessage(entity.entity.id, entity.version.id), owner, { ...ctx, prisma: asPrisma(failingEdges) });
      expect(failureCode(r)).toBe("DB_ERROR");
    } finally {
      spy.mockRestore();
    }
    // Document write and edge replacement share one transaction: the failed save left no trace.
    expect(unwrap(await getEvent(ev.id, ctx)).document).toEqual(before.document);
    expect(await draftEdges(ev.id)).toEqual([]);
  });
});
