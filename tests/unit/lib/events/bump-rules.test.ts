import { describe, it, expect } from "vitest";
import { classifyEventSpecBump, classifyMessageBump, stableStringify, type EventSpecBumpSide } from "@/lib/events/bump-rules";
import type { MessageResolvedSpec, ResolvedPin } from "@/lib/events/types";

const pin = (entityName: string, label: string, entityId = `e-${entityName}`): ResolvedPin => ({
  entityId, entityName, entityVersionId: `${entityName}@${label}`, label, major: Number(label.split(".")[0]),
});
const msg = (over: Partial<MessageResolvedSpec> = {}, spec: Partial<MessageResolvedSpec["spec"]> = {}): MessageResolvedSpec => ({
  name: "OrderCreated",
  spec: { contentType: "avro/binary", traitIds: ["t-ce"], ...spec },
  payload: pin("Order", "2.1"),
  headers: null,
  key: pin("OrderKey", "1.0"),
  ...over,
});

describe("classifyMessageBump (spec §6.1)", () => {
  it("MINOR for a minor entity bump, docs, examples, tags", () => {
    expect(classifyMessageBump(msg(), msg({ payload: pin("Order", "2.2") }, { description: "d", examples: [{ payload: {} }] }))).toEqual({
      bump: "MINOR",
      reasons: ["Payload pin moved from v2.1 to v2.2", "Documentation changed", "Examples changed"],
    });
    expect(classifyMessageBump(msg(), msg())).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("MAJOR when a pin moves to a new major, switches entity or a role is removed; adding a role is MINOR (D6)", () => {
    expect(classifyMessageBump(msg(), msg({ payload: pin("Order", "3.0") })).bump).toBe("MAJOR");
    expect(classifyMessageBump(msg(), msg({ payload: pin("Invoice", "1.0") })).reasons).toEqual(["Payload now references Invoice instead of Order"]);
    expect(classifyMessageBump(msg(), msg({ key: null }))).toEqual({ bump: "MAJOR", reasons: ["Kafka key removed (was OrderKey v1.0)"] });
    expect(classifyMessageBump(msg(), msg({ headers: pin("CloudEventsHeaders", "1.0") }))).toEqual({ bump: "MINOR", reasons: ["Headers added: CloudEventsHeaders v1.0"] });
  });

  it("MAJOR when a trait is removed or contentType / correlationId changes", () => {
    expect(classifyMessageBump(msg(), msg({}, { traitIds: [] }), { "t-ce": "CloudEvents" })).toEqual({ bump: "MAJOR", reasons: ["Trait CloudEvents removed"] });
    expect(classifyMessageBump(msg(), msg({}, { contentType: "application/json" })).reasons).toEqual(['contentType changed from "avro/binary" to "application/json"']);
    expect(classifyMessageBump(msg(), msg({}, { correlationId: { location: "$message.header#/id" } })).bump).toBe("MAJOR");
    expect(classifyMessageBump(msg(), msg({}, { traitIds: ["t-ce", "t-x"] })).bump).toBe("MINOR");
  });

  it("stableStringify ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [2] } })).toBe(stableStringify({ a: { c: [2] }, b: 1 }));
  });
});

const side = (operations: EventSpecBumpSide["document"]["operations"], over: Partial<EventSpecBumpSide> = {}): EventSpecBumpSide => ({
  document: { info: { title: "checkout-service" }, servers: [{ key: "kafka-prod", protocol: "kafka", host: "k:9092" }], operations },
  channelAddresses: { ch: "payments.orders.v1" },
  channelNames: { ch: "orders" },
  messageVersions: {
    "mv-1.3": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.3" },
    "mv-1.4": { messageId: "m1", messageName: "OrderCreated", major: 1, label: "1.4" },
    "mv-2.0": { messageId: "m1", messageName: "OrderCreated", major: 2, label: "2.0" },
    "mv-c": { messageId: "m2", messageName: "OrderCancelled", major: 1, label: "1.0" },
  },
  ...over,
});
const op = (key: string, messageVersionIds: string[], over: Record<string, unknown> = {}) => ({ key, action: "send" as const, channelId: "ch", messageVersionIds, traitIds: [], ...over });

describe("classifyEventSpecBump (spec §6.1)", () => {
  const base = side([op("publishOrderCreated", ["mv-1.3", "mv-c"])]);

  it("MINOR for added operations / messages, minor message moves, servers and info", () => {
    const next = side([op("publishOrderCreated", ["mv-1.4", "mv-c"]), op("publishRefund", ["mv-c"])], {
      document: { info: { title: "checkout-service", description: "x" }, servers: [], operations: [op("publishOrderCreated", ["mv-1.4", "mv-c"]), op("publishRefund", ["mv-c"])] },
    });
    expect(classifyEventSpecBump(base, next)).toEqual({
      bump: "MINOR",
      reasons: [
        'Message OrderCreated moved from v1.3 to v1.4 in "publishOrderCreated"',
        'Operation "publishRefund" added',
        "Info, servers or components changed",
      ],
    });
  });

  it("MAJOR for removed operations, removed messages, new-major messages, address changes, action / channel changes", () => {
    expect(classifyEventSpecBump(base, side([])).reasons).toEqual(['Operation "publishOrderCreated" removed']);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3"])])).reasons).toEqual([
      'Message OrderCancelled removed from operation "publishOrderCreated"',
    ]);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-2.0", "mv-c"])])).reasons).toEqual([
      'Message OrderCreated moved from v1.3 to v2.0 (new major) in "publishOrderCreated"',
    ]);
    expect(classifyEventSpecBump(base, side(base.document.operations, { channelAddresses: { ch: "payments.orders.v2" } })).reasons).toEqual([
      'Channel orders address changed from "payments.orders.v1" to "payments.orders.v2"',
    ]);
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3", "mv-c"], { action: "receive" })])).bump).toBe("MAJOR");
    expect(classifyEventSpecBump(base, side([op("publishOrderCreated", ["mv-1.3", "mv-c"], { channelId: "other" })])).bump).toBe("MAJOR");
  });
});

// Extra coverage beyond the plan's literal tests: the remaining D6 rules.
describe("D6 extras", () => {
  const rpc = () => side([op("rpc", ["mv-1.3"])]);

  it("Message: headers removed or a pin moving to a lower major is MAJOR; bindings changes are MINOR", () => {
    const withHeaders = msg({ headers: pin("CloudEventsHeaders", "1.0") });
    expect(classifyMessageBump(withHeaders, msg())).toEqual({ bump: "MAJOR", reasons: ["Headers removed (was CloudEventsHeaders v1.0)"] });
    expect(classifyMessageBump(msg(), msg({ payload: pin("Order", "1.5") })).bump).toBe("MAJOR");
    expect(classifyMessageBump(msg(), msg({}, { bindings: { kafka: { bindingVersion: "0.5.0" } } }))).toEqual({ bump: "MINOR", reasons: ["Bindings changed"] });
  });

  it("Event Spec: reply removed / moved is MAJOR; reply added and operation details are MINOR", () => {
    const withReply = side([op("rpc", ["mv-1.3"], { reply: { channelId: "ch", messageVersionIds: ["mv-c"] } })]);
    expect(classifyEventSpecBump(withReply, rpc())).toEqual({ bump: "MAJOR", reasons: ['Operation "rpc" reply removed'] });
    expect(
      classifyEventSpecBump(withReply, side([op("rpc", ["mv-1.3"], { reply: { channelId: "other", messageVersionIds: ["mv-c"] } })])).reasons
    ).toEqual(['Operation "rpc" reply moved to another channel']);
    expect(classifyEventSpecBump(rpc(), withReply)).toEqual({ bump: "MINOR", reasons: ['Operation "rpc" reply added'] });
    expect(classifyEventSpecBump(rpc(), side([op("rpc", ["mv-1.3"], { summary: "s" })]))).toEqual({ bump: "MINOR", reasons: ['Operation "rpc" details changed'] });
  });

  it("Event Spec: an unchanged side classifies as MINOR with no reasons", () => {
    expect(classifyEventSpecBump(rpc(), rpc())).toEqual({ bump: "MINOR", reasons: [] });
  });
});
