import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { JsonObject, PayloadFormat, SchemaArtifact } from "@/lib/event-specs/types";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { err, ok } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { ArtifactRenderer } from "@/services/events/artifact-renderer";
import { emitEventDocumentPreview, emitEventDraft } from "@/services/events/event-emit.service";
import { loadEventSnapshot } from "@/services/events/event-snapshot";
import { cleanupDomains, connectTestDb, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";

/**
 * A library trait whose message properties are inline (`spec.headers`, no entity pin) is emitted in the final AsyncAPI straight from
 * the stored row, through the real snapshot loader, resolver, assembler and BOTH validators (structural + @asyncapi/parser).
 * The trait rows live at domain level in a domain of their own (tenant level belongs to `ensureBundledTraits`), removed with it.
 */
let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let order: { entityId: string; entityVersionId: string };
let ceHeaders: { entityId: string; entityVersionId: string };
let cloudEvents: { id: string; name: string };
let traceContext: { id: string; name: string };
let legacy: { id: string; name: string };

const def = (name: string) => BUNDLED_TRAITS.find((t) => t.name === name)!;
const errorsOf = <T extends { severity: string }>(list: T[]) => list.filter((d) => d.severity === "error");
const traitsOf = (doc: JsonObject | null) => ((doc?.components as JsonObject | undefined)?.messageTraits ?? {}) as Record<string, JsonObject>;

/** The renderer stand-in: every entity is a tiny Avro record / JSON Schema object named after it. */
const modelNames = new Map<string, string>();
const renderer: ArtifactRenderer = {
  async render(subject, format: PayloadFormat) {
    const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
    const name = modelNames.get(id);
    if (!name) return err({ code: "NOT_FOUND", message: `no stub for ${id}` });
    const artifact: SchemaArtifact = format === "avro"
      ? { format: "avro", schema: { type: "record", name, fields: [{ name: "id", type: "string" }] } }
      : { format: "json-schema", dialect: "draft-07", schema: { type: "object", title: name, properties: { id: { type: "string" } } } };
    return ok({ artifact, warnings: [] });
  },
};

async function frozenEntity(name: string) {
  const entity = await own.entity(name, [{ name: "id", type: "string" }]);
  const version = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
      resolvedSource: `model ${name} {\n  id: string;\n}\n`, fieldSnapshot: [{ name: "id", fieldNumber: 1 }],
    },
  });
  modelNames.set(entity.id, name);
  modelNames.set(version.id, name);
  return { entityId: entity.id, entityVersionId: version.id };
}

function document(traitKeys: string[], traits: EventDocument["traits"]): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["order-created"] }],
    messages: [{ key: "order-created", contentType: "avro/binary", payload: order, traitKeys }],
    traits,
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["order-created"], traitKeys: [] }],
  };
}
const seedEvent = (doc: EventDocument) =>
  prisma.eventSpec.create({
    data: { name: `evt-${stamp()}`, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id, document: doc as unknown as Prisma.InputJsonValue },
  });

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  own = await createProductScope(prisma, ctx, "ip");
  order = await frozenEntity("Order");
  ceHeaders = await frozenEntity("CloudEventsHeaders");
  const trait = (name: string, spec: object, extra: object = {}) =>
    prisma.trait.create({
      data: { name: `${name}-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id, spec: spec as Prisma.InputJsonValue, ...extra },
      select: { id: true, name: true },
    });
  // stored exactly like the built-ins (marker included), at DOMAIN level so the tenant's own built-ins are not involved
  cloudEvents = await trait("CloudEvents", def("CloudEvents").spec);
  traceContext = await trait("TraceContext", def("TraceContext").spec);
  // the old demo trait: entity-pinned headers, no inline schema
  legacy = await trait("LegacyCloudEvents", { summary: "CloudEvents envelope headers" }, { headersEntityId: ceHeaders.entityId, headersEntityVersionId: ceHeaders.entityVersionId });
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [own?.domain.id]);
  await prisma.$disconnect();
});

describe("emitting a document that uses library traits with inline message properties", () => {
  it("the snapshot loads the stored spec unchanged, headers included, with no headers pin", async () => {
    const event = await seedEvent(document(["ce"], [{ key: "ce", kind: "MESSAGE", libraryTraitId: cloudEvents.id }]));
    const snapshot = unwrap(await loadEventSnapshot(prisma, event.id));
    const frozen = snapshot.libraryTraits.get(cloudEvents.id)!;
    expect(frozen).toMatchObject({ id: cloudEvents.id, name: cloudEvents.name, kind: "MESSAGE", headersEntityId: null, headersEntityVersionId: null });
    expect(frozen.spec).toEqual(def("CloudEvents").spec);
  });

  it("emits the real CloudEvents and Trace Context properties in the final AsyncAPI, with 0 errors from both validators", async () => {
    const doc = document(["ce", "trace"], [
      { key: "ce", kind: "MESSAGE", libraryTraitId: cloudEvents.id },
      { key: "trace", kind: "MESSAGE", libraryTraitId: traceContext.id },
    ]);
    const event = await seedEvent(doc);

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    const traits = traitsOf(out.document);
    expect(traits[cloudEvents.name].headers).toEqual(def("CloudEvents").spec.headers);
    expect(traits[traceContext.name].headers).toEqual(def("TraceContext").spec.headers);
    expect(traits[cloudEvents.name]).toMatchObject({ summary: def("CloudEvents").spec.summary });
    expect(traits[cloudEvents.name]).not.toHaveProperty("x-bundled"); // bookkeeping stays in storage, never in the emitted document
    const message = ((out.document?.components as JsonObject).messages as Record<string, JsonObject>)["order-created"];
    expect(message.traits).toEqual([
      { $ref: `#/components/messageTraits/${cloudEvents.name}` },
      { $ref: `#/components/messageTraits/${traceContext.name}` },
    ]);
    // the YAML shows them too
    expect(out.yaml).toContain("specversion:");
    expect(out.yaml).toContain("traceparent:");
  }, 60_000);

  it("an unsaved document (the Code panel's server render) emits the same properties", async () => {
    const doc = document(["ce"], [{ key: "ce", kind: "MESSAGE", libraryTraitId: cloudEvents.id }]);
    const event = await seedEvent(document([], []));
    const out = unwrap(await emitEventDocumentPreview(event.id, own.product.id, doc, ctx, { renderer }));
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(traitsOf(out.document)[cloudEvents.name].headers).toEqual(def("CloudEvents").spec.headers);
  }, 60_000);

  it("a document that still uses the old entity-pinned library trait opens, saves and emits exactly as before", async () => {
    const doc = document(["ce", "old"], [
      { key: "ce", kind: "MESSAGE", libraryTraitId: cloudEvents.id },
      { key: "old", kind: "MESSAGE", libraryTraitId: legacy.id },
    ]);
    const event = await seedEvent(doc);

    const out = unwrap(await emitEventDraft(event.id, own.product.id, ctx, { renderer }));

    expect(errorsOf(out.diagnostics)).toEqual([]);
    const traits = traitsOf(out.document);
    // the pinned trait emits the rendered headers artifact of its entity, the inline one its stored schema
    expect(traits[legacy.name]).toMatchObject({ summary: "CloudEvents envelope headers", headers: { title: "CloudEventsHeaders", type: "object" } });
    expect(traits[legacy.name]).not.toHaveProperty("x-bundled");
    expect(traits[cloudEvents.name].headers).toEqual(def("CloudEvents").spec.headers);
  }, 60_000);
});
