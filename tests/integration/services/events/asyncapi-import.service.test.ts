import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Parser } from "@asyncapi/parser";
import type { PrismaClient } from "@/generated/prisma/client";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { err, ok, type Result } from "@/types/result";
import type { PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { BUNDLED_TRAITS, bundledMarker } from "@/lib/events/bundled-traits";
import { parseEventDocument } from "@/lib/events/document/parse";
import { isLibraryTrait, type EventDocument } from "@/lib/events/document/types";
import { extractPayloads, mapAsyncApiToEventDocument, pascalName } from "@/lib/events/import";
import type { ImportWarning } from "@/lib/events/import";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import { importAsyncApi, previewAsyncApiImport } from "@/services/events/asyncapi-import.service";
import { deleteEntity } from "@/services/entity.service";
import { publishEntity } from "@/services/entity-version.service";
import { createEvent, getEvent, updateEventDocument, deleteEvent } from "@/services/events/event.service";
import { publishEvent } from "@/services/events/event-publish.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

// Each of these is the real function; a test makes ONE call fail by queueing a result (`mockResolvedValueOnce`) in front of it.
vi.mock("@/services/events/event.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/events/event.service")>();
  return { ...original, createEvent: vi.fn(original.createEvent), updateEventDocument: vi.fn(original.updateEventDocument), deleteEvent: vi.fn(original.deleteEvent) };
});
vi.mock("@/services/entity.service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/entity.service")>();
  return { ...original, deleteEntity: vi.fn(original.deleteEntity) };
});
vi.mock("@/lib/events/import", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/events/import")>();
  return { ...original, extractPayloads: vi.fn(original.extractPayloads), mapAsyncApiToEventDocument: vi.fn(original.mapAsyncApiToEventDocument) };
});
// The importers are the real ones; the spies count whether (and how often) they run.
vi.mock("@/lib/importers/jsonschema.importer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/importers/jsonschema.importer")>();
  return { ...original, parseJsonSchemaDocument: vi.fn(original.parseJsonSchemaDocument) };
});
vi.mock("@/lib/importers/avro.importer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/importers/avro.importer")>();
  return { ...original, parseAvroDocument: vi.fn(original.parseAvroDocument) };
});
vi.mock("@/lib/importers/protobuf.importer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/importers/protobuf.importer")>();
  return { ...original, parseProtobufDocument: vi.fn(original.parseProtobufDocument) };
});

/**
 * The AsyncAPI importer end to end (WP-I2) against the real database, the real parser, importers, mapper and event services. The
 * only stand-in is the artifact renderer of the final publish test (no TypeSpec compile of the event's entities there).
 */
const prisma = connectTestDb();
const domainIds: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  await cleanupDomains(prisma, domainIds);
  await prisma.$disconnect();
});

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "asyncapi-import");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const POSITIVE_FIXTURES = readdirSync(FIXTURES).filter((name) => !name.startsWith("negative-")).sort();

async function setup(label = "imp") {
  const ctx = await testContext(prisma);
  const scope = await createProductScope(prisma, ctx, label);
  domainIds.push(scope.domain.id);
  return { ctx, scope, s: scope.s, productId: scope.product.id, owner: { level: "PRODUCT" as const, productId: scope.product.id } };
}

/** What exists in the product: the number of entities and of events. */
const inventory = async (productId: string) => ({
  entities: await prisma.entity.count({ where: { productId } }),
  events: await prisma.eventSpec.count({ where: { productId } }),
});
const entitiesOf = (productId: string) => prisma.entity.findMany({ where: { productId }, include: { fields: { orderBy: { sortOrder: "asc" } } }, orderBy: { name: "asc" } });
const failure = <T>(r: Result<T>) => (r.success ? null : r.error);
const codeOf = (r: Result<unknown>) => failure(r)?.code ?? null;
const warningCodes = (warnings: ImportWarning[]) => warnings.map((w) => w.code);
const storedDocument = async (eventId: string): Promise<EventDocument> => {
  const row = await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } });
  return unwrap(parseEventDocument(row.document));
};

/** A tiny valid AsyncAPI 3.0 document with the given inline messages on one channel. */
function smallDocument(title: string, messages: Record<string, unknown>): string {
  const refs = Object.fromEntries(Object.keys(messages).map((key) => [key, { $ref: `#/components/messages/${key}` }]));
  return JSON.stringify({
    asyncapi: "3.0.0", info: { title, version: "1.0.0" },
    servers: { broker: { host: "broker.example.com:9092", protocol: "kafka" } },
    channels: { events: { address: "events.v1", messages: refs } },
    operations: { receiveEvents: { action: "receive", channel: { $ref: "#/channels/events" }, messages: Object.keys(messages).map((key) => ({ $ref: `#/channels/events/messages/${key}` })) } },
    components: { messages },
  });
}
const objectPayload = (...properties: string[]) => ({ type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])) });

/**
 * A fixture whose message names carry the stamp, so no asset of the tenant (a tenant-level entity, another test's leftovers) can already
 * hold a name the import will want: the final names are `<Name><stamp>` and a test may assert them, and `renamed: false`, exactly.
 */
const stampedFixture = (name: string, s: string, words: string[]) => words.reduce((text, word) => text.replace(new RegExp(`\\b${word}\\b`, "g"), `${word}${s}`), fixture(name));
function lights(s: string) {
  const content = stampedFixture("streetlights-kafka.yaml", s, ["lightMeasured", "turnOnOff", "dimLight"]).replace("title: Streetlights Kafka API", `title: Streetlights Kafka API ${s}`);
  return { content, light: `LightMeasured${s}`, onOff: `TurnOnOff${s}`, dim: `DimLight${s}`, event: `Streetlights-Kafka-API-${s}` };
}
/** The preview's entity as the file asked for it, whatever it finally got called. */
const requested = (preview: { entities: Array<{ requestedName: string; name: string }> }) => new Map(preview.entities.map((e) => [e.requestedName, e]));
/** The built-in traits fixture with the stamp in its message titles (the entity names come from them); `orderCreatedName` is what the first one is called. */
const orders = (s: string) => ["Order created", "Order shipped", "Order cancelled"].reduce((text, title) => text.replace(`title: ${title}`, `title: ${title} ${s}`), fixture("builtin-traits.yaml"));
const orderCreatedName = (s: string) => pascalName(`Order created ${s}`);
const importerCalls = () => ({
  json: vi.mocked(parseJsonSchemaDocument).mock.calls.length, avro: vi.mocked(parseAvroDocument).mock.calls.length, protobuf: vi.mocked(parseProtobufDocument).mock.calls.length,
});

describe("importAsyncApi: the happy path", () => {
  it("streetlights-kafka: draft entities (unpublished, sourceFormat, fields) and an event that pins them without a version", async () => {
    const { ctx, s, productId } = await setup();
    const l = lights(s);

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: l.content, fileName: "streetlights-kafka.yaml" }, ctx));

    expect(preview).toMatchObject({
      eventName: l.event, title: `Streetlights Kafka API ${s}`,
      counts: { servers: 2, channels: 4, messages: 3, operations: 4, traits: 2, securitySchemes: 2 },
      builtInTraits: [],
    });
    expect(preview.entities).toEqual([
      { requestedName: l.light, name: l.light, renamed: false, fields: 2, format: "json-schema" },
      { requestedName: l.onOff, name: l.onOff, renamed: false, fields: 2, format: "json-schema" },
      { requestedName: l.dim, name: l.dim, renamed: false, fields: 2, format: "json-schema" },
    ]);

    const entities = await entitiesOf(productId);
    expect(entities.map((e) => e.name)).toEqual([l.dim, l.light, l.onOff]);
    for (const entity of entities) {
      expect(entity.latestVersionId).toBeNull(); // a draft: nothing was published
      expect(entity.metadata).toEqual({ sourceFormat: "json-schema" });
      expect(entity.fields.length).toBe(2);
    }
    expect(await prisma.entityVersion.count({ where: { entity: { productId } } })).toBe(0);
    expect(entities.find((e) => e.name === l.light)?.fields.map((f) => f.name)).toEqual(["lumens", "sentAt"]);

    const event = unwrap(await getEvent(eventId, ctx));
    expect(event.name).toBe(l.event);
    expect(event.hasUnpublishedChanges).toBe(true);
    const doc = await storedDocument(eventId);
    expect(doc.messages.map((m) => m.key).sort()).toEqual([`dimLight${s}`, `lightMeasured${s}`, `turnOnOff${s}`]);
    for (const message of doc.messages) {
      const entity = entities.find((e) => e.name === message.key.charAt(0).toUpperCase() + message.key.slice(1));
      expect(message.payload).toEqual({ entityId: entity?.id, entityVersionId: null });
    }
    // an unpinned pin has no reference edge yet; the event is still what keeps the entity alive (the in-use guard reads the documents)
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: eventId } })).toBe(0);
    expect(failure(await deleteEntity(entities[0].id, ctx))).toMatchObject({ code: "IN_USE" });
  }, 120_000);

  it.each(POSITIVE_FIXTURES)("imports %s end to end: the saved document parses and every pin is an entity of the product", async (name) => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture(name), fileName: name }, ctx));

    const entities = await entitiesOf(productId);
    expect(entities.map((e) => e.name).sort()).toEqual(preview.entities.map((e) => e.name).sort());
    expect(entities.every((e) => e.latestVersionId === null)).toBe(true);
    const doc = await storedDocument(eventId); // throws when the saved document is not a valid v2 document
    expect(doc.messages.length).toBe(preview.counts.messages);
    const ids = new Set(entities.map((e) => e.id));
    for (const message of doc.messages) {
      expect(ids.has(message.payload.entityId)).toBe(true);
      expect(message.payload.entityVersionId).toBeNull();
      if (message.headers) expect(ids.has(message.headers.entityId)).toBe(true);
    }
    expect((await inventory(productId)).events).toBe(1);
  }, 120_000);

  it("multi-format-payloads: each format's importer, the message's name for JSON Schema roots, the wire name for Avro and Protobuf, headers as an entity", async () => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture("multi-format-payloads.yaml") }, ctx));

    // what the file asked for (a tenant-level asset of the same name would only add a suffix to the final name)
    const asked = requested(preview);
    expect(asked.get("Reading")).toMatchObject({ format: "avro", fields: 2 }); // the Avro record keeps its name
    expect(asked.get("ProtoReading")).toMatchObject({ format: "protobuf", fields: 2 });
    expect(asked.get("ReadingAsyncAPISchema")).toMatchObject({ format: "json-schema" });
    expect(asked.get("ReadingDefaultSchemaFormatHeaders")).toMatchObject({ format: "json-schema", fields: 1 });
    expect(asked.get("ReadingOpenAPISchema")).toMatchObject({ format: "placeholder", fields: 0 });
    const rows = new Map((await entitiesOf(productId)).map((e) => [e.name, e]));
    const row = (name: string) => rows.get(asked.get(name)?.name as string);
    expect(row("Reading")?.metadata).toEqual({ sourceFormat: "avro" });
    expect(row("ProtoReading")?.metadata).toEqual({ sourceFormat: "protobuf" });
    expect(row("ReadingOpenAPISchema")?.metadata).toBeNull();
    // the headers entity is pinned as the headers of its message
    const doc = await storedDocument(eventId);
    const defaultSchema = doc.messages.find((m) => m.key === "defaultSchema");
    expect(defaultSchema?.headers).toEqual({ entityId: row("ReadingDefaultSchemaFormatHeaders")?.id, entityVersionId: null });
    expect(warningCodes(preview.warnings)).toContain("UNSUPPORTED_PAYLOAD_FORMAT");
  }, 120_000);

  it("a message whose payload cannot be imported (OpenAPI, RAML, none) gets a placeholder entity with no fields and a warning", async () => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture("unsupported-payloads.yaml"), fileName: "unsupported-payloads.yaml" }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.format, e.fields])).toEqual([
      ["PayloadWrittenAsAnOpenAPISchema", "placeholder", 0], ["AMessageWithNoPayloadAtAll", "placeholder", 0], ["PayloadWrittenAsRAML", "placeholder", 0],
    ]);
    expect(warningCodes(preview.warnings).filter((code) => code === "UNSUPPORTED_PAYLOAD_FORMAT")).toHaveLength(2);
    expect(warningCodes(preview.warnings)).toContain("NO_PAYLOAD");
    const entities = await entitiesOf(productId);
    expect(entities.every((e) => e.fields.length === 0 && e.latestVersionId === null)).toBe(true);
    const noPayload = requested(preview).get("AMessageWithNoPayloadAtAll")?.name;
    expect(entities.find((e) => e.name === noPayload)?.description).toContain("unsupported-payloads.yaml");
    const doc = await storedDocument(eventId);
    expect(doc.messages.map((m) => m.payload.entityId).sort()).toEqual(entities.map((e) => e.id).sort());
  }, 120_000);

  it("a schema the importer rejects gets a placeholder with the importer's own reason; headers it rejects are left out", async () => {
    const { ctx, s, productId } = await setup();
    const content = smallDocument("Odd schemas", {
      [`scalarPayload${s}`]: { payload: { type: "string" }, headers: { type: "object" } },
    });

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.name, e.format])).toEqual([[`ScalarPayload${s}`, "placeholder"]]);
    const reasons = preview.warnings.filter((w) => w.code === "UNSUPPORTED_PAYLOAD_FORMAT").map((w) => w.message);
    expect(reasons.some((m) => m.includes("payload") && m.includes("could not be imported"))).toBe(true);
    expect(reasons.some((m) => m.includes("headers") && m.includes("left out"))).toBe(true);
    const doc = await storedDocument(eventId);
    expect(doc.messages[0].headers).toBeUndefined();
  }, 120_000);

  it("headers in a format the importer cannot read get NO placeholder entity: the payload's entity exists, the headers are left out, both are reported", async () => {
    const { ctx, s, productId } = await setup();
    const avroHeaders = { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "Envelope", fields: [{ name: "trace", type: "string" }] } };
    const content = smallDocument("Odd headers", { [`m${s}`]: { payload: objectPayload("id"), headers: avroHeaders } });

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.name, e.format])).toEqual([[`M${s}`, "json-schema"]]);
    expect(preview.warnings.some((w) => w.code === "UNSUPPORTED_PAYLOAD_FORMAT" && w.message.includes("headers"))).toBe(true);
    expect(preview.warnings.some((w) => w.code === "DROPPED_CONSTRUCT" && w.message.includes("headers"))).toBe(true);
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual([`M${s}`]);
    expect((await storedDocument(eventId)).messages[0].headers).toBeUndefined();
  }, 120_000);

  it("rewrites references to a renamed entity of the same payload (an Avro record that nests and refers to itself)", async () => {
    const { ctx, scope, s, productId } = await setup();
    const order = `Order${s}`;
    const address = `Address${s}`;
    await scope.entity(address);
    await scope.entity(order);
    const avro = {
      type: "record", name: order, fields: [
        { name: "to", type: { type: "record", name: address, fields: [{ name: "street", type: "string" }] } },
        { name: "next", type: ["null", order] },
      ],
    };
    const content = smallDocument("Shipping", { [`shipment${s}`]: { payload: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: avro } } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed, e.format])).toEqual([
      [order, `${order}2`, true, "avro"], [address, `${address}2`, true, "avro"],
    ]);
    const rows = new Map((await entitiesOf(productId)).map((e) => [e.name, e]));
    const referenceOf = (entity: string, field: string) => (rows.get(entity)?.fields.find((f) => f.name === field)?.decorators as { referencedEntityName?: string } | null)?.referencedEntityName;
    expect(referenceOf(`${order}2`, "to")).toBe(`${address}2`);
    expect(referenceOf(`${order}2`, "next")).toBe(`${order}2`); // a self reference follows the new name too
    expect(rows.get(order)?.fields.map((f) => f.name)).toEqual(["id"]); // the entity that was there is untouched
  }, 120_000);
});

describe("importAsyncApi: built-in traits", () => {
  it("maps CloudEvents and W3C Trace Context traits to the tenant's built-in library traits, never by name", async () => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture("builtin-traits.yaml") }, ctx));

    const library = await prisma.trait.findMany({ where: { tenantId: TENANT, domainId: null, productId: null } });
    const idOf = (marker: string) => library.find((t) => bundledMarker(t.spec) === marker)?.id;
    const doc = await storedDocument(eventId);
    const libraryTraits = doc.traits.filter(isLibraryTrait);
    expect(libraryTraits.map((t) => t.libraryTraitId).sort()).toEqual([idOf("cloudevents@1.0"), idOf("w3c-trace-context@1")].sort());
    expect(preview.builtInTraits.sort()).toEqual(["CloudEvents", "TraceContext"].sort());
    expect(warningCodes(preview.warnings)).toContain("BUILTIN_TRAIT_MAPPED");
    // the look-alike (no `source`) and the user's own headers stay local copies
    expect(doc.traits.filter((t) => !isLibraryTrait(t)).map((t) => t.key).sort()).toEqual(["cloudEventsLookalike", "tenantHeaders"]);
  }, 120_000);

  it("uses the product's OWN tenant's built-ins: nothing of another tenant leaks in, and names of another tenant do not clash", async () => {
    const { ctx, scope, s } = await setup();
    await scope.entity(orderCreatedName(s)); // a taken name in the default tenant
    const foreign = await createForeignTenantFixture(prisma, ctx);
    cleanups.push(foreign.cleanup);

    const { eventId, preview } = unwrap(await importAsyncApi(foreign.product.id, { content: orders(s) }, ctx));

    const doc = await storedDocument(eventId);
    const foreignLibrary = await prisma.trait.findMany({ where: { tenantId: foreign.tenant.id, domainId: null, productId: null }, select: { id: true } });
    const ids = doc.traits.filter(isLibraryTrait).map((t) => t.libraryTraitId);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => foreignLibrary.some((t) => t.id === id))).toBe(true);
    const row = await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.tenantId).toBe(foreign.tenant.id);
    expect(preview.entities.every((e) => !e.renamed)).toBe(true); // the name exists in the DEFAULT tenant only

    // and the names of the foreign tenant never rename an import in the default tenant
    const again = await setup();
    const other = unwrap(await previewAsyncApiImport(again.productId, { content: orders(again.s) }, again.ctx));
    expect(other.entities.every((e) => !e.renamed)).toBe(true);
  }, 120_000);
});

describe("importAsyncApi: names", () => {
  it("two payloads of one file with the same name: the second gets a suffix and a warning", async () => {
    const { ctx, s, productId } = await setup();
    const order = `Order${s}`;
    const content = smallDocument("Twins", { a: { name: order, payload: objectPayload("id") }, b: { name: order, payload: objectPayload("sku") } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed])).toEqual([[order, order, false], [order, `${order}2`, true]]);
    expect(preview.warnings.filter((w) => w.code === "ENTITY_RENAMED")).toHaveLength(1);
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual([order, `${order}2`]);
  }, 120_000);

  it("the same file twice: the second import renames everything (entities and event) and never errors", async () => {
    const { ctx, s, productId } = await setup();
    const l = lights(s);
    const input = { content: l.content };
    const first = unwrap(await importAsyncApi(productId, input, ctx));

    const second = unwrap(await importAsyncApi(productId, input, ctx));

    expect(first.preview.eventName).toBe(l.event);
    expect(second.preview.eventName).toBe(`${l.event}2`);
    expect(second.preview.entities.map((e) => [e.name, e.renamed])).toEqual([[`${l.light}2`, true], [`${l.onOff}2`, true], [`${l.dim}2`, true]]);
    expect(second.preview.warnings.filter((w) => w.code === "ENTITY_RENAMED")).toHaveLength(4);
    expect(await inventory(productId)).toEqual({ entities: 6, events: 2 });
    const doc = await storedDocument(second.eventId);
    const ids = new Set((await entitiesOf(productId)).filter((e) => e.name.endsWith("2")).map((e) => e.id));
    expect(doc.messages.every((m) => ids.has(m.payload.entityId))).toBe(true);
  }, 120_000);

  it("a name already in the product (any case) is renamed", async () => {
    const { ctx, scope, s, productId } = await setup();
    const l = lights(s);
    await scope.entity(l.light);
    await scope.entity(l.onOff.toUpperCase());

    const { preview } = unwrap(await importAsyncApi(productId, { content: l.content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name])).toEqual([[l.light, `${l.light}2`], [l.onOff, `${l.onOff}2`], [l.dim, l.dim]]);
  }, 120_000);

  it("a reserved route name (an entity cannot be called Messages) is renamed", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("Reserved", { a: { name: "Messages", payload: objectPayload("id") } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed])).toEqual([["Messages", "Messages2", true]]);
  }, 120_000);

  it("the event name is the title's slug; a taken event name, or an entity of that name, is resolved", async () => {
    const { ctx, scope, s, productId } = await setup();
    const l = lights(s);
    unwrap(await createEvent(productId, { name: l.event }, ctx));
    await scope.entity(`${l.event}2`);

    const { preview, eventId } = unwrap(await importAsyncApi(productId, { content: l.content }, ctx));

    // the event and the entities share one line: `...2` is an entity, so the event is `...3`
    expect(preview.eventName).toBe(`${l.event}3`);
    expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } })).name).toBe(`${l.event}3`);
    expect(preview.warnings.find((w) => w.pointer === "" && w.code === "ENTITY_RENAMED")?.message).toContain(`${l.event}3`);
  }, 120_000);

  it("an event name the user gives is used; a taken one is resolved; an invalid one is refused before anything runs", async () => {
    const { ctx, s, productId } = await setup();
    const content = fixture("request-reply.yaml");

    const named = unwrap(await importAsyncApi(productId, { content, eventName: `  my-prices-${s} ` }, ctx));
    expect(named.preview.eventName).toBe(`my-prices-${s}`);
    const taken = unwrap(await previewAsyncApiImport(productId, { content, eventName: `my-prices-${s}` }, ctx));
    expect(taken.eventName).toBe(`my-prices-${s}2`);

    const before = await inventory(productId);
    const bad = await importAsyncApi(productId, { content, eventName: "not a valid name!" }, ctx);
    expect(codeOf(bad)).toBe("VALIDATION_ERROR");
    expect(await inventory(productId)).toEqual(before);
  }, 120_000);

  it("names its entities after the entity-name rules: a definition named with spaces and symbols becomes a valid name", async () => {
    const { ctx, s, productId } = await setup();
    const definition = `Delivery address ${s}!`;
    const content = smallDocument("Weird names", {
      [`shipment${s}`]: { payload: { type: "object", properties: { id: { type: "string" } }, $defs: { [definition]: { type: "object", properties: { street: { type: "string" } } } } } },
    });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => e.name)).toEqual([`Shipment${s}`, pascalName(definition)]);
    expect((await entitiesOf(productId)).map((e) => e.name).sort()).toEqual([`Shipment${s}`, pascalName(definition)].sort());
  }, 120_000);

  it("finds a free name behind 150 taken ones (Name, Name2 ... Name150 exist: the import gets Name151)", async () => {
    const { ctx, scope, s, productId } = await setup();
    const base = `Item${s}`;
    await scope.entity(base);
    for (let n = 2; n <= 150; n += 1) await scope.entity(`${base}${n}`);
    const content = smallDocument("Crowded", { [`k${s}`]: { name: base, payload: objectPayload("id") } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed])).toEqual([[base, `${base}151`, true]]);
  }, 180_000);

  it("a title with no Latin letter or digit gets a valid event name (imported-event), then a suffix when that is taken", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("\u65e5\u672c\u8a9e\u306e\u30a4\u30d9\u30f3\u30c8", { a: { payload: objectPayload("id") } });

    const first = unwrap(await importAsyncApi(productId, { content }, ctx));
    const second = unwrap(await previewAsyncApiImport(productId, { content }, ctx));

    expect(first.preview.eventName).toBe("imported-event");
    expect(second.eventName).toBe("imported-event2");
    expect(unwrap(await getEvent(first.eventId, ctx)).name).toBe("imported-event");
  }, 120_000);

  it("field names whose URL slugs collide (a b / a-b, names with no Latin letter) are numbered, and reported the same in the preview and the import", async () => {
    const { ctx, s, productId } = await setup();
    const jp = "\u65e5\u672c\u8a9e";
    const cn = "\u4e2d\u6587";
    const content = smallDocument("Slugs", { [`slugs${s}`]: { payload: { type: "object", properties: { "a b": { type: "string" }, "a-b": { type: "string" }, [jp]: { type: "string" }, [cn]: { type: "string" }, other: { type: "string" } } } } });

    const previewed = unwrap(await previewAsyncApiImport(productId, { content }, ctx));
    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview).toEqual(previewed);
    const renames = preview.warnings.filter((w) => w.code === "SANITIZED_VALUE");
    expect(renames).toHaveLength(2);
    expect(renames[0].message).toContain(`Entity "Slugs${s}"`);
    expect(renames[0].message).toContain('the field "a-b"');
    expect(renames[0].message).toContain('named "a-b2"');
    expect(renames[1].message).toContain(`the field "${cn}"`);
    expect(renames[1].message).toContain(`named "${cn}2"`);
    const [entity] = await entitiesOf(productId);
    expect(entity.fields.map((f) => f.name)).toEqual(["a b", "a-b2", jp, `${cn}2`, "other"]);
    expect(new Set(entity.fields.map((f) => f.slug)).size).toBe(5); // the unique (entity, slug) index is satisfied
  }, 120_000);
});

describe("importAsyncApi: what the AsyncAPI parser says", () => {
  const diagnostic = (code: string, severity: number, message: string, at: string[]) => ({ code, severity, message, path: at, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });

  it("reports its warnings (VALIDATION_WARNING, with the pointer) and drops pure advice such as the latest-version hint", async () => {
    const { ctx, productId } = await setup();
    vi.spyOn(Parser.prototype, "validate").mockResolvedValueOnce([
      diagnostic("asyncapi-info-contact", 1, "Info object should contain a contact", ["info"]),
      diagnostic("asyncapi-latest-version", 2, "The latest version of AsyncAPI is not used", ["asyncapi"]),
    ] as never);

    const { preview } = unwrap(await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx));

    const fromParser = preview.warnings.filter((w) => w.code === "VALIDATION_WARNING");
    expect(fromParser).toEqual([{ pointer: "/info", code: "VALIDATION_WARNING", message: "Info object should contain a contact" }]);
    expect(await inventory(productId)).toEqual({ entities: 2, events: 1 }); // a warning never blocks
  }, 120_000);

  it("a crash inside the parser (its diagnostic carries a stack) is the generic INTERNAL_ERROR: nothing is created and no stack text is returned", async () => {
    const { ctx, productId } = await setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Parser.prototype, "validate").mockResolvedValueOnce([
      diagnostic("uncaught-error", 0, "Error thrown during AsyncAPI document validation. Name: TypeError, message: boom, stack: at /Users/dev/src/node_modules/@stoplight/spectral-core/index.js:12:3", []),
    ] as never);

    const result = await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx);

    spy.mockRestore();
    expect(failure(result)).toEqual({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
    expect(JSON.stringify(result)).not.toMatch(/Users\/dev|spectral|stack/);
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("keeps the first 100 parser warnings and one summary line, with every echoed text bounded", async () => {
    const { ctx, productId } = await setup();
    vi.spyOn(Parser.prototype, "validate").mockResolvedValueOnce([
      ...Array.from({ length: 150 }, (_, i) => diagnostic("asyncapi-info-contact", 1, i === 0 ? `long ${"x".repeat(5000)}` : `Warning number ${i}`, ["info", String(i)])),
      diagnostic("asyncapi-latest-version", 2, "advice", ["asyncapi"]),
    ] as never);

    const { preview } = unwrap(await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx));

    expect(preview.warnings.filter((w) => w.code === "VALIDATION_WARNING")).toHaveLength(100);
    expect(preview.warnings.filter((w) => w.message === "50 more warnings were omitted")).toEqual([{ pointer: "", code: "DROPPED_CONSTRUCT", message: "50 more warnings were omitted" }]);
    expect(Math.max(...preview.warnings.map((w) => w.message.length))).toBeLessThanOrEqual(500);
  }, 120_000);

  it("lists at most 100 parser errors (the message counts the rest), and nothing is created", async () => {
    const { ctx, productId } = await setup();
    vi.spyOn(Parser.prototype, "validate").mockResolvedValueOnce(
      Array.from({ length: 150 }, (_, i) => diagnostic("asyncapi3-document-structure", 0, `Problem number ${i}`, ["operations", String(i)])) as never,
    );

    const result = await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx);

    const error = failure(result);
    expect(error?.code).toBe("VALIDATION_ERROR");
    expect((error?.details as { problems: unknown[] }).problems).toHaveLength(100);
    expect(error?.message).toContain("and 149 more problems");
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);
});

describe("previewAsyncApiImport", () => {
  it("writes nothing: no entity, event or trait appears (in a tenant of its own), and the preview is what the import then does", async () => {
    const { ctx, s } = await setup();
    const foreign = await createForeignTenantFixture(prisma, ctx); // a tenant with no built-in traits yet: the only place a stray install would show
    cleanups.push(foreign.cleanup);
    const productId = foreign.product.id;
    const l = lights(s);
    const traitsBefore = await prisma.trait.count({ where: { tenantId: foreign.tenant.id } });
    const before = await inventory(productId);

    const preview = unwrap(await previewAsyncApiImport(productId, { content: l.content }, ctx));

    expect(await inventory(productId)).toEqual(before);
    expect(await prisma.trait.count({ where: { tenantId: foreign.tenant.id } })).toBe(traitsBefore);
    expect(preview.entities.map((e) => e.name)).toEqual([l.light, l.onOff, l.dim]);
    const imported = unwrap(await importAsyncApi(productId, { content: l.content }, ctx));
    expect(imported.preview).toEqual(preview);
    // the import is what installs the built-ins
    expect(await prisma.trait.count({ where: { tenantId: foreign.tenant.id } })).toBe(traitsBefore + BUNDLED_TRAITS.length);
  }, 120_000);

  it("reports the built-in traits it would use, and renames, without writing", async () => {
    const { ctx, scope, s, productId } = await setup();
    await scope.entity(orderCreatedName(s));

    const preview = unwrap(await previewAsyncApiImport(productId, { content: orders(s) }, ctx));

    expect(preview.builtInTraits.sort()).toEqual(["CloudEvents", "TraceContext"]);
    expect(preview.entities.find((e) => e.requestedName === orderCreatedName(s))).toMatchObject({ name: `${orderCreatedName(s)}2`, renamed: true });
    expect(await inventory(productId)).toEqual({ entities: 1, events: 0 });
  }, 120_000);

  it("fails like the import does, and says why (an invalid file, a 2.x file)", async () => {
    const { ctx, productId } = await setup();

    expect(failure(await previewAsyncApiImport(productId, { content: fixture("negative-asyncapi-2x.yaml") }, ctx))).toMatchObject({ code: "UNSUPPORTED_VERSION" });
    expect(failure(await previewAsyncApiImport(productId, { content: "just: [text" }, ctx))).toMatchObject({ code: "PARSE_ERROR" });
  }, 120_000);
});

describe("importAsyncApi: an invalid or hostile document creates nothing", () => {
  const nothingCreated = async (productId: string, run: () => Promise<Result<unknown>>) => {
    const before = await inventory(productId);
    const result = await run();
    expect(await inventory(productId)).toEqual(before);
    return result;
  };

  it("the AsyncAPI parser's errors block the import, with every problem (message and pointer) in details", async () => {
    const { ctx, productId } = await setup();
    const content = fixture("streetlights-kafka.yaml").replace("action: send", "action: publish");

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    const error = failure(result);
    expect(error?.code).toBe("VALIDATION_ERROR");
    const problems = (error?.details as { problems: Array<{ pointer: string; message: string }> }).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => typeof p.message === "string" && p.message !== "" && p.pointer.startsWith("/"))).toBe(true);
    expect(error?.message).toContain(problems[0].message);
    expect(error?.message).not.toMatch(/stack|at .*\(.*:\d+:\d+\)/i);
  }, 120_000);

  it("a document the mapper rejects (extract and the parser are fine) creates nothing: the mapper runs BEFORE the first entity", async () => {
    const { ctx, productId } = await setup();
    const rejecting = vi.mocked(mapAsyncApiToEventDocument);
    rejecting.mockReturnValueOnce(err({ code: "REF_TOO_LARGE", message: "The document expands to more than 5,000,000 values" }));
    const calls = rejecting.mock.calls.length;

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));

    expect(failure(result)).toMatchObject({ code: "REF_TOO_LARGE" });
    expect(rejecting.mock.calls.length - calls).toBe(1); // only the stand-in run happened
    const preview = failure(await previewAsyncApiImport(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));
    expect(preview).toBeNull(); // the next call is the real mapper again
  }, 120_000);

  it("a document whose title is blank passes the parser but not the mapper: nothing is created", async () => {
    const { ctx, productId } = await setup();
    const content = fixture("request-reply.yaml").replace(/title: .*/, 'title: ""');

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(codeOf(result)).toBe("VALIDATION_ERROR");
  }, 120_000);

  it.each([
    ["an external $ref", "negative-external-ref.yaml", "EXTERNAL_REF"],
    ["a missing $ref", "negative-missing-ref.yaml", "REF_NOT_FOUND"],
    ["a __proto__ key", "negative-proto-key.yaml", "PARSE_ERROR"],
    ["a YAML alias bomb", "negative-alias-bomb.yaml", "PARSE_ERROR"],
    ["an AsyncAPI 2.x document", "negative-asyncapi-2x.yaml", "UNSUPPORTED_VERSION"],
  ])("%s is rejected and nothing is created", async (_label, name, code) => {
    const { ctx, productId } = await setup();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content: fixture(name) }, ctx));

    expect(codeOf(result)).toBe(code);
  }, 120_000);

  it("a $ref cycle terminates: it is refused, or its payload degrades to ONE placeholder with a warning — never a crash or a loop", async () => {
    const { ctx, productId } = await setup();
    const started = Date.now();

    const result = await importAsyncApi(productId, { content: fixture("negative-ref-cycle.yaml") }, ctx);

    expect(Date.now() - started).toBeLessThan(30_000);
    const inv = await inventory(productId);
    if (result.success) {
      expect(inv.entities).toBe(1);
      expect(result.data.preview.entities.map((e) => e.format)).toEqual(["placeholder"]);
      expect(warningCodes(result.data.preview.warnings)).toContain("UNSUPPORTED_PAYLOAD_FORMAT");
    } else {
      expect(result.error.code).toBe("REF_CYCLE");
      expect(inv).toEqual({ entities: 0, events: 0 });
    }
  }, 120_000);

  it("more than 1 MiB is refused server-side, before anything is parsed", async () => {
    const { ctx, productId } = await setup();
    const content = `asyncapi: 3.0.0\ninfo:\n  title: big\n  description: ${"x".repeat(1024 * 1024 + 1)}\n`;

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(failure(result)).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("too large") });
  }, 120_000);

  /** `count` messages on `channelCount` channels, inline, small enough for the 1 MiB limit. */
  const manyMessages = (count: number, channelCount = 50): string => {
    const channels: Record<string, unknown> = {};
    for (let c = 0; c < channelCount; c += 1) {
      const messages: Record<string, unknown> = {};
      for (let i = 0; i < count / channelCount; i += 1) messages[`m${c * (count / channelCount) + i}`] = { payload: { type: "object", properties: { id: { type: "string" } } } };
      channels[`c${c}`] = { address: `topic.${c}`, messages };
    }
    return JSON.stringify({ asyncapi: "3.0.0", info: { title: "Huge", version: "1.0.0" }, channels });
  };

  it("501 message payloads are refused before ANY importer runs, and nothing is created (500 is the cap)", async () => {
    const { ctx, productId } = await setup();
    const content = manyMessages(501, 3);
    const before = importerCalls();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(failure(result)).toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining("501 message payloads"), details: { payloads: 501, limit: 500 }, suggestedFix: expect.stringContaining("Split"),
    });
    expect(codeOf(await previewAsyncApiImport(productId, { content }, ctx))).toBe("VALIDATION_ERROR");
    expect(importerCalls()).toEqual(before); // no importer ran, for the import or for the preview
  }, 120_000);

  it("a 5,000-message document is refused quickly, before any importer, and creates nothing", async () => {
    const { ctx, productId } = await setup();
    const content = manyMessages(5000);
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    const before = importerCalls();
    const started = Date.now();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failure(result)).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("5,000 message payloads") });
    expect(importerCalls()).toEqual(before);
  }, 120_000);

  /** A Protobuf source of about `chars` characters: one message of many fields on ONE line (a newline would be escaped and inflate the JSON file). */
  const protobufSource = (chars: number): string => {
    const parts = ['syntax = "proto3"; message Big {'];
    let length = parts[0].length;
    for (let i = 0; length < chars; i += 1) {
      const field = ` int32 f${i} = ${i + 1};`;
      parts.push(field);
      length += field.length;
    }
    return `${parts.join("")} }`;
  };
  /** `messageCount` messages that all use ONE `components.schemas.big` of `properties` string properties as their payload. */
  const sharedSchemaDocument = (properties: number, messageCount: number): string => {
    const big = { type: "object", properties: Object.fromEntries(Array.from({ length: properties }, (_, i) => [`p${i}`, { type: "string" }])) };
    const document = JSON.parse(smallDocument("Shared", Object.fromEntries(Array.from({ length: messageCount }, (_, i) => [`m${i}`, { payload: { $ref: "#/components/schemas/big" } }])))) as { components: Record<string, unknown> };
    document.components.schemas = { big };
    return JSON.stringify(document);
  };

  it("a 1 MiB Protobuf payload is refused quickly, before the Protobuf importer runs, and creates nothing", async () => {
    const { ctx, s, productId } = await setup();
    const content = smallDocument("Big proto", { [`big${s}`]: { payload: { schemaFormat: "application/vnd.google.protobuf;version=3", schema: protobufSource(1_000_000) } } });
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    const before = importerCalls();
    const started = Date.now();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(Date.now() - started).toBeLessThan(3_000); // the importer alone would take minutes
    expect(failure(result)).toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining(`The payload of message "big${s}" is larger than 128 KiB`),
      details: { messageKey: `big${s}`, role: "payload", limit: 128 * 1024 },
    });
    expect(importerCalls()).toEqual(before);
  }, 120_000);

  it("a schema shared by 40 messages is refused by the size cap, because reuse counts per message: 40 x 104 KB is over 2 MiB; quickly, nothing created, no importer run", async () => {
    const { ctx, productId } = await setup();
    const content = sharedSchemaDocument(4000, 40);
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    const before = importerCalls();
    const started = Date.now();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(failure(result)).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("add up to more than 2 MiB"), details: { limit: 2 * 1024 * 1024 } });
    expect(importerCalls()).toEqual(before);
  }, 120_000);

  it("the reviewed shape (one 8,000-property schema used by 60 messages, 480,000 planned fields) is refused quickly, whichever bound sees it first, and creates nothing", async () => {
    const { ctx, productId } = await setup();
    const content = sharedSchemaDocument(8000, 60);
    const before = importerCalls();
    const started = Date.now();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(Date.now() - started).toBeLessThan(3_000);
    // the pure layer's expansion budget (REF_TOO_LARGE) stops it today; once that budget stops over-counting shared targets, the size cap does
    const error = failure(result);
    expect(["REF_TOO_LARGE", "VALIDATION_ERROR"]).toContain(error?.code);
    if (error?.code === "VALIDATION_ERROR") expect(error.message).toContain("add up to more than 2 MiB");
    expect(importerCalls()).toEqual(before);
  }, 120_000);

  it("a schema that has more than 2,000 fields is refused naming the entity and the limit; nothing is created", async () => {
    const { ctx, productId } = await setup();
    const content = sharedSchemaDocument(2001, 1);

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(failure(result)).toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining('The entity "M0" (from m0:payload) would have 2,001 fields; one entity may have at most 2,000'),
      details: { entity: "M0", fields: 2001, limit: 2000 },
    });
  }, 120_000);

  it("fields per import: 5 messages x 2,000 fields = 10,000 is exactly at the cap and the shared schema is parsed ONCE; 6 messages are refused", async () => {
    const { ctx, productId } = await setup();
    const before = importerCalls();

    const atTheCap = unwrap(await previewAsyncApiImport(productId, { content: sharedSchemaDocument(2000, 5) }, ctx));

    expect(atTheCap.entities.map((e) => e.fields)).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(importerCalls().json - before.json).toBe(1); // memoised: one parse for five messages

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content: sharedSchemaDocument(2000, 6) }, ctx));
    expect(failure(result)).toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining("more than 10,000 fields"), details: { limit: 10_000, entity: "M5", pin: "m5:payload" },
    });
  }, 120_000);

  it("messages that share a schema share one importer run, and each still gets its own entity with all the fields", async () => {
    const { ctx, productId } = await setup();
    const before = importerCalls();

    const { preview } = unwrap(await importAsyncApi(productId, { content: sharedSchemaDocument(3, 3) }, ctx));

    expect(importerCalls().json - before.json).toBe(1);
    expect(preview.entities.map((e) => [e.requestedName, e.fields])).toEqual([["M0", 3], ["M1", 3], ["M2", 3]]);
    const rows = await entitiesOf(productId);
    expect(rows).toHaveLength(3);
    expect(rows.every((e) => e.fields.map((f) => f.name).join() === "p0,p1,p2")).toBe(true);
  }, 120_000);

  it("an IMPORT_FAILED of the pure layer never forwards its exception text (details.reason): not from the extraction, not from either mapping", async () => {
    const { ctx, productId } = await setup();
    const RAW = "RangeError: Maximum call stack size exceeded at /Users/dev/src/lib/events/import/refs.ts:12:3";
    const failing = () => err({ code: "IMPORT_FAILED", message: "The AsyncAPI document could not be processed; it is probably too large or too deeply nested.", details: { reason: RAW } });
    const real = vi.mocked(mapAsyncApiToEventDocument).getMockImplementation() as typeof mapAsyncApiToEventDocument;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const content = fixture("request-reply.yaml");

    vi.mocked(extractPayloads).mockReturnValueOnce(failing());
    const fromExtract = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));
    vi.mocked(mapAsyncApiToEventDocument).mockReturnValueOnce(failing());
    const fromStandIn = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));
    vi.mocked(mapAsyncApiToEventDocument).mockImplementationOnce(real).mockReturnValueOnce(failing());
    const fromSecondMap = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx)); // entities exist for a moment, then are deleted
    vi.mocked(extractPayloads).mockReturnValueOnce(failing());
    const previewed = await previewAsyncApiImport(productId, { content }, ctx);

    const logged = spy.mock.calls.filter((call) => call[0] === "[asyncapi-import] the document could not be processed");
    spy.mockRestore();
    for (const result of [fromExtract, fromStandIn, fromSecondMap, previewed]) {
      expect(failure(result)?.code).toBe("IMPORT_FAILED");
      expect(failure(result)?.message).toContain("could not be processed");
      expect(JSON.stringify(result)).not.toMatch(/RangeError|Users\/dev|reason/);
    }
    expect(failure(fromSecondMap)?.message).toContain("Nothing was imported");
    expect(logged).toHaveLength(4); // the text is logged server-side
  }, 120_000);

  it("refuses an input that is not { content: string } without a query or a throw", async () => {
    const { ctx, productId } = await setup();

    for (const input of [null, undefined, "text", 5, [], {}, { content: 5 }, { content: "x", eventName: 7 }, { content: "x", fileName: {} }]) {
      expect(codeOf(await importAsyncApi(productId, input as never, ctx))).toBe("VALIDATION_ERROR");
      expect(codeOf(await previewAsyncApiImport(productId, input as never, ctx))).toBe("VALIDATION_ERROR");
    }
    expect(codeOf(await importAsyncApi("", { content: "x" }, ctx))).toBe("VALIDATION_ERROR");
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("an unknown product is NOT_FOUND, before the file is read", async () => {
    const { ctx } = await setup();

    expect(failure(await importAsyncApi("no-such-product", { content: fixture("streetlights-kafka.yaml") }, ctx))).toMatchObject({ code: "NOT_FOUND" });
    expect(failure(await previewAsyncApiImport("no-such-product", { content: "not even a document" }, ctx))).toMatchObject({ code: "NOT_FOUND" });
  }, 120_000);

  it("an unexpected throw is the generic INTERNAL_ERROR text: no driver or parser text reaches the caller", async () => {
    const { ctx, productId } = await setup();
    const leaky = new Proxy(prisma, {
      get: (target, prop) => (prop === "product" ? { findUnique: () => Promise.reject(new Error("connection lost: host=db.internal table=products")) } : Reflect.get(target, prop)),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const imported = await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, { ...ctx, prisma: leaky as unknown as PrismaClient });
    const previewed = await previewAsyncApiImport(productId, { content: fixture("request-reply.yaml") }, { ...ctx, prisma: leaky as unknown as PrismaClient });

    spy.mockRestore();
    expect(failure(imported)).toEqual({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
    expect(failure(previewed)).toEqual({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
    expect(JSON.stringify([imported, previewed])).not.toMatch(/db\.internal|connection lost|products/);
  }, 120_000);
});

describe("importAsyncApi: a failed import leaves nothing behind", () => {
  it("a failing document save deletes the entities AND the event, and the error says so", async () => {
    const { ctx, productId } = await setup();
    const before = await inventory(productId);
    vi.mocked(updateEventDocument).mockResolvedValueOnce(err({ code: "VALIDATION_ERROR", message: "The event references 3 unknown or invalid item(s)", details: { problems: [{ pointer: "/messages/0/payload/entityId", message: "gone" }] } }));

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    const error = failure(result);
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(error?.message).toContain("The event references 3 unknown or invalid item(s). Nothing was imported:");
    expect(error?.message).toContain("the 3 entities created for it were deleted again");
    expect(error?.details).toMatchObject({ deletedEntities: 3, leftovers: [], cause: { problems: [{ pointer: "/messages/0/payload/entityId" }] } });
    expect(await inventory(productId)).toEqual(before); // the entities and the event row are both gone
  }, 120_000);

  it("a failing event creation deletes the entities (a database failure becomes IMPORT_FAILED, its text never shown)", async () => {
    const { ctx, productId } = await setup();
    vi.mocked(createEvent).mockResolvedValueOnce(err({ code: "DB_ERROR", message: "relation event_specs: connection lost at db.internal" }));

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    const error = failure(result);
    expect(error?.code).toBe("IMPORT_FAILED");
    expect(JSON.stringify(error)).not.toMatch(/db\.internal|event_specs|connection lost/);
    expect(error?.message).toContain("Nothing was imported");
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("a mapping failure after the entities exist (the second map) deletes them", async () => {
    const { ctx, productId } = await setup();
    const real = vi.mocked(mapAsyncApiToEventDocument).getMockImplementation() as typeof mapAsyncApiToEventDocument;
    vi.mocked(mapAsyncApiToEventDocument).mockImplementationOnce(real).mockReturnValueOnce(err({ code: "IMPORT_FAILED", message: "The AsyncAPI document could not be processed" }));

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    expect(failure(result)).toMatchObject({ code: "IMPORT_FAILED", message: expect.stringContaining("Nothing was imported") });
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("an unexpected throw after the entities exist deletes them and answers the generic text", async () => {
    const { ctx, productId } = await setup();
    vi.mocked(updateEventDocument).mockRejectedValueOnce(new Error("socket hang up: host=db.internal"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    spy.mockRestore();
    expect(failure(result)?.code).toBe("IMPORT_FAILED");
    expect(JSON.stringify(result)).not.toMatch(/socket|db\.internal/);
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("a rollback that fails is REPORTED, never hidden: the entity that could not be deleted is named in the error", async () => {
    const { ctx, s, productId } = await setup();
    const l = lights(s);
    vi.mocked(updateEventDocument).mockResolvedValueOnce(err({ code: "CONFLICT", message: "The event changed while saving" }));
    // entities are taken back newest first: the first delete (the dim light) fails, the other two work
    vi.mocked(deleteEntity).mockResolvedValueOnce(err({ code: "IN_USE", message: `Entity "${l.dim}" cannot be deleted: it is used by something` }));

    const result = await importAsyncApi(productId, { content: l.content }, ctx);

    const error = failure(result);
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("could not be undone completely");
    expect(error?.message).toContain(`the entity "${l.dim}"`);
    expect(error?.details).toMatchObject({ deletedEntities: 2, leftovers: [{ kind: "entity", name: l.dim, code: "IN_USE" }] });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual([l.dim]);
    expect((await inventory(productId)).events).toBe(0);
  }, 120_000);

  it("an entity that is already gone in the rollback (NOT_FOUND: something else deleted it) is not a leftover", async () => {
    const { ctx, productId } = await setup();
    vi.mocked(updateEventDocument).mockResolvedValueOnce(err({ code: "CONFLICT", message: "The event changed while saving" }));
    const real = vi.mocked(deleteEntity).getMockImplementation() as typeof deleteEntity;
    vi.mocked(deleteEntity).mockImplementationOnce(async (id, c) => {
      await prisma.entity.delete({ where: { id } }); // someone else removes it first: the real delete then answers NOT_FOUND
      return real(id, c);
    });

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    const error = failure(result);
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("Nothing was imported");
    expect(error?.message).not.toContain("could not be undone");
    expect(error?.details).toMatchObject({ deletedEntities: 3, leftovers: [] });
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);

  it("an event that cannot be deleted in the rollback is reported too", async () => {
    const { ctx, productId } = await setup();
    vi.mocked(updateEventDocument).mockResolvedValueOnce(err({ code: "CONFLICT", message: "The event changed while saving" }));
    vi.mocked(deleteEvent).mockResolvedValueOnce(err({ code: "IN_USE", message: "referenced" }));

    const result = await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx);

    const error = failure(result);
    expect(error?.message).toContain("the event it created");
    expect(error?.details).toMatchObject({ leftovers: [{ kind: "event" }] });
    expect((await inventory(productId)).events).toBe(1);
    expect((await inventory(productId)).entities).toBe(0);
  }, 120_000);

  it("a name taken after the names were resolved refuses the import as a retryable CONFLICT and creates none of its entities (one transaction)", async () => {
    const { ctx, scope, s, productId } = await setup();
    const l = lights(s);
    // another writer takes the LAST entity's name between the read of the names and the write of the entities
    const racing = new Proxy(prisma, {
      get: (target, prop) =>
        prop === "$transaction"
          ? async (...args: unknown[]) => {
              if ((args[1] as { timeout?: number } | undefined)?.timeout === 60_000) await scope.entity(l.dim); // the entity write's own options
              return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
            }
          : Reflect.get(target, prop),
    });

    const result = await importAsyncApi(productId, { content: l.content }, { ...ctx, prisma: racing as unknown as PrismaClient });

    expect(failure(result)).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("taken while it ran"), suggestedFix: "Import again." });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual([l.dim]); // only the other writer's entity; the other two rolled back
    expect((await inventory(productId)).events).toBe(0);
  }, 120_000);

  it("an event name taken after it was resolved fails the event step and the entities are deleted again", async () => {
    const { ctx, scope, s, productId } = await setup();
    const l = lights(s);
    const real = vi.mocked(createEvent).getMockImplementation() as typeof createEvent;
    vi.mocked(createEvent).mockImplementationOnce(async (...args) => {
      await scope.entity(l.event); // an entity takes the event's resolved name
      return real(...args);
    });

    const result = await importAsyncApi(productId, { content: l.content }, ctx);

    expect(failure(result)).toMatchObject({ code: "NAME_CONFLICT", message: expect.stringContaining("Nothing was imported") });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual([l.event]);
    expect((await inventory(productId)).events).toBe(0);
  }, 120_000);
});

function artifactFor(name: string, format: PayloadFormat): SchemaArtifact {
  return format === "avro"
    ? { format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } }
    : { format: "json-schema", dialect: "draft-07", schema: { type: "object", title: name, properties: { id: { type: "string" } } } };
}

describe("importAsyncApi: the imported event publishes once its entities are published and pinned", () => {
  it("is blocked while the entities are drafts, then publishes after publishEntity and pinning their versions", async () => {
    const { ctx, productId, owner } = await setup();
    const { eventId } = unwrap(await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx));
    const entities = await entitiesOf(productId);
    expect(entities.length).toBeGreaterThan(0);

    const names = new Map<string, string>(entities.map((e) => [e.id, e.name]));
    const renderer: ArtifactRenderer = {
      async render(subject, format) {
        const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
        const name = names.get(id);
        if (!name) return err({ code: "NOT_FOUND", message: `no stub for ${id}` });
        return ok({ artifact: artifactFor(name, format), warnings: [] });
      },
    };

    // drafts: the pins carry no version, the event cannot be published
    const blocked = await publishEvent(eventId, productId, {}, ctx, { renderer });
    expect(failure(blocked)).toMatchObject({ code: "PUBLISH_BLOCKED" });
    const blockers = (failure(blocked)?.details as { blockers: Array<{ kind: string }> }).blockers;
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.every((b) => b.kind === "UNPUBLISHED_PIN")).toBe(true);

    // publish the entities, then pin the published versions in the saved document: the pins the import wrote are the ones that carry them
    const doc = await storedDocument(eventId);
    for (const entity of entities) unwrap(await publishEntity(entity.id, {}, ctx));
    const versions = await prisma.entityVersion.findMany({ where: { entityId: { in: entities.map((e) => e.id) } } });
    for (const version of versions) names.set(version.id, names.get(version.entityId) as string);
    const versionOf = (entityId: string) => versions.find((v) => v.entityId === entityId)?.id as string;
    const pinned: EventDocument = {
      ...doc,
      messages: doc.messages.map((m) => ({
        ...m,
        payload: { entityId: m.payload.entityId, entityVersionId: versionOf(m.payload.entityId) },
        ...(m.headers && { headers: { entityId: m.headers.entityId, entityVersionId: versionOf(m.headers.entityId) } }),
      })),
    };
    unwrap(await updateEventDocument(eventId, pinned, owner, ctx));

    const published = unwrap(await publishEvent(eventId, productId, {}, ctx, { renderer }));
    expect(published.label).toBe("1.0");
  }, 240_000);
});
