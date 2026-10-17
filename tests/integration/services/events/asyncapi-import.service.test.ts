import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Parser } from "@asyncapi/parser";
import type { PrismaClient } from "@/generated/prisma/client";
import { withCompileTimeout } from "@/lib/compiler/import-limits";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { err, ok, type Result } from "@/types/result";
import type { PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { bundledMarker } from "@/lib/events/bundled-traits";
import { parseEventDocument } from "@/lib/events/document/parse";
import { isLibraryTrait, type EventDocument } from "@/lib/events/document/types";
import { mapAsyncApiToEventDocument } from "@/lib/events/import";
import type { ImportWarning } from "@/lib/events/import";
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
vi.mock("@/lib/compiler/import-limits", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/compiler/import-limits")>();
  return { ...original, withCompileTimeout: vi.fn(original.withCompileTimeout) };
});
vi.mock("@/lib/events/import", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/events/import")>();
  return { ...original, mapAsyncApiToEventDocument: vi.fn(original.mapAsyncApiToEventDocument) };
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
  return { ctx, scope, productId: scope.product.id, owner: { level: "PRODUCT" as const, productId: scope.product.id } };
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

describe("importAsyncApi: the happy path", () => {
  it("streetlights-kafka: draft entities (unpublished, sourceFormat, fields) and an event that pins them without a version", async () => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml"), fileName: "streetlights-kafka.yaml" }, ctx));

    expect(preview).toMatchObject({
      eventName: "Streetlights-Kafka-API", title: "Streetlights Kafka API",
      counts: { servers: 2, channels: 4, messages: 3, operations: 4, traits: 2, securitySchemes: 2 },
      builtInTraits: [],
    });
    expect(preview.entities).toEqual([
      { requestedName: "LightMeasured", name: "LightMeasured", renamed: false, fields: 2, format: "json-schema" },
      { requestedName: "TurnOnOff", name: "TurnOnOff", renamed: false, fields: 2, format: "json-schema" },
      { requestedName: "DimLight", name: "DimLight", renamed: false, fields: 2, format: "json-schema" },
    ]);

    const entities = await entitiesOf(productId);
    expect(entities.map((e) => e.name)).toEqual(["DimLight", "LightMeasured", "TurnOnOff"]);
    for (const entity of entities) {
      expect(entity.latestVersionId).toBeNull(); // a draft: nothing was published
      expect(entity.metadata).toEqual({ sourceFormat: "json-schema" });
      expect(entity.fields.length).toBe(2);
    }
    expect(await prisma.entityVersion.count({ where: { entity: { productId } } })).toBe(0);
    expect(entities.find((e) => e.name === "LightMeasured")?.fields.map((f) => f.name)).toEqual(["lumens", "sentAt"]);

    const event = unwrap(await getEvent(eventId, ctx));
    expect(event.name).toBe("Streetlights-Kafka-API");
    expect(event.hasUnpublishedChanges).toBe(true);
    const doc = await storedDocument(eventId);
    expect(doc.messages.map((m) => m.key).sort()).toEqual(["dimLight", "lightMeasured", "turnOnOff"]);
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

    const byName = new Map(preview.entities.map((e) => [e.name, e]));
    expect(byName.get("Reading")).toMatchObject({ format: "avro", fields: 2 }); // the Avro record keeps its name
    expect(byName.get("ProtoReading")).toMatchObject({ format: "protobuf", fields: 2 });
    expect(byName.get("ReadingAsyncAPISchema")).toMatchObject({ format: "json-schema" });
    expect(byName.get("ReadingDefaultSchemaFormatHeaders")).toMatchObject({ format: "json-schema", fields: 1 });
    expect(byName.get("ReadingOpenAPISchema")).toMatchObject({ format: "placeholder", fields: 0 });
    const rows = new Map((await entitiesOf(productId)).map((e) => [e.name, e]));
    expect(rows.get("Reading")?.metadata).toEqual({ sourceFormat: "avro" });
    expect(rows.get("ProtoReading")?.metadata).toEqual({ sourceFormat: "protobuf" });
    expect(rows.get("ReadingOpenAPISchema")?.metadata).toBeNull();
    // the headers entity is pinned as the headers of its message
    const doc = await storedDocument(eventId);
    const defaultSchema = doc.messages.find((m) => m.key === "defaultSchema");
    expect(defaultSchema?.headers).toEqual({ entityId: rows.get("ReadingDefaultSchemaFormatHeaders")?.id, entityVersionId: null });
    expect(warningCodes(preview.warnings)).toContain("UNSUPPORTED_PAYLOAD_FORMAT");
  }, 120_000);

  it("a message whose payload cannot be imported (OpenAPI, RAML, none) gets a placeholder entity with no fields and a warning", async () => {
    const { ctx, productId } = await setup();

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content: fixture("unsupported-payloads.yaml"), fileName: "unsupported-payloads.yaml" }, ctx));

    expect(preview.entities.map((e) => [e.name, e.format, e.fields])).toEqual([
      ["PayloadWrittenAsAnOpenAPISchema", "placeholder", 0], ["AMessageWithNoPayloadAtAll", "placeholder", 0], ["PayloadWrittenAsRAML", "placeholder", 0],
    ]);
    expect(warningCodes(preview.warnings).filter((code) => code === "UNSUPPORTED_PAYLOAD_FORMAT")).toHaveLength(2);
    expect(warningCodes(preview.warnings)).toContain("NO_PAYLOAD");
    const entities = await entitiesOf(productId);
    expect(entities.every((e) => e.fields.length === 0 && e.latestVersionId === null)).toBe(true);
    expect(entities.find((e) => e.name === "AMessageWithNoPayloadAtAll")?.description).toContain("unsupported-payloads.yaml");
    const doc = await storedDocument(eventId);
    expect(doc.messages.map((m) => m.payload.entityId).sort()).toEqual(entities.map((e) => e.id).sort());
  }, 120_000);

  it("a schema the importer rejects gets a placeholder with the importer's own reason; headers it rejects are left out", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("Odd schemas", {
      scalarPayload: { payload: { type: "string" }, headers: { type: "object" } },
    });

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.name, e.format])).toEqual([["ScalarPayload", "placeholder"]]);
    const reasons = preview.warnings.filter((w) => w.code === "UNSUPPORTED_PAYLOAD_FORMAT").map((w) => w.message);
    expect(reasons.some((m) => m.includes("payload") && m.includes("could not be imported"))).toBe(true);
    expect(reasons.some((m) => m.includes("headers") && m.includes("left out"))).toBe(true);
    const doc = await storedDocument(eventId);
    expect(doc.messages[0].headers).toBeUndefined();
  }, 120_000);

  it("headers in a format the importer cannot read get NO placeholder entity: the payload's entity exists, the headers are left out, both are reported", async () => {
    const { ctx, productId } = await setup();
    const avroHeaders = { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "Envelope", fields: [{ name: "trace", type: "string" }] } };
    const content = smallDocument("Odd headers", { m: { payload: objectPayload("id"), headers: avroHeaders } });

    const { eventId, preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.name, e.format])).toEqual([["M", "json-schema"]]);
    expect(preview.warnings.some((w) => w.code === "UNSUPPORTED_PAYLOAD_FORMAT" && w.message.includes("headers"))).toBe(true);
    expect(preview.warnings.some((w) => w.code === "DROPPED_CONSTRUCT" && w.message.includes("headers"))).toBe(true);
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["M"]);
    expect((await storedDocument(eventId)).messages[0].headers).toBeUndefined();
  }, 120_000);

  it("rewrites references to a renamed entity of the same payload (an Avro record that nests and refers to itself)", async () => {
    const { ctx, scope, productId } = await setup();
    await scope.entity("Address");
    await scope.entity("Order");
    const avro = {
      type: "record", name: "Order", fields: [
        { name: "to", type: { type: "record", name: "Address", fields: [{ name: "street", type: "string" }] } },
        { name: "next", type: ["null", "Order"] },
      ],
    };
    const content = smallDocument("Shipping", { shipment: { payload: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: avro } } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed, e.format])).toEqual([
      ["Order", "Order2", true, "avro"], ["Address", "Address2", true, "avro"],
    ]);
    const rows = new Map((await entitiesOf(productId)).map((e) => [e.name, e]));
    const referenceOf = (entity: string, field: string) => (rows.get(entity)?.fields.find((f) => f.name === field)?.decorators as { referencedEntityName?: string } | null)?.referencedEntityName;
    expect(referenceOf("Order2", "to")).toBe("Address2");
    expect(referenceOf("Order2", "next")).toBe("Order2"); // a self reference follows the new name too
    expect(rows.get("Order")?.fields.map((f) => f.name)).toEqual(["id"]); // the entity that was there is untouched
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
    const { ctx, scope } = await setup();
    await scope.entity("LightMeasured"); // a taken name in the default tenant
    const foreign = await createForeignTenantFixture(prisma, ctx);
    cleanups.push(foreign.cleanup);

    const { eventId, preview } = unwrap(await importAsyncApi(foreign.product.id, { content: fixture("builtin-traits.yaml") }, ctx));

    const doc = await storedDocument(eventId);
    const foreignLibrary = await prisma.trait.findMany({ where: { tenantId: foreign.tenant.id, domainId: null, productId: null }, select: { id: true } });
    const ids = doc.traits.filter(isLibraryTrait).map((t) => t.libraryTraitId);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => foreignLibrary.some((t) => t.id === id))).toBe(true);
    const row = await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.tenantId).toBe(foreign.tenant.id);
    expect(preview.entities.every((e) => !e.renamed)).toBe(true);

    // and the names of the foreign tenant never rename an import in the default tenant
    const again = await setup();
    const other = unwrap(await previewAsyncApiImport(again.productId, { content: fixture("builtin-traits.yaml") }, again.ctx));
    expect(other.entities.every((e) => !e.renamed)).toBe(true);
  }, 120_000);
});

describe("importAsyncApi: names", () => {
  it("two payloads of one file with the same name: the second gets a suffix and a warning", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("Twins", { a: { name: "Order", payload: objectPayload("id") }, b: { name: "Order", payload: objectPayload("sku") } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed])).toEqual([["Order", "Order", false], ["Order", "Order2", true]]);
    expect(preview.warnings.filter((w) => w.code === "ENTITY_RENAMED")).toHaveLength(1);
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["Order", "Order2"]);
  }, 120_000);

  it("the same file twice: the second import renames everything (entities and event) and never errors", async () => {
    const { ctx, productId } = await setup();
    const input = { content: fixture("streetlights-kafka.yaml") };
    const first = unwrap(await importAsyncApi(productId, input, ctx));

    const second = unwrap(await importAsyncApi(productId, input, ctx));

    expect(first.preview.eventName).toBe("Streetlights-Kafka-API");
    expect(second.preview.eventName).toBe("Streetlights-Kafka-API2");
    expect(second.preview.entities.map((e) => [e.name, e.renamed])).toEqual([["LightMeasured2", true], ["TurnOnOff2", true], ["DimLight2", true]]);
    expect(second.preview.warnings.filter((w) => w.code === "ENTITY_RENAMED")).toHaveLength(4);
    expect(await inventory(productId)).toEqual({ entities: 6, events: 2 });
    const doc = await storedDocument(second.eventId);
    const ids = new Set((await entitiesOf(productId)).filter((e) => e.name.endsWith("2")).map((e) => e.id));
    expect(doc.messages.every((m) => ids.has(m.payload.entityId))).toBe(true);
  }, 120_000);

  it("a name already in the product (any case) is renamed", async () => {
    const { ctx, scope, productId } = await setup();
    await scope.entity("LightMeasured");
    await scope.entity("TURNONOFF");

    const { preview } = unwrap(await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name])).toEqual([["LightMeasured", "LightMeasured2"], ["TurnOnOff", "TurnOnOff2"], ["DimLight", "DimLight"]]);
  }, 120_000);

  it("a reserved route name (an entity cannot be called Messages) is renamed", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("Reserved", { a: { name: "Messages", payload: objectPayload("id") } });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => [e.requestedName, e.name, e.renamed])).toEqual([["Messages", "Messages2", true]]);
  }, 120_000);

  it("the event name is the title's slug; a taken event name, or an entity of that name, is resolved", async () => {
    const { ctx, scope, productId } = await setup();
    unwrap(await createEvent(productId, { name: "Streetlights-Kafka-API" }, ctx));
    await scope.entity("Streetlights-Kafka-API2");

    const { preview, eventId } = unwrap(await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));

    // the event and the entities share one line: `…2` is an entity, so the event is `…3`
    expect(preview.eventName).toBe("Streetlights-Kafka-API3");
    expect((await prisma.eventSpec.findUniqueOrThrow({ where: { id: eventId } })).name).toBe("Streetlights-Kafka-API3");
    expect(preview.warnings.find((w) => w.pointer === "" && w.code === "ENTITY_RENAMED")?.message).toContain("Streetlights-Kafka-API3");
  }, 120_000);

  it("an event name the user gives is used; a taken one is resolved; an invalid one is refused before anything runs", async () => {
    const { ctx, productId } = await setup();
    const content = fixture("request-reply.yaml");

    const named = unwrap(await importAsyncApi(productId, { content, eventName: "  my-prices " }, ctx));
    expect(named.preview.eventName).toBe("my-prices");
    const taken = unwrap(await previewAsyncApiImport(productId, { content, eventName: "my-prices" }, ctx));
    expect(taken.eventName).toBe("my-prices2");

    const before = await inventory(productId);
    const bad = await importAsyncApi(productId, { content, eventName: "not a valid name!" }, ctx);
    expect(codeOf(bad)).toBe("VALIDATION_ERROR");
    expect(await inventory(productId)).toEqual(before);
  }, 120_000);

  it("names its entities after the entity-name rules: a definition named with spaces and symbols becomes a valid name", async () => {
    const { ctx, productId } = await setup();
    const content = smallDocument("Weird names", {
      shipment: { payload: { type: "object", properties: { id: { type: "string" } }, $defs: { "Delivery address!": { type: "object", properties: { street: { type: "string" } } } } } },
    });

    const { preview } = unwrap(await importAsyncApi(productId, { content }, ctx));

    expect(preview.entities.map((e) => e.name)).toEqual(["Shipment", "DeliveryAddress"]);
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["DeliveryAddress", "Shipment"]);
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

  it("a parser that never answers cannot hang the import: the wait is bounded, the import is refused with COMPILE_TIMEOUT and nothing is created", async () => {
    const { ctx, productId } = await setup();
    const real = (await vi.importActual<typeof import("@/lib/compiler/import-limits")>("@/lib/compiler/import-limits")).withCompileTimeout;
    vi.mocked(withCompileTimeout).mockImplementationOnce((task) => real(task, 50)); // the same helper, a 50 ms wait instead of the real bound
    vi.spyOn(Parser.prototype, "validate").mockImplementationOnce(() => new Promise(() => undefined));

    const result = await importAsyncApi(productId, { content: fixture("request-reply.yaml") }, ctx);

    expect(failure(result)).toMatchObject({ code: "COMPILE_TIMEOUT", message: expect.stringContaining("Validating the AsyncAPI document took longer than"), suggestedFix: expect.any(String) });
    expect(vi.mocked(withCompileTimeout).mock.calls.at(-1)?.[1]).toBe(30_000); // the production bound passed by the service
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 120_000);
});

describe("previewAsyncApiImport", () => {
  it("writes nothing: no entity, event or trait appears, and the preview is what the import then does", async () => {
    const { ctx, productId } = await setup();
    const traitsBefore = await prisma.trait.count({ where: { tenantId: TENANT } });
    const before = await inventory(productId);

    const preview = unwrap(await previewAsyncApiImport(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));

    expect(await inventory(productId)).toEqual(before);
    expect(await prisma.trait.count({ where: { tenantId: TENANT } })).toBe(traitsBefore);
    expect(preview.entities.map((e) => e.name)).toEqual(["LightMeasured", "TurnOnOff", "DimLight"]);
    const imported = unwrap(await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx));
    expect(imported.preview).toEqual(preview);
  }, 120_000);

  it("reports the built-in traits it would use, and renames, without writing", async () => {
    const { ctx, scope, productId } = await setup();
    await scope.entity("OrderCreated");

    const preview = unwrap(await previewAsyncApiImport(productId, { content: fixture("builtin-traits.yaml") }, ctx));

    expect(preview.builtInTraits.sort()).toEqual(["CloudEvents", "TraceContext"]);
    expect(preview.entities.find((e) => e.requestedName === "OrderCreated")).toMatchObject({ name: "OrderCreated2", renamed: true });
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

  it("a document that would create more than 500 entities is refused up front (501 is over, nothing is created)", async () => {
    const { ctx, productId } = await setup();
    const content = manyMessages(501, 3);

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(failure(result)).toMatchObject({
      code: "VALIDATION_ERROR", message: expect.stringContaining("501 entities"), details: { entities: 501, limit: 500 }, suggestedFix: expect.stringContaining("Split"),
    });
    expect(codeOf(await previewAsyncApiImport(productId, { content }, ctx))).toBe("VALIDATION_ERROR");
  }, 120_000);

  it("a 5,000-message document is refused quickly and creates nothing", async () => {
    const { ctx, productId } = await setup();
    const content = manyMessages(5000);
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    const started = Date.now();

    const result = await nothingCreated(productId, () => importAsyncApi(productId, { content }, ctx));

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(failure(result)).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("5000 entities") });
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
    const { ctx, productId } = await setup();
    vi.mocked(updateEventDocument).mockResolvedValueOnce(err({ code: "CONFLICT", message: "The event changed while saving" }));
    // entities are taken back newest first: the first delete (DimLight) fails, the other two work
    vi.mocked(deleteEntity).mockResolvedValueOnce(err({ code: "IN_USE", message: 'Entity "DimLight" cannot be deleted: it is used by something' }));

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    const error = failure(result);
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("could not be undone completely");
    expect(error?.message).toContain('the entity "DimLight"');
    expect(error?.details).toMatchObject({ deletedEntities: 2, leftovers: [{ kind: "entity", name: "DimLight", code: "IN_USE" }] });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["DimLight"]);
    expect((await inventory(productId)).events).toBe(0);
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
    const { ctx, scope, productId } = await setup();
    // another writer takes the LAST entity's name between the read of the names and the write of the entities
    const racing = new Proxy(prisma, {
      get: (target, prop) =>
        prop === "$transaction"
          ? async (...args: unknown[]) => {
              if ((args[1] as { timeout?: number } | undefined)?.timeout === 60_000) await scope.entity("DimLight"); // the entity write's own options
              return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args);
            }
          : Reflect.get(target, prop),
    });

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, { ...ctx, prisma: racing as unknown as PrismaClient });

    expect(failure(result)).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("taken while it ran"), suggestedFix: "Import again." });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["DimLight"]); // only the other writer's entity; LightMeasured and TurnOnOff rolled back
    expect((await inventory(productId)).events).toBe(0);
  }, 120_000);

  it("an event name taken after it was resolved fails the event step and the entities are deleted again", async () => {
    const { ctx, scope, productId } = await setup();
    const real = vi.mocked(createEvent).getMockImplementation() as typeof createEvent;
    vi.mocked(createEvent).mockImplementationOnce(async (...args) => {
      await scope.entity("Streetlights-Kafka-API"); // an entity takes the event's resolved name
      return real(...args);
    });

    const result = await importAsyncApi(productId, { content: fixture("streetlights-kafka.yaml") }, ctx);

    expect(failure(result)).toMatchObject({ code: "NAME_CONFLICT", message: expect.stringContaining("Nothing was imported") });
    expect((await entitiesOf(productId)).map((e) => e.name)).toEqual(["Streetlights-Kafka-API"]);
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
