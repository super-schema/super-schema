import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildInstantAsyncApi, PLACEHOLDER_ENTITY_KEY, PLACEHOLDER_LIBRARY_TRAIT_KEY } from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { SCHEMA_FORMATS } from "@/lib/event-specs/schema-format";
import type { Diagnostic, JsonObject } from "@/lib/event-specs/types";

const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });

const ENTITY_LABELS = new Map([
  ["ent-order", "Order"], ["ent-order-key", "OrderKey"], ["ent-refund", "Refund"], ["ent-notice", "Notice"],
  ["ent-ce-headers", "CloudEventsHeaders"], ["ent-audit", "AuditHeaders"],
]);
const VERSION_LABELS = new Map([["ver-order", "1.0"], ["ver-order-key", "1.0"], ["ver-refund", "v2.1"], ["ver-audit", "3.4"]]);
const OPTS = { productSlug: "checkout", entityLabels: ENTITY_LABELS, versionLabels: VERSION_LABELS };

/** The worked example: 3 channels (2 Kafka / Avro, 1 Pub/Sub / JSON Schema), a library trait, a local trait with a headers pin, a Kafka key. */
function checkoutService(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service", "Checkout events"),
    servers: [
      { key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" },
      { key: "pubsub", protocol: "googlepubsub", host: "pubsub.googleapis.com" },
    ],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "payments.refunds.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["RefundIssued"] },
      {
        key: "notifications", address: "projects/acme/topics/notifications", protocol: "googlepubsub", serverKeys: ["pubsub"],
        format: "json-schema", formatDialect: "draft-07", messageKeys: ["CustomerNotified"],
      },
    ],
    messages: [
      { key: "OrderCreated", payload: pin("ent-order", "ver-order"), keyPin: pin("ent-order-key", "ver-order-key"), headers: pin("ent-ce-headers", "ver-headers"), traitKeys: ["CloudEvents", "Audited"] },
      { key: "RefundIssued", payload: pin("ent-refund", "ver-refund"), traitKeys: [] },
      { key: "CustomerNotified", payload: pin("ent-notice", null), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" },
      { key: "Audited", kind: "MESSAGE", spec: { summary: "Audited message" }, headers: pin("ent-audit", "ver-audit") },
      { key: "Retryable", kind: "OPERATION", spec: { summary: "Retried on failure" } },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Retryable"] },
      { key: "publishRefundIssued", action: "send", channelKey: "refunds", messageKeys: ["RefundIssued"], traitKeys: [] },
      { key: "publishNotification", action: "send", channelKey: "notifications", messageKeys: ["CustomerNotified"], traitKeys: [] },
    ],
  };
}

const errorsOf = (list: Diagnostic[]) => list.filter((d) => d.severity === "error");
const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], value);

describe("buildInstantAsyncApi: the minimal document", () => {
  it("assembles an AsyncAPI 3.0.0 document from a title alone, versioned as a draft, with no errors", () => {
    const out = buildInstantAsyncApi(emptyEventDocument("Orders"), OPTS);
    expect(out.document).toEqual({ asyncapi: "3.0.0", info: { title: "Orders", version: "draft" } });
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(out.yaml).toBe("asyncapi: 3.0.0\ninfo:\n  title: Orders\n  version: draft\n");
  });

  it("carries the description and a server even before any channel or operation exists", () => {
    const doc = { ...emptyEventDocument("Orders", "All order events"), servers: [{ key: "dev", protocol: "kafka", host: "dev:9092" }] };
    const out = buildInstantAsyncApi(doc, OPTS);
    expect(at(out.document, "info", "description")).toBe("All order events");
    expect(at(out.document, "servers", "dev", "host")).toBe("dev:9092");
  });

  it("serializes YAML and JSON to the same content", () => {
    const out = buildInstantAsyncApi(checkoutService(), OPTS);
    expect(out.document).not.toBeNull();
    expect(parseYaml(out.yaml)).toEqual(JSON.parse(out.json));
    expect(JSON.parse(out.json)).toEqual(out.document);
    expect(out.json.endsWith("\n")).toBe(true);
    expect(out.json).toContain('\n  "asyncapi": "3.0.0"');
  });

  it("is deterministic: the same draft gives byte-identical code", () => {
    const a = buildInstantAsyncApi(checkoutService(), OPTS);
    const b = buildInstantAsyncApi(checkoutService(), OPTS);
    expect(a.yaml).toBe(b.yaml);
    expect(a.json).toBe(b.json);
  });

  it("does not mutate the draft it is given", () => {
    const doc = checkoutService();
    const before = JSON.stringify(doc);
    const frozen = (o: unknown): unknown => { if (o && typeof o === "object") { Object.values(o).forEach(frozen); Object.freeze(o); } return o; };
    expect(() => buildInstantAsyncApi(frozen(doc) as EventDocument, OPTS)).not.toThrow();
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("buildInstantAsyncApi: the worked checkout-service example", () => {
  const out = buildInstantAsyncApi(checkoutService(), OPTS);
  const doc = out.document as JsonObject;

  it("emits three channels, three operations and both servers, without a single error diagnostic", () => {
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(Object.keys(doc.channels as JsonObject).sort()).toEqual(["notifications", "orders", "refunds"]);
    expect(Object.keys(doc.operations as JsonObject).sort()).toEqual(["publishNotification", "publishOrderCreated", "publishRefundIssued"]);
    expect(Object.keys(doc.servers as JsonObject).sort()).toEqual(["kafka-prod", "pubsub"]);
  });

  it("puts an Avro record placeholder naming the entity@version on an Avro channel's payload", () => {
    const payload = at(doc, "components", "messages", "OrderCreated", "payload") as JsonObject;
    expect(payload.schemaFormat).toBe(SCHEMA_FORMATS.avro);
    expect(payload.schema).toEqual({ type: "record", name: "Order", fields: [], [PLACEHOLDER_ENTITY_KEY]: "Order@1.0" });
  });

  it("puts the Kafka key placeholder at bindings.kafka.key, as an Avro placeholder on an Avro channel", () => {
    const key = at(doc, "components", "messages", "OrderCreated", "bindings", "kafka", "key") as JsonObject;
    expect(key.schemaFormat).toBe(SCHEMA_FORMATS.avro);
    expect(key.schema).toEqual({ type: "record", name: "OrderKey", fields: [], [PLACEHOLDER_ENTITY_KEY]: "OrderKey@1.0" });
    // A message without a key pin gets no key binding.
    expect(at(doc, "components", "messages", "RefundIssued", "bindings")).toBeUndefined();
  });

  it("puts a JSON Schema placeholder on the Pub/Sub channel, in the channel's dialect, with the pin's draft state in its name", () => {
    const payload = at(doc, "components", "messages", "CustomerNotified", "payload") as JsonObject;
    expect(payload.schemaFormat).toBe(SCHEMA_FORMATS.jsonSchemaDraft07);
    expect(payload.schema).toEqual({ [PLACEHOLDER_ENTITY_KEY]: "Notice@draft" });
    expect(at(doc, "components", "messages", "CustomerNotified", "contentType")).toBe("application/json");
    expect(at(doc, "components", "messages", "CustomerNotified", "bindings")).toBeUndefined();
  });

  it("honours a 2020-12 channel", () => {
    const d = checkoutService();
    d.channels[2] = { ...d.channels[2], formatDialect: "2020-12" };
    const r = buildInstantAsyncApi(d, OPTS);
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const payload = at(r.document, "components", "messages", "CustomerNotified", "payload") as JsonObject;
    expect(payload.schemaFormat).toBe(SCHEMA_FORMATS.jsonSchema202012);
    expect(payload.schema).toEqual({ [PLACEHOLDER_ENTITY_KEY]: "Notice@draft" });
  });

  it("renders a library trait as a stub that carries its key, instead of failing to resolve it", () => {
    expect(at(doc, "components", "messageTraits", "CloudEvents")).toEqual({ [PLACEHOLDER_LIBRARY_TRAIT_KEY]: "CloudEvents" });
    expect(at(doc, "components", "messages", "OrderCreated", "traits")).toEqual([
      { $ref: "#/components/messageTraits/CloudEvents" },
      { $ref: "#/components/messageTraits/Audited" },
    ]);
  });

  it("carries a local trait's own spec, with its headers pin as an object-schema placeholder", () => {
    expect(at(doc, "components", "messageTraits", "Audited")).toEqual({
      headers: { type: "object", [PLACEHOLDER_ENTITY_KEY]: "AuditHeaders@3.4" },
      summary: "Audited message",
    });
    expect(at(doc, "components", "operationTraits", "Retryable")).toEqual({ summary: "Retried on failure" });
    expect(at(doc, "operations", "publishOrderCreated", "traits")).toEqual([{ $ref: "#/components/operationTraits/Retryable" }]);
  });

  it("renders a message's headers pin as an object-schema placeholder", () => {
    expect(at(doc, "components", "messages", "OrderCreated", "headers")).toEqual({
      type: "object", [PLACEHOLDER_ENTITY_KEY]: "CloudEventsHeaders@pinned",
    });
  });

  it("renders a Protobuf channel's payload as a commented .proto stub", () => {
    const d = checkoutService();
    d.channels[2] = { ...d.channels[2], format: "protobuf", formatDialect: undefined };
    const r = buildInstantAsyncApi(d, OPTS);
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const payload = at(r.document, "components", "messages", "CustomerNotified", "payload") as JsonObject;
    expect(payload.schemaFormat).toBe(SCHEMA_FORMATS.protobuf);
    expect(typeof payload.schema).toBe("string");
    expect(payload.schema).toContain(`${PLACEHOLDER_ENTITY_KEY}: Notice@draft`);
    expect(payload.schema).toContain("message Notice {}");
  });

  it("emits a message used on both an Avro and a JSON Schema channel once per format, each with its own placeholder", () => {
    const d = checkoutService();
    d.channels[2] = { ...d.channels[2], messageKeys: ["CustomerNotified", "RefundIssued"] };
    d.operations.push({ key: "publishRefundToPubsub", action: "send", channelKey: "notifications", messageKeys: ["RefundIssued"], traitKeys: [] });
    const r = buildInstantAsyncApi(d, OPTS);
    expect(errorsOf(r.diagnostics)).toEqual([]);
    const messages = at(r.document, "components", "messages") as JsonObject;
    expect(Object.keys(messages).filter((k) => k.startsWith("RefundIssued")).sort()).toEqual(["RefundIssued_avro", "RefundIssued_json"]);
    expect(at(messages, "RefundIssued_avro", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Refund@2.1");
    expect(at(messages, "RefundIssued_json", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Refund@2.1");
    expect(at(messages, "RefundIssued_avro", "payload", "schema", "type")).toBe("record");
  });

  it("emits a JSON Schema key placeholder on a Kafka channel that is not Avro", () => {
    const d = checkoutService();
    d.channels[0] = { ...d.channels[0], format: "json-schema" };
    const r = buildInstantAsyncApi(d, OPTS);
    expect(errorsOf(r.diagnostics)).toEqual([]);
    expect(at(r.document, "components", "messages", "OrderCreated", "bindings", "kafka", "key")).toEqual({ [PLACEHOLDER_ENTITY_KEY]: "OrderKey@1.0" });
  });
});

describe("buildInstantAsyncApi: placeholders name Entity@version", () => {
  const nameOf = (entityId: string, entityVersionId: string | null, labels = ENTITY_LABELS, versions = VERSION_LABELS) => {
    const doc = checkoutService();
    doc.messages = [{ key: "OrderCreated", payload: pin(entityId, entityVersionId), traitKeys: [] }];
    doc.channels = [doc.channels[0]];
    doc.channels[0].messageKeys = ["OrderCreated"];
    doc.operations = [doc.operations[0]];
    doc.operations[0] = { ...doc.operations[0], traitKeys: [] };
    doc.traits = [];
    const r = buildInstantAsyncApi(doc, { productSlug: "checkout", entityLabels: labels, versionLabels: versions });
    return at(r.document, "components", "messages", "OrderCreated", "payload", "schema", PLACEHOLDER_ENTITY_KEY);
  };

  it("uses the entity's label and the pinned version's label", () => {
    expect(nameOf("ent-order", "ver-order")).toBe("Order@1.0");
  });
  it("drops a leading v of the version label", () => {
    expect(nameOf("ent-refund", "ver-refund")).toBe("Refund@2.1");
  });
  it("says draft for an unpinned pin, which previews the entity's current draft", () => {
    expect(nameOf("ent-order", null)).toBe("Order@draft");
  });
  it("says pinned for a pinned version whose label is not known client-side", () => {
    expect(nameOf("ent-order", "ver-unknown")).toBe("Order@pinned");
  });
  it("falls back to the entity id when the entity is not in the label map", () => {
    expect(nameOf("ent-gone", "ver-x")).toBe("ent-gone@pinned");
  });
  it("works without any version labels at all", () => {
    const doc = emptyEventDocument("x");
    doc.channels = [{ key: "c", address: "c", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["M"] }];
    doc.messages = [{ key: "M", payload: pin("ent-order", "ver-order"), traitKeys: [] }];
    doc.operations = [{ key: "op", action: "send", channelKey: "c", messageKeys: ["M"], traitKeys: [] }];
    const r = buildInstantAsyncApi(doc, { productSlug: "p", entityLabels: ENTITY_LABELS });
    expect(at(r.document, "components", "messages", "M", "payload", "schema", PLACEHOLDER_ENTITY_KEY)).toBe("Order@pinned");
  });
  it("turns an entity label that is not a valid Avro name into one, and keeps the raw label in the marker", () => {
    const labels = new Map([["ent-order", "order-created v2"], ["ent-refund", "2fast"]]);
    const mk = (entity: string) => {
      const doc = emptyEventDocument("x");
      doc.channels = [{ key: "c", address: "c", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["M"] }];
      doc.messages = [{ key: "M", payload: pin(entity, null), traitKeys: [] }];
      doc.operations = [{ key: "op", action: "send", channelKey: "c", messageKeys: ["M"], traitKeys: [] }];
      return at(buildInstantAsyncApi(doc, { productSlug: "p", entityLabels: labels }).document, "components", "messages", "M", "payload", "schema") as JsonObject;
    };
    expect(mk("ent-order")).toMatchObject({ name: "order_created_v2", [PLACEHOLDER_ENTITY_KEY]: "order-created v2@draft" });
    expect(mk("ent-refund")).toMatchObject({ name: "_2fast" });
  });
});

describe("buildInstantAsyncApi: external references", () => {
  function withExternals(): EventDocument {
    const doc = checkoutService();
    doc.externalRefs = [
      { key: "ext-audit-channel", eventVersionId: "evv-1", kind: "channel", itemKey: "audit" },
      { key: "ext-audit-message", eventVersionId: "evv-1", kind: "message", itemKey: "AuditRecorded" },
    ];
    doc.channels[0] = { ...doc.channels[0], messageKeys: ["OrderCreated", "ext-audit-message"] };
    doc.operations[0] = { ...doc.operations[0], messageKeys: ["OrderCreated", "ext-audit-message"] };
    doc.operations.push({ key: "receiveAudit", action: "receive", channelKey: "ext-audit-channel", messageKeys: [], traitKeys: [] });
    return doc;
  }

  it("leaves them out of the document and says so with one info diagnostic each, at the reference's draft pointer", () => {
    const out = buildInstantAsyncApi(withExternals(), OPTS);
    expect(out.document).not.toBeNull();
    expect(errorsOf(out.diagnostics)).toEqual([]);
    const omitted = out.diagnostics.filter((d) => d.code === "EXTERNAL_REF_OMITTED");
    expect(omitted.map((d) => [d.severity, d.pointer])).toEqual([["info", "/externalRefs/0"], ["info", "/externalRefs/1"]]);
    expect(omitted[0].message).toContain("ext-audit-channel");
    expect(omitted[1].message).toContain("AuditRecorded");
  });

  it("drops an operation on an external channel and an external message from a local operation and channel, keeping the rest", () => {
    const out = buildInstantAsyncApi(withExternals(), OPTS);
    expect(Object.keys(at(out.document, "operations") as JsonObject)).not.toContain("receiveAudit");
    expect(at(out.document, "operations", "publishOrderCreated", "messages")).toEqual([{ $ref: "#/channels/orders/messages/OrderCreated" }]);
    expect(Object.keys(at(out.document, "channels", "orders", "messages") as JsonObject)).toEqual(["OrderCreated"]);
  });

  it("drops a reply that goes to an external channel and keeps one that stays local", () => {
    const doc = withExternals();
    doc.operations[0] = { ...doc.operations[0], reply: { channelKey: "ext-audit-channel", messageKeys: [] } };
    doc.operations[1] = { ...doc.operations[1], reply: { channelKey: "refunds", messageKeys: ["RefundIssued", "ext-audit-message"] } };
    doc.channels[1] = { ...doc.channels[1], messageKeys: ["RefundIssued", "ext-audit-message"] };
    const out = buildInstantAsyncApi(doc, OPTS);
    expect(errorsOf(out.diagnostics)).toEqual([]);
    expect(at(out.document, "operations", "publishOrderCreated", "reply")).toBeUndefined();
    expect(at(out.document, "operations", "publishRefundIssued", "reply", "messages")).toEqual([{ $ref: "#/channels/refunds/messages/RefundIssued" }]);
  });

  it("adds no omission diagnostic to a document without external references", () => {
    expect(buildInstantAsyncApi(checkoutService(), OPTS).diagnostics.some((d) => d.code === "EXTERNAL_REF_OMITTED")).toBe(false);
  });
});

describe("buildInstantAsyncApi: a draft that does not parse", () => {
  it("returns a null document and empty code with the parse problems as error diagnostics at their draft pointers", () => {
    const out = buildInstantAsyncApi(emptyEventDocument(""), OPTS);
    expect(out.document).toBeNull();
    expect(out.yaml).toBe("");
    expect(out.json).toBe("");
    expect(out.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "INVALID_DRAFT", pointer: "/info/title" })]);
    expect(out.diagnostics[0].message).toContain("title");
  });

  it("reports every problem, not only the first", () => {
    const doc = checkoutService();
    doc.info = { title: "" };
    doc.servers[0] = { ...doc.servers[0], host: "" };
    doc.operations[0] = { ...doc.operations[0], channelKey: "nowhere" };
    const out = buildInstantAsyncApi(doc, OPTS);
    expect(out.document).toBeNull();
    expect(out.diagnostics.map((d) => d.pointer)).toEqual(expect.arrayContaining(["/info/title", "/servers/0/host", "/operations/0/channelKey"]));
    expect(out.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  it("reports a draft that parses but does not resolve (a library trait declared with two kinds) as UNRESOLVED_REFERENCE errors, null document", () => {
    const doc = checkoutService();
    doc.traits = [
      { key: "A", kind: "MESSAGE", libraryTraitId: "lib-1" },
      { key: "B", kind: "OPERATION", libraryTraitId: "lib-1" },
    ];
    doc.messages[0] = { ...doc.messages[0], traitKeys: ["A"] };
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["B"] };
    const out = buildInstantAsyncApi(doc, OPTS);
    expect(out.document).toBeNull();
    expect(out.yaml).toBe("");
    expect(out.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "UNRESOLVED_REFERENCE", pointer: "/traits/1/libraryTraitId" })]);
  });
});

describe("buildInstantAsyncApi: never throws", () => {
  const checks = (out: ReturnType<typeof buildInstantAsyncApi>) => {
    expect(Object.keys(out).sort()).toEqual(["diagnostics", "document", "json", "yaml"]);
    expect(typeof out.yaml).toBe("string");
    expect(typeof out.json).toBe("string");
    expect(Array.isArray(out.diagnostics)).toBe(true);
    if (out.document === null) {
      expect(out.yaml).toBe("");
      expect(out.json).toBe("");
      expect(out.diagnostics.length).toBeGreaterThan(0);
    } else {
      expect(parseYaml(out.yaml)).toEqual(JSON.parse(out.json));
    }
  };
  const run = (value: unknown) => buildInstantAsyncApi(value as EventDocument, OPTS);

  it("survives values that are not documents at all", () => {
    const cyclic: Record<string, unknown> = { documentVersion: 2, info: { title: "x" } };
    cyclic.servers = [cyclic];
    const throwing = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, has() { throw new Error("boom"); } });
    const getter = { documentVersion: 2, get info(): never { throw new Error("getter"); } };
    for (const value of [
      undefined, null, 0, 1, NaN, "", "x", true, [], [[]], {}, () => 1, Symbol("s"), BigInt(10), cyclic, throwing, getter,
      { documentVersion: 2 }, { documentVersion: "2", info: { title: "x" } }, { documentVersion: 2, info: null },
      { documentVersion: 2, info: { title: "x" }, servers: "nope", channels: 5, messages: {}, traits: null, operations: [null], externalRefs: [[]] },
      JSON.parse('{"__proto__": {"polluted": true}, "documentVersion": 2, "info": {"title": "x"}}'),
    ]) {
      expect(() => run(value), String(typeof value)).not.toThrow();
      checks(run(value));
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("survives a document whose values the serializers cannot handle (a function in a binding, a bigint in an example)", () => {
    const doc = checkoutService();
    doc.channels[0] = { ...doc.channels[0], bindings: { kafka: { partitions: () => 1 } } as unknown as JsonObject };
    expect(() => run(doc)).not.toThrow();
    checks(run(doc));
    const doc2 = checkoutService();
    doc2.messages[0] = { ...doc2.messages[0], examples: [{ payload: BigInt(10) }] as unknown as JsonObject[] };
    expect(() => run(doc2)).not.toThrow();
    checks(run(doc2));
  });

  it("survives random object shapes (seeded)", () => {
    let seed = 20261016;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
    const KEYS = ["documentVersion", "info", "title", "servers", "channels", "messages", "traits", "operations", "externalRefs", "components",
      "key", "protocol", "host", "address", "format", "formatDialect", "serverKeys", "messageKeys", "traitKeys", "payload", "entityId",
      "entityVersionId", "headers", "keyPin", "kind", "spec", "libraryTraitId", "action", "channelKey", "reply", "bindings", "__proto__", "constructor"];
    const gen = (depth: number): unknown => {
      const r = next();
      if (depth <= 0 || r < 0.25) return pick([null, undefined, 0, 2, -1.5, "", "x", "kafka", "avro", "json-schema", "send", "MESSAGE", true, false]);
      if (r < 0.45) return Array.from({ length: Math.floor(next() * 4) }, () => gen(depth - 1));
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(next() * 6); i > 0; i--) Object.defineProperty(o, pick(KEYS), { value: gen(depth - 1), enumerable: true, configurable: true, writable: true });
      return o;
    };
    for (let i = 0; i < 400; i++) {
      const value = gen(4);
      expect(() => run(value), `case ${i}`).not.toThrow();
      checks(run(value));
    }
  });

  it("survives random mutations of a valid document (seeded): some build, some do not, none throw", () => {
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    const junk = [null, undefined, 3, "", "zzz", [], {}, [1], { a: 1 }];
    let built = 0;
    for (let i = 0; i < 300; i++) {
      const doc = JSON.parse(JSON.stringify(checkoutService())) as Record<string, unknown>;
      for (let m = 1 + Math.floor(next() * 3); m > 0; m--) {
        let node: unknown = doc;
        for (let depth = Math.floor(next() * 4); depth > 0; depth--) {
          const keys = node && typeof node === "object" ? Object.keys(node) : [];
          if (keys.length === 0) break;
          node = (node as Record<string, unknown>)[keys[Math.floor(next() * keys.length)]];
        }
        if (node && typeof node === "object") {
          const keys = Object.keys(node);
          if (keys.length > 0) (node as Record<string, unknown>)[keys[Math.floor(next() * keys.length)]] = junk[Math.floor(next() * junk.length)];
        }
      }
      const out = run(doc);
      checks(out);
      if (out.document !== null) built += 1;
    }
    expect(built).toBeGreaterThan(0);
    expect(built).toBeLessThan(300);
  });
});
