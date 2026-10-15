import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { createChannel } from "@/services/events/channel.service";
import { createEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { emitEventSpec, getLatestEventSpecVersionLabel } from "@/services/events/event-spec-emit.service";
import { createMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap, type TestField } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
let checkout: Awaited<ReturnType<typeof createProductScope>>;
let fraud: Awaited<ReturnType<typeof createProductScope>>;
let renderer: ReturnType<typeof createArtifactRenderer>;

let traitName: string;
let message: { id: string; name: string };
let messageVersionId: string;
let avroChannelId: string;
let jsonChannelId: string;
let producer: { id: string };
let consumer: { id: string };

const errorsOf = (diagnostics: Array<{ severity: string }>) => diagnostics.filter((d) => d.severity === "error");
const productOwner = (productId: string) => ({ level: "PRODUCT" as const, productId });

/**
 * Fixtures are shared by every test. `publishEntity` writes an immutable PUBLISH_VERSION audit row into the shared dev DB, so the
 * suite publishes exactly twice (Address, then Order which references it — the real generator output + the real FIELD pin).
 * The two simple fixtures (OrderKey, CloudEventsHeaders) and the MessageVersion / EventSpecVersion rows are inserted directly:
 * the resolver only reads `resolvedSource` / the pins, and Task 10 / Task 12 (publish) land in the same wave.
 */
async function frozenEntity(name: string, fields: TestField[]) {
  const entity = await checkout.entity(name, fields);
  const version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n${fields.map((f) => `  ${f.name}: ${f.type};`).join("\n")}\n}\n`,
      fieldSnapshot: fields.map((f, i) => ({ name: f.name, fieldNumber: i + 1 })),
    },
  });
  return { entity, version };
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  checkout = await createProductScope(prisma, ctx, "co");
  fraud = await createProductScope(prisma, ctx, "fr");
  renderer = createArtifactRenderer({ db: prisma });
  const s = checkout.s;

  const address = await checkout.publishedEntity("Address", [{ name: "street", type: "string" }]);
  const order = await checkout.publishedEntity("Order", [
    { name: "id", type: "string" },
    { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
  ]);
  const orderKey = await frozenEntity("OrderKey", [{ name: "id", type: "string" }]);
  const headers = await frozenEntity("CloudEventsHeaders", [
    { name: "ce_id", type: "string" }, { name: "ce_type", type: "string" }, { name: "ce_source", type: "string" },
  ]);

  const trait = unwrap(await createTrait({ level: "DOMAIN", domainId: checkout.domain.id }, {
    name: `CloudEvents-${s}`, kind: "MESSAGE", headers: { entityId: headers.entity.id, entityVersionId: headers.version.id },
  }, ctx));
  traitName = trait.name;

  const created = unwrap(await createMessage(checkout.product.id, {
    name: `OrderCreated-${s}`, spec: { contentType: "avro/binary", traitIds: [trait.id] },
    payload: { entityId: order.entity.id }, key: { entityId: orderKey.entity.id, entityVersionId: orderKey.version.id },
  }, ctx));
  message = { id: created.id, name: created.name };
  // Task 10 (publish) lands in the same wave; freeze a version directly.
  const mv = await prisma.messageVersion.create({
    data: {
      messageId: message.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      payloadEntityVersionId: order.version.id, keyEntityVersionId: orderKey.version.id,
      resolvedSpec: {
        name: message.name, spec: { contentType: "avro/binary", traitIds: [trait.id] },
        payload: { entityId: order.entity.id, entityName: "Order", entityVersionId: order.version.id, label: "1.0", major: 1 },
        headers: null,
        key: { entityId: orderKey.entity.id, entityName: "OrderKey", entityVersionId: orderKey.version.id, label: "1.0", major: 1 },
      },
    },
  });
  messageVersionId = mv.id;

  avroChannelId = unwrap(await createChannel(checkout.product.id, {
    name: `orders-${s}`, address: "payments.orders.v1", protocol: "kafka", format: "avro", spec: { bindings: { kafka: { partitions: 12 } } },
  }, ctx)).id;
  jsonChannelId = unwrap(await createChannel(checkout.product.id, {
    name: `orders-json-${s}`, address: "payments.orders.json.v1", protocol: "kafka", format: "json-schema",
  }, ctx)).id;

  producer = unwrap(await createEventSpec(checkout.product.id, { name: `checkout-service-${s}`, title: "checkout-service" }, ctx));
  consumer = unwrap(await createEventSpec(fraud.product.id, { name: `fraud-scorer-${fraud.s}`, title: "fraud-scorer" }, ctx));
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [checkout?.domain.id, fraud?.domain.id]);
  await prisma.$disconnect();
});

describe.sequential("emitEventSpec — DB → ResolvedEventSpec → AsyncAPI 3 (parser-validated)", () => {
  it("emits the §6.2-shaped producer spec: Avro payload + Kafka key + CloudEvents headers trait", async () => {
    unwrap(await updateEventSpecDocument(producer.id, {
      info: { title: "checkout-service" },
      servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
      operations: [{ key: "publishOrderCreated", action: "send", channelId: avroChannelId, messageVersionIds: [messageVersionId], traitIds: [] }],
    }, productOwner(checkout.product.id), ctx));

    const emitted = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
    expect(errorsOf(emitted.diagnostics)).toEqual([]);
    expect(emitted.published).toBe(false);
    expect(emitted.version).toBe("draft");
    expect(emitted.unpublishedMessages).toEqual([]);
    const doc = emitted.document as JsonObject;
    expect(doc.asyncapi).toBe("3.0.0");
    expect(doc.info).toEqual({ title: "checkout-service", version: "draft" });
    const component = ((doc.components as JsonObject).messages as JsonObject)[message.name] as JsonObject;
    expect(component.contentType).toBe("avro/binary");
    expect((component.payload as JsonObject).schemaFormat).toBe("application/vnd.apache.avro+json;version=1.9.0");
    // The Kafka binding types `key` as a JSON Schema Object, so the Avro key is tagged with its schemaFormat (a bare record is a parser error).
    expect(((component.bindings as JsonObject).kafka as JsonObject).key).toMatchObject({
      schemaFormat: "application/vnd.apache.avro+json;version=1.9.0",
      schema: { type: "record", name: "OrderKey" },
    });
    const traitComponent = ((doc.components as JsonObject).messageTraits as JsonObject)[traitName] as JsonObject;
    expect((traitComponent.headers as JsonObject).type).toBe("object");
    expect(emitted.yaml).toContain("asyncapi: 3.0.0");
    expect(JSON.parse(emitted.json as string)).toEqual(doc);
    // The Avro payload references Address by a named type in the same schema — never a file reference.
    expect(JSON.stringify(doc)).not.toMatch(/"\$ref":"[^#]/);
  }, 180_000);

  it("emits a cross-product consumer spec on another product's JSON Schema channel (draft-07, no remote refs)", async () => {
    unwrap(await updateEventSpecDocument(consumer.id, {
      info: { title: "fraud-scorer" }, servers: [],
      operations: [{ key: "consumeOrderCreated", action: "receive", channelId: jsonChannelId, messageVersionIds: [messageVersionId], traitIds: [] }],
    }, productOwner(fraud.product.id), ctx));
    const consumed = unwrap(await emitEventSpec(consumer.id, { draft: true }, ctx, { renderer }));
    expect(errorsOf(consumed.diagnostics)).toEqual([]);
    const json = JSON.stringify(consumed.document);
    expect(json).toContain("application/schema+json;version=draft-07");
    expect(json).not.toMatch(/"\$ref":"[^#]/); // Review Focus 4: no file refs (Address.json) reach the document
    expect(json).toContain("#/components/messages/"); // …the Address definition is document-rooted
    expect(json).toContain("/definitions/Address");
  }, 180_000);

  it("previews unpublished own-product messages (D4), pinned or against the entity's current draft", async () => {
    const draftEntity = await checkout.entity("Draftling", [{ name: "draftOnlyField", type: "string" }]);
    const draftMessage = unwrap(await createMessage(checkout.product.id, {
      name: `DraftOnly-${checkout.s}`, payload: { entityId: draftEntity.id, entityVersionId: null },
    }, ctx));
    unwrap(await updateEventSpecDocument(producer.id, {
      info: { title: "checkout-service" }, servers: [],
      operations: [
        { key: "publishDraft", action: "send", channelId: avroChannelId, messageVersionIds: [message.id], traitIds: [] },
        { key: "publishDraftOnly", action: "send", channelId: jsonChannelId, messageVersionIds: [draftMessage.id], traitIds: [] },
      ],
    }, productOwner(checkout.product.id), ctx));

    const preview = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
    expect(preview.unpublishedMessages).toEqual([
      { id: message.id, name: message.name },
      { id: draftMessage.id, name: draftMessage.name },
    ]);
    expect(preview.diagnostics.filter((d) => d.code === "UNPUBLISHED_MESSAGE")).toHaveLength(2);
    expect(errorsOf(preview.diagnostics)).toEqual([]);
    expect(JSON.stringify(preview.document)).toContain("draftOnlyField"); // the entity's current draft, never published
  }, 180_000);

  it("reports unresolved references with draft pointers and no document — including another product's unpublished message (D4)", async () => {
    await prisma.eventSpec.update({
      where: { id: producer.id },
      data: { document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "send", channelId: "gone", messageVersionIds: [], traitIds: [] }] } },
    });
    const broken = unwrap(await emitEventSpec(producer.id, { draft: true }, ctx, { renderer }));
    expect(broken.document).toBeNull();
    expect(broken.json).toBeNull();
    expect(broken.yaml).toBeNull();
    expect(broken.diagnostics).toEqual([{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" }]);

    // Fraud's spec naming Checkout's message *draft* (not a version) is unresolved: only own-product drafts are previewable.
    await prisma.eventSpec.update({
      where: { id: consumer.id },
      data: { document: { info: { title: "x" }, servers: [], operations: [{ key: "op", action: "receive", channelId: jsonChannelId, messageVersionIds: [message.id], traitIds: [] }] } },
    });
    const foreign = unwrap(await emitEventSpec(consumer.id, { draft: true }, ctx, { renderer }));
    expect(foreign.document).toBeNull();
    expect(foreign.diagnostics).toEqual([
      { severity: "error", code: "UNRESOLVED_REFERENCE", message: `Draft reference: Message version "${message.id}" not found`, pointer: "/operations/0/messageVersionIds/0" },
    ]);
  }, 180_000);

  it("returns a published version's stored document verbatim (never regenerated) and maps lookups to clear errors", async () => {
    const stored: JsonObject = {
      asyncapi: "3.0.0", info: { title: "stored", version: "1.0" }, operations: {}, channels: {}, // deliberately not what a regeneration would produce
    };
    const version = await prisma.eventSpecVersion.create({
      data: {
        eventSpecId: producer.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
        document: stored, sourceDocument: { info: { title: "stored" }, servers: [], operations: [] },
        frozenChannels: [], frozenTraits: [], messageVersionIds: [],
        compatReport: { reasons: [], diagnostics: [{ severity: "warning", code: "PAYLOAD_NOT_VALIDATED", message: "kept", pointer: "" }] },
      },
    });

    expect(unwrap(await getLatestEventSpecVersionLabel(producer.id, ctx))).toBeNull();
    await prisma.eventSpec.update({ where: { id: producer.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
    expect(unwrap(await getLatestEventSpecVersionLabel(producer.id, ctx))).toBe("1.0");

    const emitted = unwrap(await emitEventSpec(producer.id, { versionLabel: "1.0" }, ctx, { renderer }));
    expect(emitted).toMatchObject({ specId: producer.id, version: "1.0", published: true, document: stored, unpublishedMessages: [] });
    expect(JSON.parse(emitted.json as string)).toEqual(stored);
    expect(emitted.yaml).toContain("title: stored");
    expect(emitted.diagnostics).toEqual([{ severity: "warning", code: "PAYLOAD_NOT_VALIDATED", message: "kept", pointer: "" }]);

    const missing = await emitEventSpec(producer.id, { versionLabel: "9.9" }, ctx, { renderer });
    expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    const malformed = await emitEventSpec(producer.id, { versionLabel: "v1" }, ctx, { renderer });
    expect(malformed.success).toBe(false);
    const unknown = await emitEventSpec("no-such-spec", { draft: true }, ctx, { renderer });
    expect(!unknown.success && unknown.error.code).toBe("NOT_FOUND");
    const unknownLabel = await getLatestEventSpecVersionLabel("no-such-spec", ctx);
    expect(!unknownLabel.success && unknownLabel.error.code).toBe("NOT_FOUND");
  }, 60_000);
});
