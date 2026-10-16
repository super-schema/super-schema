import { describe, expect, it } from "vitest";
import { planDocumentArtifacts, resolveDocument, type ResolveDocumentInput } from "@/lib/events/document/resolve";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { ResolvedChannel } from "@/lib/event-specs/types";

const avro = (name: string) => ({ format: "avro" as const, schema: { type: "record", name, fields: [] } });
const doc = (): EventDocument => ({
  ...emptyEventDocument("checkout-service"),
  servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
  channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], bindings: { kafka: { partitions: 12 } }, format: "avro", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", contentType: "avro/binary", payload: { entityId: "e1", entityVersionId: "v1" }, keyPin: { entityId: "e2", entityVersionId: "v2" }, traitKeys: ["CloudEvents"] }],
  traits: [{ key: "CloudEvents", kind: "MESSAGE", spec: {} }],
  operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});
const input = (d = doc()): ResolveDocumentInput => ({
  doc: d, productSlug: "checkout", version: "2.0",
  artifacts: new Map([["OrderCreated", { payloads: [avro("Order")], keys: [avro("OrderKey")] }]]),
  localTraitHeaders: new Map([["CloudEvents", { format: "json-schema", dialect: "draft-07", schema: { type: "object", properties: { ce_id: { type: "string" } } } }]]),
  libraryTraits: new Map(), libraryTraitHeaders: new Map(), external: new Map(),
});

describe("planDocumentArtifacts", () => {
  it("renders payload and key in the format of every channel carrying the message", () => {
    expect(planDocumentArtifacts(doc()).get("OrderCreated")).toEqual({ payloadFormats: ["avro"], keyFormats: ["avro"] });
  });
  it("skips key formats for non-Kafka channels", () => {
    const d = doc(); d.channels[0].protocol = "googlepubsub";
    expect(planDocumentArtifacts(d).get("OrderCreated")?.keyFormats).toEqual([]);
  });
  it("includes channels reached only through operations or replies", () => {
    const d = doc(); d.channels[0].messageKeys = [];
    d.channels.push({ key: "audit", address: "a", protocol: "kafka", serverKeys: [], format: "json-schema", formatDialect: "draft-07", messageKeys: ["OrderCreated"] });
    d.operations[0].reply = { channelKey: "audit", messageKeys: ["OrderCreated"] };
    expect(planDocumentArtifacts(d).get("OrderCreated")?.payloadFormats.sort()).toEqual(["avro", "json-schema"]);
  });
  // Deviation from the plan's "same formats" wording: the assembler picks the Kafka key profile with kafkaKeyProfile()
  // (Avro on an Avro channel, otherwise JSON Schema draft-07), so planning a protobuf/other key would leave the key unresolved.
  it("renders a Kafka key as JSON Schema on every channel that is not Avro", () => {
    const d = doc(); d.channels[0].format = "protobuf";
    d.channels.push({ key: "audit", address: "a", protocol: "kafka", serverKeys: [], format: "json-schema", messageKeys: ["OrderCreated"] });
    expect(planDocumentArtifacts(d).get("OrderCreated")).toEqual({ payloadFormats: ["protobuf", "json-schema"].sort(), keyFormats: ["json-schema"] });
  });
  it("ignores external channels, which bring their own rendered messages", () => {
    const d = doc(); d.channels = []; d.operations[0].channelKey = "ext";
    d.externalRefs = [{ key: "ext", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
    expect(planDocumentArtifacts(d).size).toBe(0);
  });
});

const problemsOf = (r: ReturnType<typeof resolveDocument>) => {
  expect(r.success).toBe(false);
  if (r.success) return [];
  expect(r.error.code).toBe("UNRESOLVED_REFERENCES");
  return (r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems;
};

describe("resolveDocument", () => {
  it("maps keys to ids and produces an assemblable spec", () => {
    const r = resolveDocument(input());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.info).toMatchObject({ title: "checkout-service", version: "2.0" });
    expect(r.data.channels[0]).toMatchObject({ id: "orders", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" } });
    expect(r.data.messages[0]).toMatchObject({ id: "OrderCreated", traitRefs: ["CloudEvents"] });
    expect(r.data.operations[0]).toMatchObject({ key: "publishOrderCreated", channelRef: "orders", messageRefs: ["OrderCreated"] });
    const assembled = assembleAsyncApi3(r.data);
    expect(assembled.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect((assembled.document.channels as Record<string, unknown>)).toHaveProperty("orders");
  });
  it("reports one UNRESOLVED_REFERENCES error listing every missing piece", () => {
    const i = input(); i.artifacts = new Map();
    const d = i.doc; d.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "gone" }];
    const r = resolveDocument(i);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.code).toBe("UNRESOLVED_REFERENCES");
    const pointers = (r.error.details as { problems: Array<{ pointer: string }> }).problems.map((p) => p.pointer);
    expect(pointers).toContain("/messages/0");
    expect(pointers).toContain("/traits/0/libraryTraitId");
  });
  it("uses a library trait's frozen copy and header artifact", () => {
    const i = input(); i.doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-1" }];
    i.libraryTraits = new Map([["lib-1", { id: "lib-1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headersEntityId: null, headersEntityVersionId: null }]]);
    const r = resolveDocument(i);
    expect(r.success && r.data.traits[0]).toMatchObject({ id: "CloudEvents", ownerSlug: "acme", spec: { summary: "ce" } });
  });
  it("substitutes external items under the external ref key", () => {
    const i = input();
    i.doc.externalRefs = [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
    i.doc.operations.push({ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["OrderCreated"], traitKeys: [] });
    i.external = new Map([["ext-orders", { channel: { id: "orders", name: "orders", productSlug: "checkout", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" } } }]]);
    const r = resolveDocument(i);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channels.map((c) => c.id).sort()).toEqual(["ext-orders", "orders"]);
  });

  describe("local items", () => {
    it("fills the channel, message and trait fields and drops undefined optionals", () => {
      const i = input();
      i.doc.channels[0] = { ...i.doc.channels[0], title: "Orders", parameters: { region: { description: "Region" } }, tags: [{ name: "pay" }] };
      i.doc.messages[0] = { ...i.doc.messages[0], title: "Order created", examples: [{ name: "ex" }], bindings: { kafka: { key: {} } } };
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.channels[0]).toMatchObject({ id: "orders", name: "orders", productSlug: "checkout", title: "Orders", parameters: { region: { description: "Region" } }, tags: [{ name: "pay" }] });
      expect(r.data.channels[0]).not.toHaveProperty("summary");
      expect(r.data.channels[0]).not.toHaveProperty("formatDialect");
      expect(r.data.channels[0].profile).toEqual({ format: "avro" });
      expect(r.data.messages[0]).toMatchObject({ id: "OrderCreated", name: "OrderCreated", productSlug: "checkout", title: "Order created", contentType: "avro/binary", examples: [{ name: "ex" }] });
      expect(r.data.messages[0].payloads).toEqual([avro("Order")]);
      expect(r.data.messages[0].keys).toEqual([avro("OrderKey")]);
      expect(r.data.messages[0]).not.toHaveProperty("headers");
      expect(r.data.messages[0]).not.toHaveProperty("unpublished");
      expect(r.data.traits[0]).toMatchObject({ id: "CloudEvents", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "checkout", spec: {} });
      expect(r.data.traits[0].headers).toMatchObject({ format: "json-schema", dialect: "draft-07" });
    });
    it("carries the dialect of a JSON Schema channel and omits an empty key list", () => {
      const i = input();
      i.doc.channels[0] = { ...i.doc.channels[0], protocol: "googlepubsub", format: "json-schema", formatDialect: "2020-12" };
      i.artifacts = new Map([["OrderCreated", { payloads: [{ format: "json-schema", dialect: "2020-12", schema: { type: "object" } }], keys: [] }]]);
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.channels[0].profile).toEqual({ format: "json-schema", dialect: "2020-12" });
      expect(r.data.messages[0]).not.toHaveProperty("keys");
    });
    it("carries only what operations use, in first-reference order, without requiring unused messages to be rendered", () => {
      const i = input();
      i.doc.channels.push({ key: "spare", address: "s", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["Spare"] });
      i.doc.messages.push({ key: "Spare", payload: { entityId: "e3", entityVersionId: null }, traitKeys: [] });
      i.doc.traits.push({ key: "Unused", kind: "MESSAGE", spec: {} }, { key: "OpTrait", kind: "OPERATION", spec: { summary: "op" } });
      i.doc.operations[0].traitKeys = ["OpTrait"];
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.channels.map((c) => c.id)).toEqual(["orders"]);
      expect(r.data.messages.map((m) => m.id)).toEqual(["OrderCreated"]);
      expect(r.data.traits.map((t) => [t.id, t.kind])).toEqual([["CloudEvents", "MESSAGE"], ["OpTrait", "OPERATION"]]);
    });
    it("maps operations, their traits and replies from keys", () => {
      const i = input();
      i.doc.channels.push({ key: "replies", address: "r", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] });
      i.doc.traits.push({ key: "OpTrait", kind: "OPERATION", spec: {} });
      i.doc.operations[0] = { ...i.doc.operations[0], summary: "Publish", description: "d", bindings: { kafka: { groupId: "g" } }, traitKeys: ["OpTrait"], reply: { channelKey: "replies", messageKeys: ["OrderCreated"] } };
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.operations).toEqual([{
        key: "publishOrderCreated", action: "send", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["OpTrait"],
        summary: "Publish", description: "d", bindings: { kafka: { groupId: "g" } },
        reply: { channelRef: "replies", messageRefs: ["OrderCreated"] },
      }]);
      expect(r.data.channels.map((c) => c.id)).toEqual(["orders", "replies"]);
    });
    it("copies info, default content type, servers (without origin) and components", () => {
      const i = input();
      i.doc.info = { title: "checkout-service", description: "d", tags: [{ name: "x" }] };
      i.doc.defaultContentType = "application/json";
      i.doc.servers[0] = { ...i.doc.servers[0], origin: { provider: "infra", ref: "k1", syncedAt: "2026-10-15T00:00:00Z" } };
      i.doc.components = { correlationIds: { cid: { location: "$message.header#/id" } } };
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.productSlug).toBe("checkout");
      expect(r.data.info).toEqual({ title: "checkout-service", description: "d", tags: [{ name: "x" }], version: "2.0" });
      expect(r.data.defaultContentType).toBe("application/json");
      expect(r.data.servers).toEqual([{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }]);
      expect(r.data.components).toEqual({ correlationIds: { cid: { location: "$message.header#/id" } } });
    });
    it("leaves defaultContentType off and components empty when the document has none", () => {
      const r = resolveDocument(input());
      expect(r.success && r.data).toMatchObject({ components: {} });
      expect(r.success && r.data).not.toHaveProperty("defaultContentType");
    });
    it("does not mutate the input and does not alias its objects", () => {
      const i = input();
      const before = JSON.stringify([i.doc, [...i.artifacts], [...i.localTraitHeaders]]);
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(JSON.stringify([i.doc, [...i.artifacts], [...i.localTraitHeaders]])).toBe(before);
      expect(r.data.channels[0].bindings).toEqual(i.doc.channels[0].bindings);
      expect(r.data.channels[0].bindings).not.toBe(i.doc.channels[0].bindings);
      expect(r.data.info).not.toBe(i.doc.info);
    });
  });

  describe("unresolved references", () => {
    it("reports an operation channel, message, trait and reply that resolve to nothing, each with its pointer", () => {
      const i = input();
      i.doc.operations.push({ key: "bad", action: "send", channelKey: "nope", messageKeys: ["OrderCreated", "Ghost"], traitKeys: ["Missing"], reply: { channelKey: "ghost-channel", messageKeys: ["Ghost2"] } });
      const problems = problemsOf(resolveDocument(i));
      expect(problems.map((p) => p.pointer).sort()).toEqual([
        "/operations/1/channelKey",
        "/operations/1/messageKeys/1",
        "/operations/1/reply/channelKey",
        "/operations/1/reply/messageKeys/0",
        "/operations/1/traitKeys/0",
      ]);
      expect(problems.find((p) => p.pointer === "/operations/1/messageKeys/1")?.message).toContain("Ghost");
    });
    it("reports the same unknown key at every place it is used", () => {
      const i = input();
      i.doc.operations.push({ key: "a", action: "send", channelKey: "orders", messageKeys: ["Ghost"], traitKeys: [] }, { key: "b", action: "send", channelKey: "orders", messageKeys: ["Ghost"], traitKeys: [] });
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/operations/1/messageKeys/0", "/operations/2/messageKeys/0"]);
    });
    it("does not assume an operation's messages exist on its channel, only that every message key resolves", () => {
      const i = input();
      i.doc.channels[0].messageKeys = [];
      i.doc.operations[0].channelKey = "ext-orders";
      i.doc.externalRefs = [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
      i.doc.operations.push({ key: "other", action: "receive", channelKey: "ext-orders", messageKeys: ["not-a-message"], traitKeys: [] });
      i.external = new Map([["ext-orders", { channel: { id: "orders", name: "orders", productSlug: "up", address: "o", protocol: "kafka", profile: { format: "avro" } } }]]);
      const problems = problemsOf(resolveDocument(i));
      expect(problems.map((p) => p.pointer)).toEqual(["/operations/1/messageKeys/0"]);
    });
    it("reports a message used by an operation that has no rendered payload, once, with its traits still checked", () => {
      const i = input(); i.artifacts = new Map([["OrderCreated", { payloads: [], keys: [] }]]);
      i.doc.messages[0].traitKeys = ["Unknown"];
      i.doc.operations.push({ key: "again", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] });
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/messages/0", "/messages/0/traitKeys/0"]);
    });
    it("reports a trait of the wrong kind where it is used", () => {
      const i = input();
      i.doc.traits.push({ key: "OpTrait", kind: "OPERATION", spec: {} });
      i.doc.messages[0].traitKeys = ["OpTrait"];
      i.doc.operations[0].traitKeys = ["CloudEvents"];
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer).sort()).toEqual(["/messages/0/traitKeys/0", "/operations/0/traitKeys/0"]);
    });
    it("reports a missing library trait once even when several messages use it", () => {
      const i = input();
      i.doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "gone" }];
      i.doc.messages.push({ key: "Second", payload: { entityId: "e5", entityVersionId: "v5" }, traitKeys: ["CloudEvents"] });
      i.doc.channels[0].messageKeys.push("Second");
      i.doc.operations[0].messageKeys.push("Second");
      i.artifacts = new Map([...i.artifacts, ["Second", { payloads: [avro("S")], keys: [] }]]);
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/traits/0/libraryTraitId"]);
    });
    it("reports a library trait that is missing even when nothing uses it yet", () => {
      const i = input(); i.doc.traits.push({ key: "Spare", kind: "OPERATION", libraryTraitId: "gone" });
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/traits/1/libraryTraitId"]);
    });
    it("reports a library trait whose kind differs from the kind the document declares", () => {
      const i = input(); i.doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-1" }];
      i.libraryTraits = new Map([["lib-1", { id: "lib-1", name: "x", kind: "OPERATION", ownerSlug: "acme", spec: {}, headersEntityId: null, headersEntityVersionId: null }]]);
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/traits/0/libraryTraitId"]);
    });
    it("reports an external ref whose item was not supplied, or was supplied for the other kind", () => {
      const i = input();
      i.doc.externalRefs = [
        { key: "ext-c", eventVersionId: "ev9", kind: "channel", itemKey: "orders" },
        { key: "ext-m", eventVersionId: "ev9", kind: "message", itemKey: "Created" },
        { key: "ext-x", eventVersionId: "ev9", kind: "message", itemKey: "Other" },
      ];
      i.external = new Map([
        ["ext-m", { channel: { id: "orders", name: "orders", productSlug: "up", address: "o", protocol: "kafka", profile: { format: "avro" } } }],
      ]);
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/externalRefs/0", "/externalRefs/1", "/externalRefs/2"]);
    });
  });

  describe("external messages", () => {
    const external = (traitId = "CloudEvents") => ({
      channel: { id: "orders", name: "orders", productSlug: "upstream", address: "o", protocol: "kafka", profile: { format: "avro" as const } },
      message: {
        id: "OrderCreated", name: "OrderCreated", productSlug: "upstream", traitRefs: [traitId], payloads: [avro("Up")],
      },
      traits: [{ id: traitId, name: "CloudEvents", kind: "MESSAGE" as const, ownerSlug: "upstream", spec: { summary: "upstream ce" } }],
    });
    const withExternal = () => {
      const i = input();
      i.doc.channels = []; i.doc.messages = []; i.doc.traits = [{ key: "CloudEvents", kind: "MESSAGE", spec: {} }];
      i.doc.externalRefs = [
        { key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" },
        { key: "ext-created", eventVersionId: "ev9", kind: "message", itemKey: "OrderCreated" },
      ];
      i.doc.operations = [{ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["ext-created"], traitKeys: [] }];
      i.artifacts = new Map();
      const e = external();
      i.external = new Map([["ext-orders", { channel: e.channel }], ["ext-created", { message: e.message, traits: e.traits }]]);
      return i;
    };
    it("substitutes an external message under the ref key and carries its traits", () => {
      const r = resolveDocument(withExternal());
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.channels.map((c) => c.id)).toEqual(["ext-orders"]);
      expect(r.data.channels[0]).toMatchObject({ productSlug: "upstream", name: "orders" });
      expect(r.data.messages).toHaveLength(1);
      expect(r.data.messages[0]).toMatchObject({ id: "ext-created", name: "OrderCreated", productSlug: "upstream", payloads: [avro("Up")] });
      expect(r.data.operations[0]).toMatchObject({ channelRef: "ext-orders", messageRefs: ["ext-created"] });
    });
    it("scopes an external trait's id to its event version so it cannot capture a local trait of the same key", () => {
      const i = withExternal();
      i.doc.messages = [{ key: "Mine", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: ["CloudEvents"] }];
      i.doc.channels = [{ key: "mine", address: "m", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["Mine"] }];
      i.doc.operations.push({ key: "send", action: "send", channelKey: "mine", messageKeys: ["Mine"], traitKeys: [] });
      i.artifacts = new Map([["Mine", { payloads: [avro("Mine")], keys: [avro("MineKey")] }]]);
      const r = resolveDocument(i);
      expect(r.success).toBe(true);
      if (!r.success) return;
      const ids = r.data.traits.map((t) => t.id).sort();
      expect(ids).toEqual(["CloudEvents", "ev9:CloudEvents"]);
      expect(r.data.messages.find((m) => m.id === "ext-created")?.traitRefs).toEqual(["ev9:CloudEvents"]);
      expect(r.data.messages.find((m) => m.id === "Mine")?.traitRefs).toEqual(["CloudEvents"]);
      expect(r.data.traits.find((t) => t.id === "ev9:CloudEvents")).toMatchObject({ name: "CloudEvents", ownerSlug: "upstream", spec: { summary: "upstream ce" } });
      expect(assembleAsyncApi3(r.data).diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    });
    it("emits a trait shared by two external messages of one version once", () => {
      const i = withExternal();
      i.doc.externalRefs.push({ key: "ext-updated", eventVersionId: "ev9", kind: "message", itemKey: "OrderUpdated" });
      i.doc.operations[0].messageKeys.push("ext-updated");
      const e = external();
      i.external = new Map([...i.external, ["ext-updated", { message: { ...e.message, id: "OrderUpdated", name: "OrderUpdated" }, traits: e.traits }]]);
      const r = resolveDocument(i);
      expect(r.success && r.data.traits.map((t) => t.id)).toEqual(["ev9:CloudEvents"]);
    });
    it("reports an external message that uses a trait the stored version did not supply", () => {
      const i = withExternal();
      i.external = new Map([...i.external, ["ext-created", { message: external().message, traits: [] }]]);
      expect(problemsOf(resolveDocument(i)).map((p) => p.pointer)).toEqual(["/externalRefs/1"]);
    });
  });
});

// A version published with `emitAll` + `emitChannelServers` stores its channels WITH the ids of its own servers and messages
// (`serverRefs`, `messageRefs`) and a per-message profile table keyed by its own message ids (`messageProfiles`). Another event that
// references the channel must get the channel itself, never those ids: they name things that do not exist in the referencing event.
describe("an external channel brings no references of the source event", () => {
  const stored = (): ResolvedChannel => ({
    id: "orders", name: "orders", productSlug: "upstream", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" },
    title: "Orders", bindings: { kafka: { partitions: 12 } },
    serverRefs: ["kafka-prod"], messageRefs: ["OrderCreated"], messageProfiles: { OrderCreated: { format: "protobuf" } },
  });
  const jsonSchema = (name: string) => ({ format: "json-schema" as const, dialect: "draft-07" as const, schema: { type: "object", title: name, properties: { id: { type: "string" } } } });
  const errorsOf = (r: ReturnType<typeof assembleAsyncApi3>) => r.diagnostics.filter((x) => x.severity === "error");
  const emitAllInput = (d: EventDocument): ResolveDocumentInput => ({ ...input(d), emitAll: true, emitChannelServers: true });

  /** An event with NO local channel and NO server: it only references the source's channel and sends / receives on it. */
  const referencing = (messageKey: string): EventDocument => ({
    ...emptyEventDocument("consumer"),
    externalRefs: [{ key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }],
    operations: [{ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: [messageKey], traitKeys: [] }],
  });

  it("keeps what describes the channel and drops serverRefs, messageRefs and messageProfiles, without touching the stored copy", () => {
    const d = referencing("Mine");
    d.messages = [{ key: "Mine", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] }];
    const i = emitAllInput(d);
    i.artifacts = new Map([["Mine", { payloads: [jsonSchema("Mine")], keys: [] }]]);
    const channel = stored();
    i.external = new Map([["ext-orders", { channel }]]);

    const r = resolveDocument(i);

    expect(r.success).toBe(true);
    if (!r.success) return;
    const resolved = r.data.channels.find((c) => c.id === "ext-orders");
    expect(resolved).toMatchObject({ id: "ext-orders", name: "orders", productSlug: "upstream", address: "payments.orders.v1", protocol: "kafka", profile: { format: "avro" }, title: "Orders", bindings: { kafka: { partitions: 12 } } });
    expect(resolved).not.toHaveProperty("serverRefs");
    expect(resolved).not.toHaveProperty("messageRefs");
    expect(resolved).not.toHaveProperty("messageProfiles");
    expect(channel).toEqual(stored()); // the supplied (stored) channel is a copy source, never mutated
  });

  it("sends a LOCAL message on an external channel and emits with 0 errors", () => {
    const d = referencing("Mine");
    d.messages = [{ key: "Mine", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] }];
    const i = emitAllInput(d);
    i.artifacts = new Map([["Mine", { payloads: [jsonSchema("Mine")], keys: [] }]]);
    i.external = new Map([["ext-orders", { channel: stored() }]]);

    const r = resolveDocument(i);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const assembled = assembleAsyncApi3(r.data);

    expect(errorsOf(assembled)).toEqual([]);
    const channels = Object.values(assembled.document.channels as Record<string, { address?: string; messages?: Record<string, unknown>; servers?: unknown }>);
    expect(channels).toHaveLength(1); // the external channel, emitted under its own name
    expect(channels[0].address).toBe("payments.orders.v1");
    expect(Object.keys(channels[0].messages ?? {})).toHaveLength(1); // exactly what this event's operation put on it
    expect(channels[0]).not.toHaveProperty("servers"); // the source's servers are not this event's
  });

  it("never lets the source's per-message profile reach a local message that happens to share a message id", () => {
    // the source's table says "OrderCreated is protobuf on this channel"; the LOCAL message with the same id has no protobuf payload
    const d = referencing("OrderCreated");
    d.messages = [{ key: "OrderCreated", payload: { entityId: "e1", entityVersionId: "v1" }, traitKeys: [] }];
    const i = emitAllInput(d);
    i.artifacts = new Map([["OrderCreated", { payloads: [jsonSchema("Mine")], keys: [] }]]);
    i.external = new Map([["ext-orders", { channel: stored() }]]);

    const r = resolveDocument(i);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const assembled = assembleAsyncApi3(r.data);

    expect(errorsOf(assembled)).toEqual([]);
    const messages = (assembled.document.components as { messages: Record<string, { payload?: { schemaFormat?: string } }> }).messages;
    const formats = Object.values(messages).map((m) => m.payload?.schemaFormat ?? "");
    expect(formats.some((f) => f.includes("schema+json"))).toBe(true);
    expect(formats.some((f) => f.includes("protobuf"))).toBe(false);
  });

  it("receives an external MESSAGE of the same version on the external channel and emits with 0 errors", () => {
    const d = referencing("ext-created");
    d.externalRefs.push({ key: "ext-created", eventVersionId: "ev9", kind: "message", itemKey: "OrderCreated" });
    const i = emitAllInput(d);
    i.artifacts = new Map();
    i.external = new Map([
      ["ext-orders", { channel: stored() }],
      ["ext-created", { message: { id: "OrderCreated", name: "OrderCreated", productSlug: "upstream", traitRefs: [], payloads: [avro("Up")], profile: { format: "avro" } }, traits: [] }],
    ]);

    const r = resolveDocument(i);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const assembled = assembleAsyncApi3(r.data);

    expect(errorsOf(assembled)).toEqual([]);
    const channels = Object.values(assembled.document.channels as Record<string, { messages?: Record<string, unknown> }>);
    expect(channels).toHaveLength(1);
    expect(Object.keys(channels[0].messages ?? {})).toHaveLength(1);
  });
});
