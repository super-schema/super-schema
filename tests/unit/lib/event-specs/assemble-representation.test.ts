// tests/unit/lib/event-specs/assemble-representation.test.ts
// WP-1b: per-message format profiles (`ResolvedMessage.profile`, `ResolvedChannel.messageProfiles`) and `emitAll`.
import { describe, expect, it } from "vitest";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { SCHEMA_FORMATS } from "@/lib/event-specs/schema-format";
import type { JsonObject, ResolvedEventSpec, ResolvedTrait } from "@/lib/event-specs/types";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import { avroRecord, channel, deepFreeze, jsonObject, message, operation, spec } from "./fixtures/builders";

const at = (doc: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);
const keys = (value: unknown): string[] => Object.keys((value ?? {}) as object);
const errorsOf = (list: Array<{ severity: string }>) => list.filter((d) => d.severity === "error");
const jsonProfile = { format: "json-schema", dialect: "draft-07" } as const;

describe("a message profile picks the artifacts instead of the channel's profile", () => {
  const avroKafka = channel({ id: "orders", name: "orders", profile: { format: "avro" } });

  it("emits a JSON Schema payload for a JSON Schema message on an Avro channel, with no format suffix", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: jsonProfile });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCreated"]);
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schema", "title")).toBe("OrderCreated");
    expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe("application/json");
    expect(at(document, "operations", "send", "messages")).toEqual([{ $ref: "#/channels/orders/messages/OrderCreated" }]);
    expect(diagnostics).toEqual([]);
  });

  it("emits an Avro payload for an Avro message on a JSON Schema channel", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: { format: "avro" } });
    const jsonChannel = channel({ id: "orders", name: "orders", profile: jsonProfile, protocol: "googlepubsub" });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [jsonChannel], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe("avro/binary");
    expect(diagnostics).toEqual([]);
  });

  it("places an Avro Kafka key (Multi Format Schema Object) when the MESSAGE is Avro, even on a JSON Schema channel", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: { format: "avro" }, keys: [avroRecord("OrderKey"), jsonObject("OrderKey")] });
    const jsonKafka = channel({ id: "orders", name: "orders", profile: jsonProfile, protocol: "kafka" });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [jsonKafka], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    const key = at(document, "components", "messages", "OrderCreated", "bindings", "kafka", "key") as JsonObject;
    expect(key.schemaFormat).toBe(SCHEMA_FORMATS.avro);
    expect((key.schema as JsonObject).name).toBe("OrderKey");
    expect(diagnostics).toEqual([]);
  });

  it("places a JSON Schema Kafka key when the message is not Avro, even on an Avro channel", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: jsonProfile, keys: [avroRecord("OrderKey"), jsonObject("OrderKey")] });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    const key = at(document, "components", "messages", "OrderCreated", "bindings", "kafka", "key") as JsonObject;
    expect(key.title).toBe("OrderKey");
    expect(key).not.toHaveProperty("schemaFormat");
    expect(diagnostics).toEqual([]);
  });

  it("without a message profile the channel's profile decides, exactly as before", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", keys: [avroRecord("OrderKey"), jsonObject("OrderKey")] });
    const { document } = assembleAsyncApi3(spec({
      channels: [avroKafka], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(document, "components", "messages", "OrderCreated", "bindings", "kafka", "key", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
  });

  it("one message with one profile on two channels of different profiles is ONE component message", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: jsonProfile });
    const pubsub = channel({ id: "notices", name: "notices", profile: jsonProfile, protocol: "googlepubsub" });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka, pubsub], messages: [m],
      operations: [
        operation({ key: "a", channelRef: "orders", messageRefs: ["OrderCreated"] }),
        operation({ key: "b", channelRef: "notices", messageRefs: ["OrderCreated"] }),
      ],
    }));
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCreated"]);
    expect(at(document, "channels", "orders", "messages")).toEqual({ OrderCreated: { $ref: "#/components/messages/OrderCreated" } });
    expect(at(document, "channels", "notices", "messages")).toEqual({ OrderCreated: { $ref: "#/components/messages/OrderCreated" } });
    expect(diagnostics).toEqual([]);
  });

  it("without a message profile the same two channels still produce two suffixed variants (existing behaviour)", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated" });
    const pubsub = channel({ id: "notices", name: "notices", profile: jsonProfile, protocol: "googlepubsub" });
    const { document } = assembleAsyncApi3(spec({
      channels: [avroKafka, pubsub], messages: [m],
      operations: [
        operation({ key: "a", channelRef: "orders", messageRefs: ["OrderCreated"] }),
        operation({ key: "b", channelRef: "notices", messageRefs: ["OrderCreated"] }),
      ],
    }));
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCreated_avro", "OrderCreated_json"]);
  });

  it("a per-channel messageProfiles entry wins over the message profile, and operations reference the right variant", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: { format: "avro" } });
    const second = channel({ id: "second", name: "second", profile: { format: "avro" }, messageProfiles: { OrderCreated: jsonProfile } });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka, second], messages: [m],
      operations: [
        operation({ key: "a", channelRef: "orders", messageRefs: ["OrderCreated"] }),
        operation({ key: "b", channelRef: "second", messageRefs: ["OrderCreated"] }),
      ],
    }));
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCreated_avro", "OrderCreated_json"]);
    expect(at(document, "operations", "a", "messages")).toEqual([{ $ref: "#/channels/orders/messages/OrderCreated_avro" }]);
    expect(at(document, "operations", "b", "messages")).toEqual([{ $ref: "#/channels/second/messages/OrderCreated_json" }]);
    expect(at(document, "components", "messages", "OrderCreated_json", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(diagnostics).toEqual([]);
  });

  it("a messageProfiles entry applies to replies as well", () => {
    const reply = message({ id: "Reply", name: "Reply", profile: { format: "avro" } });
    const replies = channel({ id: "replies", name: "replies", profile: { format: "avro" }, messageProfiles: { Reply: jsonProfile } });
    const { document, diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka, replies], messages: [reply, message({ id: "Ask", name: "Ask" })],
      operations: [operation({ key: "ask", channelRef: "orders", messageRefs: ["Ask"], reply: { channelRef: "replies", messageRefs: ["Reply"] } })],
    }));
    expect(at(document, "operations", "ask", "reply", "messages")).toEqual([{ $ref: "#/channels/replies/messages/Reply" }]);
    expect(at(document, "components", "messages", "Reply", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(diagnostics).toEqual([]);
  });

  it("reports a missing artifact for the message profile at that message's payload", () => {
    const m = message({ id: "OrderCreated", name: "OrderCreated", profile: { format: "protobuf" } });
    const { diagnostics } = assembleAsyncApi3(spec({
      channels: [avroKafka], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    }));
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([["PAYLOAD_ARTIFACT_MISSING", "No payload schema rendered as protobuf"]]);
    expect(diagnostics[0].pointer).toBe("/components/messages/OrderCreated/payload/schema");
  });

  it("never reads a prototype member through messageProfiles", () => {
    const m = message({ id: "toString", name: "toString" });
    const c = channel({ id: "orders", name: "orders", profile: { format: "avro" }, messageProfiles: {} });
    const { document } = assembleAsyncApi3(spec({ channels: [c], messages: [m], operations: [operation({ key: "send", channelRef: "orders", messageRefs: ["toString"] })] }));
    expect(at(document, "components", "messages", "toString", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
  });
});

describe("emitAll", () => {
  const orders = channel({ id: "orders", name: "orders", title: "Orders", profile: { format: "avro" }, messageRefs: ["OrderCreated", "OrderCancelled"] });
  const idle = channel({ id: "idle", name: "idle", protocol: "googlepubsub", profile: jsonProfile, messageRefs: ["OrderCancelled"], serverRefs: ["pubsub"] });
  const created = message({ id: "OrderCreated", name: "OrderCreated" });
  const cancelled = message({ id: "OrderCancelled", name: "OrderCancelled" });
  const orphan = message({ id: "Orphan", name: "Orphan" });
  const unusedMessageTrait: ResolvedTrait = { id: "Audited", name: "Audited", kind: "MESSAGE", ownerSlug: "checkout", spec: { summary: "audited" } };
  const unusedOperationTrait: ResolvedTrait = { id: "Retry", name: "Retry", kind: "OPERATION", ownerSlug: "checkout", spec: { summary: "retried" } };
  const build = (over: Partial<ResolvedEventSpec> = {}): ResolvedEventSpec => spec({
    servers: [{ key: "kafka", protocol: "kafka", host: "k:9092" }, { key: "pubsub", protocol: "googlepubsub", host: "pubsub.googleapis.com" }],
    channels: [orders, idle], messages: [created, cancelled, orphan], traits: [unusedMessageTrait, unusedOperationTrait],
    operations: [operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"] })],
    emitAll: true,
    ...over,
  });

  it("by default (flag absent) emits only what operations reach — unchanged", () => {
    const { document } = assembleAsyncApi3(build({ emitAll: undefined }));
    expect(keys(at(document, "channels"))).toEqual(["orders"]);
    expect(keys(at(document, "channels", "orders", "messages"))).toEqual(["OrderCreated"]);
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCreated"]);
    expect(at(document, "components", "messageTraits")).toBeUndefined();
    expect(at(document, "components", "operationTraits")).toBeUndefined();
  });

  it("emits a channel that no operation uses", () => {
    const { document } = assembleAsyncApi3(build());
    expect(keys(at(document, "channels"))).toEqual(["idle", "orders"]);
    expect(at(document, "channels", "idle", "address")).toBe("idle.v1");
  });

  it("lists the messages a channel allows in addition to the ones operations use", () => {
    const { document } = assembleAsyncApi3(build());
    expect(keys(at(document, "channels", "orders", "messages"))).toEqual(["OrderCancelled_avro", "OrderCreated"]);
    expect(at(document, "channels", "orders", "messages", "OrderCancelled_avro")).toEqual({ $ref: "#/components/messages/OrderCancelled_avro" });
    expect(keys(at(document, "channels", "idle", "messages"))).toEqual(["OrderCancelled_json"]);
  });

  it("emits each allowed message in the profile of the channel that allows it (two variants of one message)", () => {
    const { document } = assembleAsyncApi3(build());
    expect(keys(at(document, "components", "messages"))).toEqual(["OrderCancelled_avro", "OrderCancelled_json", "OrderCreated", "Orphan"]);
    expect(at(document, "components", "messages", "OrderCancelled_avro", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
    expect(at(document, "components", "messages", "OrderCancelled_json", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
  });

  it("emits a message that no channel carries into components.messages, in its own profile (default JSON Schema draft-07)", () => {
    const { document } = assembleAsyncApi3(build());
    expect(at(document, "components", "messages", "Orphan", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(JSON.stringify(at(document, "channels"))).not.toContain("Orphan");
    const proto = message({ id: "Orphan", name: "Orphan", profile: { format: "avro" } });
    const { document: avroDoc } = assembleAsyncApi3(build({ messages: [created, cancelled, proto] }));
    expect(at(avroDoc, "components", "messages", "Orphan", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
  });

  it("emits traits nothing uses", () => {
    const { document } = assembleAsyncApi3(build());
    expect(at(document, "components", "messageTraits", "Audited")).toEqual({ summary: "audited" });
    expect(at(document, "components", "operationTraits", "Retry")).toEqual({ summary: "retried" });
  });

  it("emits server references on every emitted channel", () => {
    const { document, diagnostics } = assembleAsyncApi3(build());
    expect(at(document, "channels", "idle", "servers")).toEqual([{ $ref: "#/servers/pubsub" }]);
    expect(diagnostics).toEqual([]);
  });

  it("a message listed on a channel AND used by an operation of it is emitted once", () => {
    const { document } = assembleAsyncApi3(build());
    expect(keys(at(document, "channels", "orders", "messages")).filter((k) => k.startsWith("OrderCreated"))).toEqual(["OrderCreated"]);
  });

  it("places the Kafka key on a message that is only listed (not used by an operation) on a Kafka channel", () => {
    const keyed = message({ id: "OrderCancelled", name: "OrderCancelled", keys: [avroRecord("CancelKey")] });
    const { document } = assembleAsyncApi3(build({ messages: [created, keyed, orphan] }));
    expect(at(document, "components", "messages", "OrderCancelled_avro", "bindings", "kafka", "key", "schemaFormat")).toBe(SCHEMA_FORMATS.avro);
  });

  it("reports a channel message that is not in the resolved spec", () => {
    const broken = channel({ id: "orders", name: "orders", profile: { format: "avro" }, messageRefs: ["Ghost"] });
    const { diagnostics } = assembleAsyncApi3(build({ channels: [broken, idle] }));
    const hit = diagnostics.find((d) => d.code === "UNKNOWN_MESSAGE_REF");
    expect(hit?.message).toBe('Message "Ghost" is not in the resolved spec');
    expect(hit?.pointer).toBe("/channels/orders/messages/0");
  });

  it("reports an unknown server reference of a channel without operation", () => {
    const lost = channel({ id: "idle", name: "idle", profile: jsonProfile, serverRefs: ["nope"] });
    const { diagnostics } = assembleAsyncApi3(build({ channels: [orders, lost] }));
    expect(diagnostics.find((d) => d.code === "UNKNOWN_SERVER_REF")?.pointer).toBe("/channels/idle/servers/0");
  });

  it("produces a document the structural validator accepts", () => {
    const { document, diagnostics } = assembleAsyncApi3(build());
    expect(errorsOf(diagnostics)).toEqual([]);
    expect(errorsOf(validateAsyncApi3Structure(document))).toEqual([]);
  });

  it("is independent of input order", () => {
    const a = assembleAsyncApi3(build());
    const b = assembleAsyncApi3(build({ channels: [idle, orders], messages: [orphan, cancelled, created], traits: [unusedOperationTrait, unusedMessageTrait] }));
    expect(JSON.stringify(b.document)).toBe(JSON.stringify(a.document));
  });

  it("never mutates its input", () => {
    const frozen = deepFreeze(structuredClone(build()));
    expect(() => assembleAsyncApi3(frozen)).not.toThrow();
  });

  it("does not emit the same message twice when the operation's channel also lists it and the message has a profile", () => {
    const profiled = message({ id: "OrderCreated", name: "OrderCreated", profile: jsonProfile });
    const { document } = assembleAsyncApi3(build({ messages: [profiled, cancelled, orphan] }));
    expect(keys(at(document, "components", "messages")).filter((k) => k.startsWith("OrderCreated"))).toEqual(["OrderCreated"]);
    expect(at(document, "components", "messages", "OrderCreated", "payload", "schemaFormat")).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(keys(at(document, "channels", "orders", "messages")).filter((k) => k.startsWith("OrderCreated"))).toEqual(["OrderCreated"]);
  });
});
