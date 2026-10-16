// tests/unit/lib/events/document/instant-asyncapi-representation.test.ts
// WP-1b: the live Code panel follows each message's effective representation and shows everything the user has defined so far.
import { describe, expect, it } from "vitest";
import { buildInstantAsyncApi, PLACEHOLDER_ENTITY_KEY, PLACEHOLDER_LIBRARY_TRAIT_KEY } from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { SCHEMA_FORMATS } from "@/lib/event-specs/schema-format";
import type { PayloadFormat } from "@/lib/event-specs/types";

const pin = (entityId: string, entityVersionId: string | null = null) => ({ entityId, entityVersionId });
const OPTS = { productSlug: "checkout", entityLabels: new Map([["ent-order", "Order"], ["ent-notice", "Notice"], ["ent-orphan", "Draft"], ["ent-cancelled", "Cancelled"]]) };
const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], value);
const keys = (value: unknown): string[] => Object.keys((value ?? {}) as object);
const errorsOf = (list: Array<{ severity: string }>) => list.filter((d) => d.severity === "error");
const formats = (entries: Array<[string, PayloadFormat]>): ReadonlyMap<string, PayloadFormat | undefined> => new Map(entries);

/** A Kafka and a Pub/Sub channel, neither with a format (Auto), one message and one send operation each. */
function autoDoc(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka", protocol: "kafka", host: "kafka.internal:9092" }, { key: "pubsub", protocol: "googlepubsub", host: "pubsub.googleapis.com" }],
    channels: [
      { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka"], messageKeys: ["OrderCreated"] },
      { key: "notices", address: "projects/acme/topics/notices", protocol: "googlepubsub", serverKeys: ["pubsub"], messageKeys: ["Notice"] },
    ],
    messages: [
      { key: "OrderCreated", payload: pin("ent-order", "ver-order"), keyPin: pin("ent-order", "ver-order"), traitKeys: [] },
      { key: "Notice", payload: pin("ent-notice"), traitKeys: [] },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] },
      { key: "publishNotice", action: "send", channelKey: "notices", messageKeys: ["Notice"], traitKeys: [] },
    ],
  };
}

describe("buildInstantAsyncApi: the effective representation", () => {
  it("a Kafka channel without a format shows Avro placeholders, key included", () => {
    const out = buildInstantAsyncApi(autoDoc(), OPTS);
    expect(at(out.document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(out.document, "components", "messages", "OrderCreated", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Order@pinned");
    expect(at(out.document, "components", "messages", "OrderCreated", "bindings", "kafka", "key", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(errorsOf(out.diagnostics)).toEqual([]);
  });

  it("a Pub/Sub channel without a format shows a JSON Schema placeholder by default", () => {
    const out = buildInstantAsyncApi(autoDoc(), OPTS);
    expect(at(out.document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(at(out.document, "components", "messages", "Notice", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Notice@draft");
  });

  it("an Avro-imported entity on that Pub/Sub channel shows Avro (entityFormats)", () => {
    const out = buildInstantAsyncApi(autoDoc(), { ...OPTS, entityFormats: formats([["ent-notice", "avro"]]) });
    expect(at(out.document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(out.document, "components", "messages", "Notice", "payload", "schema", "type")).toBe("record");
    expect(at(out.document, "components", "messages", "Notice", "contentType")).toBe("avro/binary");
    expect(errorsOf(out.diagnostics)).toEqual([]);
  });

  it("entityFormats is optional and defaults to none", () => {
    const withMap = buildInstantAsyncApi(autoDoc(), { ...OPTS, entityFormats: new Map() });
    const without = buildInstantAsyncApi(autoDoc(), OPTS);
    expect(withMap.yaml).toBe(without.yaml);
  });

  it("an explicit message representation wins over the entity: protobuf with a JSON Schema Kafka key", () => {
    const d = autoDoc();
    d.messages[0].representation = "protobuf";
    const out = buildInstantAsyncApi(d, { ...OPTS, entityFormats: formats([["ent-order", "avro"]]) });
    expect(at(out.document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
    expect(typeof at(out.document, "components", "messages", "OrderCreated", "payload", "schema")).toBe("string");
    expect(at(out.document, "components", "messages", "OrderCreated", "bindings", "kafka", "key", PLACEHOLDER_ENTITY_KEY)).toBe("Order@pinned");
    expect(errorsOf(out.diagnostics)).toEqual([]);
  });

  it("switching the representation changes the code, never leaves a stale schema behind", () => {
    const d = autoDoc();
    const before = buildInstantAsyncApi(d, OPTS);
    d.messages[1].representation = "avro";
    const after = buildInstantAsyncApi(d, OPTS);
    expect(before.yaml).not.toBe(after.yaml);
    expect(at(before.document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(at(after.document, "components", "messages", "Notice", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(keys(at(after.document, "components", "messages"))).toEqual(["Notice", "OrderCreated"]);
  });

  it("a document whose channels still set an explicit format is rendered exactly as before", () => {
    const d = autoDoc();
    d.channels[0].format = "avro";
    d.channels[1].format = "json-schema";
    d.channels[1].formatDialect = "draft-07";
    const explicit = buildInstantAsyncApi(d, OPTS);
    const auto = buildInstantAsyncApi(autoDoc(), OPTS);
    expect(explicit.yaml).toBe(auto.yaml); // the same outcome as Auto: Kafka → Avro, Pub/Sub → JSON Schema
  });
});

describe("buildInstantAsyncApi: everything the user has defined is shown", () => {
  function sprawling(): EventDocument {
    const d = autoDoc();
    d.channels.push({ key: "idle", address: "idle.v1", protocol: "kafka", serverKeys: ["kafka"], title: "Idle", messageKeys: ["Cancelled"] });
    d.messages.push(
      { key: "Cancelled", payload: pin("ent-cancelled"), traitKeys: ["Audited"] },
      { key: "Draft", payload: pin("ent-orphan"), traitKeys: [] },
    );
    d.traits.push(
      { key: "Audited", kind: "MESSAGE", spec: { summary: "Audited" } },
      { key: "Retry", kind: "OPERATION", spec: { summary: "Retried" } },
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" },
    );
    return d;
  }

  it("shows a channel that has no operation yet", () => {
    const out = buildInstantAsyncApi(sprawling(), OPTS);
    expect(keys(at(out.document, "channels"))).toEqual(["idle", "notices", "orders"]);
    expect(at(out.document, "channels", "idle", "title")).toBe("Idle");
  });

  it("shows the messages a channel allows, from the channel's own list", () => {
    const out = buildInstantAsyncApi(sprawling(), OPTS);
    expect(at(out.document, "channels", "idle", "messages", "Cancelled")).toEqual({ $ref: "#/components/messages/Cancelled" });
    expect(at(out.document, "components", "messages", "Cancelled", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Cancelled@draft");
  });

  it("shows a message that no channel carries yet, as a component", () => {
    const out = buildInstantAsyncApi(sprawling(), OPTS);
    expect(keys(at(out.document, "components", "messages"))).toEqual(["Cancelled", "Draft", "Notice", "OrderCreated"]);
    expect(at(out.document, "components", "messages", "Draft", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Draft@draft");
    expect(at(out.document, "components", "messages", "Draft", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
  });

  it("an unattached message follows its entity's format and its own representation", () => {
    const viaEntity = buildInstantAsyncApi(sprawling(), { ...OPTS, entityFormats: formats([["ent-orphan", "protobuf"]]) });
    expect(at(viaEntity.document, "components", "messages", "Draft", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.protobuf);
    const d = sprawling();
    d.messages[3].representation = "avro";
    const viaChoice = buildInstantAsyncApi(d, { ...OPTS, entityFormats: formats([["ent-orphan", "protobuf"]]) });
    expect(at(viaChoice.document, "components", "messages", "Draft", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
  });

  it("shows each channel's server references", () => {
    const out = buildInstantAsyncApi(sprawling(), OPTS);
    expect(at(out.document, "channels", "idle", "servers")).toEqual([{ $ref: "#/servers/kafka" }]);
    expect(at(out.document, "channels", "notices", "servers")).toEqual([{ $ref: "#/servers/pubsub" }]);
  });

  it("shows traits that nothing uses yet, library traits as stubs", () => {
    const out = buildInstantAsyncApi(sprawling(), OPTS);
    expect(at(out.document, "components", "messageTraits", "Audited")).toEqual({ summary: "Audited" });
    expect(at(out.document, "components", "operationTraits", "Retry")).toEqual({ summary: "Retried" });
    expect(at(out.document, "components", "messageTraits", "CloudEvents", PLACEHOLDER_LIBRARY_TRAIT_KEY)).toBe("CloudEvents");
  });

  it("produces no error diagnostics for it", () => {
    expect(errorsOf(buildInstantAsyncApi(sprawling(), OPTS).diagnostics)).toEqual([]);
  });

  it("a channel with no messages and no operations is still shown", () => {
    const d = emptyEventDocument("Orders");
    d.channels = [{ key: "lonely", address: "lonely.v1", protocol: "kafka", serverKeys: [], messageKeys: [] }];
    const out = buildInstantAsyncApi(d, OPTS);
    expect(at(out.document, "channels", "lonely", "address")).toBe("lonely.v1");
    expect(errorsOf(out.diagnostics)).toEqual([]);
  });

  it("external references are still left out with their info diagnostic (the browser cannot resolve them)", () => {
    const d = sprawling();
    d.externalRefs = [{ key: "ext-msg", eventVersionId: "ev9", kind: "message", itemKey: "Settled" }];
    d.channels[2].messageKeys = ["Cancelled", "ext-msg"];
    const out = buildInstantAsyncApi(d, OPTS);
    expect(out.diagnostics.map((x) => x.code)).toContain("EXTERNAL_REF_OMITTED");
    expect(JSON.stringify(out.document)).not.toContain("ext-msg");
    expect(errorsOf(out.diagnostics)).toEqual([]);
  });
});
