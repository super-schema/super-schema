import { describe, expect, it } from "vitest";
import type { BumpDecision, BumpTraitHeadersPin } from "@/lib/events/bump-rules";
import { classifyEventBump, type EventBumpPinFact, type EventBumpSide } from "@/lib/events/document/bump";
import { renameKey, type KeyKind } from "@/lib/events/document/keys";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocChannel, type EventDocument } from "@/lib/events/document/types";

const pin = (entityId: string, entityVersionId: string | null) => ({ entityId, entityVersionId });
const fact = (entityId: string, entityName: string, label: string, major: number): EventBumpPinFact => ({ entityId, entityName, label, major });

/** Facts per pinned entityVersionId. v1/v2 share a major, v3 is the next major (same for h*, k*, t*). */
const PINS: Record<string, EventBumpPinFact> = {
  v1: fact("e1", "Order", "1.0", 1),
  v2: fact("e1", "Order", "1.1", 1),
  v3: fact("e1", "Order", "2.0", 2),
  c1: fact("ec", "OrderCancelledPayload", "1.0", 1),
  s1: fact("es", "OrderShippedPayload", "1.0", 1),
  r1: fact("er", "RefundPayload", "1.0", 1),
  x1: fact("ex", "Invoice", "1.0", 1),
  h1: fact("eh", "EventHeaders", "1.0", 1),
  h2: fact("eh", "EventHeaders", "1.1", 1),
  h3: fact("eh", "EventHeaders", "2.0", 2),
  k1: fact("ek", "OrderKey", "1.0", 1),
  k2: fact("ek", "OrderKey", "1.1", 1),
  k3: fact("ek", "OrderKey", "2.0", 2),
  t1: fact("et", "Envelope", "1.0", 1),
  t2: fact("et", "Envelope", "1.1", 1),
  t3: fact("et", "Envelope", "2.0", 2),
};
const libHeaders = (entityVersionId: string, major: number, label: string): BumpTraitHeadersPin => ({
  entityId: "elh", entityName: "CloudEventsHeaders", entityVersionId, major, label,
});
const LIBRARY: Record<string, BumpTraitHeadersPin | null> = { "lib-ce": libHeaders("lh1", 1, "1.0") };
const EXTERNAL: Record<string, number> = { "ev-pay-1": 1, "ev-pay-2": 1, "ev-pay-3": 2 };

function base(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [
      { key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated", "OrderCancelled", "OrderShipped"] },
      { key: "refunds", address: "payments.refunds.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "json-schema", formatDialect: "draft-07", messageKeys: ["RefundIssued"] },
    ],
    messages: [
      {
        key: "OrderCreated", payload: pin("e1", "v1"), headers: pin("eh", "h1"), keyPin: pin("ek", "k1"), contentType: "avro/binary",
        correlationId: { location: "$message.header#/correlationId" }, traitKeys: ["CloudEvents", "Envelope"],
      },
      { key: "OrderCancelled", payload: pin("ec", "c1"), traitKeys: [] },
      { key: "OrderShipped", payload: pin("es", "s1"), traitKeys: [] },
      { key: "RefundIssued", payload: pin("er", "r1"), traitKeys: [] },
    ],
    traits: [
      { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" },
      { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" }, headers: pin("et", "t1") },
      { key: "Audited", kind: "OPERATION", spec: {} },
    ],
    operations: [
      { key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"] },
      { key: "cancelOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCancelled"], traitKeys: [] },
      {
        key: "consumeRefund", action: "receive", channelKey: "refunds", messageKeys: ["RefundIssued"], traitKeys: [],
        reply: { channelKey: "orders", messageKeys: ["OrderCancelled"] },
      },
    ],
    externalRefs: [{ key: "PaymentSettled", eventVersionId: "ev-pay-1", kind: "message", itemKey: "Settled" }],
  };
}

type Mut = (d: EventDocument) => void;
type SideOver = Partial<Omit<EventBumpSide, "doc">>;
const docOf = (mut?: Mut): EventDocument => {
  const d = base();
  mut?.(d);
  return d;
};
const sideOf = (doc: EventDocument, over: SideOver = {}): EventBumpSide => ({ doc, pins: PINS, libraryHeaders: LIBRARY, externalMajors: EXTERNAL, ...over });

/** prev = base() (+ `prev` mutation), next = base() + `next` mutation. */
function classify(next: Mut | undefined, opts: { prev?: Mut; prevSide?: SideOver; nextSide?: SideOver } = {}): BumpDecision {
  return classifyEventBump(sideOf(docOf(opts.prev), opts.prevSide), sideOf(docOf(next), opts.nextSide));
}
const major = (...reasons: string[]): BumpDecision => ({ bump: "MAJOR", reasons });
const minor = (...reasons: string[]): BumpDecision => ({ bump: "MINOR", reasons });
const channelNamed = (d: EventDocument, key: string): DocChannel => d.channels.find((c) => c.key === key) as DocChannel;

describe("classifyEventBump: the fixture and the empty change", () => {
  it("the base fixture is a valid document", () => {
    expect(parseEventDocument(base()).success).toBe(true);
  });

  it("identical documents are MINOR with no reasons", () => {
    expect(classify(undefined)).toEqual(minor());
  });

  it("reordering keys, key lists and trait lists is not a change", () => {
    const decision = classify((d) => {
      d.channels.reverse();
      d.messages.reverse();
      d.traits.reverse();
      d.operations.reverse();
      channelNamed(d, "orders").messageKeys.reverse();
      d.messages.find((m) => m.key === "OrderCreated")!.traitKeys.reverse();
    });
    expect(decision).toEqual(minor());
  });

  it("origin (infra sync metadata) is ignored", () => {
    const origin = { provider: "confluent", ref: "lkc-1", syncedAt: "2026-10-15T00:00:00Z" };
    expect(classify((d) => { d.channels[0].origin = origin; d.servers[0].origin = origin; })).toEqual(minor());
  });

  it("MAJOR reasons come before MINOR reasons", () => {
    const decision = classify((d) => {
      d.info.description = "Checkout events";
      d.operations = d.operations.filter((o) => o.key !== "cancelOrder");
    });
    expect(decision).toEqual(major('Operation "cancelOrder" removed', "Info changed"));
  });
});

describe("classifyEventBump: operations", () => {
  it("MAJOR when an operation is removed", () => {
    expect(classify((d) => { d.operations = d.operations.filter((o) => o.key !== "cancelOrder"); })).toEqual(major('Operation "cancelOrder" removed'));
  });

  it("MAJOR when a message is removed from an operation, MINOR when one is added", () => {
    const withBoth: Mut = (d) => { d.operations[0].messageKeys = ["OrderCreated", "OrderCancelled"]; };
    expect(classify(undefined, { prev: withBoth })).toEqual(major('Message "OrderCancelled" removed from operation "publishOrderCreated"'));
    expect(classify(withBoth)).toEqual(minor('Message "OrderCancelled" added to operation "publishOrderCreated"'));
  });

  it("MAJOR when a message is removed from an operation's reply, MINOR when one is added", () => {
    const noReplyMessages: Mut = (d) => { d.operations[2].reply = { channelKey: "orders" }; };
    expect(classify(noReplyMessages)).toEqual(major('Message "OrderCancelled" removed from the reply of operation "consumeRefund"'));
    expect(classify(undefined, { prev: noReplyMessages })).toEqual(minor('Message "OrderCancelled" added to the reply of operation "consumeRefund"'));
  });

  it("MAJOR when an operation's action or channel changes (an operation removal plus an addition)", () => {
    expect(classify((d) => { d.operations[0].action = "receive"; })).toEqual(major('Operation "publishOrderCreated" action changed from send to receive'));
    const moved = classify((d) => {
      d.channels.push({ ...structuredClone(channelNamed(d, "orders")), key: "orders-v2", address: "payments.orders.v2" });
      d.operations[0].channelKey = "orders-v2";
    });
    expect(moved).toEqual(major('Operation "publishOrderCreated" moved from channel "orders" to "orders-v2"', 'Channel "orders-v2" added'));
  });

  it("MAJOR when a reply is removed or moved to another channel, MINOR when one is added", () => {
    expect(classify((d) => { delete d.operations[2].reply; })).toEqual(major('Operation "consumeRefund" reply removed'));
    const moved = classify((d) => {
      d.channels.push({ ...structuredClone(channelNamed(d, "orders")), key: "orders-v2", address: "payments.orders.v2" });
      d.operations[2].reply = { channelKey: "orders-v2", messageKeys: ["OrderCancelled"] };
    });
    expect(moved).toEqual(major('Operation "consumeRefund" reply moved from channel "orders" to "orders-v2"', 'Channel "orders-v2" added'));
    expect(classify((d) => { d.operations[1].reply = { channelKey: "orders", messageKeys: ["OrderCancelled"] }; })).toEqual(
      minor('Operation "cancelOrder" reply added')
    );
  });

  it("MINOR for operation trait and detail edits, naming the operation", () => {
    expect(classify((d) => { d.operations[0].traitKeys = []; })).toEqual(minor('Operation "publishOrderCreated" trait "Audited" removed'));
    expect(classify((d) => { d.operations[1].traitKeys = ["Audited"]; })).toEqual(minor('Operation "cancelOrder" trait "Audited" added'));
    expect(classify((d) => { d.operations[0].summary = "Publish a new order"; })).toEqual(minor('Operation "publishOrderCreated" details changed'));
    expect(classify((d) => { d.operations[0].description = "d"; })).toEqual(minor('Operation "publishOrderCreated" details changed'));
    expect(classify((d) => { d.operations[0].bindings = { kafka: { clientId: "c" } }; })).toEqual(minor('Operation "publishOrderCreated" details changed'));
  });
});

describe("classifyEventBump: channels", () => {
  it("MAJOR when a message is removed from a channel, MINOR when one is added", () => {
    const withoutShipped: Mut = (d) => { channelNamed(d, "orders").messageKeys = ["OrderCreated", "OrderCancelled"]; };
    expect(classify(withoutShipped)).toEqual(major('Message "OrderShipped" removed from channel "orders"'));
    expect(classify(undefined, { prev: withoutShipped })).toEqual(minor('Message "OrderShipped" added to channel "orders"'));
  });

  it("MAJOR when a channel is removed", () => {
    const decision = classify((d) => {
      d.operations = d.operations.filter((o) => o.key !== "consumeRefund");
      d.channels = d.channels.filter((c) => c.key !== "refunds");
    });
    expect(decision).toEqual(major('Operation "consumeRefund" removed', 'Channel "refunds" removed'));
  });

  it.each<[string, Mut, string]>([
    ["address", (d) => { d.channels[0].address = "payments.orders.v2"; }, 'Channel "orders" address changed from "payments.orders.v1" to "payments.orders.v2"'],
    ["address (to none)", (d) => { d.channels[0].address = null; }, 'Channel "orders" address changed from "payments.orders.v1" to "(none)"'],
    ["protocol", (d) => { d.channels[0].protocol = "amqp"; }, 'Channel "orders" protocol changed from kafka to amqp'],
    ["format", (d) => { d.channels[0].format = "protobuf"; }, 'Channel "orders" format changed from avro to protobuf'],
    ["formatDialect", (d) => { d.channels[1].formatDialect = "2020-12"; }, 'Channel "refunds" formatDialect changed from draft-07 to 2020-12'],
  ])("MAJOR when channel %s changes (R78)", (_name, mutate, reason) => {
    expect(classify(mutate)).toEqual(major(reason));
  });

  it("MAJOR when a json-schema channel gains or loses a dialect", () => {
    const noDialect: Mut = (d) => { delete channelNamed(d, "refunds").formatDialect; };
    expect(classify(noDialect)).toEqual(major('Channel "refunds" formatDialect changed from draft-07 to (none)'));
    expect(classify(undefined, { prev: noDialect })).toEqual(major('Channel "refunds" formatDialect changed from (none) to draft-07'));
  });

  it("reports only the format when a format change also drops the dialect", () => {
    const decision = classify((d) => { const c = channelNamed(d, "refunds"); c.format = "avro"; delete c.formatDialect; });
    expect(decision).toEqual(major('Channel "refunds" format changed from json-schema to avro'));
  });

  it("MINOR for every other channel field", () => {
    const edits: Mut[] = [
      (d) => { d.channels[0].title = "Orders"; },
      (d) => { d.channels[0].summary = "s"; },
      (d) => { d.channels[0].description = "d"; },
      (d) => { d.channels[0].tags = [{ name: "orders" }]; },
      (d) => { d.channels[0].externalDocs = { url: "https://example.com" }; },
      (d) => { d.channels[0].bindings = { kafka: { partitions: 12 } }; },
      (d) => { d.channels[0].parameters = { region: {} }; },
      (d) => { d.servers.push({ key: "kafka-dr", protocol: "kafka", host: "dr:9092" }); d.channels[0].serverKeys = ["kafka-prod", "kafka-dr"]; },
    ];
    for (const edit of edits) {
      const decision = classify((d) => { edit(d); });
      expect(decision.bump).toBe("MINOR");
      expect(decision.reasons).toContain('Channel "orders" details changed');
    }
  });
});

describe("classifyEventBump: messages", () => {
  it("MAJOR when a message is removed", () => {
    const decision = classify((d) => {
      d.messages = d.messages.filter((m) => m.key !== "OrderShipped");
      channelNamed(d, "orders").messageKeys = ["OrderCreated", "OrderCancelled"];
    });
    expect(decision).toEqual(major('Message "OrderShipped" removed from channel "orders"', 'Message "OrderShipped" removed'));
  });

  it("MAJOR when the payload pin moves to a new entity major, MINOR for a same-major move", () => {
    expect(classify((d) => { d.messages[0].payload = pin("e1", "v3"); })).toEqual(
      major('Message "OrderCreated" payload pin moved from Order v1.0 to v2.0 (new major)')
    );
    expect(classify((d) => { d.messages[0].payload = pin("e1", "v2"); })).toEqual(
      minor('Message "OrderCreated" payload pin moved from v1.0 to v1.1')
    );
    expect(classify((d) => { d.messages[0].payload = pin("ex", "x1"); })).toEqual(
      major('Message "OrderCreated" payload now references Invoice instead of Order')
    );
  });

  it("MAJOR when the payload pin moves to a lower major", () => {
    const decision = classify(undefined, { prev: (d) => { d.messages[0].payload = pin("e1", "v3"); } });
    expect(decision).toEqual(major('Message "OrderCreated" payload pin moved from Order v2.0 to v1.0 (new major)'));
  });

  it("MAJOR when the payload becomes unpinned", () => {
    expect(classify((d) => { d.messages[0].payload = pin("e1", null); })).toEqual(
      major('Message "OrderCreated" payload removed (was Order v1.0)')
    );
  });

  describe.each([
    { field: "headers", label: "headers", entity: "EventHeaders", entityId: "eh", prefix: "h", holder: 0, bare: 1 },
    { field: "keyPin", label: "key", entity: "OrderKey", entityId: "ek", prefix: "k", holder: 0, bare: 1 },
  ] as const)("$label pin", ({ field, label, entity, entityId, prefix, holder, bare }) => {
    const holderKey = base().messages[holder].key;
    const bareKey = base().messages[bare].key;

    it("MAJOR when removed", () => {
      expect(classify((d) => { delete d.messages[holder][field]; })).toEqual(major(`Message "${holderKey}" ${label} removed (was ${entity} v1.0)`));
    });

    it("MAJOR when added (D6 treats this as MINOR for a whole Message; for an event it is MAJOR)", () => {
      expect(classify((d) => { d.messages[bare][field] = pin(entityId, `${prefix}1`); })).toEqual(
        major(`Message "${bareKey}" ${label} added: ${entity} v1.0`)
      );
    });

    it("MAJOR when replaced by another entity", () => {
      expect(classify((d) => { d.messages[holder][field] = pin("ex", "x1"); })).toEqual(
        major(`Message "${holderKey}" ${label} now references Invoice instead of ${entity}`)
      );
    });

    it("MAJOR for a new entity major, MINOR for a same-major move", () => {
      expect(classify((d) => { d.messages[holder][field] = pin(entityId, `${prefix}3`); })).toEqual(
        major(`Message "${holderKey}" ${label} pin moved from ${entity} v1.0 to v2.0 (new major)`)
      );
      expect(classify((d) => { d.messages[holder][field] = pin(entityId, `${prefix}2`); })).toEqual(
        minor(`Message "${holderKey}" ${label} pin moved from v1.0 to v1.1`)
      );
    });
  });

  it("MAJOR when a trait is removed from a message, MINOR when one is added", () => {
    expect(classify((d) => { d.messages[0].traitKeys = ["Envelope"]; })).toEqual(major('Message "OrderCreated" trait "CloudEvents" removed'));
    expect(classify((d) => { d.messages[1].traitKeys = ["CloudEvents"]; })).toEqual(minor('Message "OrderCancelled" trait "CloudEvents" added'));
  });

  it.each<[string, Mut, string]>([
    ["contentType", (d) => { d.messages[0].contentType = "application/json"; }, 'Message "OrderCreated" contentType changed from "avro/binary" to "application/json"'],
    ["contentType (removed)", (d) => { delete d.messages[0].contentType; }, 'Message "OrderCreated" contentType changed from "avro/binary" to "(default)"'],
    ["contentType (added)", (d) => { d.messages[1].contentType = "application/json"; }, 'Message "OrderCancelled" contentType changed from "(default)" to "application/json"'],
    ["correlationId", (d) => { d.messages[0].correlationId = { location: "$message.payload#/orderId" }; }, 'Message "OrderCreated" correlationId changed'],
    ["correlationId (removed)", (d) => { delete d.messages[0].correlationId; }, 'Message "OrderCreated" correlationId changed'],
    ["correlationId (added)", (d) => { d.messages[1].correlationId = { location: "$message.header#/id" }; }, 'Message "OrderCancelled" correlationId changed'],
  ])("MAJOR when message %s changes", (_name, mutate, reason) => {
    expect(classify(mutate)).toEqual(major(reason));
  });

  it("a correlationId with reordered members is not a change", () => {
    const withTwo: Mut = (d) => { d.messages[0].correlationId = { location: "$message.header#/id", description: "x" }; };
    const reordered: Mut = (d) => { d.messages[0].correlationId = { description: "x", location: "$message.header#/id" }; };
    expect(classify(reordered, { prev: withTwo })).toEqual(minor());
  });

  it("MINOR for message documentation, examples and bindings, naming the message", () => {
    expect(classify((d) => { d.messages[0].description = "An order was created"; })).toEqual(minor('Message "OrderCreated" documentation changed'));
    expect(classify((d) => { d.messages[0].summary = "s"; })).toEqual(minor('Message "OrderCreated" documentation changed'));
    expect(classify((d) => { d.messages[0].title = "t"; })).toEqual(minor('Message "OrderCreated" documentation changed'));
    expect(classify((d) => { d.messages[0].tags = [{ name: "orders" }]; })).toEqual(minor('Message "OrderCreated" documentation changed'));
    expect(classify((d) => { d.messages[0].externalDocs = { url: "https://example.com" }; })).toEqual(minor('Message "OrderCreated" documentation changed'));
    expect(classify((d) => { d.messages[0].examples = [{ name: "e", payload: { id: 1 } }]; })).toEqual(minor('Message "OrderCreated" examples changed'));
    expect(classify((d) => { d.messages[0].bindings = { kafka: { bindingVersion: "0.5.0" } }; })).toEqual(minor('Message "OrderCreated" bindings changed'));
  });
});

describe("classifyEventBump: traits", () => {
  it("MAJOR when a local trait's headers pin moves to a new entity major, MINOR for a same-major move", () => {
    expect(classify((d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" }, headers: pin("et", "t3") }; })).toEqual(
      major('Trait "Envelope": headers pin moved from Envelope v1.0 to v2.0 (new major)')
    );
    expect(classify((d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" }, headers: pin("et", "t2") }; })).toEqual(
      minor('Trait "Envelope": headers pin moved from v1.0 to v1.1')
    );
  });

  it("MAJOR when a local trait's headers entity is added, removed or replaced", () => {
    const without: Mut = (d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" } }; };
    expect(classify(without)).toEqual(major('Trait "Envelope": headers entity removed (was Envelope v1.0)'));
    expect(classify(undefined, { prev: without })).toEqual(major('Trait "Envelope": headers entity added (Envelope v1.0)'));
    expect(classify((d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" }, headers: pin("ex", "x1") }; })).toEqual(
      major('Trait "Envelope": headers now reference Invoice instead of Envelope')
    );
  });

  it("MAJOR when a library trait's frozen headers pin moves to a new major (via libraryHeaders)", () => {
    const moved = classify(undefined, { nextSide: { libraryHeaders: { "lib-ce": libHeaders("lh3", 2, "2.0") } } });
    expect(moved).toEqual(major('Trait "CloudEvents": headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)'));
    const removed = classify(undefined, { nextSide: { libraryHeaders: { "lib-ce": null } } });
    expect(removed).toEqual(major('Trait "CloudEvents": headers entity removed (was CloudEventsHeaders v1.0)'));
    const added = classify(undefined, { prevSide: { libraryHeaders: { "lib-ce": null } } });
    expect(added).toEqual(major('Trait "CloudEvents": headers entity added (CloudEventsHeaders v1.0)'));
  });

  it("MINOR for a same-major library headers move, and no change for an unknown (absent) library entry", () => {
    expect(classify(undefined, { nextSide: { libraryHeaders: { "lib-ce": libHeaders("lh2", 1, "1.1") } } })).toEqual(
      minor('Trait "CloudEvents": headers pin moved from v1.0 to v1.1')
    );
    expect(classify(undefined, { nextSide: { libraryHeaders: {} } })).toEqual(minor());
    expect(classify(undefined, { prevSide: { libraryHeaders: {} } })).toEqual(minor());
  });

  it("swapping the library trait behind a key compares the old and the new headers pin", () => {
    const decision = classify(
      (d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce-2" }; },
      { nextSide: { libraryHeaders: { "lib-ce-2": { entityId: "elx", entityName: "OtherHeaders", entityVersionId: "lx1", major: 1, label: "1.0" } } } }
    );
    expect(decision).toEqual(major('Trait "CloudEvents": headers now reference OtherHeaders instead of CloudEventsHeaders', 'Trait "CloudEvents" changed'));
  });

  it("MINOR when a local trait's spec changes, naming the trait", () => {
    expect(classify((d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Changed" }, headers: pin("et", "t1") }; })).toEqual(
      minor('Trait "Envelope" changed')
    );
  });

  it("MINOR when a trait nothing in a message uses is removed", () => {
    expect(classify((d) => { d.operations[0].traitKeys = []; d.traits = d.traits.filter((t) => t.key !== "Audited"); })).toEqual(
      minor('Operation "publishOrderCreated" trait "Audited" removed', 'Trait "Audited" removed')
    );
  });
});

describe("classifyEventBump: defaultContentType, external refs and the document shell", () => {
  it("MAJOR when defaultContentType changes", () => {
    expect(classify((d) => { d.defaultContentType = "application/json"; })).toEqual(major('defaultContentType changed from "(none)" to "application/json"'));
    expect(classify((d) => { d.defaultContentType = "application/avro"; }, { prev: (d) => { d.defaultContentType = "application/json"; } })).toEqual(
      major('defaultContentType changed from "application/json" to "application/avro"')
    );
    expect(classify(undefined, { prev: (d) => { d.defaultContentType = "application/json"; } })).toEqual(
      major('defaultContentType changed from "application/json" to "(none)"')
    );
  });

  it("MAJOR when an external ref is removed", () => {
    expect(classify((d) => { d.externalRefs = []; })).toEqual(major('External reference "PaymentSettled" removed'));
  });

  it("MAJOR when the referenced major increases or drops, MINOR for a same-major move", () => {
    const to = (eventVersionId: string): Mut => (d) => { d.externalRefs[0].eventVersionId = eventVersionId; };
    expect(classify(to("ev-pay-3"))).toEqual(major('External reference "PaymentSettled" moved to a new major (v1 to v2)'));
    expect(classify(to("ev-pay-2"))).toEqual(minor('External reference "PaymentSettled" moved to another version of the same major (v1)'));
    expect(classify(undefined, { prev: to("ev-pay-3") })).toEqual(major('External reference "PaymentSettled" moved to an older major (v2 to v1)'));
  });

  it("MAJOR when an external ref now points at another item", () => {
    expect(classify((d) => { d.externalRefs[0].itemKey = "Refunded"; })).toEqual(
      major('External reference "PaymentSettled" now points at message "Refunded" instead of message "Settled"')
    );
    expect(classify((d) => { d.externalRefs[0].kind = "channel"; })).toEqual(
      major('External reference "PaymentSettled" now points at channel "Settled" instead of message "Settled"')
    );
  });

  it("MINOR when an external ref is added", () => {
    expect(classify((d) => { d.externalRefs.push({ key: "Shipped", eventVersionId: "ev-pay-1", kind: "message", itemKey: "Shipped" }); })).toEqual(
      minor('External reference "Shipped" added')
    );
  });

  it("MINOR for description, tags, examples, summary, bindings, server and info edits", () => {
    expect(classify((d) => { d.info.description = "Checkout events"; })).toEqual(minor("Info changed"));
    expect(classify((d) => { d.info.tags = [{ name: "checkout" }]; })).toEqual(minor("Info changed"));
    expect(classify((d) => { d.servers[0].host = "kafka-eu.internal:9092"; })).toEqual(minor('Server "kafka-prod" changed'));
    expect(classify((d) => { d.servers.push({ key: "kafka-dr", protocol: "kafka", host: "dr:9092" }); })).toEqual(minor('Server "kafka-dr" added'));
    expect(classify(undefined, { prev: (d) => { d.servers.push({ key: "kafka-dr", protocol: "kafka", host: "dr:9092" }); } })).toEqual(minor('Server "kafka-dr" removed'));
    expect(classify((d) => { d.components = { correlationIds: { orderId: { location: "$message.payload#/orderId" } } }; })).toEqual(minor("Components changed"));
  });
});

describe("classifyEventBump: additions", () => {
  it("MINOR for a brand-new channel, message, operation and trait", () => {
    const decision = classify((d) => {
      d.channels.push({ key: "audit", address: "payments.audit.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["AuditLogged"] });
      d.messages.push({ key: "AuditLogged", payload: pin("e1", "v1"), traitKeys: ["Tagged"] });
      d.traits.push({ key: "Tagged", kind: "MESSAGE", spec: { tags: [{ name: "audit" }] } });
      d.operations.push({ key: "emitAudit", action: "send", channelKey: "audit", messageKeys: ["AuditLogged"], traitKeys: [] });
    });
    expect(decision).toEqual(minor('Operation "emitAudit" added', 'Channel "audit" added', 'Message "AuditLogged" added', 'Trait "Tagged" added'));
  });
});

describe("classifyEventBump: a key rename is a removal plus an addition", () => {
  const renamed = (kind: KeyKind, from: string, to: string): Mut => (d) => {
    const result = renameKey(d, kind, from, to);
    if (!result.success) throw new Error(result.error.message);
    Object.assign(d, result.data);
  };

  it.each<[KeyKind, string, string, string, string]>([
    ["message", "OrderShipped", "OrderDispatched", 'Message "OrderShipped" removed', 'Message "OrderDispatched" added'],
    ["operation", "publishOrderCreated", "publishOrderPlaced", 'Operation "publishOrderCreated" removed', 'Operation "publishOrderPlaced" added'],
    ["channel", "refunds", "returns", 'Channel "refunds" removed', 'Channel "returns" added'],
    ["trait", "CloudEvents", "CE", 'Message "OrderCreated" trait "CloudEvents" removed', 'Message "OrderCreated" trait "CE" added'],
    ["externalRef", "PaymentSettled", "SettlementDone", 'External reference "PaymentSettled" removed', 'External reference "SettlementDone" added'],
  ])("MAJOR when a %s key is renamed (%s to %s)", (kind, from, to, removed, added) => {
    const decision = classify(renamed(kind, from, to));
    expect(decision.bump).toBe("MAJOR");
    expect(decision.reasons).toContain(removed);
    expect(decision.reasons).toContain(added);
    expect(decision.reasons.indexOf(removed)).toBeLessThan(decision.reasons.indexOf(added)); // MAJOR reasons first
  });
});

describe("classifyEventBump: missing facts fail closed, unchanged pins never do", () => {
  it("MAJOR when a changed pin's entity version has no facts", () => {
    expect(classify((d) => { d.messages[0].payload = pin("e1", "v-unknown"); })).toEqual(
      major('Message "OrderCreated" payload: entity version facts unavailable (treated as breaking)')
    );
    expect(classify((d) => { d.traits[1] = { key: "Envelope", kind: "MESSAGE", spec: { description: "Standard envelope" }, headers: pin("et", "t-unknown") }; })).toEqual(
      major('Trait "Envelope": headers entity version facts unavailable (treated as breaking)')
    );
  });

  it("no change is reported for a pin that is identical on both sides, even without facts", () => {
    const unknown: Mut = (d) => { d.messages[0].payload = pin("e1", "v-unknown"); };
    expect(classify(unknown, { prev: unknown })).toEqual(minor());
  });

  it("MAJOR when an external ref moves and a referenced major is unknown", () => {
    expect(classify((d) => { d.externalRefs[0].eventVersionId = "ev-unknown"; })).toEqual(
      major('External reference "PaymentSettled": referenced version major unavailable (treated as breaking)')
    );
    expect(classify(undefined, { nextSide: { externalMajors: {} }, prevSide: { externalMajors: {} } })).toEqual(minor());
  });
});
