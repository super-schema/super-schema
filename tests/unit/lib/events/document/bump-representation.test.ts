// tests/unit/lib/events/document/bump-representation.test.ts
// WP-1b: a changed EFFECTIVE representation of a message is MAJOR; the AsyncAPI properties WP-1a added to the model are MINOR
// (never "no changes") when they are all that changed.
import { describe, expect, it } from "vitest";
import type { BumpDecision } from "@/lib/events/bump-rules";
import { classifyEventBump, type EventBumpSide } from "@/lib/events/document/bump";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import type { PayloadFormat } from "@/lib/event-specs/types";

const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });
const PINS = { v1: { entityId: "e1", entityName: "Order", label: "1.0", major: 1 }, r1: { entityId: "er", entityName: "Refund", label: "1.0", major: 1 } };

function base(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "payments.refunds.v1", protocol: "googlepubsub", serverKeys: [], messageKeys: ["RefundIssued"] },
    ],
    messages: [
      { key: "OrderCreated", payload: pin("e1", "v1"), traitKeys: ["CloudEvents"] },
      { key: "RefundIssued", payload: pin("er", "r1"), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", spec: { summary: "ce" } },
      { key: "Audited", kind: "OPERATION", spec: { summary: "audited" } },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], reply: { channelKey: "refunds", messageKeys: ["RefundIssued"] } },
    ],
  };
}
type Reps = Record<string, PayloadFormat>;
const side = (doc: EventDocument, representations?: Reps): EventBumpSide => ({
  doc, pins: PINS, libraryHeaders: {}, externalMajors: {}, ...(representations ? { representations } : {}),
});
const mutated = (fn: (d: EventDocument) => void): EventDocument => { const d = base(); fn(d); return d; };
const major = (...reasons: string[]): BumpDecision => ({ bump: "MAJOR", reasons });
const minor = (...reasons: string[]): BumpDecision => ({ bump: "MINOR", reasons });
const REPS: Reps = { OrderCreated: "avro", RefundIssued: "json-schema" };

describe("a changed effective representation is MAJOR", () => {
  it("Avro → JSON Schema", () => {
    const decision = classifyEventBump(side(base(), REPS), side(base(), { ...REPS, OrderCreated: "json-schema" }));
    expect(decision).toEqual(major('Message "OrderCreated": representation Avro → JSON Schema'));
  });

  it.each([
    ["avro", "protobuf", "Avro → Protobuf"],
    ["protobuf", "json-schema", "Protobuf → JSON Schema"],
    ["json-schema", "avro", "JSON Schema → Avro"],
  ] as const)("%s → %s reads %s", (from, to, label) => {
    const decision = classifyEventBump(side(base(), { ...REPS, RefundIssued: from }), side(base(), { ...REPS, RefundIssued: to }));
    expect(decision).toEqual(major(`Message "RefundIssued": representation ${label}`));
  });

  it("reports each message that changed, in document order", () => {
    const decision = classifyEventBump(side(base(), REPS), side(base(), { OrderCreated: "protobuf", RefundIssued: "avro" }));
    expect(decision.reasons).toEqual([
      'Message "OrderCreated": representation Avro → Protobuf',
      'Message "RefundIssued": representation JSON Schema → Avro',
    ]);
  });

  it("an unchanged effective representation is not a change", () => {
    expect(classifyEventBump(side(base(), REPS), side(base(), { ...REPS }))).toEqual(minor());
  });

  it("choosing explicitly what Auto already resolved to is not a change (the effective format is the same)", () => {
    const prev = base();
    const next = mutated((d) => { d.messages[0].representation = "avro"; });
    expect(classifyEventBump(side(prev, REPS), side(next, REPS))).toEqual(minor());
  });

  it("switching a message from Auto to a different explicit representation is MAJOR through the effective formats", () => {
    const next = mutated((d) => { d.messages[0].representation = "protobuf"; });
    expect(classifyEventBump(side(base(), REPS), side(next, { ...REPS, OrderCreated: "protobuf" }))).toEqual(
      major('Message "OrderCreated": representation Avro → Protobuf'),
    );
  });

  it("a message present on one side only is judged by the usual added / removed rules, not by representation", () => {
    const next = mutated((d) => { d.messages = d.messages.filter((m) => m.key !== "RefundIssued"); d.channels[1].messageKeys = []; d.operations[0].reply = undefined; });
    const decision = classifyEventBump(side(base(), REPS), side(next, { OrderCreated: "avro" }));
    expect(decision.reasons.some((r) => r.includes("representation"))).toBe(false);
    expect(decision.reasons).toContain('Message "RefundIssued" removed');
    const added = classifyEventBump(side(next, { OrderCreated: "avro" }), side(base(), REPS));
    expect(added.reasons.some((r) => r.includes("representation"))).toBe(false);
    expect(added.reasons).toContain('Message "RefundIssued" added');
  });

  it("fails closed: when the effective formats are not supplied, a changed message representation is MAJOR", () => {
    const next = mutated((d) => { d.messages[0].representation = "protobuf"; });
    expect(classifyEventBump(side(base()), side(next))).toEqual(
      major('Message "OrderCreated": representation changed (effective formats unavailable, treated as breaking)'),
    );
  });

  it("fails closed when only one side supplies the effective formats", () => {
    const next = mutated((d) => { d.messages[0].representation = "protobuf"; });
    expect(classifyEventBump(side(base(), REPS), side(next)).bump).toBe("MAJOR");
    expect(classifyEventBump(side(base()), side(next, REPS)).bump).toBe("MAJOR");
  });

  it("without supplied formats and without a representation change nothing is reported", () => {
    expect(classifyEventBump(side(base()), side(base()))).toEqual(minor());
  });

  it("a prototype member name is never read as a message's effective format", () => {
    const toString: Reps = {};
    expect(classifyEventBump(side(base(), toString), side(base(), toString))).toEqual(minor());
  });
});

describe("the channel's explicit format, now optional", () => {
  it("explicit → a different explicit format is MAJOR, as before", () => {
    const next = mutated((d) => { d.channels[0].format = "json-schema"; });
    expect(classifyEventBump(side(base()), side(next))).toEqual(major('Channel "orders" format changed from avro to json-schema'));
  });

  it("explicit → Auto without supplied effective formats fails closed (MAJOR)", () => {
    const next = mutated((d) => { delete d.channels[0].format; });
    expect(classifyEventBump(side(base()), side(next))).toEqual(major('Channel "orders" format changed from avro to (auto)'));
  });

  it("Auto → explicit without supplied effective formats fails closed (MAJOR)", () => {
    const prev = mutated((d) => { delete d.channels[0].format; });
    expect(classifyEventBump(side(prev), side(base()))).toEqual(major('Channel "orders" format changed from (auto) to avro'));
  });

  it("explicit → Auto with the same effective formats on both sides is not a change", () => {
    const next = mutated((d) => { delete d.channels[0].format; });
    expect(classifyEventBump(side(base(), REPS), side(next, REPS))).toEqual(minor());
  });

  it("explicit → Auto that changes a message's effective format is reported once, as the message's representation", () => {
    const next = mutated((d) => { delete d.channels[0].format; });
    expect(classifyEventBump(side(base(), REPS), side(next, { ...REPS, OrderCreated: "json-schema" }))).toEqual(
      major('Message "OrderCreated": representation Avro → JSON Schema'),
    );
  });

  it("a dialect change is still MAJOR, with or without a format", () => {
    const prev = mutated((d) => { d.channels[1].formatDialect = "draft-07"; });
    const next = mutated((d) => { d.channels[1].formatDialect = "2020-12"; });
    expect(classifyEventBump(side(prev, REPS), side(next, REPS))).toEqual(major('Channel "refunds" formatDialect changed from draft-07 to 2020-12'));
  });

  it("two channels that both have no format are compared like any other channel", () => {
    expect(classifyEventBump(side(base()), side(base()))).toEqual(minor());
    const next = mutated((d) => { d.channels[1].address = "payments.refunds.v2"; });
    expect(classifyEventBump(side(base()), side(next)).bump).toBe("MAJOR");
  });
});

describe("AsyncAPI properties that are MINOR when they are all that changed", () => {
  const cases: Array<[string, (d: EventDocument) => void, string]> = [
    ["message name", (d) => { d.messages[0].name = "order.created"; }, 'Message "OrderCreated" name changed'],
    ["message deprecated", (d) => { d.messages[0].deprecated = true; }, 'Message "OrderCreated" deprecation changed'],
    ["message deprecated flag cleared to false", (d) => { d.messages[0].deprecated = false; }, 'Message "OrderCreated" deprecation changed'],
    ["operation title", (d) => { d.operations[0].title = "Publish an order"; }, 'Operation "publishOrderCreated" details changed'],
    ["operation security", (d) => { d.operations[0].security = ["basic"]; }, 'Operation "publishOrderCreated" details changed'],
    ["operation tags", (d) => { d.operations[0].tags = [{ name: "orders" }]; }, 'Operation "publishOrderCreated" details changed'],
    ["operation externalDocs", (d) => { d.operations[0].externalDocs = { url: "https://example.com/op" }; }, 'Operation "publishOrderCreated" details changed'],
    ["operation reply address", (d) => { d.operations[0].reply = { ...d.operations[0].reply, address: { location: "$message.header#/replyTo" } }; }, 'Operation "publishOrderCreated" reply address changed'],
    ["info terms of service", (d) => { d.info.termsOfService = "https://example.com/terms"; }, "Info changed"],
    ["info contact", (d) => { d.info.contact = { email: "platform@example.com" }; }, "Info changed"],
    ["info license", (d) => { d.info.license = { name: "MIT" }; }, "Info changed"],
    ["info tags", (d) => { d.info.tags = [{ name: "payments" }]; }, "Info changed"],
    ["info externalDocs", (d) => { d.info.externalDocs = { url: "https://example.com/docs" }; }, "Info changed"],
    ["server title", (d) => { d.servers[0].title = "Production"; }, 'Server "kafka-prod" changed'],
    ["server summary", (d) => { d.servers[0].summary = "Prod cluster"; }, 'Server "kafka-prod" changed'],
    ["server variables", (d) => { d.servers[0].host = "{env}.kafka:9092"; d.servers[0].variables = { env: { default: "prod" } }; }, 'Server "kafka-prod" changed'],
    ["server security", (d) => { d.servers[0].security = ["basic"]; }, 'Server "kafka-prod" changed'],
    ["server tags", (d) => { d.servers[0].tags = [{ name: "prod" }]; }, 'Server "kafka-prod" changed'],
    ["server externalDocs", (d) => { d.servers[0].externalDocs = { url: "https://example.com/kafka" }; }, 'Server "kafka-prod" changed'],
    ["server bindings", (d) => { d.servers[0].bindings = { kafka: { schemaRegistryUrl: "https://registry" } }; }, 'Server "kafka-prod" changed'],
    ["channel summary", (d) => { d.channels[0].summary = "Orders"; }, 'Channel "orders" details changed'],
    ["channel parameters", (d) => { d.channels[0].parameters = { region: { description: "Region" } }; }, 'Channel "orders" details changed'],
    ["channel tags", (d) => { d.channels[0].tags = [{ name: "orders" }]; }, 'Channel "orders" details changed'],
    ["channel externalDocs", (d) => { d.channels[0].externalDocs = { url: "https://example.com/orders" }; }, 'Channel "orders" details changed'],
    ["channel bindings", (d) => { d.channels[0].bindings = { kafka: { partitions: 3 } }; }, 'Channel "orders" details changed'],
    ["message trait spec", (d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", spec: { summary: "ce", tags: [{ name: "x" }] } }; }, 'Trait "CloudEvents" changed'],
    ["message trait bindings", (d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", spec: { summary: "ce", bindings: { kafka: { schemaIdLocation: "header" } } } }; }, 'Trait "CloudEvents" changed'],
    ["operation trait spec", (d) => { d.traits[1] = { key: "Audited", kind: "OPERATION", spec: { summary: "audited", security: ["basic"] } }; }, 'Trait "Audited" changed'],
    ["operation trait bindings", (d) => { d.traits[1] = { key: "Audited", kind: "OPERATION", spec: { summary: "audited", bindings: { kafka: { groupId: { type: "string" } } } } }; }, 'Trait "Audited" changed'],
    ["message correlation-free documentation", (d) => { d.messages[1].title = "Refund issued"; }, 'Message "RefundIssued" documentation changed'],
  ];

  it.each(cases)("%s is MINOR with its own reason", (_name, change, reason) => {
    expect(classifyEventBump(side(base(), REPS), side(mutated(change), REPS))).toEqual(minor(reason));
  });

  it("is symmetric: removing the property is MINOR as well", () => {
    for (const [, change, reason] of cases) {
      const prevDoc = mutated(change);
      const decision = classifyEventBump(side(prevDoc, REPS), side(base(), REPS));
      expect(decision.bump).toBe("MINOR");
      expect(decision.reasons).toContain(reason);
    }
  });

  it("changing several of them reports each one", () => {
    const next = mutated((d) => { d.messages[0].name = "order.created"; d.operations[0].title = "Publish"; d.info.termsOfService = "https://example.com/terms"; });
    expect(classifyEventBump(side(base(), REPS), side(next, REPS))).toEqual(
      minor('Operation "publishOrderCreated" details changed', 'Message "OrderCreated" name changed', "Info changed"),
    );
  });

  it("origin stays ignored", () => {
    const next = mutated((d) => { d.channels[0].origin = { provider: "confluent", ref: "lkc-1", syncedAt: "2026-10-15T00:00:00Z" }; });
    expect(classifyEventBump(side(base(), REPS), side(next, REPS))).toEqual(minor());
  });
});
