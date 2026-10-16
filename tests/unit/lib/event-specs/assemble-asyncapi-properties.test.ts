// tests/unit/lib/event-specs/assemble-asyncapi-properties.test.ts
// WP-1a: the assembler emits every AsyncAPI 3.0 property the intermediate types gained, in canonical positions, and leaves
// the output of a spec that uses none of them untouched.
import { describe, expect, it } from "vitest";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import { INFO_KEY_ORDER, canonicalizeDocumentOrder, toJson } from "@/lib/event-specs/serialize";
import { validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import type { JsonObject, ResolvedEventSpec } from "@/lib/event-specs/types";
import { channel, deepFreeze, jsonObject, message, operation, spec } from "./fixtures/builders";

const ch = channel({ id: "orders", name: "orders" });
const msg = message({ id: "OrderCreated", name: "OrderCreated" });
const op = operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"] });
const base = (extra: Partial<ResolvedEventSpec> = {}): ResolvedEventSpec => spec({ channels: [ch], messages: [msg], operations: [op], ...extra });

const emit = (s: ResolvedEventSpec) => assembleAsyncApi3(s);
const keysOf = (value: unknown): string[] => Object.keys(value as JsonObject);
const at = (document: JsonObject, ...path: string[]): JsonObject => path.reduce<unknown>((node, key) => (node as JsonObject)[key], document) as JsonObject;
const errorsOf = (s: ResolvedEventSpec) => [...emit(s).diagnostics, ...validateAsyncApi3Structure(emit(s).document)].filter((d) => d.severity === "error");

describe("info", () => {
  const info = {
    title: "t", version: "1.0", description: "d", termsOfService: "https://example.com/terms",
    contact: { name: "n", url: "https://example.com", email: "a@b.co" }, license: { name: "MIT", url: "https://example.com/mit" },
    tags: [{ name: "x", description: "X", externalDocs: { url: "https://example.com/x" } }], externalDocs: { url: "https://example.com/docs", description: "Docs" },
  };
  it("emits termsOfService after description, then contact, license, tags, externalDocs", () => {
    const { document } = emit(base({ info }));
    expect(keysOf(document.info)).toEqual(["title", "version", "description", "termsOfService", "contact", "license", "tags", "externalDocs"]);
    expect(document.info).toEqual(info);
  });
  it("keeps the serializer's canonical info order in sync with the assembler", () => {
    expect(INFO_KEY_ORDER).toEqual(["title", "version", "description", "termsOfService", "contact", "license", "tags", "externalDocs"]);
    const { document } = emit(base({ info }));
    expect(toJson(canonicalizeDocumentOrder(document))).toBe(toJson(document));
  });
  it("restores termsOfService to its place after a jsonb round trip", () => {
    const { document } = emit(base({ info }));
    const scrambled = { ...document, info: Object.fromEntries(Object.entries(document.info as JsonObject).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))) };
    expect(keysOf(scrambled.info)).not.toEqual(keysOf(document.info));
    expect(keysOf(canonicalizeDocumentOrder(scrambled).info)).toEqual(keysOf(document.info));
  });
  it("omits termsOfService when it is not set", () => {
    expect(keysOf(emit(base()).document.info)).toEqual(["title", "version"]);
  });
});

describe("servers", () => {
  const server = {
    key: "kafka-prod", protocol: "kafka", host: "{env}.kafka.internal:9092", pathname: "/{region}", protocolVersion: "3.7", description: "Prod",
    title: "Kafka prod", summary: "The production cluster",
    variables: { region: { default: "eu", enum: ["eu", "us"] }, env: { description: "Environment", examples: ["prod"] } },
    security: ["token", "basic"], tags: [{ name: "prod" }], externalDocs: { url: "https://example.com/kafka", description: "Runbook" },
    bindings: { kafka: { schemaRegistryUrl: "https://registry.example.com" } },
  };
  const securitySchemes = { basic: { type: "userPassword" }, token: { type: "http", scheme: "bearer" } };

  it("emits every server property in canonical order", () => {
    const { document, diagnostics } = emit(base({ servers: [server], components: { securitySchemes } }));
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(keysOf(at(document, "servers", "kafka-prod"))).toEqual([
      "host", "protocol", "protocolVersion", "pathname", "title", "summary", "description", "variables", "security", "tags", "externalDocs", "bindings",
    ]);
  });
  it("sorts the variables by name and keeps each variable's content", () => {
    const { document } = emit(base({ servers: [server] }));
    const variables = at(document, "servers", "kafka-prod").variables as JsonObject;
    expect(keysOf(variables)).toEqual(["env", "region"]);
    expect(variables.region).toEqual({ default: "eu", enum: ["eu", "us"] });
  });
  it("emits security as $refs to components.securitySchemes, in authored order, next to the schemes themselves", () => {
    const { document } = emit(base({ servers: [server], components: { securitySchemes } }));
    expect(at(document, "servers", "kafka-prod").security).toEqual([{ $ref: "#/components/securitySchemes/token" }, { $ref: "#/components/securitySchemes/basic" }]);
    expect(at(document, "components").securitySchemes).toEqual(securitySchemes);
    expect(keysOf(at(document, "components", "securitySchemes"))).toEqual(["basic", "token"]);
  });
  it("escapes a key in a security $ref", () => {
    const { document } = emit(base({ servers: [{ ...server, security: ["a/b"] }], components: { securitySchemes: { "a/b": { type: "plain" } } } }));
    expect(at(document, "servers", "kafka-prod").security).toEqual([{ $ref: "#/components/securitySchemes/a~1b" }]);
  });
  it("emits externalDocs over the v1 externalRef shorthand, and keeps the shorthand when externalDocs is absent", () => {
    const both = emit(base({ servers: [{ ...server, externalRef: "https://example.com/old" }] })).document;
    expect(at(both, "servers", "kafka-prod").externalDocs).toEqual({ url: "https://example.com/kafka", description: "Runbook" });
    const shorthand = emit(base({ servers: [{ key: "s", protocol: "kafka", host: "h:1", externalRef: "https://example.com/old" }] })).document;
    expect(at(shorthand, "servers", "s").externalDocs).toEqual({ url: "https://example.com/old" });
  });
  it("omits empty lists and maps instead of emitting empty containers", () => {
    const { document } = emit(base({ servers: [{ key: "s", protocol: "kafka", host: "h:1", variables: {}, security: [], tags: [] }] }));
    expect(keysOf(at(document, "servers", "s"))).toEqual(["host", "protocol"]);
  });
  it("a server that uses none of the new fields keeps its slice-1 shape", () => {
    const { document } = emit(base({ servers: [{ key: "s", protocol: "kafka", host: "h:1", protocolVersion: "3", pathname: "/p", description: "d", externalRef: "https://example.com" }] }));
    expect(keysOf(at(document, "servers", "s"))).toEqual(["host", "protocol", "protocolVersion", "pathname", "description", "externalDocs"]);
  });
  it("a security $ref to a missing scheme is a structural error, not a silent drop", () => {
    expect(errorsOf(base({ servers: [{ ...server, security: ["ghost"] }] })).map((d) => d.code)).toContain("UNRESOLVED_REF");
  });
});

describe("channels", () => {
  const server = { key: "kafka-prod", protocol: "kafka", host: "h:9092" };
  it("emits servers as $refs after description and before parameters", () => {
    const withServers = channel({ id: "orders", name: "orders", description: "d", parameters: { p: { description: "P" } }, address: "orders.{p}", serverRefs: ["kafka-prod"] });
    const { document, diagnostics } = emit(base({ channels: [withServers], servers: [server] }));
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(keysOf(at(document, "channels", "orders"))).toEqual(["address", "messages", "description", "servers", "parameters"]);
    expect(at(document, "channels", "orders").servers).toEqual([{ $ref: "#/servers/kafka-prod" }]);
  });
  it("reports a channel server that is not in the spec, with the channel pointer", () => {
    const { document, diagnostics } = emit(base({ channels: [channel({ id: "orders", name: "orders", serverRefs: ["ghost", "kafka-prod"] })], servers: [server] }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "UNKNOWN_SERVER_REF", pointer: "/channels/orders/servers/0" }));
    expect(at(document, "channels", "orders").servers).toEqual([{ $ref: "#/servers/kafka-prod" }]);
  });
  it("omits servers when serverRefs is absent or empty (a slice-1 channel keeps its shape)", () => {
    expect(keysOf(at(emit(base()).document, "channels", "orders"))).toEqual(["address", "messages"]);
    expect(keysOf(at(emit(base({ channels: [channel({ id: "orders", name: "orders", serverRefs: [] })] })).document, "channels", "orders"))).toEqual(["address", "messages"]);
  });
  it("emits every channel parameter property", () => {
    const parameters = { tenant: { description: "T", enum: ["a"], default: "a", examples: ["a"], location: "$message.payload#/tenant" } };
    const { document } = emit(base({ channels: [channel({ id: "orders", name: "orders", address: "o.{tenant}", parameters })] }));
    expect(at(document, "channels", "orders").parameters).toEqual(parameters);
  });
});

describe("operations", () => {
  const full = operation({
    key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["Audited"],
    title: "Publish", summary: "s", description: "d", security: ["basic"], tags: [{ name: "orders" }], externalDocs: { url: "https://example.com/op" },
    bindings: { kafka: { clientId: "c" } }, reply: { address: { location: "$message.header#/replyTo", description: "Reply" }, channelRef: "replies", messageRefs: ["OrderCreated"] },
  });
  const replies = channel({ id: "replies", name: "replies" });
  const audited = { id: "Audited", name: "Audited", kind: "OPERATION" as const, ownerSlug: "checkout", spec: { summary: "Audited" } };
  const fullSpec = () => base({ channels: [ch, replies], operations: [full], traits: [audited], components: { securitySchemes: { basic: { type: "userPassword" } } } });

  it("emits every operation property in canonical order", () => {
    const { document, diagnostics } = emit(fullSpec());
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(keysOf(at(document, "operations", "publish"))).toEqual([
      "action", "channel", "title", "summary", "description", "security", "tags", "externalDocs", "bindings", "traits", "messages", "reply",
    ]);
  });
  it("emits security as $refs", () => {
    expect(at(emit(fullSpec()).document, "operations", "publish").security).toEqual([{ $ref: "#/components/securitySchemes/basic" }]);
  });
  it("emits the reply address inline, before channel and messages", () => {
    const reply = at(emit(fullSpec()).document, "operations", "publish", "reply");
    expect(keysOf(reply)).toEqual(["address", "channel", "messages"]);
    expect(reply.address).toEqual({ location: "$message.header#/replyTo", description: "Reply" });
    expect(reply.channel).toEqual({ $ref: "#/channels/replies" });
  });
  it("emits a reply that carries only an address", () => {
    const only = operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], reply: { address: { location: "$message.payload#/replyTo" } } });
    const reply = at(emit(base({ operations: [only] })).document, "operations", "publish", "reply");
    expect(reply).toEqual({ address: { location: "$message.payload#/replyTo" } });
  });
  it("omits empty security and tags; a slice-1 operation keeps its shape", () => {
    const empty = operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], security: [], tags: [] });
    expect(keysOf(at(emit(base({ operations: [empty] })).document, "operations", "publish"))).toEqual(["action", "channel", "messages"]);
  });
  it("a security $ref to a missing scheme is a structural error", () => {
    const s = base({ operations: [operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], security: ["ghost"] })] });
    expect(errorsOf(s).map((d) => d.code)).toContain("UNRESOLVED_REF");
  });
});

describe("messages", () => {
  const emitted = (m: Partial<Parameters<typeof message>[0]>) =>
    at(emit(base({ messages: [message({ id: "OrderCreated", name: "OrderCreated", payloads: [jsonObject("P"), { format: "avro", schema: { type: "record", name: "P", fields: [] } }], ...m })] })).document, "components", "messages");

  it("emits deprecated after externalDocs and before bindings", () => {
    const out = emit(base({ messages: [message({ id: "OrderCreated", name: "OrderCreated", title: "T", tags: [{ name: "t" }], externalDocs: { url: "https://example.com" }, deprecated: true, bindings: { kafka: {} }, examples: [{ payload: 1 }] })] }));
    expect(keysOf(at(out.document, "components", "messages", "OrderCreated"))).toEqual(
      ["title", "contentType", "payload", "tags", "externalDocs", "deprecated", "bindings", "examples"],
    );
    expect(at(out.document, "components", "messages", "OrderCreated").deprecated).toBe(true);
  });
  it("emits deprecated: false when the document says false (as authored)", () => {
    expect(at(emit(base({ messages: [message({ id: "OrderCreated", name: "OrderCreated", deprecated: false })] })).document, "components", "messages", "OrderCreated").deprecated).toBe(false);
  });
  it("emits messageName as the AsyncAPI name, first", () => {
    const out = at(emit(base({ messages: [message({ id: "OrderCreated", name: "OrderCreated", messageName: "order.created", title: "T" })] })).document, "components", "messages", "OrderCreated");
    expect(keysOf(out)[0]).toBe("name");
    expect(out.name).toBe("order.created");
  });
  it("messageName wins over the disambiguation name, and every format variant carries it", () => {
    const channels = [channel({ id: "a", name: "a", profile: { format: "avro" } }), channel({ id: "b", name: "b", profile: { format: "json-schema", dialect: "draft-07" } })];
    const m = message({ id: "OrderCreated", name: "OrderCreated", messageName: "order.created" });
    const ops = [operation({ key: "o1", channelRef: "a", messageRefs: ["OrderCreated"] }), operation({ key: "o2", channelRef: "b", messageRefs: ["OrderCreated"] })];
    const messages = at(emit(base({ channels, messages: [m], operations: ops })).document, "components", "messages");
    expect(keysOf(messages)).toEqual(["OrderCreated_avro", "OrderCreated_json"]);
    expect(Object.values(messages).map((x) => (x as JsonObject).name)).toEqual(["order.created", "order.created"]);
  });
  it("without messageName the disambiguated name is still derived as before", () => {
    const channels = [channel({ id: "a", name: "a", profile: { format: "avro" } }), channel({ id: "b", name: "b", profile: { format: "json-schema", dialect: "draft-07" } })];
    const ops = [operation({ key: "o1", channelRef: "a", messageRefs: ["OrderCreated"] }), operation({ key: "o2", channelRef: "b", messageRefs: ["OrderCreated"] })];
    const messages = at(emit(base({ channels, messages: [msg], operations: ops })).document, "components", "messages");
    expect(Object.values(messages).map((x) => (x as JsonObject).name)).toEqual(["OrderCreated", "OrderCreated"]);
  });
  it("a message without name or deprecated keeps its slice-1 shape", () => {
    expect(keysOf(emitted({}).OrderCreated)).toEqual(["contentType", "payload"]);
  });
});

describe("traits", () => {
  const trait = (kind: "MESSAGE" | "OPERATION", specObject: JsonObject) => ({ id: "T", name: "T", kind, ownerSlug: "checkout", spec: specObject });

  it("emits an operation trait's security keys as $refs and leaves the other keys verbatim", () => {
    const s = base({
      operations: [operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["T"] })],
      traits: [trait("OPERATION", { title: "T", security: ["basic"], tags: [{ name: "t" }], bindings: { kafka: { groupId: "g" } } })],
      components: { securitySchemes: { basic: { type: "userPassword" } } },
    });
    const out = emit(s);
    expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(at(out.document, "components", "operationTraits", "T")).toEqual({
      title: "T", security: [{ $ref: "#/components/securitySchemes/basic" }], tags: [{ name: "t" }], bindings: { kafka: { groupId: "g" } },
    });
    expect(keysOf(at(out.document, "components", "operationTraits", "T"))).toEqual(["title", "security", "tags", "bindings"]);
  });
  it("leaves security entries that are already objects (a library trait's native form) alone", () => {
    const s = base({
      operations: [operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["T"] })],
      traits: [trait("OPERATION", { security: [{ $ref: "#/components/securitySchemes/basic" }] })],
      components: { securitySchemes: { basic: { type: "userPassword" } } },
    });
    expect(at(emit(s).document, "components", "operationTraits", "T").security).toEqual([{ $ref: "#/components/securitySchemes/basic" }]);
  });
  it("emits every message trait property verbatim", () => {
    const specObject = {
      name: "n", title: "t", summary: "s", description: "d", contentType: "application/json", correlationId: { location: "$message.header#/id" },
      tags: [{ name: "x" }], externalDocs: { url: "https://example.com" }, deprecated: false, examples: [{ headers: { a: "1" } }], bindings: { kafka: {} },
    };
    const s = base({ messages: [message({ id: "OrderCreated", name: "OrderCreated", traitRefs: ["T"] })], traits: [trait("MESSAGE", specObject)] });
    const out = emit(s);
    expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(at(out.document, "components", "messageTraits", "T")).toEqual(specObject);
  });
});

describe("a spec that uses none of the new fields", () => {
  it("emits no new key anywhere", () => {
    const { document } = emit(base({ servers: [{ key: "s", protocol: "kafka", host: "h:1" }] }));
    expect(keysOf(document)).toEqual(["asyncapi", "info", "servers", "channels", "operations", "components"]);
    expect(keysOf(document.info)).toEqual(["title", "version"]);
    expect(keysOf(at(document, "servers", "s"))).toEqual(["host", "protocol"]);
    expect(keysOf(at(document, "channels", "orders"))).toEqual(["address", "messages"]);
    expect(keysOf(at(document, "operations", "publish"))).toEqual(["action", "channel", "messages"]);
  });
});

describe("purity", () => {
  it("never mutates a deep-frozen input that uses every new field, and is deterministic", () => {
    const frozen = deepFreeze(spec({
      info: { title: "t", version: "1", termsOfService: "https://example.com/t", contact: { name: "n" }, license: { name: "MIT" }, tags: [{ name: "a" }], externalDocs: { url: "https://example.com" } },
      servers: [{ key: "s", protocol: "kafka", host: "{e}.h:1", title: "T", summary: "S", variables: { e: { default: "p" } }, security: ["basic"], tags: [{ name: "t" }], externalDocs: { url: "https://example.com" }, bindings: { kafka: {} } }],
      channels: [channel({ id: "orders", name: "orders", serverRefs: ["s"] }), channel({ id: "replies", name: "replies" })],
      messages: [message({ id: "OrderCreated", name: "OrderCreated", messageName: "order.created", deprecated: true })],
      operations: [operation({ key: "publish", channelRef: "orders", messageRefs: ["OrderCreated"], traitRefs: ["Audited"], title: "T", security: ["basic"], tags: [{ name: "o" }], externalDocs: { url: "https://example.com" }, reply: { address: { location: "$message.header#/r" }, channelRef: "replies", messageRefs: ["OrderCreated"] } })],
      traits: [{ id: "Audited", name: "Audited", kind: "OPERATION", ownerSlug: "checkout", spec: { security: ["basic"] } }],
      components: { securitySchemes: { basic: { type: "userPassword" } } },
    }));
    const a = toJson(assembleAsyncApi3(frozen).document);
    const b = toJson(assembleAsyncApi3(structuredClone(frozen)).document);
    expect(b).toBe(a);
  });
});
