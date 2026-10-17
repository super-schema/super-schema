import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { isDeepStrictEqual } from "node:util";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { diagnostic } from "@/lib/event-specs/diagnostics";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { GENERIC_VALIDATION_FAILURE, type EventSpecValidator } from "@/lib/event-specs";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { collectDocumentEdges } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocMessage, type EventDocument } from "@/lib/events/document/types";
import type { EventPublishBlocker } from "@/lib/events/publish-plan";
import type { EntityPin } from "@/lib/events/types";
import { MAX_CHANGE_SUMMARY, type PublishInput } from "@/lib/entity-versioning/types";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { emitEventStoredVersion, type EmitDeps } from "@/services/events/event-emit.service";
import { listEventVersions, previewEventPublish, publishEvent } from "@/services/events/event-publish.service";
import { createEvent, updateEventDocument } from "@/services/events/event.service";
import { deleteTrait } from "@/services/events/trait.service";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";

/**
 * Publish of a self-contained event (WP-P1) against the real database, the real snapshot loader, resolver, assembler and both
 * validators. Only the artifact renderer is a stand-in (no TypeSpec compile): every entity is a tiny Avro record / JSON Schema
 * object named after it, and the stand-in never consults the database (so a pin to a version that does not exist still "renders").
 */
let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let other: Awaited<ReturnType<typeof createProductScope>>;
let owner: { level: "PRODUCT"; productId: string };

type Versioned = { entityId: string; name: string; v: Record<string, string> };
let order: Versioned; // 1.0, 1.1, 2.0
let orderKey: Versioned;
let shipment: Versioned;
let ceHeaders: Versioned; // 1.0, 2.0

const modelNames = new Map<string, string>();
const def = (name: string) => BUNDLED_TRAITS.find((t) => t.name === name)!;
const obj = (value: unknown): JsonObject => value as JsonObject;
const failureCode = (r: Result<unknown>) => (r.success ? null : r.error.code);
const blockersOf = (r: Result<unknown>): EventPublishBlocker[] => (r.success ? [] : ((r.error.details as { blockers?: EventPublishBlocker[] } | undefined)?.blockers ?? []));
const edgeKeys = (edges: Array<{ role: string; toKind: string; toId: string }>) => edges.map((e) => `${e.role}|${e.toKind}|${e.toId}`).sort();
const pin = (e: Versioned, label?: string): EntityPin => ({ entityId: e.entityId, entityVersionId: label ? e.v[label] : null });

async function versionedEntity(name: string, labels: string[]): Promise<Versioned> {
  const entity = await own.entity(name, [{ name: "id", type: "string" }]);
  modelNames.set(entity.id, name);
  const v: Record<string, string> = {};
  for (const [i, label] of labels.entries()) {
    const [major, minor] = label.split(".").map(Number);
    const row = await prisma.entityVersion.create({
      data: {
        entityId: entity.id, major, minor, sequence: i + 1, changeKind: i === 0 ? "INITIAL" : minor === 0 ? "MAJOR" : "MINOR", publishedById: ctx.userId,
        resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
      },
    });
    modelNames.set(row.id, name);
    v[label] = row.id;
  }
  return { entityId: entity.id, name, v };
}

function artifactFor(name: string, format: PayloadFormat): SchemaArtifact {
  return format === "avro"
    ? { format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } }
    : { format: "json-schema", dialect: "draft-07", schema: { type: "object", title: name, properties: { id: { type: "string" } } } };
}
const renderer: ArtifactRenderer = {
  async render(subject, format) {
    const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
    const name = modelNames.get(id);
    if (!name) return err({ code: "NOT_FOUND", message: `no stub for ${id}` });
    return ok({ artifact: artifactFor(name, format), warnings: [] });
  },
};
/** A renderer that runs `before` once, on its FIRST call: after the publish read its snapshot and before it takes any lock. */
function racingRenderer(before: () => Promise<unknown>): ArtifactRenderer {
  let fired = false;
  return {
    async render(subject, format) {
      if (!fired) {
        fired = true;
        await before();
      }
      return renderer.render(subject, format);
    },
  };
}
function countingRenderer() {
  const state = { calls: 0 };
  return { state, renderer: { render: (...args: Parameters<ArtifactRenderer["render"]>) => { state.calls += 1; return renderer.render(...args); } } satisfies ArtifactRenderer };
}

interface DocOptions { title?: string; description?: string; payload?: EntityPin; headers?: EntityPin; keyPin?: EntityPin; traitKeys?: string[]; traits?: EventDocument["traits"] }
/** A complete, valid v2 document: one Kafka/Avro channel, one message pinned to the published Order 1.0, one send operation. */
function orderDocument(o: DocOptions = {}): EventDocument {
  const message: DocMessage = {
    key: "order-created", contentType: "avro/binary", payload: o.payload ?? pin(order, "1.0"), traitKeys: o.traitKeys ?? [],
    ...(o.headers && { headers: o.headers }), ...(o.keyPin && { keyPin: o.keyPin }),
  };
  return {
    ...emptyEventDocument(o.title ?? "checkout-service", o.description),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["order-created"] }],
    messages: [message],
    traits: o.traits ?? [],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
  };
}

/**
 * `orderDocument` with its channel left on Auto (no explicit format): the message follows its payload entity's recorded source format
 * (`entity.metadata.sourceFormat`), so changing that format changes what is emitted without touching the document.
 */
function autoDocument(o: DocOptions = {}): EventDocument {
  const doc = orderDocument(o);
  return { ...doc, channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], messageKeys: ["order-created"] }] };
}
/** The representation an entity was imported in, straight into its metadata (what an import records; the draft event is not touched). */
const recordFormat = (e: Versioned, sourceFormat: string) => prisma.entity.update({ where: { id: e.entityId }, data: { metadata: { sourceFormat } } });
/** `compatReport.representations` of a stored version row. */
const storedRepresentations = (row: { compatReport: unknown }) => obj(row.compatReport).representations;

/** An event saved through the real service (pins, library traits and refs validated; draft edges written). */
async function draft(doc: EventDocument): Promise<string> {
  const event = unwrap(await createEvent(own.product.id, { name: `evt-${stamp()}` }, ctx));
  unwrap(await updateEventDocument(event.id, doc, owner, ctx));
  return event.id;
}
const save = async (eventId: string, doc: EventDocument) => unwrap(await updateEventDocument(eventId, doc, owner, ctx));
/** Straight into the table: a document `updateEventDocument` would refuse (a pin that went away, an unresolvable ref). */
const seedEvent = (doc: unknown) =>
  prisma.eventSpec.create({
    data: { name: `evt-${stamp()}`, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id, document: doc as Prisma.InputJsonValue },
  });
const publish = (eventId: string, input: PublishInput = {}, deps: EmitDeps = { renderer }) => publishEvent(eventId, own.product.id, input, ctx, deps);
const preview = async (eventId: string, deps: EmitDeps = { renderer }) => unwrap(await previewEventPublish(eventId, own.product.id, ctx, deps));
async function published(doc: EventDocument): Promise<string> {
  const id = await draft(doc);
  unwrap(await publish(id));
  return id;
}
const versionRows = (eventId: string) => prisma.eventSpecVersion.findMany({ where: { eventSpecId: eventId }, orderBy: { sequence: "asc" } });
const eventRow = (eventId: string) => prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } });

/**
 * Another product's event, published through the service itself: the `resolvedSpec` it stores is what other events reference. That
 * stored channel carries the source's own `serverRefs` and `messageRefs` (asserted here, so the tests below fail if that ever stops
 * being true and they would no longer prove anything).
 */
async function publishedSource() {
  const source = unwrap(await createEvent(other.product.id, { name: `source-${stamp()}` }, ctx));
  unwrap(await updateEventDocument(source.id, orderDocument({ title: "payments" }), { level: "PRODUCT", productId: other.product.id }, ctx));
  const version = unwrap(await publishEvent(source.id, other.product.id, {}, ctx, { renderer }));
  const [row] = await versionRows(source.id);
  const channel = (obj(row.resolvedSpec).channels as JsonObject[]).find((c) => c.id === "orders")!;
  expect(channel).toMatchObject({ serverRefs: ["kafka-prod"], messageRefs: ["order-created"] });
  return { version, row };
}

/** A domain-level library trait of the own domain (tenant level belongs to `ensureBundledTraits`); removed with the domain. */
async function libraryTrait(name: string, spec: object, extra: object = {}) {
  return prisma.trait.create({
    data: { name: `${name}-${stamp()}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id, spec: spec as Prisma.InputJsonValue, ...extra },
    select: { id: true, name: true },
  });
}
const withTrait = (traitId: string, o: DocOptions = {}) =>
  orderDocument({ ...o, traitKeys: ["lib"], traits: [{ key: "lib", kind: "MESSAGE", libraryTraitId: traitId }] });

/** `prisma` whose `delegate.method` rejects like a lost connection; everything else is the real client. */
function failing(delegate: string, method: string): ServiceContext {
  const broken = new Proxy(prisma, {
    get(target, prop) {
      if (prop === delegate) return { ...(Reflect.get(target, prop) as object), [method]: () => Promise.reject(new Error("connection lost: SECRET-HOST")) };
      return Reflect.get(target, prop) as unknown;
    },
  });
  return { ...ctx, prisma: broken };
}
function failingTransaction(): ServiceContext {
  const broken = new Proxy(prisma, {
    get(target, prop) {
      if (prop === "$transaction") return () => Promise.reject(new Error("connection lost: SECRET-HOST"));
      return Reflect.get(target, prop) as unknown;
    },
  });
  return { ...ctx, prisma: broken };
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  own = await createProductScope(prisma, ctx, "pb");
  other = await createProductScope(prisma, ctx, "px");
  owner = { level: "PRODUCT", productId: own.product.id };
  order = await versionedEntity("Order", ["1.0", "1.1", "2.0"]);
  orderKey = await versionedEntity("OrderKey", ["1.0"]);
  shipment = await versionedEntity("Shipment", ["1.0"]);
  ceHeaders = await versionedEntity("CloudEventsHeaders", ["1.0", "2.0"]);
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [own?.domain.id, other?.domain.id]);
  await prisma.$disconnect();
});

describe("publishEvent", () => {
  it("publishes 1.0 on first publish and stores document, sourceDocument, resolvedSpec and frozenTraits", async () => {
    const trait = await libraryTrait("CloudEvents", def("CloudEvents").spec);
    const id = await draft(withTrait(trait.id, { title: "checkout-service" }));

    const summary = unwrap(await publish(id, { changeSummary: "  first cut  " }));

    expect(summary).toMatchObject({ major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: "first cut" });
    const [row] = await versionRows(id);
    expect(row).toMatchObject({ major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId });
    expect(obj(row.document).asyncapi).toBe("3.0.0");
    expect(obj(obj(row.document).info).version).toBe("1.0");
    expect(obj(obj(obj(row.document).components).messageTraits)[trait.name]).toBeDefined(); // the library trait is in the assembled document
    const event = await eventRow(id);
    expect(row.sourceDocument).toEqual(event.document); // the v2 draft as saved: the input of the next classification
    const resolved = obj(row.resolvedSpec);
    expect(obj(resolved.info).version).toBe("1.0");
    expect((resolved.channels as JsonObject[]).map((c) => c.id)).toEqual(["orders"]);
    expect((resolved.messages as JsonObject[]).map((m) => m.id)).toEqual(["order-created"]);
    expect(row.frozenTraits).toEqual([
      expect.objectContaining({ id: trait.id, name: trait.name, kind: "MESSAGE", spec: def("CloudEvents").spec, headersEntityId: null, headersEntityVersionId: null }),
    ]);
    expect(event.latestVersionId).toBe(row.id);
    expect(event.hasUnpublishedChanges).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: id } })).toBe(1);
  }, 120_000);

  it("writes EVENT_SPEC_VERSION edges for the pins and keeps the draft edges", async () => {
    const doc = orderDocument({
      headers: pin(ceHeaders, "1.0"), keyPin: pin(orderKey, "1.0"),
      traitKeys: ["audit"], traits: [{ key: "audit", kind: "MESSAGE", spec: {}, headers: pin(shipment, "1.0") }],
    });
    const id = await draft(doc);
    const draftBefore = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: id } });

    unwrap(await publish(id));

    const [version] = await versionRows(id);
    const expected = edgeKeys(collectDocumentEdges(doc));
    expect(expected.length).toBeGreaterThanOrEqual(4);
    const frozen = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id } });
    expect(edgeKeys(frozen)).toEqual(expected);
    expect(frozen.every((e) => !e.isDraft)).toBe(true);
    const draftAfter = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: id } });
    expect(edgeKeys(draftAfter)).toEqual(expected);
    expect(draftAfter.every((e) => e.isDraft)).toBe(true);
    expect(edgeKeys(draftAfter)).toEqual(edgeKeys(draftBefore));
  }, 120_000);

  it("blocks publish for an unpinned pin and for a missing entity version, naming every pointer at once", async () => {
    modelNames.set("ghost-version", "CloudEventsHeaders"); // the stand-in renderer renders it; the facts must still catch it
    const event = await seedEvent(orderDocument({ payload: pin(order), headers: { entityId: ceHeaders.entityId, entityVersionId: "ghost-version" } }));

    const result = await publish(event.id);

    expect(failureCode(result)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(result)).toEqual([
      { kind: "UNPUBLISHED_PIN", pointer: "/messages/0/payload", message: "Order has no published version pinned" },
      { kind: "MISSING_ENTITY", pointer: "/messages/0/headers", message: expect.stringContaining("CloudEventsHeaders") },
    ]);
    expect(await versionRows(event.id)).toEqual([]);
    expect((await eventRow(event.id)).latestVersionId).toBeNull();
    // the preview shows the same blockers instead of failing
    expect((await preview(event.id)).blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_PIN", "MISSING_ENTITY"]);
  }, 120_000);

  it("treats a pinned version that belongs to another entity as missing", async () => {
    const event = await seedEvent(orderDocument({ payload: { entityId: order.entityId, entityVersionId: shipment.v["1.0"] } }));

    const result = await publish(event.id);

    expect(failureCode(result)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(result)).toEqual([{ kind: "MISSING_ENTITY", pointer: "/messages/0/payload", message: expect.stringContaining("Order") }]);
  }, 120_000);

  it("blocks with VALIDATION_ERROR when the emitted AsyncAPI has validator errors", async () => {
    const id = await draft(orderDocument());
    const rejecting: EventSpecValidator = {
      name: "stub",
      validate: async () => ok([
        diagnostic("error", "STUB_RULE", "The stub validator rejects this document", "/channels/orders"),
        diagnostic("warning", "STUB_WARNING", "only a warning", "/info"),
      ]),
    };

    const result = await publish(id, {}, { renderer, validators: [rejecting] });

    expect(failureCode(result)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(result)).toEqual([{ kind: "VALIDATION_ERROR", pointer: "/channels/orders", message: "The stub validator rejects this document" }]);
    expect(await versionRows(id)).toEqual([]);
  }, 120_000);

  it("returns the generic message under the same code when a validator itself fails, and logs the raw text server-side only", async () => {
    const id = await draft(orderDocument());
    const crashing: EventSpecValidator = {
      name: "crashing",
      validate: async () => err({ code: "PARSER_CRASHED", message: "SECRET-TOKEN at /tmp/superschema/connection.string" }),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const result of [await publish(id, {}, { renderer, validators: [crashing] }), await previewEventPublish(id, own.product.id, ctx, { renderer, validators: [crashing] })]) {
        expect(failureCode(result)).toBe("PARSER_CRASHED");
        expect(result.success ? "" : result.error.message).toBe(GENERIC_VALIDATION_FAILURE);
        expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN");
      }
      expect(logged.mock.calls.flat().join(" ")).toContain("SECRET-TOKEN"); // kept in the server log
    } finally {
      logged.mockRestore();
    }
    expect(await versionRows(id)).toEqual([]);
  }, 120_000);

  it("maps an unresolved reference to an UNRESOLVED_REFERENCE blocker at its pointer", async () => {
    const doc = orderDocument();
    doc.externalRefs = [{ key: "elsewhere", eventVersionId: "no-such-version", kind: "message", itemKey: "Anything" }];
    const event = await seedEvent(doc);

    const result = await publish(event.id);

    expect(failureCode(result)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(result)).toContainEqual({ kind: "UNRESOLVED_REFERENCE", pointer: "/externalRefs/0", message: expect.stringContaining("elsewhere") });
  }, 120_000);

  it("returns NO_CHANGES when nothing changed, and not after a library trait edit (drift counts as a change)", async () => {
    const trait = await libraryTrait("Drifting", { summary: "first summary" });
    const id = await published(withTrait(trait.id));

    const again = await publish(id);
    expect(failureCode(again)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(again)).toEqual([{ kind: "NO_CHANGES", message: "No unpublished changes since v1.0." }]);
    expect((await preview(id)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);

    await prisma.trait.update({ where: { id: trait.id }, data: { spec: { summary: "second summary" } } });

    const analysis = await preview(id);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.suggestedBump).toBe("MINOR");
    const summary = unwrap(await publish(id));
    expect(summary).toMatchObject({ label: "1.1", changeKind: "MINOR", sequence: 2 });
    // and once published, the edit is no longer pending
    expect(blockersOf(await publish(id)).map((b) => b.kind)).toEqual(["NO_CHANGES"]);
  }, 180_000);

  it("stores the effective representation of every message with the version", async () => {
    const id = await published(orderDocument()); // the channel names Avro explicitly

    const [row] = await versionRows(id);

    expect(obj(row.compatReport)).toMatchObject({ reasons: expect.any(Array), diagnostics: expect.any(Array), representations: { "order-created": "avro" } });
  }, 120_000);

  it("treats a change of an entity's recorded source format as a change: MAJOR, stored, and quiet again once published", async () => {
    const formatted = await versionedEntity("Formatted", ["1.0"]);
    await recordFormat(formatted, "avro");
    const id = await published(autoDocument({ payload: pin(formatted, "1.0") }));
    const [first] = await versionRows(id);
    expect(storedRepresentations(first)).toEqual({ "order-created": "avro" });
    expect((await preview(id)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]); // the draft is unchanged and so is the format

    await recordFormat(formatted, "json-schema"); // only the entity's recorded format moves: the draft document is untouched
    expect((await eventRow(id)).document).toEqual(first.sourceDocument);

    const analysis = await preview(id);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.suggestedBump).toBe("MAJOR");
    expect(analysis.reasons).toEqual(['Message "order-created": representation Avro → JSON Schema']);

    expect(unwrap(await publish(id))).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 2 });
    const versions = await versionRows(id);
    expect(storedRepresentations(versions[1])).toEqual({ "order-created": "json-schema" });
    expect(versions[1].compatReport).toMatchObject({ reasons: ['Message "order-created": representation Avro → JSON Schema'] });
    // the new version is the baseline now
    expect(blockersOf(await publish(id)).map((b) => b.kind)).toEqual(["NO_CHANGES"]);
    expect((await preview(id)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);
  }, 180_000);

  it("a version published before representations were stored behaves as before: no false change and no false MAJOR", async () => {
    const formatted = await versionedEntity("LegacyFormatted", ["1.0"]);
    await recordFormat(formatted, "avro");
    const doc = autoDocument({ payload: pin(formatted, "1.0") });
    // the ways a stored value can be unusable: absent (the `{}` default), or not a map of known formats — never an error, never a change
    const legacy: unknown[] = [{}, { reasons: [], diagnostics: [] }, { representations: "garbage" }, { representations: { "order-created": "bogus" } }, { representations: [] }];
    for (const compatReport of legacy) {
      const event = await seedEvent(doc);
      const row = await createEventSpecVersion(prisma, {
        eventSpecId: event.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId, document: { asyncapi: "3.0.0" },
        sourceDocument: JSON.parse(JSON.stringify(doc)) as Prisma.InputJsonValue, frozenTraits: [], compatReport: compatReport as Prisma.InputJsonValue,
      });
      await prisma.eventSpec.update({ where: { id: event.id }, data: { latestVersionId: row.id, hasUnpublishedChanges: false } });

      expect((await preview(event.id)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);
      await recordFormat(formatted, "json-schema"); // nothing stored to compare with: exactly as before this existed
      expect((await preview(event.id)).blockers.map((b) => b.kind)).toEqual(["NO_CHANGES"]);

      // a real edit is classified without a phantom representation change
      await save(event.id, autoDocument({ payload: pin(formatted, "1.0"), description: "now with a description" }));
      const analysis = await preview(event.id);
      expect(analysis.blockers).toEqual([]);
      expect(analysis.suggestedBump).toBe("MINOR");
      expect(analysis.reasons.join("\n")).not.toContain("representation");
      await recordFormat(formatted, "avro");
    }
  }, 240_000);

  it("keeps the frozen library trait copy until the next publish", async () => {
    const trait = await libraryTrait("Frozen", { summary: "first summary" });
    const doc = withTrait(trait.id);
    const id = await published(doc);

    await prisma.trait.update({ where: { id: trait.id }, data: { spec: { summary: "second summary" } } });

    const [v10] = await versionRows(id);
    expect(obj((v10.frozenTraits as JsonObject[])[0].spec).summary).toBe("first summary");
    const stored = unwrap(await emitEventStoredVersion(id, own.product.id, "1.0", ctx));
    expect(obj(obj(obj(stored.document).components).messageTraits)[trait.name]).toMatchObject({ summary: "first summary" });

    // the draft stops using the trait, but version 1.0 froze it: deleting it stays blocked
    await save(id, orderDocument());
    const blocked = await deleteTrait(trait.id, { level: "DOMAIN", domainId: own.domain.id }, ctx);
    expect(failureCode(blocked)).toBe("IN_USE");
    expect(await prisma.trait.count({ where: { id: trait.id } })).toBe(1);

    // the next publish freezes the live copy; version 1.0 keeps the old one
    await save(id, doc);
    const next = unwrap(await publish(id));
    expect(next.label).toBe("1.1");
    const rows = await versionRows(id);
    expect(obj((rows[0].frozenTraits as JsonObject[])[0].spec).summary).toBe("first summary");
    expect(obj((rows[1].frozenTraits as JsonObject[])[0].spec).summary).toBe("second summary");
    expect(obj(obj(obj(rows[1].document).components).messageTraits)[trait.name]).toMatchObject({ summary: "second summary" });
  }, 180_000);

  it("classifies a library trait whose headers pin moved to a new major as MAJOR", async () => {
    const trait = await libraryTrait("Enveloped", { summary: "envelope headers" }, { headersEntityId: ceHeaders.entityId, headersEntityVersionId: ceHeaders.v["1.0"] });
    const id = await published(withTrait(trait.id));

    await prisma.trait.update({ where: { id: trait.id }, data: { headersEntityVersionId: ceHeaders.v["2.0"] } });

    const analysis = await preview(id);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.suggestedBump).toBe("MAJOR");
    expect(analysis.reasons.join(" ")).toContain("headers pin moved");
    expect(unwrap(await publish(id))).toMatchObject({ label: "2.0", changeKind: "MAJOR" });
    const [v10, v20] = await versionRows(id);
    expect(v10.frozenTraits).toEqual([expect.objectContaining({ headersEntityVersionId: ceHeaders.v["1.0"] })]);
    expect(v20.frozenTraits).toEqual([expect.objectContaining({ headersEntityVersionId: ceHeaders.v["2.0"] })]);
  }, 180_000);

  it("blocks publish for a library trait whose message properties entity is not pinned to a published version", async () => {
    // reachable: `resolvePin` accepts `entityVersionId: null`, and stores null when the entity has no published version yet
    const pinned = await libraryTrait("PinnedProps", { summary: "pinned" }, { headersEntityId: ceHeaders.entityId, headersEntityVersionId: ceHeaders.v["1.0"] });
    const unpinned = await libraryTrait("UnpinnedProps", { summary: "unpinned" }, { headersEntityId: ceHeaders.entityId, headersEntityVersionId: null });
    const id = await draft(orderDocument({
      traitKeys: ["good", "loose"],
      traits: [
        { key: "good", kind: "MESSAGE", libraryTraitId: pinned.id },
        { key: "loose", kind: "MESSAGE", libraryTraitId: unpinned.id },
      ],
    }));

    const result = await publish(id);

    // without the blocker the version would freeze headers rendered from the entity's mutable draft
    expect(failureCode(result)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(result)).toEqual([
      { kind: "UNPUBLISHED_PIN", pointer: "/traits/1", message: `Library trait "${unpinned.name}": CloudEventsHeaders has no published version pinned` },
    ]);
    expect((await preview(id)).blockers.map((b) => [b.kind, b.pointer])).toEqual([["UNPUBLISHED_PIN", "/traits/1"]]);
    expect(await versionRows(id)).toEqual([]);

    // once the library trait pins a published version, the same draft publishes
    await prisma.trait.update({ where: { id: unpinned.id }, data: { headersEntityVersionId: ceHeaders.v["1.0"] } });
    expect(unwrap(await publish(id)).label).toBe("1.0");
  }, 120_000);

  it("classifies bumps: payload pin to a new entity major -> 2.0; same-major pin move -> 1.1; docs-only edit -> 1.1", async () => {
    const toNewMajor = await published(orderDocument());
    await save(toNewMajor, orderDocument({ payload: pin(order, "2.0") }));
    expect(await preview(toNewMajor)).toMatchObject({ suggestedBump: "MAJOR", latestLabel: "1.0", candidateLabels: { MAJOR: "2.0", MINOR: "1.1" } });
    expect(unwrap(await publish(toNewMajor))).toMatchObject({ label: "2.0", changeKind: "MAJOR" });

    const sameMajor = await published(orderDocument());
    await save(sameMajor, orderDocument({ payload: pin(order, "1.1") }));
    expect((await preview(sameMajor)).suggestedBump).toBe("MINOR");
    expect(unwrap(await publish(sameMajor))).toMatchObject({ label: "1.1", changeKind: "MINOR" });

    const docsOnly = await published(orderDocument());
    await save(docsOnly, orderDocument({ description: "Emitted when an order is placed" }));
    const analysis = await preview(docsOnly);
    expect(analysis.suggestedBump).toBe("MINOR");
    expect(analysis.reasons).toContain("Info changed");
    const summary = unwrap(await publish(docsOnly));
    expect(summary).toMatchObject({ label: "1.1", changeKind: "MINOR", sequence: 2 });
    const rows = await versionRows(docsOnly);
    expect(obj(rows[1].compatReport).reasons).toEqual(["Info changed"]);
  }, 240_000);

  it("lets the user raise the bump to MAJOR but returns BUMP_TOO_LOW when lowering", async () => {
    const raised = await published(orderDocument());
    await save(raised, orderDocument({ description: "docs only" }));
    expect(unwrap(await publish(raised, { bump: "MAJOR" }))).toMatchObject({ label: "2.0", changeKind: "MAJOR" });

    const breaking = await published(orderDocument());
    await save(breaking, orderDocument({ payload: pin(order, "2.0") }));
    const lowered = await publish(breaking, { bump: "MINOR" });
    expect(failureCode(lowered)).toBe("BUMP_TOO_LOW");
    expect(await versionRows(breaking)).toHaveLength(1); // only 1.0
    expect(unwrap(await publish(breaking, { bump: "MAJOR" })).label).toBe("2.0");
  }, 240_000);

  it("rejects a malformed publish input before reading anything", async () => {
    const id = await draft(orderDocument());
    expect(failureCode(await publish(id, { bump: "PATCH" } as unknown as PublishInput))).toBe("VALIDATION_ERROR");
    expect(failureCode(await publish(id, { changeSummary: 5 } as unknown as PublishInput))).toBe("VALIDATION_ERROR");
    expect(await versionRows(id)).toEqual([]);
    // null / blank are fine: a blank summary is stored as no summary
    expect(unwrap(await publish(id, { changeSummary: "   " })).changeSummary).toBeNull();
  }, 120_000);

  it("rejects a change summary over 500 characters before reading anything, and accepts exactly 500", async () => {
    const id = await draft(orderDocument());
    // A context whose database fails on ANY access: a rejection that came after a read would surface as DB_ERROR, not VALIDATION_ERROR.
    const untouchable = { ...ctx, prisma: new Proxy({}, { get: () => { throw new Error("the publish read the database"); } }) as unknown as PrismaClient };
    const tooLong = "x".repeat(MAX_CHANGE_SUMMARY + 1);
    for (const changeSummary of [tooLong, `  ${tooLong}  `]) {
      const rejected = await publishEvent(id, own.product.id, { changeSummary }, untouchable, { renderer });
      expect(failureCode(rejected)).toBe("VALIDATION_ERROR");
      expect(rejected.success ? "" : rejected.error.message).toBe(`Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`);
    }
    expect(await versionRows(id)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: "PUBLISH_VERSION", entityType: "EventSpec", entityId: id } })).toBe(0);
    // The cap is on the trimmed text: exactly 500 characters (even padded with blanks) publishes and is stored trimmed.
    const exact = "y".repeat(MAX_CHANGE_SUMMARY);
    expect(unwrap(await publish(id, { changeSummary: `  ${exact}  ` })).changeSummary).toBe(exact);
    expect((await versionRows(id))[0].changeSummary).toBe(exact);
  }, 120_000);

  it("publishes an event that receives a message through an external ref and freezes it in resolvedSpec", async () => {
    const { version: sourceVersion, row: sourceRow } = await publishedSource();
    const sourceMessage = ((obj(sourceRow.resolvedSpec).messages as JsonObject[]).find((m) => m.id === "order-created"))!;

    const doc: EventDocument = {
      ...emptyEventDocument("fraud-scorer"),
      servers: [{ key: "kafka-in", protocol: "kafka", host: "kafka-in.internal:9092" }],
      channels: [{ key: "inbox", address: "fraud.inbox.v1", protocol: "kafka", serverKeys: ["kafka-in"], format: "avro", messageKeys: ["payment-received"] }],
      externalRefs: [{ key: "payment-received", eventVersionId: sourceVersion.id, kind: "message", itemKey: "order-created" }],
      operations: [{ key: "consumePayment", action: "receive", channelKey: "inbox", messageKeys: ["payment-received"], traitKeys: [] }],
    };
    const id = await draft(doc);
    const counted = countingRenderer();

    const summary = unwrap(await publish(id, {}, { renderer: counted.renderer }));

    expect(summary.label).toBe("1.0");
    expect(counted.state.calls).toBe(0); // the external message comes from the stored resolvedSpec: nothing is re-rendered
    const [row] = await versionRows(id);
    const message = (obj(row.resolvedSpec).messages as JsonObject[]).find((m) => m.id === "payment-received");
    expect(message?.payloads).toEqual(sourceMessage.payloads); // a frozen copy of what the referenced version carried
    // the assembler files an external message under its own name
    expect(obj(obj(obj(row.document).components).messages)["order-created"]).toBeDefined();
    const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: row.id } });
    expect(edgeKeys(edges)).toEqual([`MESSAGE|EVENT_SPEC_VERSION|${sourceVersion.id}`]);
  }, 120_000);

  it("publishes an event that sends its own message on an external channel, without the source's servers or messages", async () => {
    const { version: sourceVersion } = await publishedSource();
    const doc: EventDocument = {
      ...emptyEventDocument("fraud-feed"),
      externalRefs: [{ key: "orders-ch", eventVersionId: sourceVersion.id, kind: "channel", itemKey: "orders" }],
      messages: [{ key: "fraud-alert", payload: pin(order, "1.0"), traitKeys: [] }], // a LOCAL message, not one of the source's
      operations: [{ key: "publishFraudAlert", action: "send", channelKey: "orders-ch", messageKeys: ["fraud-alert"], traitKeys: [] }],
    };
    const id = await draft(doc);

    expect(await preview(id)).toMatchObject({ blockers: [] }); // 0 errors from the emission, both validators included
    const summary = unwrap(await publish(id));

    expect(summary.label).toBe("1.0");
    const [row] = await versionRows(id);
    // the stored channel is the channel itself: no id of the source's servers or messages travels with it
    const channel = (obj(row.resolvedSpec).channels as JsonObject[]).find((c) => c.id === "orders-ch")!;
    expect(channel).toMatchObject({ address: "payments.orders.v1", protocol: "kafka" });
    for (const field of ["serverRefs", "messageRefs", "messageProfiles"]) expect(channel).not.toHaveProperty(field);
    // in the emitted document the channel carries exactly what this event's operation put on it
    const emitted = Object.values(obj(obj(row.document).channels)).map(obj);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ address: "payments.orders.v1" });
    expect(emitted[0]).not.toHaveProperty("servers");
    expect(Object.keys(obj(emitted[0].messages))).toHaveLength(1);
    expect(obj(obj(row.document).components).messages).toHaveProperty("fraud-alert");
    expect(obj(obj(row.document).components).messages).not.toHaveProperty("order-created");
    const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: row.id } });
    expect(edgeKeys(edges)).toEqual([`MESSAGE|EVENT_SPEC_VERSION|${sourceVersion.id}`, `PAYLOAD|ENTITY_VERSION|${order.v["1.0"]}`].sort());
  }, 120_000);

  it("publishes an event that receives an external message on the external channel of the same published version", async () => {
    const { version: sourceVersion, row: sourceRow } = await publishedSource();
    const sourceMessage = ((obj(sourceRow.resolvedSpec).messages as JsonObject[]).find((m) => m.id === "order-created"))!;
    const doc: EventDocument = {
      ...emptyEventDocument("order-consumer"),
      externalRefs: [
        { key: "orders-ch", eventVersionId: sourceVersion.id, kind: "channel", itemKey: "orders" },
        { key: "order-msg", eventVersionId: sourceVersion.id, kind: "message", itemKey: "order-created" },
      ],
      operations: [{ key: "consumeOrder", action: "receive", channelKey: "orders-ch", messageKeys: ["order-msg"], traitKeys: [] }],
    };
    const id = await draft(doc);
    const counted = countingRenderer();

    expect(await preview(id, { renderer: counted.renderer })).toMatchObject({ blockers: [] });
    const summary = unwrap(await publish(id, {}, { renderer: counted.renderer }));

    expect(summary.label).toBe("1.0");
    expect(counted.state.calls).toBe(0); // nothing local to render: both items come from the stored resolvedSpec
    const [row] = await versionRows(id);
    const resolved = obj(row.resolvedSpec);
    expect((resolved.messages as JsonObject[]).find((m) => m.id === "order-msg")?.payloads).toEqual(sourceMessage.payloads);
    expect((resolved.channels as JsonObject[]).find((c) => c.id === "orders-ch")).not.toHaveProperty("messageRefs");
    const emitted = Object.values(obj(obj(row.document).channels)).map(obj);
    expect(emitted).toHaveLength(1);
    expect(Object.keys(obj(emitted[0].messages))).toHaveLength(1);
    const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: row.id } });
    expect(edgeKeys(edges)).toEqual([`MESSAGE|EVENT_SPEC_VERSION|${sourceVersion.id}`]); // both refs point at one version: one edge
  }, 120_000);

  it("returns CONFLICT when the draft changes between prepare and the write", async () => {
    const id = await draft(orderDocument());
    const changed = orderDocument({ title: "changed-while-publishing" });
    // the first render happens after the snapshot is read and before the lock: the re-verification must notice the new draft
    const racing = racingRenderer(() => prisma.eventSpec.update({ where: { id }, data: { document: changed as unknown as Prisma.InputJsonValue } }));

    const result = await publish(id, {}, { renderer: racing });

    expect(failureCode(result)).toBe("CONFLICT");
    expect(result.success ? "" : result.error.message).toBe("The event changed while publishing.");
    expect(result.success ? "" : result.error.suggestedFix).toBe("Reload the event and publish again.");
    expect(await versionRows(id)).toEqual([]);
    expect((await eventRow(id)).latestVersionId).toBeNull();
    // retrying publishes what is saved now
    unwrap(await publish(id));
    const [row] = await versionRows(id);
    expect(obj(row.sourceDocument).info).toMatchObject({ title: "changed-while-publishing" });
  }, 120_000);

  it("returns CONFLICT when a pinned entity changes between prepare and the write", async () => {
    const entity = await versionedEntity("Moving", ["1.0"]);
    const id = await draft(orderDocument({ payload: pin(entity, "1.0") }));
    const racing = racingRenderer(() => prisma.entity.update({ where: { id: entity.entityId }, data: { name: `Moved-${stamp()}` } }));

    const result = await publish(id, {}, { renderer: racing });

    expect(failureCode(result)).toBe("CONFLICT");
    expect(await versionRows(id)).toEqual([]);
    unwrap(await publish(id));
    expect(await versionRows(id)).toHaveLength(1);
  }, 120_000);

  it("returns CONFLICT when a pinned entity is deleted between prepare and the write, and the retry names the blocker", async () => {
    const entity = await versionedEntity("Vanishing", ["1.0"]);
    const id = await draft(orderDocument({ payload: pin(entity, "1.0") }));
    const racing = racingRenderer(() => prisma.entity.delete({ where: { id: entity.entityId } })); // its versions go with it

    const result = await publish(id, {}, { renderer: racing });

    expect(failureCode(result)).toBe("CONFLICT");
    expect(await versionRows(id)).toEqual([]);
    const retry = await publish(id);
    expect(failureCode(retry)).toBe("PUBLISH_BLOCKED");
    expect(blockersOf(retry).map((b) => [b.kind, b.pointer])).toEqual([["MISSING_ENTITY", "/messages/0/payload"]]);
  }, 120_000);

  it("serializes a concurrent save and publish: published edges match the published document, draft edges match the saved one", async () => {
    for (let round = 0; round < 3; round += 1) {
      const original = orderDocument({ headers: pin(ceHeaders, "1.0") });
      const saved = orderDocument({ payload: pin(order, "1.1"), keyPin: pin(orderKey, "1.0") });
      const id = await draft(original);

      const [saveResult, firstPublish] = await Promise.all([updateEventDocument(id, saved, owner, ctx), publish(id)]);

      expect(saveResult.success).toBe(true);
      if (!firstPublish.success) {
        expect(firstPublish.error.code).toBe("CONFLICT"); // the publish read the old draft, the save won the lock
        expect(await versionRows(id)).toEqual([]);
        // "Reload the event and publish again": the retry publishes exactly what was saved
        expect((await publish(id)).success).toBe(true);
      }

      const event = await eventRow(id);
      const draftDoc = unwrap(parseEventDocument(event.document));
      const draftEdges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: id } });
      expect(edgeKeys(draftEdges)).toEqual(edgeKeys(collectDocumentEdges(draftDoc)));
      expect(draftDoc.messages[0].payload.entityVersionId).toBe(order.v["1.1"]); // the save is never lost

      const versions = await versionRows(id);
      expect(versions).toHaveLength(1);
      const publishedDoc = unwrap(parseEventDocument(versions[0].sourceDocument));
      expect([original, saved].some((d) => isDeepStrictEqual(unwrap(parseEventDocument(JSON.parse(JSON.stringify(d)))), publishedDoc))).toBe(true);
      const versionEdges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: versions[0].id } });
      expect(edgeKeys(versionEdges)).toEqual(edgeKeys(collectDocumentEdges(publishedDoc)));
      // a publish of the saved draft leaves no unpublished changes; a save that landed after the publish leaves some
      expect(event.hasUnpublishedChanges).toBe(!isDeepStrictEqual(publishedDoc, draftDoc));
    }
  }, 300_000);

  it("two concurrent publishes of the same draft write exactly one version; the other gets CONFLICT or NO_CHANGES, never a second", async () => {
    for (let round = 0; round < 3; round += 1) {
      const doc = orderDocument({ headers: pin(ceHeaders, "1.0") });
      const id = await draft(doc);

      const results = await Promise.all([publish(id), publish(id)]);

      const wins = results.filter((r) => r.success);
      const losses = results.filter((r) => !r.success);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      const loser = losses[0];
      const noChanges = failureCode(loser) === "PUBLISH_BLOCKED" && blockersOf(loser).map((b) => b.kind).join() === "NO_CHANGES";
      expect(failureCode(loser) === "CONFLICT" || noChanges).toBe(true); // the second one either lost the lock race or saw 1.0 already published
      const versions = await versionRows(id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ major: 1, minor: 0, sequence: 1 });
      const event = await eventRow(id);
      expect(event.latestVersionId).toBe(versions[0].id);
      expect(event.hasUnpublishedChanges).toBe(false);
      const edges = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: versions[0].id } });
      expect(edgeKeys(edges)).toEqual(edgeKeys(collectDocumentEdges(doc)));
    }
  }, 300_000);

  it("rejects another product's event (FORBIDDEN) and an unknown event (NOT_FOUND) without leaking its name", async () => {
    const foreign = await prisma.eventSpec.create({
      data: { name: `secret-${other.s}`, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id, document: orderDocument() as unknown as Prisma.InputJsonValue },
    });

    for (const result of [
      await publish(foreign.id),
      await previewEventPublish(foreign.id, own.product.id, ctx, { renderer }),
      await listEventVersions(foreign.id, own.product.id, ctx),
    ]) {
      expect(failureCode(result)).toBe("FORBIDDEN");
      expect(JSON.stringify(result)).not.toContain(`secret-${other.s}`);
      expect(result.success ? undefined : result.error.details).toBeUndefined();
    }
    expect(await versionRows(foreign.id)).toEqual([]);

    expect(failureCode(await publish("no-such-event"))).toBe("NOT_FOUND");
    expect(failureCode(await previewEventPublish("no-such-event", own.product.id, ctx, { renderer }))).toBe("NOT_FOUND");
    expect(failureCode(await listEventVersions("no-such-event", own.product.id, ctx))).toBe("NOT_FOUND");
    expect(failureCode(await publishEvent(foreign.id, "no-such-product", {}, ctx, { renderer }))).toBe("NOT_FOUND");
    expect(failureCode(await publishEvent("", own.product.id, {}, ctx, { renderer }))).toBe("VALIDATION_ERROR");
  }, 120_000);

  it("maps an unexpected database failure to DB_ERROR", async () => {
    const id = await draft(orderDocument());
    const silenced = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const results = [
        await publishEvent(id, own.product.id, {}, failing("eventSpec", "findUnique"), { renderer }), // before anything is read
        await publishEvent(id, own.product.id, {}, failingTransaction(), { renderer }), // the write itself
        await previewEventPublish(id, own.product.id, failing("entityVersion", "findMany"), { renderer }), // while gathering facts
        await listEventVersions(id, own.product.id, failing("eventSpecVersion", "findMany")),
      ];
      for (const result of results) {
        expect(failureCode(result)).toBe("DB_ERROR");
        expect(JSON.stringify(result)).not.toContain("SECRET-HOST");
      }
    } finally {
      silenced.mockRestore();
    }
    expect(await versionRows(id)).toEqual([]);
  }, 120_000);

  it("returns DATA_CORRUPT instead of guessing when the latest version's stored source document or frozen traits are garbage", async () => {
    const seed = async (version: { sourceDocument: unknown; frozenTraits: unknown }) => {
      const event = await seedEvent(orderDocument());
      const row = await createEventSpecVersion(prisma, {
        eventSpecId: event.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId, document: { asyncapi: "3.0.0" },
        sourceDocument: version.sourceDocument as Prisma.InputJsonValue, frozenTraits: version.frozenTraits as Prisma.InputJsonValue,
      });
      await prisma.eventSpec.update({ where: { id: event.id }, data: { latestVersionId: row.id, hasUnpublishedChanges: false } });
      return event.id;
    };
    const validSource = JSON.parse(JSON.stringify(orderDocument())) as unknown;
    const cases = [
      await seed({ sourceDocument: {}, frozenTraits: [] }), // not a v2 document (the shape the old fixtures left behind)
      await seed({ sourceDocument: validSource, frozenTraits: "garbage" }),
      await seed({ sourceDocument: validSource, frozenTraits: [{ id: 5 }] }),
      await seed({ sourceDocument: validSource, frozenTraits: [{ id: "t", name: "T", kind: "MESSAGE", ownerSlug: "s", spec: "not-an-object", headersEntityId: null, headersEntityVersionId: null }] }),
    ];
    for (const id of cases) {
      expect(failureCode(await previewEventPublish(id, own.product.id, ctx, { renderer }))).toBe("DATA_CORRUPT");
      expect(failureCode(await publish(id))).toBe("DATA_CORRUPT");
      expect(await versionRows(id)).toHaveLength(1); // only the seeded one
    }
  }, 120_000);
});

describe("listEventVersions", () => {
  it("lists versions newest first", async () => {
    const id = await published(orderDocument());
    await save(id, orderDocument({ description: "second" }));
    unwrap(await publish(id));
    await save(id, orderDocument({ payload: pin(order, "2.0") }));
    unwrap(await publish(id));

    const list = unwrap(await listEventVersions(id, own.product.id, ctx));

    expect(list.map((v) => [v.label, v.sequence, v.changeKind])).toEqual([["2.0", 3, "MAJOR"], ["1.1", 2, "MINOR"], ["1.0", 1, "INITIAL"]]);
    expect(list[0]).toMatchObject({ publishedAt: expect.any(String), changeSummary: null });
    expect(unwrap(await listEventVersions((await draft(orderDocument())), own.product.id, ctx))).toEqual([]);
  }, 240_000);
});

describe("previewEventPublish", () => {
  it("writes nothing (no version, no audit row, event row unchanged)", async () => {
    const id = await draft(orderDocument());
    const before = await eventRow(id);
    const auditBefore = await prisma.auditLog.count({ where: { entityType: "EventSpec", entityId: id } });
    const refsBefore = await prisma.schemaReference.count({ where: { fromId: id } });

    const analysis = unwrap(await previewEventPublish(id, own.product.id, ctx, { renderer }));

    expect(analysis).toMatchObject({ isFirstPublish: true, latestLabel: null, initialLabel: "1.0", blockers: [] });
    const after = await eventRow(id);
    expect(after.document).toEqual(before.document);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.hasUnpublishedChanges).toBe(before.hasUnpublishedChanges);
    expect(after.latestVersionId).toBeNull();
    expect(await versionRows(id)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { entityType: "EventSpec", entityId: id } })).toBe(auditBefore);
    expect(await prisma.schemaReference.count({ where: { fromId: id } })).toBe(refsBefore);
  }, 120_000);
});
