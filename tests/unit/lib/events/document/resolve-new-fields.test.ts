// tests/unit/lib/events/document/resolve-new-fields.test.ts
// WP-1a: resolveDocument carries every new document field into the intermediate types, without aliasing the draft and
// without adding keys a slice-1 document never had.
import { describe, expect, it } from "vitest";
import { resolveDocument, type ResolveDocumentInput } from "@/lib/events/document/resolve";
import type { EventDocument } from "@/lib/events/document/types";
import type { ResolvedEventSpec } from "@/lib/event-specs/types";
import { resolveInput } from "./fixtures/compat-pipeline";
import { slice1Minimal } from "./fixtures/slice1-documents";

/** The minimal document, extended so every new field is present at least once. */
function rich(): EventDocument {
  const d = slice1Minimal();
  d.traits = [{ key: "Envelope", kind: "MESSAGE", spec: { summary: "Envelope" } }, { key: "Audited", kind: "OPERATION", spec: { summary: "Audited" } }];
  d.info = {
    title: "checkout-service", termsOfService: "https://example.com/terms", contact: { name: "Platform", email: "p@example.com" },
    license: { name: "MIT" }, tags: [{ name: "payments" }], externalDocs: { url: "https://example.com/docs" },
  };
  d.servers = [{
    key: "kafka-prod", protocol: "kafka", host: "{env}.kafka.internal:9092", title: "Prod", summary: "Production cluster",
    variables: { env: { enum: ["prod", "stage"], default: "prod" } }, security: ["basic"],
    tags: [{ name: "prod" }], externalDocs: { url: "https://example.com/kafka" }, bindings: { kafka: { schemaRegistryUrl: "https://registry.example.com" } },
  }];
  d.channels = [
    { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
    { key: "replies", address: "orders.replies.v1", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] },
  ];
  d.messages = [{
    key: "OrderCreated", name: "order.created", title: "Order created", deprecated: true,
    correlationId: { location: "$message.header#/correlationId" }, tags: [{ name: "created" }], externalDocs: { url: "https://example.com/created" },
    examples: [{ name: "e", payload: { id: "1" } }], payload: { entityId: "ent-order", entityVersionId: "ev1" }, traitKeys: ["Envelope"],
  }];
  d.operations = [{
    key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"],
    title: "Publish", security: ["basic"], tags: [{ name: "orders" }], externalDocs: { url: "https://example.com/op" },
    reply: { address: { location: "$message.header#/replyTo", description: "Reply topic" }, channelKey: "replies", messageKeys: ["OrderCreated"] },
  }];
  d.components = { securitySchemes: { basic: { type: "userPassword", description: "Basic" } } };
  return d;
}
const resolveRich = (overrides: Partial<ResolveDocumentInput> = {}, doc = rich()): ResolvedEventSpec => {
  const r = resolveDocument(resolveInput(doc, overrides));
  if (!r.success) throw new Error(JSON.stringify(r.error.details));
  return r.data;
};

describe("resolveDocument carries the new document fields", () => {
  it("info, with the version added", () => {
    expect(resolveRich().info).toEqual({
      title: "checkout-service", termsOfService: "https://example.com/terms", contact: { name: "Platform", email: "p@example.com" },
      license: { name: "MIT" }, tags: [{ name: "payments" }], externalDocs: { url: "https://example.com/docs" }, version: "2.0",
    });
  });

  it("every new server field, and still omits origin", () => {
    const d = rich();
    d.servers[0] = { ...d.servers[0], origin: { provider: "infra", ref: "k1", syncedAt: "2026-10-15T00:00:00Z" } };
    expect(resolveRich({}, d).servers).toEqual([{
      key: "kafka-prod", protocol: "kafka", host: "{env}.kafka.internal:9092", title: "Prod", summary: "Production cluster",
      variables: { env: { enum: ["prod", "stage"], default: "prod" } }, security: ["basic"],
      tags: [{ name: "prod" }], externalDocs: { url: "https://example.com/kafka" }, bindings: { kafka: { schemaRegistryUrl: "https://registry.example.com" } },
    }]);
  });

  it("message name as messageName (the resolved name stays the key), deprecated, correlationId and the other message fields", () => {
    const message = resolveRich().messages[0];
    expect(message).toMatchObject({
      id: "OrderCreated", name: "OrderCreated", messageName: "order.created", deprecated: true,
      correlationId: { location: "$message.header#/correlationId" }, tags: [{ name: "created" }], externalDocs: { url: "https://example.com/created" },
      examples: [{ name: "e", payload: { id: "1" } }],
    });
  });

  it("deprecated: false is carried as authored", () => {
    const d = rich(); d.messages[0].deprecated = false;
    expect(resolveRich({}, d).messages[0].deprecated).toBe(false);
  });

  it("every new operation field, including the reply address", () => {
    expect(resolveRich().operations[0]).toEqual({
      key: "publishOrderCreated", action: "send", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["Audited"],
      title: "Publish", security: ["basic"], tags: [{ name: "orders" }], externalDocs: { url: "https://example.com/op" },
      reply: { address: { location: "$message.header#/replyTo", description: "Reply topic" }, channelRef: "replies", messageRefs: ["OrderCreated"] },
    });
  });

  it("a reply that carries only an address", () => {
    const d = rich();
    d.operations[0].reply = { address: { location: "$message.payload#/replyTo" } };
    expect(resolveRich({}, d).operations[0].reply).toEqual({ address: { location: "$message.payload#/replyTo" } });
  });

  it("components.securitySchemes", () => {
    expect(resolveRich().components).toEqual({ securitySchemes: { basic: { type: "userPassword", description: "Basic" } } });
  });

  it("local trait specs unchanged", () => {
    expect(resolveRich().traits.map((t) => [t.id, t.spec])).toEqual([["Envelope", { summary: "Envelope" }], ["Audited", { summary: "Audited" }]]);
  });
});

describe("channel servers are opt-in (a slice-1 document must resolve to what it resolved to before)", () => {
  it("does not add serverRefs by default", () => {
    expect(resolveRich().channels.map((c) => "serverRefs" in c)).toEqual([false, false]);
  });
  it("adds serverRefs from serverKeys when emitChannelServers is set, and only for channels that have servers", () => {
    const channels = resolveRich({ emitChannelServers: true }).channels;
    expect(channels.find((c) => c.id === "orders")?.serverRefs).toEqual(["kafka-prod"]);
    expect(channels.find((c) => c.id === "replies")).not.toHaveProperty("serverRefs");
  });
  it("leaves external channels untouched", () => {
    const d = rich();
    d.channels = []; d.messages[0].traitKeys = [];
    d.externalRefs = [{ key: "ext", eventVersionId: "ev9", kind: "channel", itemKey: "orders" }];
    d.operations = [{ key: "recv", action: "receive", channelKey: "ext", messageKeys: [], traitKeys: [] }];
    const ext = { id: "orders", name: "orders", productSlug: "up", address: "o", protocol: "kafka", profile: { format: "avro" as const }, serverRefs: ["upstream-kafka"] };
    const r = resolveRich({ emitChannelServers: true, external: new Map([["ext", { channel: ext }]]) }, d);
    expect(r.channels[0].serverRefs).toEqual(["upstream-kafka"]);
  });
});

describe("absent fields stay absent", () => {
  it("adds none of the new keys for a slice-1 document", () => {
    const r = resolveRich({}, slice1Minimal());
    expect(r.info).toEqual({ title: "checkout-service", version: "2.0" });
    expect(Object.keys(r.servers[0])).toEqual(["key", "protocol", "host"]);
    expect(Object.keys(r.operations[0]).sort()).toEqual(["action", "channelRef", "key", "messageRefs", "traitRefs"]);
    const message = r.messages[0];
    for (const key of ["messageName", "deprecated", "correlationId", "tags", "externalDocs", "examples", "bindings"]) expect(message).not.toHaveProperty(key);
    expect(r.components).toEqual({});
  });
});

describe("no aliasing of the draft", () => {
  it("clones every new nested object", () => {
    const d = rich();
    const r = resolveRich({}, d);
    expect(r.servers[0].variables).not.toBe(d.servers[0].variables);
    expect(r.servers[0].variables?.env).not.toBe(d.servers[0].variables?.env);
    expect(r.servers[0].security).not.toBe(d.servers[0].security);
    expect(r.servers[0].tags).not.toBe(d.servers[0].tags);
    expect(r.servers[0].externalDocs).not.toBe(d.servers[0].externalDocs);
    expect(r.servers[0].bindings).not.toBe(d.servers[0].bindings);
    expect(r.operations[0].security).not.toBe(d.operations[0].security);
    expect(r.operations[0].tags).not.toBe(d.operations[0].tags);
    expect(r.operations[0].externalDocs).not.toBe(d.operations[0].externalDocs);
    expect(r.operations[0].reply?.address).not.toBe(d.operations[0].reply?.address);
    expect(r.info.contact).not.toBe(d.info.contact);
    expect(r.info.tags).not.toBe(d.info.tags);
    expect(r.components.securitySchemes).not.toBe(d.components?.securitySchemes);
  });
  it("does not mutate the document", () => {
    const d = rich();
    const before = JSON.stringify(d);
    resolveRich({}, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
