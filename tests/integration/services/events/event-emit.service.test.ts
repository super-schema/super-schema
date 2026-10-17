import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { JsonObject, PayloadFormat, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { EntityPin } from "@/lib/events/types";
import { err, ok, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { ArtifactRenderer, ArtifactSubject } from "@/services/events/artifact-renderer";
import { emitEventDocumentPreview, emitEventDraft, emitEventStoredVersion } from "@/services/events/event-emit.service";
import { createEvent, updateEventDocument } from "@/services/events/event.service";
import { getExternalVersionItems } from "@/services/events/external-refs.service";
import { loadEventSnapshot, resolveEventSnapshot } from "@/services/events/event-snapshot";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let other: Awaited<ReturnType<typeof createProductScope>>;

let order: { entity: { id: string }; version: { id: string } };
let orderKey: { entity: { id: string }; version: { id: string } };
let ceHeaders: { entity: { id: string }; version: { id: string } };
let draftling: { id: string };
let libraryTrait: { id: string; name: string };
let externalEvent: { id: string };
let externalVersion: { id: string };
let legacyExternalVersion: { id: string };

/** Entity (or entity-version) id → the model name its stub artifact carries. */
const modelNames = new Map<string, string>();
const errorsOf = <T extends { severity: string }>(diagnostics: T[]): T[] => diagnostics.filter((d) => d.severity === "error");
const obj = (value: unknown): JsonObject => value as JsonObject;
const pin = (e: { id: string }, v?: { id: string }): EntityPin => ({ entityId: e.id, entityVersionId: v?.id ?? null });

/** An entity plus a directly inserted published version (publishEntity would write immutable audit rows into the shared dev DB). */
async function frozenEntity(scope: typeof own, name: string) {
  const entity = await scope.entity(name, [{ name: "id", type: "string" }]);
  const version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
    },
  });
  modelNames.set(entity.id, name);
  modelNames.set(version.id, name);
  return { entity, version };
}

function artifactFor(name: string, format: PayloadFormat): SchemaArtifact {
  if (format === "avro") return { format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } };
  if (format === "json-schema") {
    return { format: "json-schema", dialect: "2020-12", schema: { type: "object", title: name, properties: { id: { type: "string" } }, required: ["id"] } };
  }
  return { format: "protobuf", schema: `syntax = "proto3";\nmessage ${name} { string id = 1; }\n` };
}

type RenderCall = { subject: ArtifactSubject; format: PayloadFormat };
const callKey = (c: RenderCall) => `${c.subject.kind === "version" ? `version:${c.subject.entityVersionId}` : `draft:${c.subject.entityId}`}:${c.format}`;

/** The renderer stand-in: records every call, returns a tiny artifact named after the entity, and fails on request. */
function stubRenderer(fail?: (call: RenderCall) => ServiceError | undefined) {
  const calls: RenderCall[] = [];
  const renderer: ArtifactRenderer = {
    async render(subject, format) {
      calls.push({ subject, format });
      const failure = fail?.({ subject, format });
      if (failure) return err(failure);
      const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
      return ok({ artifact: artifactFor(modelNames.get(id) ?? "Unknown", format), warnings: [] });
    },
  };
  return { renderer, calls };
}

function avroChannel(key = "orders", messageKeys = ["order-created"]): EventDocument["channels"][number] {
  return { key, address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], bindings: { kafka: { partitions: 12 } }, format: "avro", messageKeys };
}

/** A complete, valid v2 document: one Kafka/Avro channel, one message pinned to the published Order, one send operation. */
function orderDocument(title = "checkout-service"): EventDocument {
  return {
    ...emptyEventDocument(title),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [avroChannel()],
    messages: [{ key: "order-created", contentType: "avro/binary", payload: pin(order.entity, order.version), traitKeys: [] }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
  };
}

/** Events are seeded straight into the table (the event service is built separately); `document` is any JSON. */
async function seedEvent(document: unknown, scope: typeof own = own) {
  return prisma.eventSpec.create({
    data: {
      name: `evt-${stamp()}`, tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id,
      document: document as Prisma.InputJsonValue,
    },
  });
}

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

const externalResolvedSpec = (): ResolvedEventSpec => {
  const slug = other.product.slug;
  return {
    productSlug: slug,
    info: { title: "payments", version: "1.0" },
    servers: [],
    operations: [],
    channels: [{ id: "payments-in", name: "payments-in", productSlug: slug, address: "payments.in.v1", protocol: "kafka", profile: { format: "avro" } }],
    messages: [{
      id: "PaymentReceived", name: "PaymentReceived", productSlug: slug, contentType: "avro/binary", traitRefs: ["Audited"],
      payloads: [artifactFor("PaymentReceived", "avro")],
    }],
    traits: [{ id: "Audited", name: "Audited", kind: "MESSAGE", ownerSlug: slug, spec: { summary: "Audited message" } }],
    components: {},
  };
};

/** receive-side document: an external channel and an external message, no local rendering at all. */
function externalDocument(versionId: string): EventDocument {
  return {
    ...emptyEventDocument("fraud-scorer"),
    externalRefs: [
      { key: "payments-in", eventVersionId: versionId, kind: "channel", itemKey: "payments-in" },
      { key: "payment-received", eventVersionId: versionId, kind: "message", itemKey: "PaymentReceived" },
    ],
    operations: [{ key: "consumePayment", action: "receive", channelKey: "payments-in", messageKeys: ["payment-received"], traitKeys: [] }],
  };
}

async function seedVersion(eventSpecId: string, data: Partial<Prisma.EventSpecVersionUncheckedCreateInput> & { major: number; minor: number; sequence: number }) {
  return createEventSpecVersion(prisma, {
    eventSpecId, changeKind: "INITIAL", publishedById: ctx.userId,
    document: { asyncapi: "3.0.0" }, sourceDocument: {}, frozenTraits: [],
    ...data,
  });
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  own = await createProductScope(prisma, ctx, "ee");
  other = await createProductScope(prisma, ctx, "ex");

  order = await frozenEntity(own, "Order");
  orderKey = await frozenEntity(own, "OrderKey");
  ceHeaders = await frozenEntity(own, "CloudEventsHeaders");
  draftling = await own.entity("Draftling", [{ name: "draftOnlyField", type: "string" }]);
  modelNames.set(draftling.id, "Draftling");

  libraryTrait = await prisma.trait.create({
    data: {
      kind: "MESSAGE", name: `CloudEvents-${own.s}`, spec: { summary: "CloudEvents binary mode" }, tenantId: TENANT, domainId: own.domain.id,
      headersEntityId: ceHeaders.entity.id, headersEntityVersionId: ceHeaders.version.id,
    },
  });

  // Another product's event with two published versions: 1.0 carries a stored resolvedSpec, 1.1 predates document v2 (none).
  externalEvent = await prisma.eventSpec.create({
    data: { name: `payments-${other.s}`, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id, document: emptyEventDocument("payments") as unknown as Prisma.InputJsonValue },
  });
  externalVersion = await seedVersion(externalEvent.id, { major: 1, minor: 0, sequence: 1, resolvedSpec: externalResolvedSpec() as unknown as Prisma.InputJsonValue });
  legacyExternalVersion = await seedVersion(externalEvent.id, { major: 1, minor: 1, sequence: 2 });
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [own?.domain.id, other?.domain.id]);
  await prisma.$disconnect();
});

describe.sequential("emitEventDraft / emitEventDocumentPreview / emitEventStoredVersion", () => {
  it("emits an AsyncAPI document for a draft with one pinned message", async () => {
    const event = await seedEvent(orderDocument());
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    const doc = obj(out.document);
    expect(doc.asyncapi).toBe("3.0.0");
    expect(doc.info).toEqual({ title: "checkout-service", version: "draft" });
    expect(Object.keys(obj(doc.channels))).toEqual(["orders"]);
    expect(obj(obj(doc.channels).orders).address).toBe("payments.orders.v1");
    expect(Object.keys(obj(doc.operations))).toEqual(["publishOrderCreated"]);
    const message = obj(obj(obj(doc.components).messages)["order-created"]);
    expect(message.contentType).toBe("avro/binary");
    expect(obj(message.payload).schemaFormat).toBe("application/vnd.apache.avro+json;version=1.9.0");
    expect(obj(message.payload).schema).toMatchObject({ type: "record", name: "Order" });
    expect(out.json).toBeTruthy();
    expect(out.yaml).toContain("asyncapi: 3.0.0");
    expect(JSON.parse(out.json as string)).toEqual(doc);
    // the pinned version is rendered as that version, in the channel's format: nothing else is rendered
    expect(calls.map(callKey)).toEqual([`version:${order.version.id}:avro`]);
  }, 60_000);

  it("previews unsaved edits without writing", async () => {
    const event = await seedEvent(orderDocument());
    const before = await prisma.eventSpec.findUniqueOrThrow({ where: { id: event.id } });
    const { renderer } = stubRenderer();

    const edited = orderDocument("edited-title");
    edited.operations[0].summary = "Published when an order is placed";
    const out = unwrap(await emitEventDocumentPreview(event.id, own.product.id, edited, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(obj(out.document).info).toEqual({ title: "edited-title", version: "draft" });
    expect(JSON.stringify(out.document)).toContain("Published when an order is placed");
    // nothing was written: not the document, not the row's timestamps / flags, no version, no edges
    const after = await prisma.eventSpec.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.document).toEqual(before.document);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.hasUnpublishedChanges).toBe(before.hasUnpublishedChanges);
    expect(after.latestVersionId).toBeNull();
    expect(await prisma.eventSpecVersion.count({ where: { eventSpecId: event.id } })).toBe(0);
    expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC", fromId: event.id } })).toBe(0);
    // and the stored draft still emits as saved
    const saved = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));
    expect(obj(saved.document).info).toEqual({ title: "checkout-service", version: "draft" });
  }, 60_000);

  it("reports a diagnostic and still returns when a payload cannot be rendered", async () => {
    const event = await seedEvent(orderDocument());
    const { renderer } = stubRenderer((c) =>
      c.subject.kind === "version" && c.subject.entityVersionId === order.version.id
        ? { code: "ROOT_MODEL_NOT_FOUND", message: "Order has no root model" }
        : undefined
    );

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    // resolved is null: diagnostics only, no document
    expect(out.document).toBeNull();
    expect(out.json).toBeNull();
    expect(out.yaml).toBeNull();
    expect(errorsOf(out.diagnostics)).toEqual(
      expect.arrayContaining([
        // the render failure names the message key and points at its payload pin in the draft document
        { severity: "error", code: "ROOT_MODEL_NOT_FOUND", message: "Message order-created payload (avro): Order has no root model", pointer: "/messages/0/payload" },
        // the message is skipped, so the resolver reports it unresolved at the message itself
        { severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Message "order-created" has no rendered payload', pointer: "/messages/0" },
      ])
    );
    expect(errorsOf(out.diagnostics)).toHaveLength(2);
  }, 60_000);

  it("shows only sanitized render failures: raw emitter output and paths never reach the diagnostics", async () => {
    const event = await seedEvent(orderDocument());
    const secret = "SECRET-TOKEN-123 at /tmp/superschema-tsp-abc/main.tsp";
    const { renderer } = stubRenderer(() => ({ code: "EMITTER_FAILED", message: secret }));
    const silenced = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));
      expect(out.document).toBeNull();
      const failure = out.diagnostics.find((d) => d.code === "EMITTER_FAILED");
      expect(failure?.message).toBe("Message order-created payload (avro): Artifact render failed");
      expect(JSON.stringify(out.diagnostics)).not.toContain("SECRET-TOKEN-123");
      expect(JSON.stringify(out.diagnostics)).not.toContain("/tmp/");
    } finally {
      silenced.mockRestore();
    }
  }, 60_000);

  it("uses an unpublished entity draft for the preview", async () => {
    const doc = orderDocument();
    doc.messages[0].payload = pin(draftling); // entityVersionId null = not pinned yet
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(calls.map((c) => c.subject)).toEqual([{ kind: "draft", entityId: draftling.id }]);
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(obj(obj(obj(obj(out.document).components).messages)["order-created"]).payload).toMatchObject({ schema: { type: "record", name: "Draftling" } });
    // the preview says what it did, at the pin, without blocking
    expect(out.diagnostics).toContainEqual(expect.objectContaining({ severity: "info", code: "UNPUBLISHED_PIN", pointer: "/messages/0/payload" }));
  }, 60_000);

  it("substitutes an external message from a published version's resolvedSpec", async () => {
    const event = await seedEvent(externalDocument(externalVersion.id));
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    const doc = obj(out.document);
    // the external channel and message come from the stored resolvedSpec; the draft itself needs no rendering
    expect(calls).toEqual([]);
    expect(Object.keys(obj(doc.channels))).toEqual(["payments-in"]);
    expect(obj(obj(doc.channels)["payments-in"]).address).toBe("payments.in.v1");
    expect(Object.keys(obj(doc.operations))).toEqual(["consumePayment"]);
    expect(obj(obj(doc.operations).consumePayment).action).toBe("receive");
    const message = obj(obj(obj(doc.components).messages).PaymentReceived);
    expect(message.contentType).toBe("avro/binary");
    expect(obj(message.payload).schema).toMatchObject({ type: "record", name: "PaymentReceived" });
    // the message's own trait travels with it
    expect(obj(obj(doc.components).messageTraits)).toEqual({ Audited: { summary: "Audited message" } });
    expect(message.traits).toEqual([{ $ref: "#/components/messageTraits/Audited" }]);
  }, 60_000);

  it("emits a stored version from the saved AsyncAPI document without rendering", async () => {
    // The saved draft points at an entity that does not exist: any attempt to re-render it would fail, so a clean emission of the
    // stored document (which is also not what a regeneration would produce) shows the version is read as stored, never re-rendered.
    const unrenderable = orderDocument();
    unrenderable.messages[0].payload = { entityId: "no-such-entity", entityVersionId: "no-such-entity-version" };
    const event = await seedEvent(unrenderable);
    const stored: JsonObject = { asyncapi: "3.0.0", info: { title: "stored", version: "1.0" }, components: {}, operations: {}, channels: {}, servers: {} };
    await seedVersion(event.id, {
      major: 1, minor: 0, sequence: 1, document: stored,
      compatReport: { reasons: [], diagnostics: [{ severity: "warning", code: "PAYLOAD_NOT_VALIDATED", message: "kept", pointer: "" }] },
    });

    const out = unwrap(await emitEventStoredVersion(event.id, own.product.id, "1.0", ctx));

    expect(out.document).toEqual(stored);
    expect(JSON.parse(out.json)).toEqual(stored);
    expect(out.yaml).toContain("title: stored");
    // jsonb hands the keys back shortest-first; the emission restores the canonical AsyncAPI order
    expect(Object.keys(out.document)).toEqual(["asyncapi", "info", "servers", "channels", "operations", "components"]);
    expect(out.json.startsWith('{\n  "asyncapi": "3.0.0",\n  "info": {')).toBe(true);
    expect(out.diagnostics).toEqual([{ severity: "warning", code: "PAYLOAD_NOT_VALIDATED", message: "kept", pointer: "" }]);

    const missing = await emitEventStoredVersion(event.id, own.product.id, "9.9", ctx);
    expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    const malformed = await emitEventStoredVersion(event.id, own.product.id, "v1", ctx);
    expect(!malformed.success && malformed.error.code).toBe("VALIDATION_ERROR");
  }, 60_000);

  it("rejects a preview document that fails the parser, with pointer problems", async () => {
    const event = await seedEvent(orderDocument());
    const { renderer, calls } = stubRenderer();
    const bad = orderDocument();
    bad.messages[0].key = "has a space";
    bad.operations[0].channelKey = "gone";

    const r = await emitEventDocumentPreview(event.id, own.product.id, bad, ctx, { renderer });

    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("VALIDATION_ERROR");
    const problems = (r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems;
    expect(problems.map((p) => p.pointer)).toEqual(expect.arrayContaining(["/messages/0/key", "/operations/0/channelKey"]));
    expect(problems.every((p) => typeof p.message === "string" && p.message.length > 0)).toBe(true);
    // not an object at all
    const notObject = await emitEventDocumentPreview(event.id, own.product.id, null, ctx, { renderer });
    expect(!notObject.success && notObject.error.code).toBe("VALIDATION_ERROR");
    expect(!notObject.success && (notObject.error.details as { problems: Array<{ pointer: string }> }).problems[0].pointer).toBe("");
    // a legacy (v1) document is not a v2 document
    const legacy = await emitEventDocumentPreview(event.id, own.product.id, { info: { title: "x" }, servers: [], operations: [] }, ctx, { renderer });
    expect(!legacy.success && legacy.error.code).toBe("VALIDATION_ERROR");
    expect(calls).toEqual([]); // nothing was rendered for any of them
  }, 60_000);

  it("rejects an event that belongs to another product", async () => {
    const foreign = await seedEvent(orderDocument(), other);
    const { renderer, calls } = stubRenderer();

    const results = [
      await emitEventDraft(foreign.id, own.product.id, ctx, { renderer }),
      await emitEventDocumentPreview(foreign.id, own.product.id, orderDocument(), ctx, { renderer }),
      await emitEventStoredVersion(foreign.id, own.product.id, "1.0", ctx),
    ];
    for (const r of results) {
      expect(!r.success && r.error.code).toBe("FORBIDDEN");
      expect(!r.success && r.error.details).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(foreign.name); // a foreign event's name never leaks
    }
    expect(calls).toEqual([]);

    const unknown = await emitEventDraft("no-such-event", own.product.id, ctx, { renderer });
    expect(!unknown.success && unknown.error.code).toBe("NOT_FOUND");
    const unknownProduct = await emitEventDraft(foreign.id, "no-such-product", ctx, { renderer });
    expect(!unknownProduct.success && unknownProduct.error.code).toBe("NOT_FOUND");
    const blank = await emitEventDraft("", own.product.id, ctx, { renderer });
    expect(!blank.success && blank.error.code).toBe("VALIDATION_ERROR");
  }, 60_000);

  it("maps an unexpected database failure to a DB_ERROR Result", async () => {
    // a library trait makes the snapshot read the traits table, so a failure there happens after the ownership check passed
    const withLibraryTrait: EventDocument = { ...orderDocument(), traits: [{ key: "ce", kind: "MESSAGE", libraryTraitId: libraryTrait.id }] };
    const event = await seedEvent(withLibraryTrait);
    const { renderer } = stubRenderer();
    const silenced = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cases = [
        failing("eventSpec", "findUnique"), // the very first read fails
        failing("trait", "findMany"), // the ownership check passes, then loading the snapshot loses the connection
      ];
      for (const broken of cases) {
        for (const r of [
          await emitEventDraft(event.id, own.product.id, broken, { renderer }),
          await emitEventDocumentPreview(event.id, own.product.id, withLibraryTrait, broken, { renderer }),
        ]) {
          expect(!r.success && r.error.code).toBe("DB_ERROR");
          expect(JSON.stringify(r)).not.toMatch(/connection lost|SECRET-HOST/);
        }
      }
      // the stored emission reads the version row
      const stored = await emitEventStoredVersion(event.id, own.product.id, "1.0", failing("eventSpecVersion", "findUnique"));
      expect(!stored.success && stored.error.code).toBe("DB_ERROR");
      expect(JSON.stringify(stored)).not.toMatch(/connection lost|SECRET-HOST/);
    } finally {
      silenced.mockRestore();
    }
  }, 60_000);

});

describe.sequential("event document rendering plan", () => {
  it("renders payload, Kafka key, headers and trait headers in the right formats and as the right subjects", async () => {
    const doc = orderDocument();
    doc.messages[0].keyPin = pin(orderKey.entity, orderKey.version);
    doc.messages[0].headers = pin(ceHeaders.entity, ceHeaders.version);
    doc.messages[0].traitKeys = ["audit-headers", "cloud-events"];
    doc.traits = [
      { key: "audit-headers", kind: "MESSAGE", spec: { summary: "Audit headers" }, headers: pin(ceHeaders.entity, ceHeaders.version) },
      { key: "cloud-events", kind: "MESSAGE", libraryTraitId: libraryTrait.id },
      { key: "idempotent", kind: "OPERATION", spec: { summary: "Safe to retry" } },
    ];
    doc.operations[0].traitKeys = ["idempotent"];
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(calls.map(callKey).sort()).toEqual([
      `version:${order.version.id}:avro`,
      `version:${orderKey.version.id}:avro`, // Kafka key on an Avro channel is Avro
      `version:${ceHeaders.version.id}:json-schema`, // message headers
      `version:${ceHeaders.version.id}:json-schema`, // local trait headers
      `version:${ceHeaders.version.id}:json-schema`, // library trait headers (the trait's own pin)
    ].sort());
    const components = obj(obj(out.document).components);
    const message = obj(obj(components.messages)["order-created"]);
    expect(obj(obj(message.bindings).kafka).key).toMatchObject({ schemaFormat: "application/vnd.apache.avro+json;version=1.9.0", schema: { type: "record", name: "OrderKey" } });
    expect(obj(message.headers).type).toBe("object");
    const traits = obj(components.messageTraits);
    // a local trait is named by its key; a library trait keeps the name it has in the library
    expect(Object.keys(traits).sort()).toEqual(["audit-headers", libraryTrait.name].sort());
    expect(obj(obj(traits["audit-headers"]).headers).type).toBe("object");
    expect(obj(obj(traits[libraryTrait.name]).headers).type).toBe("object");
    expect(obj(traits[libraryTrait.name]).summary).toBe("CloudEvents binary mode");
    expect(obj(components.operationTraits)).toEqual({ idempotent: { summary: "Safe to retry" } });
  }, 60_000);

  it("renders every format a message is emitted in, and a trait header failure is reported at its pin", async () => {
    const doc = orderDocument();
    doc.channels.push({ key: "orders-json", address: "payments.orders.json.v1", protocol: "kafka", serverKeys: [], format: "json-schema", formatDialect: "draft-07", messageKeys: ["order-created"] });
    doc.operations.push({ key: "consumeOrderCreated", action: "receive", channelKey: "orders-json", messageKeys: ["order-created"], traitKeys: [] });
    doc.traits = [{ key: "broken", kind: "MESSAGE", spec: {}, headers: pin(ceHeaders.entity, ceHeaders.version) }];
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer((c) => (c.subject.kind === "version" && c.subject.entityVersionId === ceHeaders.version.id ? { code: "UNSUPPORTED_FORMAT", message: "no headers for you" } : undefined));
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));

    const { resolved, diagnostics } = await resolveEventSnapshot(snapshot, renderer, "draft");

    expect(calls.map(callKey).sort()).toEqual([
      `version:${ceHeaders.version.id}:json-schema`,
      `version:${order.version.id}:avro`,
      `version:${order.version.id}:json-schema`,
    ].sort());
    // an unrenderable trait header is reported (and blocks publish as an error) but does not make the document unresolvable
    expect(resolved).not.toBeNull();
    expect(diagnostics).toEqual([
      { severity: "error", code: "UNSUPPORTED_FORMAT", message: "Trait broken headers (json-schema): no headers for you", pointer: "/traits/0/headers" },
    ]);
  }, 60_000);
});

describe.sequential("loadEventSnapshot / resolveEventSnapshot", () => {
  it("loads the event, library traits, external items and the latest version", async () => {
    const doc = externalDocument(externalVersion.id);
    doc.traits = [{ key: "cloud-events", kind: "MESSAGE", libraryTraitId: libraryTrait.id }];
    const event = await seedEvent(doc);
    await seedVersion(event.id, { major: 3, minor: 2, sequence: 1, sourceDocument: doc as unknown as Prisma.InputJsonValue });
    const latest = await prisma.eventSpecVersion.findFirstOrThrow({ where: { eventSpecId: event.id } });
    await prisma.eventSpec.update({ where: { id: event.id }, data: { latestVersionId: latest.id } });

    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));

    expect(snapshot.event).toEqual({
      id: event.id, name: event.name, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id, productSlug: own.product.slug, specType: "asyncapi@3.0",
    });
    expect(snapshot.document).toEqual(doc);
    // publish reads the version's sequence (next sequence), its frozen traits (library drift) and its stored compat report (the
    // representations it was published in) from here; the version was seeded with the column's default report
    expect(snapshot.latest).toEqual({ id: latest.id, major: 3, minor: 2, sequence: 1, sourceDocument: doc, resolvedSpec: null, frozenTraits: [], compatReport: {} });
    expect([...snapshot.libraryTraits.keys()]).toEqual([libraryTrait.id]);
    expect(snapshot.libraryTraits.get(libraryTrait.id)).toMatchObject({ id: libraryTrait.id, name: libraryTrait.name, kind: "MESSAGE", ownerSlug: own.domain.slug, headersEntityVersionId: ceHeaders.version.id });
    // external items come from the referenced version's stored resolvedSpec, by externalRef key
    expect([...snapshot.external.keys()].sort()).toEqual(["payment-received", "payments-in"]);
    expect(snapshot.external.get("payments-in")?.channel).toMatchObject({ id: "payments-in", address: "payments.in.v1" });
    expect(snapshot.external.get("payment-received")?.message).toMatchObject({ id: "PaymentReceived", traitRefs: ["Audited"] });
    expect(snapshot.external.get("payment-received")?.traits).toEqual([expect.objectContaining({ id: "Audited", kind: "MESSAGE" })]);
    expect(snapshot.externalMajors).toEqual({ [externalVersion.id]: 1 });

    const stub = stubRenderer();
    const { resolved, diagnostics } = await resolveEventSnapshot(snapshot, stub.renderer, "2.0");
    expect(errorsOf(diagnostics)).toEqual([]);
    expect(resolved?.info.version).toBe("2.0");
    // every library trait renders its headers whether or not an operation uses it; the external items need no rendering
    expect(stub.calls.map(callKey)).toEqual([`version:${ceHeaders.version.id}:json-schema`]);
    // an external message's traits are scoped to its event version, so they never capture a local trait of the same key;
    // the emission carries every trait the document defines (emitAll), so the unused local library trait is there too
    expect(resolved?.messages.map((m) => m.id)).toEqual(["payment-received"]);
    expect(resolved?.messages[0].traitRefs).toEqual([`${externalVersion.id}:Audited`]);
    expect(resolved?.traits.map((t) => t.id)).toEqual([`${externalVersion.id}:Audited`, "cloud-events"]);
    expect(resolved?.channels.map((c) => c.id)).toEqual(["payments-in"]);
  }, 60_000);

  it("a document override replaces the stored draft and the stored draft is not parsed", async () => {
    const event = await seedEvent({ info: { title: "legacy v1 draft" }, servers: [], operations: [] }); // not a v2 document
    const corrupt = await loadEventSnapshot(prisma, event.id);
    expect(!corrupt.success && corrupt.error.code).toBe("DATA_CORRUPT");

    const override = orderDocument("from the editor");
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id, override));
    expect(snapshot.document).toBe(override);

    const draft = await emitEventDraft(event.id, own.product.id, ctx, { renderer: stubRenderer().renderer });
    expect(!draft.success && draft.error.code).toBe("DATA_CORRUPT");
    const preview = unwrap(await emitEventDocumentPreview(event.id, own.product.id, override, ctx, { renderer: stubRenderer().renderer }));
    expect(obj(preview.document).info).toEqual({ title: "from the editor", version: "draft" });
  }, 60_000);

  it("reports unresolved library traits and external refs by pointer instead of crashing", async () => {
    const doc = externalDocument(legacyExternalVersion.id); // 1.1 has no stored resolvedSpec
    doc.traits = [{ key: "ghost", kind: "MESSAGE", libraryTraitId: "no-such-trait" }];
    doc.externalRefs.push({ key: "elsewhere", eventVersionId: "no-such-version", kind: "message", itemKey: "Anything" });
    doc.externalRefs.push({ key: "missing-item", eventVersionId: externalVersion.id, kind: "message", itemKey: "NoSuchMessage" });
    const event = await seedEvent(doc);

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer: stubRenderer().renderer }));

    expect(out.document).toBeNull();
    const pointers = errorsOf(out.diagnostics).map((d) => `${d.code} ${d.pointer}`).sort();
    expect(pointers).toEqual([
      "UNRESOLVED_REFERENCE /externalRefs/0", // channel ref to a version with no resolvedSpec
      "UNRESOLVED_REFERENCE /externalRefs/1", // message ref to the same version
      "UNRESOLVED_REFERENCE /externalRefs/2", // version id that does not exist
      "UNRESOLVED_REFERENCE /externalRefs/3", // item that the stored resolvedSpec does not contain
      "UNRESOLVED_REFERENCE /traits/0/libraryTraitId",
    ].sort());
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));
    expect(snapshot.external.size).toBe(0);
    expect(snapshot.libraryTraits.size).toBe(0);
    // the version's major is known even though it has no resolvedSpec
    expect(snapshot.externalMajors).toEqual({ [legacyExternalVersion.id]: 1, [externalVersion.id]: 1 });
  }, 60_000);

  it("treats a corrupt stored item alike in the picker, on save and in the snapshot: not offered, not accepted, unresolved", async () => {
    // Items the ids of which exist but whose stored shape the assembler cannot use: no channel profile, no message payloads,
    // a traitRefs entry that is not a string. A readable item of the same spec stays usable.
    const spec = externalResolvedSpec();
    const [fine] = spec.messages;
    const corruptSpec = {
      ...spec,
      channels: [...spec.channels, { id: "no-profile", name: "no-profile", productSlug: other.product.slug, address: null, protocol: "kafka" }],
      messages: [
        fine,
        { id: "no-payloads", name: "no-payloads", productSlug: other.product.slug, traitRefs: [] },
        { ...fine, id: "bad-traits", name: "bad-traits", traitRefs: ["Audited", 7] },
      ],
    };
    const corruptEvent = await prisma.eventSpec.create({
      data: { name: `corrupt-${other.s}`, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id, document: emptyEventDocument("corrupt") as unknown as Prisma.InputJsonValue },
    });
    const corruptVersion = await seedVersion(corruptEvent.id, { major: 1, minor: 0, sequence: 1, resolvedSpec: corruptSpec as unknown as Prisma.InputJsonValue });
    const refs = [
      { key: "ok", eventVersionId: corruptVersion.id, kind: "message" as const, itemKey: "PaymentReceived" },
      { key: "chan", eventVersionId: corruptVersion.id, kind: "channel" as const, itemKey: "no-profile" },
      { key: "msg", eventVersionId: corruptVersion.id, kind: "message" as const, itemKey: "no-payloads" },
      { key: "traits", eventVersionId: corruptVersion.id, kind: "message" as const, itemKey: "bad-traits" },
    ];

    // The picker lists the readable message only.
    const items = unwrap(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: corruptVersion.id }));
    expect(items.channels.map((c) => c.key)).toEqual(["payments-in"]);
    expect(items.messages.map((m) => m.key)).toEqual(["PaymentReceived"]);

    // Save validation refuses the three corrupt refs and accepts the readable one.
    const consumer = unwrap(await createEvent(own.product.id, { name: `consumer-${own.s}` }, ctx));
    const owner = { level: "PRODUCT" as const, productId: own.product.id };
    const saved = await updateEventDocument(consumer.id, { ...emptyEventDocument("consumer"), externalRefs: refs }, owner, ctx);
    expect(saved.success).toBe(false);
    const problems = (!saved.success && (saved.error.details as { problems: Array<{ pointer: string; message: string }> }).problems) || [];
    expect(problems.map((p) => p.pointer)).toEqual(["/externalRefs/1/itemKey", "/externalRefs/2/itemKey", "/externalRefs/3/itemKey"]);
    expect(unwrap(await updateEventDocument(consumer.id, { ...emptyEventDocument("consumer"), externalRefs: refs.slice(0, 1) }, owner, ctx)).document.externalRefs).toHaveLength(1);

    // The snapshot (a draft stored before the version was corrupted, here seeded directly) resolves the readable ref only.
    const event = await seedEvent({ ...emptyEventDocument("direct"), externalRefs: refs });
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));
    expect([...snapshot.external.keys()]).toEqual(["ok"]);
    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer: stubRenderer().renderer }));
    expect(errorsOf(out.diagnostics).map((d) => `${d.code} ${d.pointer}`).sort()).toEqual(
      ["UNRESOLVED_REFERENCE /externalRefs/1", "UNRESOLVED_REFERENCE /externalRefs/2", "UNRESOLVED_REFERENCE /externalRefs/3"]
    );
  }, 60_000);

  it("never reads another tenant's library traits or published events", async () => {
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const foreignEvent = await prisma.eventSpec.create({
        data: { name: `fe-${foreign.s}`, tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id, document: emptyEventDocument("foreign") as unknown as Prisma.InputJsonValue },
      });
      const foreignVersion = await seedVersion(foreignEvent.id, { major: 1, minor: 0, sequence: 1, resolvedSpec: externalResolvedSpec() as unknown as Prisma.InputJsonValue });
      const doc = externalDocument(foreignVersion.id);
      doc.traits = [{ key: "stolen", kind: "MESSAGE", libraryTraitId: foreign.trait.id }];
      const event = await seedEvent(doc);

      const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));
      expect(snapshot.libraryTraits.size).toBe(0);
      expect(snapshot.external.size).toBe(0);
      expect(snapshot.externalMajors).toEqual({});

      const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer: stubRenderer().renderer }));
      expect(out.document).toBeNull();
      expect(errorsOf(out.diagnostics).map((d) => d.pointer).sort()).toEqual(["/externalRefs/0", "/externalRefs/1", "/traits/0/libraryTraitId"]);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);
});

/** A published entity whose import recorded `metadata`. */
async function importedEntity(scope: typeof own, name: string, metadata: Prisma.InputJsonValue | null) {
  const made = await frozenEntity(scope, name);
  if (metadata !== null) await prisma.entity.update({ where: { id: made.entity.id }, data: { metadata } });
  return made;
}

/** A Pub/Sub channel that sets no format (Auto), carrying `messageKeys`. */
const autoChannel = (key: string, messageKeys: string[]): EventDocument["channels"][number] =>
  ({ key, address: `projects/acme/topics/${key}`, protocol: "googlepubsub", serverKeys: [], messageKeys });

describe.sequential("entity formats (R4 Auto) and emitAll through the snapshot", () => {
  it("loads the recorded source format of every payload entity — usable ones only, own tenant only", async () => {
    const avroEntity = await importedEntity(own, "AvroImported", { sourceFormat: "avro", tags: ["core"] });
    const jsonEntity = await importedEntity(own, "JsonImported", { sourceFormat: "json-schema" });
    const typespecEntity = await importedEntity(own, "TypeSpecImported", { sourceFormat: "typespec" });
    const plainEntity = await importedEntity(own, "NeverImported", null);
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      await prisma.entity.update({ where: { id: foreign.entity.id }, data: { metadata: { sourceFormat: "protobuf" } } });
      const doc: EventDocument = {
        ...emptyEventDocument("formats"),
        channels: [autoChannel("all", ["a", "b", "c", "d", "f"])],
        messages: [
          { key: "a", payload: pin(avroEntity.entity, avroEntity.version), traitKeys: [] },
          { key: "b", payload: pin(jsonEntity.entity, jsonEntity.version), traitKeys: [] },
          { key: "c", payload: pin(typespecEntity.entity, typespecEntity.version), traitKeys: [] },
          { key: "d", payload: pin(plainEntity.entity, plainEntity.version), traitKeys: [] },
          { key: "f", payload: { entityId: foreign.entity.id, entityVersionId: foreign.version.id }, traitKeys: [] },
        ],
      };
      const event = await seedEvent(doc);

      const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));

      expect(Object.fromEntries(snapshot.entityFormats)).toEqual({ [avroEntity.entity.id]: "avro", [jsonEntity.entity.id]: "json-schema" });
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("an event with no messages loads no entity formats", async () => {
    const event = await seedEvent(emptyEventDocument("empty"));
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));
    expect(snapshot.entityFormats.size).toBe(0);
  }, 60_000);

  it("Auto: an Avro-imported entity on a Pub/Sub channel without a format is rendered and emitted as Avro, others as JSON Schema", async () => {
    const imported = await importedEntity(own, "ImportedFromAvro", { sourceFormat: "avro" });
    const doc: EventDocument = {
      ...emptyEventDocument("auto"),
      servers: [{ key: "pubsub", protocol: "googlepubsub", host: "pubsub.googleapis.com" }],
      channels: [autoChannel("notices", ["from-avro", "plain"])],
      messages: [
        { key: "from-avro", payload: pin(imported.entity, imported.version), traitKeys: [] },
        { key: "plain", payload: pin(order.entity, order.version), traitKeys: [] },
      ],
      operations: [{ key: "publishNotices", action: "send", channelKey: "notices", messageKeys: ["from-avro", "plain"], traitKeys: [] }],
    };
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(calls.map(callKey).sort()).toEqual([`version:${imported.version.id}:avro`, `version:${order.version.id}:json-schema`].sort());
    const messages = obj(obj(obj(out.document).components).messages);
    expect(obj(obj(messages["from-avro"]).payload).schemaFormat).toBe("application/vnd.apache.avro+json;version=1.9.0");
    expect(obj(messages["from-avro"]).contentType).toBe("avro/binary");
    expect(obj(obj(messages.plain).payload).schemaFormat).toBe("application/schema+json;version=draft-07");
  }, 60_000);

  it("an explicit message representation beats the entity's recorded format", async () => {
    const imported = await importedEntity(own, "ImportedButOverridden", { sourceFormat: "avro" });
    const doc: EventDocument = {
      ...emptyEventDocument("override"),
      channels: [autoChannel("notices", ["m"])],
      messages: [{ key: "m", representation: "protobuf", payload: pin(imported.entity, imported.version), traitKeys: [] }],
      operations: [{ key: "publish", action: "send", channelKey: "notices", messageKeys: ["m"], traitKeys: [] }],
    };
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(calls.map(callKey)).toEqual([`version:${imported.version.id}:protobuf`]);
    expect(obj(obj(obj(obj(out.document).components).messages).m).payload).toMatchObject({ schemaFormat: "application/vnd.google.protobuf;version=3" });
  }, 60_000);

  it("emits everything the user defined: a channel without an operation, the messages it allows, an unattached message, unused traits, server references", async () => {
    const doc = orderDocument();
    doc.channels.push(autoChannel("idle", ["allowed"]));
    doc.messages.push(
      { key: "allowed", payload: pin(orderKey.entity, orderKey.version), traitKeys: ["unused-message-trait"] },
      { key: "unattached", payload: pin(draftling), traitKeys: [] },
    );
    doc.traits = [
      { key: "unused-message-trait", kind: "MESSAGE", spec: { summary: "Never used by an operation" } },
      { key: "unused-operation-trait", kind: "OPERATION", spec: { summary: "Also unused" } },
    ];
    const event = await seedEvent(doc);
    const { renderer, calls } = stubRenderer();

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    const document = obj(out.document);
    expect(Object.keys(obj(document.channels))).toEqual(["idle", "orders"]);
    expect(obj(obj(obj(document.channels).idle).messages)).toEqual({ allowed: { $ref: "#/components/messages/allowed" } });
    expect(obj(obj(document.channels).orders).servers).toEqual([{ $ref: "#/servers/kafka-prod" }]);
    expect(Object.keys(obj(obj(document.components).messages))).toEqual(["allowed", "order-created", "unattached"]);
    expect(obj(obj(obj(obj(document.components).messages).unattached).payload).schemaFormat).toBe("application/schema+json;version=draft-07");
    expect(obj(obj(document.components).messageTraits)).toEqual({ "unused-message-trait": { summary: "Never used by an operation" } });
    expect(obj(obj(document.components).operationTraits)).toEqual({ "unused-operation-trait": { summary: "Also unused" } });
    // the unattached message is rendered too: it has no channel, so its own effective format (JSON Schema) is used
    expect(calls.map(callKey)).toContain(`draft:${draftling.id}:json-schema`);
  }, 60_000);

  it("an unattached message whose payload cannot be rendered is reported at that message", async () => {
    const doc = orderDocument();
    doc.messages.push({ key: "unattached", payload: pin(draftling), traitKeys: [] });
    const event = await seedEvent(doc);
    const { renderer } = stubRenderer((c) => (c.subject.kind === "draft" && c.subject.entityId === draftling.id ? { code: "ROOT_MODEL_NOT_FOUND", message: "no root model" } : undefined));

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(out.document).toBeNull();
    expect(errorsOf(out.diagnostics).map((d) => d.pointer)).toEqual(expect.arrayContaining(["/messages/1/payload", "/messages/1"]));
  }, 60_000);
});
