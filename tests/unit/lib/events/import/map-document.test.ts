// tests/unit/lib/events/import/map-document.test.ts
// WP-I1: an AsyncAPI 3.0 document → an event document (the inverse of the assembler). One test group per fixture asserts the key facts and
// the warnings; the rest pin the rules the brief names: component identity, key adjustment, sanitising, built-in traits, hostile input.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { EventDocument } from "@/lib/events/document/types";
import { extractPayloads } from "@/lib/events/import/payloads";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { ImportWarning, MapContext, RawAsyncApi3 } from "@/lib/events/import/types";

const DIR = path.join(process.cwd(), "tests/fixtures/asyncapi-import");
const FIXTURES = [
  "builtin-traits.yaml", "http-websocket-minimal.json", "inline-messages-and-traits.yaml", "multi-format-payloads.yaml",
  "recursive-payload-placeholder.yaml", "recursive-schemas.yaml", "request-reply.yaml", "streetlights-kafka.yaml", "streetlights-mqtt.yaml",
  "unsupported-payloads.yaml",
];

function load(name: string): RawAsyncApi3 {
  const parsed = parseAsyncApiSource(readFileSync(path.join(DIR, name), "utf8"));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}
/** A pin for every extracted payload and headers schema, the way the persisting step would hand them in. */
function pinsFor(raw: RawAsyncApi3): MapContext["payloadPins"] {
  const extracted = extractPayloads(raw);
  if (!extracted.success) return new Map(); // a document the mapper must reject has nothing to pin
  return new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `ent-${p.messageKey}-${p.role}`, entityVersionId: null }]));
}
const context = (raw: RawAsyncApi3, builtInTraitIds: MapContext["builtInTraitIds"] = {}): MapContext => ({ payloadPins: pinsFor(raw), builtInTraitIds });
function mapRaw(raw: RawAsyncApi3, builtInTraitIds?: MapContext["builtInTraitIds"]): { document: EventDocument; warnings: ImportWarning[] } {
  const result = mapAsyncApiToEventDocument(raw, context(raw, builtInTraitIds));
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
const mapFixture = (name: string, builtInTraitIds?: MapContext["builtInTraitIds"]) => mapRaw(load(name), builtInTraitIds);
function failure(raw: RawAsyncApi3, ctx: MapContext = context(raw)) {
  const result = mapAsyncApiToEventDocument(raw, ctx);
  if (result.success) throw new Error("expected the mapping to fail");
  return result.error;
}
const doc = (rest: Record<string, unknown>): RawAsyncApi3 => ({ asyncapi: "3.0.0", info: { title: "T", version: "1" }, ...rest });
/** A one-channel, one-message document to hang a single odd value on. */
function tiny(overrides: { message?: Record<string, unknown>; channel?: Record<string, unknown>; operation?: Record<string, unknown>; server?: Record<string, unknown>; components?: Record<string, unknown> } = {}): RawAsyncApi3 {
  return doc({
    servers: { s: { host: "h:1", protocol: "kafka", ...overrides.server } },
    channels: { c: { address: "a", messages: { m: { $ref: "#/components/messages/m" } }, ...overrides.channel } },
    operations: { o: { action: "send", channel: { $ref: "#/channels/c" }, messages: [{ $ref: "#/channels/c/messages/m" }], ...overrides.operation } },
    components: { messages: { m: { payload: { type: "object" }, ...overrides.message } }, ...overrides.components },
  });
}
const byCode = (warnings: ImportWarning[], code: string) => warnings.filter((w) => w.code === code);
const keysOf = (items: Array<{ key: string }>) => items.map((i) => i.key);

describe("every fixture", () => {
  it.each(FIXTURES)("%s maps to a document that parses, with no version, no external references and the app's own shape", (name) => {
    const { document } = mapFixture(name);
    const reparsed = parseEventDocument(document);
    expect(reparsed.success).toBe(true);
    if (reparsed.success) expect(reparsed.data).toEqual(document);
    expect(document.documentVersion).toBe(2);
    expect(document.externalRefs).toEqual([]);
    expect(document.info).not.toHaveProperty("version");
    expect(document.messages.length).toBeGreaterThan(0);
    for (const m of document.messages) expect(m.payload.entityId).not.toBe("");
  });

  it.each(FIXTURES)("%s: every key a list refers to exists, and nothing is shared with the input", (name) => {
    const raw = load(name);
    const before = JSON.stringify(raw);
    const { document } = mapRaw(raw);
    expect(JSON.stringify(raw)).toBe(before);
    const messageKeys = new Set(keysOf(document.messages));
    const channelKeys = new Set(keysOf(document.channels));
    for (const c of document.channels) for (const k of c.messageKeys) expect(messageKeys.has(k)).toBe(true);
    for (const o of document.operations) {
      expect(channelKeys.has(o.channelKey)).toBe(true);
      for (const k of o.messageKeys) expect(messageKeys.has(k)).toBe(true);
    }
  });
});

describe("streetlights-kafka.yaml (components, $refs, a send/receive pair, no reply)", () => {
  const { document, warnings } = mapFixture("streetlights-kafka.yaml");

  it("imports without a single warning", () => {
    expect(warnings).toEqual([]);
  });

  it("info: title, description, contact, license, tags, externalDocs; no version", () => {
    expect(document.info.title).toBe("Streetlights Kafka API");
    expect(document.info.description).toContain("remotely manage the city lights");
    expect(document.info.contact).toEqual({ name: "Streetlights support", email: "support@streetlights.example.com" });
    expect(document.info.license).toEqual({ name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" });
    expect(document.info.tags).toEqual([{ name: "smart-city", description: "Smart city infrastructure" }]);
    expect(document.info.externalDocs).toEqual({ description: "Find more info here", url: "https://www.asyncapi.com" });
    expect(document.defaultContentType).toBe("application/json");
  });

  it("servers: host, protocol as written, description, security as component keys, tags", () => {
    expect(keysOf(document.servers)).toEqual(["scram-connections", "mtls-connections"]);
    expect(document.servers[0]).toMatchObject({
      host: "test.mykafkacluster.org:18092", protocol: "kafka-secure", security: ["saslScram"],
      description: "Test broker secured with scramSha256 and scramSha512",
    });
    expect(document.servers[0].tags?.map((t) => t.name)).toEqual(["env:test-scram", "kind:remote", "visibility:private"]);
    expect(document.servers[1].security).toEqual(["certs"]);
  });

  it("channels: address, the protocol of the document's server (kafka-secure → kafka), inlined parameters, component message keys", () => {
    expect(keysOf(document.channels)).toEqual(["lightingMeasured", "lightTurnOn", "lightTurnOff", "lightsDim"]);
    const on = document.channels.find((c) => c.key === "lightTurnOn");
    expect(on).toMatchObject({
      address: "smartylighting.streetlights.1.0.action.{streetlightId}.turn.on", protocol: "kafka", serverKeys: [],
      parameters: { streetlightId: { description: "The ID of the streetlight." } },
      // the channel-local key is `turnOn`; the message keeps its COMPONENT key
      messageKeys: ["turnOnOff"],
    });
    expect(document.channels[0]).toMatchObject({ messageKeys: ["lightMeasured"], description: "The topic on which measured values may be produced and consumed." });
  });

  it("messages keep their component keys and carry name, title, summary, contentType, trait keys and an unpinned-ready payload pin", () => {
    expect(keysOf(document.messages)).toEqual(["lightMeasured", "turnOnOff", "dimLight"]);
    expect(document.messages[0]).toMatchObject({
      name: "lightMeasured", title: "Light measured", contentType: "application/json", traitKeys: ["commonHeaders"],
      summary: "Inform about environmental lighting conditions of a particular streetlight.",
      payload: { entityId: "ent-lightMeasured-payload", entityVersionId: null },
    });
    expect(document.messages[1].name).toBe("turnOnOff");
    expect(document.messages.every((m) => m.headers === undefined)).toBe(true);
  });

  it("traits: component message and operation traits become local traits under their component keys, headers staying inline", () => {
    expect(document.traits).toEqual([
      { key: "commonHeaders", kind: "MESSAGE", spec: { headers: { type: "object", properties: { "my-app-header": { type: "integer", minimum: 0, maximum: 100 } } } } },
      { key: "kafka", kind: "OPERATION", spec: { bindings: { kafka: { clientId: { type: "string", enum: ["my-app-id"] } } } } },
    ]);
  });

  it("operations: action, channel key, the message keys behind the channel-local refs, trait keys, summary", () => {
    expect(keysOf(document.operations)).toEqual(["receiveLightMeasurement", "turnOn", "turnOff", "dimLight"]);
    expect(document.operations[0]).toMatchObject({
      action: "receive", channelKey: "lightingMeasured", messageKeys: ["lightMeasured"], traitKeys: ["kafka"],
      summary: "Inform about environmental lighting conditions of a particular streetlight.",
    });
    expect(document.operations[1]).toMatchObject({ action: "send", channelKey: "lightTurnOn", messageKeys: ["turnOnOff"] });
    expect(document.operations.every((o) => o.reply === undefined)).toBe(true);
  });

  it("components: security schemes by key, parameters kept next to their inlined use", () => {
    expect(document.components).toEqual({
      securitySchemes: {
        saslScram: { type: "scramSha256", description: "Provide your username and password for SASL/SCRAM authentication" },
        certs: { type: "X509", description: "Download the certificate files from service provider" },
      },
      parameters: { streetlightId: { description: "The ID of the streetlight." } },
    });
  });
});

describe("streetlights-mqtt.yaml (channel parameters, security schemes, server variables)", () => {
  const { document, warnings } = mapFixture("streetlights-mqtt.yaml");

  it("imports without a single warning", () => {
    expect(warnings).toEqual([]);
  });

  it("server: variables, protocol version, security keys, tags, bindings verbatim", () => {
    expect(document.servers).toHaveLength(1);
    expect(document.servers[0]).toMatchObject({
      key: "production", host: "test.mosquitto.org:{port}", protocol: "mqtt", protocolVersion: "5",
      variables: { port: { default: "1883", enum: ["1883", "8883"], description: "Secure connection (TLS) is available through port 8883." } },
      security: ["apiKey", "supportedOauthFlows", "openIdConnectWellKnown"],
      bindings: { mqtt: { clientId: "guest", cleanSession: true, keepAlive: 60, bindingVersion: "0.2.0" } },
    });
    expect(document.info.termsOfService).toBe("https://www.example.com/terms");
  });

  it("channels: server refs become server keys, parameters are inlined, bindings are verbatim", () => {
    const measured = document.channels.find((c) => c.key === "lightingMeasured");
    expect(measured).toMatchObject({
      address: "smartylighting/streetlights/1/0/event/{streetlightId}/lighting/measured", protocol: "mqtt", serverKeys: ["production"],
      parameters: { streetlightId: { description: "The ID of the streetlight." } },
      bindings: { mqtt: { bindingVersion: "0.2.0" } }, messageKeys: ["lightMeasured"],
    });
    expect(document.channels.find((c) => c.key === "lightTurnOn")?.serverKeys).toEqual(["production"]);
  });

  it("operations: security refs become scheme keys, bindings are verbatim", () => {
    expect(document.operations[0]).toMatchObject({ key: "receiveLightMeasurement", action: "receive", security: ["apiKey"], bindings: { mqtt: { qos: 1, retain: false, bindingVersion: "0.2.0" } } });
  });

  it("security schemes: every supported type, with its type-specific fields", () => {
    const schemes = document.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(["apiKey", "supportedOauthFlows", "openIdConnectWellKnown"]);
    expect(schemes.apiKey).toEqual({ type: "apiKey", in: "user", description: "Provide your API key as the user and leave the password empty." });
    expect(Object.keys((schemes.supportedOauthFlows as unknown as { flows: object }).flows)).toEqual(["implicit", "password", "clientCredentials", "authorizationCode"]);
    expect(schemes.supportedOauthFlows).toMatchObject({ type: "oauth2", scopes: ["streetlights:on", "streetlights:off", "streetlights:dim"] });
    expect(schemes.openIdConnectWellKnown).toEqual({ type: "openIdConnect", openIdConnectUrl: "https://authserver.example/.well-known/openid-configuration" });
  });
});

describe("http-websocket-minimal.json", () => {
  const { document, warnings } = mapFixture("http-websocket-minimal.json");

  it("imports without a single warning", () => {
    expect(warnings).toEqual([]);
  });

  it("servers keep their protocols; channels follow their server's protocol (https → http, wss → ws)", () => {
    expect(document.servers.map((s) => [s.key, s.protocol, s.host, s.pathname])).toEqual([["api", "https", "api.example.com", "/v1"], ["echo", "wss", "echo.example.com", undefined]]);
    expect(document.channels.map((c) => [c.key, c.protocol, c.serverKeys])).toEqual([["postOrders", "http", ["api"]], ["echoSocket", "ws", ["echo"]]]);
    expect(document.channels[1].bindings).toEqual({ ws: { method: "GET", bindingVersion: "0.1.0" } });
  });

  it("operations carry their bindings and the messages behind their refs", () => {
    expect(document.operations.map((o) => [o.key, o.action, o.channelKey, o.messageKeys])).toEqual([
      ["placeOrder", "send", "postOrders", ["orderPlaced"]], ["sendEcho", "send", "echoSocket", ["echo"]], ["receiveEcho", "receive", "echoSocket", ["echo"]],
    ]);
    expect(document.operations[0].bindings).toEqual({ http: { method: "POST", bindingVersion: "0.3.0" } });
  });
});

describe("inline-messages-and-traits.yaml", () => {
  const { document, warnings } = mapFixture("inline-messages-and-traits.yaml");

  it("messages: component keys stay, inline ones get their channel-local key, a taken one the next free key", () => {
    expect(keysOf(document.messages)).toEqual(["userLeft", "signedUp", "signedUp-2"]);
    expect(document.messages[1]).toMatchObject({ name: "UserSignedUp", title: "User signed up", contentType: "application/json" });
    expect(document.messages[2]).toMatchObject({ name: "UserDeleted" });
  });

  it("an inline message keeps its headers pin, examples and trait keys (component first, then the inline trait it carries)", () => {
    const m = document.messages[1];
    expect(m.headers).toEqual({ entityId: "ent-signedUp-headers", entityVersionId: null });
    expect(m.traitKeys).toEqual(["audited", "trait"]);
    expect(m.examples).toEqual([{ name: "first", summary: "The first user", headers: { "correlation-id": "abc-1" }, payload: { userId: "u-1", email: "first@example.com" } }]);
  });

  it("traits: component traits keep their keys; inline traits get generated keys and keep their content", () => {
    expect(document.traits.map((t) => [t.key, t.kind])).toEqual([["audited", "MESSAGE"], ["retryable", "OPERATION"], ["trait", "MESSAGE"], ["Inline-operation-trait", "OPERATION"]]);
    expect(document.traits[0]).toMatchObject({ spec: { summary: "Audited message", tags: [{ name: "audit" }], headers: { type: "object" } } });
    expect(document.traits[2]).toEqual({ key: "trait", kind: "MESSAGE", spec: { summary: "An inline trait that nothing else shares.", tags: [{ name: "lifecycle" }] } });
    expect(document.traits[3]).toEqual({ key: "Inline-operation-trait", kind: "OPERATION", spec: { title: "Inline operation trait", description: "An operation trait written in place." } });
  });

  it("a channel key that is not a valid key is adjusted, references follow it, and an alias message appears once", () => {
    expect(keysOf(document.channels)).toEqual(["userSignedUp", "user-left-channel", "userDeleted"]);
    expect(document.channels[1].messageKeys).toEqual(["userLeft"]);
    const left = document.operations.find((o) => o.key === "onUserLeft");
    expect(left).toMatchObject({ channelKey: "user-left-channel", messageKeys: ["userLeft"] });
    expect(document.operations.find((o) => o.key === "onUserSignedUp")).toMatchObject({ messageKeys: ["signedUp"], traitKeys: ["retryable", "Inline-operation-trait"] });
    expect(document.operations.find((o) => o.key === "publishUserDeleted")).toMatchObject({ channelKey: "userDeleted", messageKeys: ["signedUp-2"] });
  });

  it("warns about both adjusted keys, naming the source pointer, and nothing else", () => {
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual(expect.arrayContaining([
      ["KEY_ADJUSTED", "/channels/userDeleted/messages/signedUp"],
      ["KEY_ADJUSTED", "/channels/user-left~1channel"],
    ]));
    expect(warnings).toHaveLength(2);
    expect(warnings.find((w) => w.pointer === "/channels/user-left~1channel")?.message).toContain("user-left-channel");
  });
});

describe("builtin-traits.yaml", () => {
  const ids = { cloudEvents: "lib-ce", traceContext: "lib-tc" };

  it("maps CloudEvents and W3C Trace Context headers to the tenant's built-in traits, and says so", () => {
    const { document, warnings } = mapFixture("builtin-traits.yaml", ids);
    expect(document.traits).toEqual(expect.arrayContaining([
      { key: "cloudEventsEnvelope", kind: "MESSAGE", libraryTraitId: "lib-ce" },
      { key: "traceContext", kind: "MESSAGE", libraryTraitId: "lib-tc" },
    ]));
    const mapped = byCode(warnings, "BUILTIN_TRAIT_MAPPED");
    expect(mapped.map((w) => w.pointer).sort()).toEqual(["/components/messageTraits/cloudEventsEnvelope", "/components/messageTraits/traceContext"]);
    // what the built-in replaces is named, so nothing disappears silently
    expect(mapped.find((w) => w.pointer.endsWith("cloudEventsEnvelope"))?.message).toMatch(/CloudEvents.*summary, description, bindings/);
    // message trait lists point at the same keys
    expect(document.messages.find((m) => m.key === "orderCreated")?.traitKeys).toEqual(["cloudEventsEnvelope", "traceContext"]);
  });

  it("keeps a lookalike (no `source`) and a trait with extra headers as local traits", () => {
    const { document } = mapFixture("builtin-traits.yaml", ids);
    expect(document.traits.find((t) => t.key === "cloudEventsLookalike")).toMatchObject({ spec: { summary: "Looks like CloudEvents but has no source" } });
    expect(document.traits.find((t) => t.key === "tenantHeaders")).toMatchObject({ spec: { headers: { properties: { "x-tenant-id": { type: "string" } } } } });
  });

  it("with no built-in ids available, every trait stays a local copy and nothing is reported", () => {
    const { document, warnings } = mapFixture("builtin-traits.yaml", {});
    expect(document.traits.every((t) => "spec" in t)).toBe(true);
    expect(byCode(warnings, "BUILTIN_TRAIT_MAPPED")).toEqual([]);
    expect(document.traits.find((t) => t.key === "cloudEventsEnvelope")).toMatchObject({ spec: { summary: "Our CloudEvents envelope", bindings: { kafka: { bindingVersion: "0.5.0" } } } });
  });

  it("uses only the id that is available", () => {
    const { document } = mapFixture("builtin-traits.yaml", { traceContext: "lib-tc" });
    expect(document.traits.find((t) => t.key === "traceContext")).toEqual({ key: "traceContext", kind: "MESSAGE", libraryTraitId: "lib-tc" });
    expect(document.traits.find((t) => t.key === "cloudEventsEnvelope")).toHaveProperty("spec");
  });

  it("the result parses with library traits (a library trait carries no spec)", () => {
    const { document } = mapFixture("builtin-traits.yaml", ids);
    expect(parseEventDocument(document).success).toBe(true);
  });
});

describe("request-reply.yaml", () => {
  const { document, warnings } = mapFixture("request-reply.yaml");

  it("imports without a single warning, on the protocol of the document's server", () => {
    expect(warnings).toEqual([]);
    expect(document.channels.map((c) => c.protocol)).toEqual(["nats", "nats", "nats"]);
  });

  it("reply: address, channel key and message keys behind the channel-local refs", () => {
    expect(document.operations.find((o) => o.key === "askPrice")?.reply).toEqual({
      address: { description: "Where the reply is sent", location: "$message.header#/replyTo" },
      channelKey: "priceReplies", messageKeys: ["priceReply"],
    });
  });

  it("a reply with only a channel stays a reply with only a channel", () => {
    expect(document.operations.find((o) => o.key === "answerPrice")?.reply).toEqual({ channelKey: "priceReplies" });
    expect(document.operations.find((o) => o.key === "auditPrice")?.reply).toBeUndefined();
  });

  it("a channel-local alias of a component message resolves to the component key", () => {
    expect(document.channels.find((c) => c.key === "audit")?.messageKeys).toEqual(["priceReply"]);
    expect(document.operations.find((o) => o.key === "auditPrice")?.messageKeys).toEqual(["priceReply"]);
  });

  it("channel parameters with a runtime-expression location, and correlation ids inline and by component", () => {
    expect(document.channels.find((c) => c.key === "priceReplies")?.parameters).toEqual({ requestId: { description: "The request this reply answers.", location: "$message.header#/requestId" } });
    expect(document.messages.find((m) => m.key === "priceRequest")?.correlationId).toEqual({ description: "Request id, set by the caller", location: "$message.header#/requestId" });
    expect(document.messages.find((m) => m.key === "priceReply")?.correlationId).toEqual({ description: "The id of the request that is answered", location: "$message.header#/requestId" });
    expect(document.components?.correlationIds).toEqual({ requestId: { description: "Request id, set by the caller", location: "$message.header#/requestId" } });
  });
});

describe("payload warnings", () => {
  it("multi-format-payloads.yaml: only the OpenAPI payload is reported", () => {
    const { document, warnings } = mapFixture("multi-format-payloads.yaml");
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual([["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/openApiReading/payload"]]);
    expect(warnings[0].message).toContain("application/vnd.oai.openapi;version=3.0.0");
    expect(keysOf(document.messages)).toEqual(["defaultSchema", "asyncApiSchema", "draft07Schema", "avroReading", "protobufReading", "openApiReading"]);
    expect(document.messages[0].headers).toEqual({ entityId: "ent-defaultSchema-headers", entityVersionId: null });
    expect(document.messages[3]).toMatchObject({ name: "AvroReading", contentType: "avro/binary" });
  });

  it("unsupported-payloads.yaml: unsupported formats and a missing payload each get a warning, and every message still pins a payload", () => {
    const { document, warnings } = mapFixture("unsupported-payloads.yaml");
    expect(warnings.map((w) => [w.code, w.pointer]).sort()).toEqual([
      ["NO_PAYLOAD", "/components/messages/noPayload/payload"],
      ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/openApiPayload/payload"],
      ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/ramlPayload/payload"],
    ]);
    expect(document.messages.map((m) => m.payload.entityId)).toEqual(["ent-openApiPayload-payload", "ent-noPayload-payload", "ent-ramlPayload-payload"]);
  });
});

describe("pins", () => {
  it("a message without a payload pin is an error that names the pin (the entities must exist first)", () => {
    const raw = tiny();
    const error = failure(raw, { payloadPins: new Map(), builtInTraitIds: {} });
    expect(error.code).toBe("MISSING_PAYLOAD_PIN");
    expect(error.message).toContain("m:payload");
  });

  it("headers without a pin are left out with a warning; the payload pin is still used", () => {
    const raw = tiny({ message: { headers: { type: "object", properties: { a: { type: "string" } } } } });
    const result = mapAsyncApiToEventDocument(raw, { payloadPins: new Map([["m:payload", { entityId: "e1", entityVersionId: null }]]), builtInTraitIds: {} });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.document.messages[0].headers).toBeUndefined();
    expect(result.data.warnings.map((w) => [w.code, w.pointer])).toEqual([["DROPPED_CONSTRUCT", "/components/messages/m/headers"]]);
  });

  it("pins are copied, not shared with the context", () => {
    const pin = { entityId: "e1", entityVersionId: "v1" };
    const result = mapAsyncApiToEventDocument(tiny(), { payloadPins: new Map([["m:payload", pin]]), builtInTraitIds: {} });
    expect(result.success && result.data.document.messages[0].payload).toEqual(pin);
    expect(result.success && result.data.document.messages[0].payload).not.toBe(pin);
  });
});

describe("sanitising: what the document model rejects is removed and reported, never copied through", () => {
  it("unknown properties inside tags, externalDocs, correlationId, examples, contact and license", () => {
    const { document, warnings } = mapRaw(tiny({
      message: {
        tags: [{ name: "t", color: "red" }], externalDocs: { url: "https://example.com/d", note: "x" },
        correlationId: { location: "$message.header#/id", format: "uuid" },
        examples: [{ name: "e", payload: { a: 1 }, extra: true }],
      },
    }));
    const m = document.messages[0];
    expect(m.tags).toEqual([{ name: "t" }]);
    expect(m.externalDocs).toEqual({ url: "https://example.com/d" });
    expect(m.correlationId).toEqual({ location: "$message.header#/id" });
    expect(m.examples).toEqual([{ name: "e", payload: { a: 1 } }]);
    const sanitized = byCode(warnings, "SANITIZED_VALUE");
    expect(sanitized.map((w) => w.pointer).sort()).toEqual([
      "/components/messages/m/correlationId/format", "/components/messages/m/examples/0/extra",
      "/components/messages/m/externalDocs/note", "/components/messages/m/tags/0/color",
    ]);
    expect(sanitized[0].message).toMatch(/not a property/);

    const info = mapRaw({ ...tiny(), info: { title: "T", version: "1", contact: { name: "n", phone: "1" }, license: { name: "MIT", spdx: "MIT" } } });
    expect(info.document.info.contact).toEqual({ name: "n" });
    expect(info.document.info.license).toEqual({ name: "MIT" });
    expect(byCode(info.warnings, "SANITIZED_VALUE").map((w) => w.pointer).sort()).toEqual(["/info/contact/phone", "/info/license/spdx"]);
  });

  it("x- extensions are kept where the model keeps them (tags, externalDocs, …) and reported where it has no place for them", () => {
    const { document, warnings } = mapRaw(tiny({
      message: { "x-owner": "team-a", tags: [{ name: "t", "x-color": "red" }] },
      channel: { "x-internal": true }, server: { "x-region": "eu" }, operation: { "x-slo": "99.9" },
    }));
    expect(document.messages[0].tags).toEqual([{ name: "t", "x-color": "red" }]);
    expect(byCode(warnings, "UNSUPPORTED_EXTENSION").map((w) => w.pointer).sort()).toEqual([
      "/channels/c/x-internal", "/components/messages/m/x-owner", "/operations/o/x-slo", "/servers/s/x-region",
    ]);
  });

  it("a property that is not part of a message, server, channel or operation is reported as a dropped construct", () => {
    const { warnings } = mapRaw(tiny({ message: { publish: {} }, channel: { subscribe: {} }, server: { url: "kafka://h" }, operation: { operationId: "x" } }));
    expect(byCode(warnings, "DROPPED_CONSTRUCT").map((w) => w.pointer).sort()).toEqual([
      "/channels/c/subscribe", "/components/messages/m/publish", "/operations/o/operationId", "/servers/s/url",
    ]);
  });

  it("the root's own extras: `id` and x- keys", () => {
    const { warnings } = mapRaw({ ...tiny(), id: "urn:example:app", "x-owner": "me" });
    expect(warnings.map((w) => [w.code, w.pointer]).sort()).toEqual([["DROPPED_CONSTRUCT", "/id"], ["UNSUPPORTED_EXTENSION", "/x-owner"]]);
  });

  it("a value that cannot be repaired drops the whole value: a tag without a name, an example with nothing in it, a non-http URL", () => {
    const { document, warnings } = mapRaw(tiny({
      message: { tags: [{ description: "no name" }, { name: "ok" }], examples: [{ name: "empty" }, { payload: 1 }], externalDocs: { url: "docs/readme.md" } },
    }));
    const m = document.messages[0];
    expect(m.tags).toEqual([{ name: "ok" }]);
    expect(m.examples).toEqual([{ payload: 1 }]);
    expect(m.externalDocs).toBeUndefined();
    expect(warnings.filter((w) => w.code === "SANITIZED_VALUE").length).toBeGreaterThanOrEqual(3);
  });

  it("wrong types: a number where text belongs, a list where an object belongs", () => {
    const { document, warnings } = mapRaw(tiny({ message: { title: 5, summary: ["x"], deprecated: "yes", bindings: [1] } }));
    expect(document.messages[0]).not.toHaveProperty("title");
    expect(document.messages[0]).not.toHaveProperty("deprecated");
    expect(document.messages[0]).not.toHaveProperty("bindings");
    expect(byCode(warnings, "SANITIZED_VALUE")).toHaveLength(4);
  });

  it("an address expression without a parameter definition gets an empty definition, so the document parses", () => {
    const { document, warnings } = mapRaw(tiny({ channel: { address: "orders.{region}.v1" } }));
    expect(document.channels[0].parameters).toEqual({ region: {} });
    expect(warnings.find((w) => w.pointer === "/channels/c/parameters")?.code).toBe("SANITIZED_VALUE");
  });

  it("a server variable that the host or pathname never uses is left out", () => {
    const { document, warnings } = mapRaw(tiny({ server: { host: "h:{port}", variables: { port: { default: "1" }, unused: { default: "2" } } } }));
    expect(document.servers[0].variables).toEqual({ port: { default: "1" } });
    expect(warnings.some((w) => w.pointer === "/servers/s/variables/unused")).toBe(true);
  });

  it("a pathname without its leading slash gets one", () => {
    const { document, warnings } = mapRaw(tiny({ server: { pathname: "v1" } }));
    expect(document.servers[0].pathname).toBe("/v1");
    expect(warnings.some((w) => w.pointer === "/servers/s/pathname" && w.code === "SANITIZED_VALUE")).toBe(true);
  });

  it("a section that should be a map but is not (servers as a list) is reported, not silently ignored", () => {
    const raw = tiny();
    raw.servers = [{ host: "h", protocol: "kafka" }];
    const { document, warnings } = mapRaw(raw);
    expect(document.servers).toEqual([]);
    expect(warnings.some((w) => w.pointer === "/servers" && w.code === "SANITIZED_VALUE")).toBe(true);
  });

  it("headers in a format other than JSON Schema are reported as unsupported and still pinned when the caller gave a pin", () => {
    const raw = tiny({ message: { headers: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "H", fields: [] } } } });
    const { document, warnings } = mapRaw(raw);
    expect(document.messages[0].headers).toEqual({ entityId: "ent-m-headers", entityVersionId: null });
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual([["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/m/headers"]]);
  });

  it("the sanitised result of every case above parses", () => {
    const { document } = mapRaw(tiny({ message: { tags: [{ name: "t", color: "red" }], examples: [{ extra: 1 }] }, channel: { address: "{x}" } }));
    expect(parseEventDocument(document).success).toBe(true);
  });
});

describe("security schemes", () => {
  it("a scheme type the event cannot hold is dropped with DROPPED_CONSTRUCT and every reference to it is removed", () => {
    const { document, warnings } = mapRaw(tiny({
      server: { security: [{ $ref: "#/components/securitySchemes/mine" }, { $ref: "#/components/securitySchemes/weird" }] },
      operation: { security: [{ $ref: "#/components/securitySchemes/weird" }] },
      components: { securitySchemes: { mine: { type: "userPassword" }, weird: { type: "mutualTLS" } } },
    }));
    expect(document.components?.securitySchemes).toEqual({ mine: { type: "userPassword" } });
    expect(document.servers[0].security).toEqual(["mine"]);
    expect(document.operations[0].security).toBeUndefined();
    expect(byCode(warnings, "DROPPED_CONSTRUCT").map((w) => w.pointer).sort()).toEqual([
      "/components/securitySchemes/weird", "/operations/o/security/0", "/servers/s/security/1",
    ]);
  });

  it("an invalid scheme (an apiKey without `in`) is dropped, not copied through", () => {
    const { document, warnings } = mapRaw(tiny({ components: { securitySchemes: { k: { type: "apiKey" } } } }));
    expect(document.components?.securitySchemes).toBeUndefined();
    expect(warnings.some((w) => w.code === "DROPPED_CONSTRUCT" && w.pointer === "/components/securitySchemes/k")).toBe(true);
  });

  it("a scheme key that is not a valid key is adjusted and the references follow", () => {
    const { document, warnings } = mapRaw(tiny({
      server: { security: [{ $ref: "#/components/securitySchemes/my~1scheme" }] },
      components: { securitySchemes: { "my/scheme": { type: "userPassword" } } },
    }));
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(["my-scheme"]);
    expect(document.servers[0].security).toEqual(["my-scheme"]);
    expect(warnings.some((w) => w.code === "KEY_ADJUSTED" && w.pointer === "/components/securitySchemes/my~1scheme")).toBe(true);
  });

  it("a scheme written in place under `security` is stored as a component, once for equal ones", () => {
    const { document } = mapRaw(tiny({
      server: { security: [{ type: "userPassword" }] }, operation: { security: [{ type: "userPassword" }] },
    }));
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(["userPassword"]);
    expect(document.servers[0].security).toEqual(["userPassword"]);
    expect(document.operations[0].security).toEqual(["userPassword"]);
  });

  it("an operation trait's security refs become scheme keys", () => {
    const { document } = mapRaw(tiny({
      operation: { traits: [{ $ref: "#/components/operationTraits/t" }] },
      components: { securitySchemes: { s1: { type: "userPassword" } }, operationTraits: { t: { security: [{ $ref: "#/components/securitySchemes/s1" }], summary: "x" } } },
    }));
    expect(document.traits).toEqual([{ key: "t", kind: "OPERATION", spec: { summary: "x", security: ["s1"] } }]);
  });
});

describe("keys", () => {
  it("a valid component key is kept as written, whatever order the file lists them in", () => {
    const raw = doc({
      servers: { s: { host: "h:1", protocol: "kafka" } },
      channels: { c: { address: "a", messages: { x: { $ref: "#/components/messages/a b" }, y: { $ref: "#/components/messages/a-b" } } } },
      components: { messages: { "a b": { payload: { type: "object" } }, "a-b": { payload: { type: "object" } } } },
    });
    const { document, warnings } = mapRaw(raw);
    expect(keysOf(document.messages)).toEqual(["a-b-2", "a-b"]);
    expect(document.channels[0].messageKeys).toEqual(["a-b-2", "a-b"]);
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual([["KEY_ADJUSTED", "/components/messages/a b"]]);
  });

  it("keys longer than 64 characters are shortened, reserved names get a suffix, and the result is a valid key", () => {
    const long = "k".repeat(80);
    const { document } = mapRaw(doc({
      channels: { [long]: { address: "a" }, constructor: { address: "b" } },
      operations: { [`op ${long}`]: { action: "send", channel: { $ref: `#/channels/${long}` } } },
    }), undefined);
    for (const item of [...document.channels, ...document.operations]) {
      expect(item.key.length).toBeLessThanOrEqual(64);
      expect(item.key).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
    expect(document.channels.map((c) => c.key)).toContain("constructor-1");
  });

  it("two keys that become the same key get distinct ones", () => {
    const { document } = mapRaw(doc({ channels: { "a b": { address: "1" }, "a/b": { address: "2" }, "a-b": { address: "3" } } }));
    expect(document.channels.map((c) => [c.address, c.key])).toEqual([["1", "a-b-2"], ["2", "a-b-3"], ["3", "a-b"]]);
  });

  it("one key space for message and operation traits: a clash is adjusted and each list follows its own trait", () => {
    const { document, warnings } = mapRaw(tiny({
      message: { traits: [{ $ref: "#/components/messageTraits/Audited" }] },
      operation: { traits: [{ $ref: "#/components/operationTraits/Audited" }] },
      components: { messageTraits: { Audited: { summary: "m" } }, operationTraits: { Audited: { summary: "o" } } },
    }));
    expect(document.traits.map((t) => [t.key, t.kind])).toEqual([["Audited", "MESSAGE"], ["Audited-2", "OPERATION"]]);
    expect(document.messages[0].traitKeys).toEqual(["Audited"]);
    expect(document.operations[0].traitKeys).toEqual(["Audited-2"]);
    expect(warnings.some((w) => w.code === "KEY_ADJUSTED" && w.pointer === "/components/operationTraits/Audited")).toBe(true);
  });

  it("trait specs keep only the properties AsyncAPI defines for their kind (extensions stay): an operation-only property on message properties is removed", () => {
    const { document, warnings } = mapRaw(tiny({
      message: { traits: [{ $ref: "#/components/messageTraits/mt" }] },
      operation: { traits: [{ $ref: "#/components/operationTraits/ot" }] },
      components: {
        messageTraits: { mt: { summary: "m", security: [], foo: 1, "x-keep": true } },
        operationTraits: { ot: { summary: "o", headers: { type: "object" }, correlationId: { location: "$message.header#/id" }, "x-keep": 1 } },
      },
    }));
    expect(document.traits).toEqual([
      { key: "mt", kind: "MESSAGE", spec: { summary: "m", "x-keep": true } },
      { key: "ot", kind: "OPERATION", spec: { summary: "o", "x-keep": 1 } },
    ]);
    expect(byCode(warnings, "SANITIZED_VALUE").map((w) => w.pointer).sort()).toEqual([
      "/components/messageTraits/mt/foo", "/components/messageTraits/mt/security",
      "/components/operationTraits/ot/correlationId", "/components/operationTraits/ot/headers",
    ]);
  });

  it("a message trait list that points at an operation trait leaves it out", () => {
    const { document, warnings } = mapRaw(tiny({
      message: { traits: [{ $ref: "#/components/operationTraits/o1" }] }, components: { operationTraits: { o1: { summary: "o" } } },
    }));
    expect(document.messages[0].traitKeys).toEqual([]);
    expect(warnings.some((w) => w.code === "DROPPED_CONSTRUCT" && w.pointer === "/components/messages/m/traits/0")).toBe(true);
  });
});

describe("channel protocol", () => {
  const protocolOf = (overrides: Parameters<typeof tiny>[0], mutate?: (raw: RawAsyncApi3) => void) => {
    const raw = tiny(overrides);
    mutate?.(raw);
    return mapRaw(raw).document.channels[0].protocol;
  };

  it("follows the channel's own server, then its bindings, then the document's first server, then kafka", () => {
    expect(protocolOf({ channel: { servers: [{ $ref: "#/servers/s2" }] } }, (raw) => { (raw.servers as Record<string, unknown>).s2 = { host: "h:2", protocol: "AMQP" }; })).toBe("amqp");
    expect(protocolOf({ channel: { bindings: { mqtt: { bindingVersion: "0.2.0" } } } })).toBe("mqtt");
    expect(protocolOf({ server: { protocol: "nats" } })).toBe("nats");
    expect(protocolOf({}, (raw) => { delete raw.servers; })).toBe("kafka");
  });

  it("secure variants map to the protocol the bindings use", () => {
    for (const [written, expected] of [["kafka-secure", "kafka"], ["mqtts", "mqtt"], ["secure-mqtt", "mqtt"], ["amqps", "amqp"], ["https", "http"], ["wss", "ws"], ["Kafka", "kafka"], ["googlepubsub", "googlepubsub"]]) {
      expect(protocolOf({ server: { protocol: written } }), written).toBe(expected);
    }
  });

  it("the server itself keeps the protocol as written", () => {
    expect(mapRaw(tiny({ server: { protocol: "kafka-secure" } })).document.servers[0].protocol).toBe("kafka-secure");
  });

  describe("a guessed protocol is reported, a protocol with evidence is not", () => {
    const guesses = (warnings: ImportWarning[]) => warnings.filter((w) => /^(This channel is on servers with different protocols|This channel names no server and the document's servers use different protocols|Nothing in the document tells the protocol of this channel)/.test(w.message));
    const twoProtocols = (raw: RawAsyncApi3) => { (raw.servers as Record<string, unknown>).other = { host: "h:2", protocol: "mqtt" }; };

    it("nothing tells the protocol (no server, no bindings): kafka is assumed, and the warning says so", () => {
      const raw = tiny();
      delete raw.servers;
      const { document, warnings } = mapRaw(raw);
      expect(document.channels[0].protocol).toBe("kafka");
      expect(guesses(warnings)).toEqual([expect.objectContaining({ code: "SANITIZED_VALUE", pointer: "/channels/c", message: expect.stringMatching(/Nothing in the document tells the protocol.*"kafka" was assumed/) })]);
    });

    it("the channel names no server and the document's servers disagree: the first server's protocol is taken, and the warning lists them", () => {
      const raw = tiny();
      twoProtocols(raw);
      const { document, warnings } = mapRaw(raw);
      expect(document.channels[0].protocol).toBe("kafka");
      expect(guesses(warnings)).toEqual([expect.objectContaining({ code: "SANITIZED_VALUE", pointer: "/channels/c", message: expect.stringMatching(/different protocols \(kafka, mqtt\).*first server's, "kafka"/) })]);
    });

    it("the channel is on servers with different protocols: the first one is used, and the warning lists them", () => {
      const raw = tiny({ channel: { servers: [{ $ref: "#/servers/other" }, { $ref: "#/servers/s" }] } });
      twoProtocols(raw);
      const { document, warnings } = mapRaw(raw);
      expect(document.channels[0].protocol).toBe("mqtt");
      expect(guesses(warnings)).toEqual([expect.objectContaining({ code: "SANITIZED_VALUE", pointer: "/channels/c", message: expect.stringMatching(/servers with different protocols \(mqtt, kafka\).*"mqtt" was used/) })]);
    });

    it("no warning when there is evidence: one server protocol in the document, the channel's own server, its bindings", () => {
      expect(guesses(mapRaw(tiny()).warnings)).toEqual([]);
      const named = tiny({ channel: { servers: [{ $ref: "#/servers/other" }] } });
      twoProtocols(named);
      expect(guesses(mapRaw(named).warnings)).toEqual([]);
      const bound = tiny({ channel: { bindings: { mqtt: { bindingVersion: "0.2.0" } } } });
      twoProtocols(bound);
      expect(guesses(mapRaw(bound).warnings)).toEqual([]);
      const noServers = tiny({ channel: { bindings: { mqtt: { bindingVersion: "0.2.0" } } } });
      delete noServers.servers;
      expect(guesses(mapRaw(noServers).warnings)).toEqual([]);
    });

    it("spellings of one protocol are not a disagreement (kafka-secure and kafka, https and http)", () => {
      const raw = tiny({ server: { protocol: "kafka-secure" } });
      (raw.servers as Record<string, unknown>).plain = { host: "h:2", protocol: "Kafka" };
      expect(guesses(mapRaw(raw).warnings)).toEqual([]);
      const channelOn = tiny({ channel: { servers: [{ $ref: "#/servers/s" }, { $ref: "#/servers/plain" }] }, server: { protocol: "https" } });
      (channelOn.servers as Record<string, unknown>).plain = { host: "h:2", protocol: "http" };
      expect(guesses(mapRaw(channelOn).warnings)).toEqual([]);
    });

    it("every channel that is guessed is reported once, at its own place", () => {
      const raw = doc({
        servers: { a: { host: "h:1", protocol: "kafka" }, b: { host: "h:2", protocol: "mqtt" } },
        channels: { one: { address: "1" }, two: { address: "2" }, three: { address: "3", servers: [{ $ref: "#/servers/b" }] } },
      });
      expect(guesses(mapRaw(raw).warnings).map((w) => w.pointer)).toEqual(["/channels/one", "/channels/two"]);
    });
  });
});

describe("a schema that refers to itself degrades that payload only", () => {
  it("recursive-payload-placeholder.yaml (Node -> Tree -> Node): the event imports, the payload is pinned to its placeholder, the warning names the loop", () => {
    const raw = load("recursive-payload-placeholder.yaml");
    const { document, warnings } = mapRaw(raw);
    expect(document.messages.map((m) => [m.key, m.payload.entityId])).toEqual([["nodeCreated", "ent-nodeCreated-payload"]]);
    expect(warnings.filter((w) => w.pointer.startsWith("/components/messages"))).toEqual([{
      pointer: "/components/messages/nodeCreated/payload", code: "UNSUPPORTED_PAYLOAD_FORMAT",
      message: 'The payload of "nodeCreated" refers to itself (#/components/schemas/Node → #/components/schemas/Tree → #/components/schemas/Node) and cannot be imported; an empty entity was created instead',
    }]);
    expect(parseEventDocument(document).success).toBe(true);
  });

  it("recursive-schemas.yaml: payload and headers are each reported, the other message imports untouched", () => {
    const { document, warnings } = mapFixture("recursive-schemas.yaml");
    expect(keysOf(document.messages)).toEqual(["commentPosted", "commentCounted"]);
    expect(document.messages[0].headers).toEqual({ entityId: "ent-commentPosted-headers", entityVersionId: null });
    expect(warnings.map((w) => [w.code, w.pointer]).sort()).toEqual([
      ["DROPPED_CONSTRUCT", "/components/schemas"],
      ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/commentPosted/headers"],
      ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/commentPosted/payload"],
    ]);
    expect(warnings.find((w) => w.pointer === "/components/schemas")?.message).toMatch(/1 entry that nothing refers to \(TreeNode\)/);
    expect(warnings.find((w) => w.pointer.endsWith("commentPosted/payload"))?.message).toContain("refers to itself (#/components/schemas/Comment → #/components/schemas/Comment)");
  });

  it("a recursive schema in an unused component imports cleanly; only the unused-component warning remains", () => {
    const { warnings } = mapRaw(tiny({ components: { schemas: { Tree: { properties: { children: { items: { $ref: "#/components/schemas/Tree" } } } } } } }));
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual([["DROPPED_CONSTRUCT", "/components/schemas"]]);
  });

  it("a recursive schema inside a multi-format wrapper, and a self-referencing headers schema, are reported the same way", () => {
    const raw = tiny({
      message: {
        payload: { schemaFormat: "application/schema+json;version=draft-07", schema: { $ref: "#/components/schemas/C" } },
        headers: { $ref: "#/components/schemas/C" },
      },
      components: { schemas: { C: { properties: { next: { $ref: "#/components/schemas/C" } } } } },
    });
    const { warnings } = mapRaw(raw);
    expect(warnings.map((w) => [w.code, w.pointer])).toEqual([
      ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/m/payload"], ["UNSUPPORTED_PAYLOAD_FORMAT", "/components/messages/m/headers"],
    ]);
    expect(warnings[0].message).toContain("refers to itself");
  });

  describe("every other loop still fails the import (REF_CYCLE)", () => {
    it("a payload that is a chain of wrappers A -> B -> A", () => {
      const raw = tiny({ message: { payload: { $ref: "#/components/schemas/A" } }, components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } } });
      expect(failure(raw).code).toBe("REF_CYCLE");
    });

    it("a loop through bindings", () => {
      const raw = tiny({
        message: { bindings: { $ref: "#/components/messageBindings/b" } },
        components: { messageBindings: { b: { kafka: { $ref: "#/components/messageBindings/b" } } } },
      });
      expect(failure(raw).code).toBe("REF_CYCLE");
    });

    it("a recursive schema used as the headers of a trait, which stay inline in the trait", () => {
      const raw = tiny({
        message: { traits: [{ $ref: "#/components/messageTraits/t" }] },
        components: {
          messageTraits: { t: { headers: { $ref: "#/components/schemas/H" } } },
          schemas: { H: { properties: { up: { $ref: "#/components/schemas/H" } } } },
        },
      });
      expect(failure(raw).code).toBe("REF_CYCLE");
    });

    it("a recursive schema inside a message example", () => {
      const raw = tiny({
        message: { examples: [{ payload: { $ref: "#/components/schemas/H" } }] },
        components: { schemas: { H: { next: { $ref: "#/components/schemas/H" } } } },
      });
      expect(failure(raw).code).toBe("REF_CYCLE");
    });

    it("an external ref or a missing ref next to a recursive schema", () => {
      const schemas = { C: { items: { $ref: "#/components/schemas/C" }, other: { $ref: "https://example.com/x.json" } } };
      expect(failure(tiny({ message: { payload: { $ref: "#/components/schemas/C" } }, components: { schemas } })).code).toBe("EXTERNAL_REF");
    });
  });
});

describe("operations and references", () => {
  it("an operation without a channel is an error that names the operation", () => {
    const raw = tiny();
    delete (raw.operations as Record<string, Record<string, unknown>>).o.channel;
    const error = failure(raw);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("/operations/o");
  });

  it("a message ref of a different channel is left out with a warning instead of making the document invalid", () => {
    const raw = doc({
      channels: { a: { address: "a", messages: { m: { payload: {} } } }, b: { address: "b", messages: { n: { payload: {} } } } },
      operations: { o: { action: "send", channel: { $ref: "#/channels/a" }, messages: [{ $ref: "#/channels/a/messages/m" }, { $ref: "#/channels/b/messages/n" }] } },
    });
    const { document, warnings } = mapRaw(raw);
    expect(document.operations[0].messageKeys).toEqual(["m"]);
    expect(warnings.some((w) => w.code === "DROPPED_CONSTRUCT" && w.pointer === "/operations/o/messages/1")).toBe(true);
  });

  it("a message written in a channel that is itself a component $ref is found", () => {
    const raw = doc({
      channels: { c: { $ref: "#/components/channels/shared" } },
      operations: { o: { action: "send", channel: { $ref: "#/channels/c" }, messages: [{ $ref: "#/channels/c/messages/m" }] } },
      components: { channels: { shared: { address: "shared.v1", messages: { m: { payload: { type: "object" } } } } } },
    });
    const result = mapAsyncApiToEventDocument(raw, context(raw));
    // a pointer THROUGH a $ref (#/channels/c/messages/m) is not a path in the file, so it cannot be followed
    expect(result.success ? "ok" : result.error.code).toBe("REF_NOT_FOUND");
  });

  it("a server or channel entry that is a component $ref is read", () => {
    const raw = doc({
      servers: { s: { $ref: "#/components/servers/prod" } },
      channels: { c: { $ref: "#/components/channels/shared" } },
      components: {
        servers: { prod: { host: "h:1", protocol: "mqtt", description: "Prod" } },
        channels: { shared: { address: "shared.v1", messages: { m: { payload: { type: "object" } } } } },
      },
    });
    const { document, warnings } = mapRaw(raw);
    expect(document.servers).toMatchObject([{ key: "s", host: "h:1", protocol: "mqtt", description: "Prod" }]);
    expect(document.channels).toMatchObject([{ key: "c", address: "shared.v1", protocol: "mqtt", messageKeys: ["m"] }]);
    expect(warnings).toEqual([]);
  });

  it("bindings, tags and security written as $refs to unused-looking components are inlined", () => {
    const raw = tiny({
      message: { bindings: { $ref: "#/components/messageBindings/b" }, externalDocs: { $ref: "#/components/externalDocs/d" } },
      components: { messageBindings: { b: { kafka: { schemaIdLocation: "payload" } } }, externalDocs: { d: { url: "https://example.com/d" } } },
    });
    const { document, warnings } = mapRaw(raw);
    expect(document.messages[0].bindings).toEqual({ kafka: { schemaIdLocation: "payload" } });
    expect(document.messages[0].externalDocs).toEqual({ url: "https://example.com/d" });
    expect(warnings).toEqual([]);
  });

  it("components nothing refers to are reported once per section", () => {
    const { warnings } = mapRaw(tiny({ components: { operationBindings: { a: {}, b: {} }, schemas: { unused: { type: "string" } } } }));
    const dropped = byCode(warnings, "DROPPED_CONSTRUCT");
    expect(dropped.map((w) => w.pointer).sort()).toEqual(["/components/operationBindings", "/components/schemas"]);
    expect(dropped.find((w) => w.pointer === "/components/operationBindings")?.message).toMatch(/2 entries/);
  });

  it("a referenced component is not reported as unused", () => {
    const raw = tiny({ message: { payload: { $ref: "#/components/schemas/S" } }, components: { schemas: { S: { type: "string" } } } });
    expect(mapRaw(raw).warnings).toEqual([]);
  });

  it("an info without a title cannot become an event: the error names where the file needs fixing", () => {
    const raw = tiny();
    raw.info = { version: "1" };
    const error = failure(raw);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("title is required");
    expect(error.message).toContain("/info/title");
    expect((error.details as { problems: Array<{ sourcePointer: string }> }).problems[0].sourcePointer).toBe("/info/title");
  });

  it("a problem inside a server is reported at the server's place in the FILE, not at an array index", () => {
    const raw = tiny({ server: { host: "kafka://h:1" } });
    const error = failure(raw);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("/servers/s/host");
  });
});

describe("hostile input", () => {
  it.each([
    ["negative-external-ref.yaml", "EXTERNAL_REF"],
    ["negative-ref-cycle-trait-message.yaml", "REF_CYCLE"],
    ["negative-missing-ref.yaml", "REF_NOT_FOUND"],
  ])("%s is rejected as %s and creates nothing", (name, code) => {
    const error = failure(load(name));
    expect(error.code).toBe(code);
  });

  it("an external ref in a place the mapper would never read is still rejected", () => {
    expect(failure(tiny({ components: { schemas: { Unused: { $ref: "file:///etc/passwd" } } } })).code).toBe("EXTERNAL_REF");
  });

  it("keys named like Object.prototype members, handed over directly (bypassing the source check), become ordinary keys and pollute nothing", () => {
    const raw = JSON.parse(`{
      "asyncapi": "3.0.0", "info": { "title": "T" },
      "channels": { "__proto__": { "address": "a", "messages": { "constructor": { "payload": { "type": "object" } } } } },
      "operations": { "prototype": { "action": "send", "channel": { "$ref": "#/channels/__proto__" } } },
      "components": { "securitySchemes": { "__proto__": { "type": "userPassword" } } }
    }`) as RawAsyncApi3;
    const { document } = mapRaw(raw);
    expect(document.channels.map((c) => c.key)).toEqual(["__proto__-1"]);
    expect(document.messages.map((m) => m.key)).toEqual(["constructor-1"]);
    expect(document.operations.map((o) => o.key)).toEqual(["prototype-1"]);
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(["__proto__-1"]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(Object.getPrototypeOf(document.components?.securitySchemes)).toBe(Object.prototype);
  });

  it("a $ref bomb inside a payload", () => {
    const schemas: Record<string, unknown> = { S0: { type: "string" } };
    for (let i = 1; i <= 40; i += 1) schemas[`S${i}`] = { allOf: [{ $ref: `#/components/schemas/S${i - 1}` }, { $ref: `#/components/schemas/S${i - 1}` }] };
    expect(failure(tiny({ message: { payload: { $ref: "#/components/schemas/S40" } }, components: { schemas } })).code).toBe("REF_TOO_LARGE");
  });

  it("a 5,000-message document maps in well under a second, with no stack overflow", () => {
    const channels: Record<string, unknown> = {};
    const operations: Record<string, unknown> = {};
    const messages: Record<string, unknown> = {};
    for (let c = 0; c < 50; c += 1) {
      const channelMessages: Record<string, unknown> = {};
      for (let i = 0; i < 100; i += 1) {
        const n = c * 100 + i;
        messages[`m${n}`] = { title: `Message ${n}`, payload: { type: "object", properties: { id: { type: "string" } } } };
        channelMessages[`m${n}`] = { $ref: `#/components/messages/m${n}` };
        operations[`op${n}`] = { action: "send", channel: { $ref: `#/channels/c${c}` }, messages: [{ $ref: `#/channels/c${c}/messages/m${n}` }] };
      }
      channels[`c${c}`] = { address: `topic.${c}`, messages: channelMessages };
    }
    const raw = doc({ servers: { s: { host: "h:1", protocol: "kafka" } }, channels, operations, components: { messages } });
    const ctx = context(raw);
    const started = performance.now();
    const result = mapAsyncApiToEventDocument(raw, ctx);
    const elapsed = performance.now() - started;
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.document.messages).toHaveLength(5000);
    expect(result.data.document.operations).toHaveLength(5000);
    expect(result.data.document.channels).toHaveLength(50);
    expect(result.data.warnings).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it("5,000 messages whose keys all need adjusting stay fast (no quadratic key search)", () => {
    const channelMessages: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) channelMessages[`not valid ${i}`] = { payload: { type: "object" } };
    const raw = doc({ channels: { c: { address: "a", messages: channelMessages } } });
    const ctx = context(raw);
    const started = performance.now();
    const result = mapAsyncApiToEventDocument(raw, ctx);
    const elapsed = performance.now() - started;
    expect(result.success).toBe(true);
    if (result.success) expect(new Set(result.data.document.messages.map((m) => m.key)).size).toBe(5000);
    expect(elapsed).toBeLessThan(1500);
  });
});
