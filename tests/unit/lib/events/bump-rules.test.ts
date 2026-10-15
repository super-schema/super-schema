import { describe, it, expect } from "vitest";
import { classifyEventSpecBump, classifyMessageBump, findUnresolvedMessageVersions, stableStringify, type EventSpecBumpSide } from "@/lib/events/bump-rules";
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

describe("fix round 1: remaining message rules", () => {
  it("Message: a tags change is MINOR documentation", () => {
    expect(classifyMessageBump(msg(), msg({}, { tags: [{ name: "orders" }] }))).toEqual({ bump: "MINOR", reasons: ["Documentation changed"] });
  });

  it("Message: headers / key moving to a new major is MAJOR; correlationId removal is MAJOR; trait reordering is not a change", () => {
    const withHeaders = msg({ headers: pin("CloudEventsHeaders", "1.0") });
    expect(classifyMessageBump(withHeaders, msg({ headers: pin("CloudEventsHeaders", "2.0") }))).toEqual({
      bump: "MAJOR",
      reasons: ["Headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)"],
    });
    expect(classifyMessageBump(msg(), msg({ key: pin("OrderKey", "2.0") })).reasons).toEqual(["Kafka key pin moved from OrderKey v1.0 to v2.0 (new major)"]);
    const withCorrelation = msg({}, { correlationId: { location: "$message.header#/id" } });
    expect(classifyMessageBump(withCorrelation, msg())).toEqual({ bump: "MAJOR", reasons: ["correlationId changed"] });
    expect(classifyMessageBump(msg({}, { traitIds: ["a", "b"] }), msg({}, { traitIds: ["b", "a"] }))).toEqual({ bump: "MINOR", reasons: [] });
  });
});

describe("event spec message comparison is order independent (fix round 1)", () => {
  const ops = (ids: string[]) => side([op("o", ids)]);

  it("the same message list in any order is unchanged", () => {
    expect(classifyEventSpecBump(ops(["mv-1.3", "mv-c"]), ops(["mv-c", "mv-1.3"]))).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("[a] to [a, b] and [b, a] give the same decision (a minor version of the same message)", () => {
    const forward = classifyEventSpecBump(ops(["mv-1.3"]), ops(["mv-1.3", "mv-1.4"]));
    const reversed = classifyEventSpecBump(ops(["mv-1.3"]), ops(["mv-1.4", "mv-1.3"]));
    expect(forward).toEqual(reversed);
    expect(forward).toEqual({ bump: "MINOR", reasons: ['Message OrderCreated moved from v1.3 to v1.3, v1.4 in "o"'] });
  });

  it("a new major anywhere in the next list is MAJOR regardless of position", () => {
    const forward = classifyEventSpecBump(ops(["mv-1.3"]), ops(["mv-1.3", "mv-2.0"]));
    const reversed = classifyEventSpecBump(ops(["mv-1.3"]), ops(["mv-2.0", "mv-1.3"]));
    expect(forward).toEqual(reversed);
    expect(forward).toEqual({ bump: "MAJOR", reasons: ['Message OrderCreated moved from v1.3 to v1.3, v2.0 (new major) in "o"'] });
    // The same holds for the previous list.
    expect(classifyEventSpecBump(ops(["mv-2.0", "mv-1.3"]), ops(["mv-1.3", "mv-2.0"]))).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("dropping a whole major of a still-present message is MAJOR; dropping a minor of the same major is MINOR", () => {
    expect(classifyEventSpecBump(ops(["mv-1.3", "mv-2.0"]), ops(["mv-2.0"]))).toEqual({
      bump: "MAJOR",
      reasons: ['Message OrderCreated moved from v1.3, v2.0 to v2.0 (major version dropped) in "o"'],
    });
    expect(classifyEventSpecBump(ops(["mv-1.3", "mv-1.4"]), ops(["mv-1.4"]))).toEqual({
      bump: "MINOR",
      reasons: ['Message OrderCreated moved from v1.3, v1.4 to v1.4 in "o"'],
    });
  });

  it("message removed entirely is MAJOR; a message added to an operation is MINOR", () => {
    expect(classifyEventSpecBump(ops(["mv-1.3", "mv-c"]), ops(["mv-c"]))).toEqual({
      bump: "MAJOR",
      reasons: ['Message OrderCreated removed from operation "o"'],
    });
    expect(classifyEventSpecBump(ops(["mv-1.3"]), ops(["mv-1.3", "mv-c"]))).toEqual({
      bump: "MINOR",
      reasons: ['Message OrderCancelled added to "o"'],
    });
  });

  it("reply message moves follow the same rules", () => {
    const withReply = (ids: string[]) => side([op("rpc", ["mv-c"], { reply: { channelId: "ch", messageVersionIds: ids } })]);
    expect(classifyEventSpecBump(withReply(["mv-1.3"]), withReply(["mv-1.4"]))).toEqual({
      bump: "MINOR",
      reasons: ['Message OrderCreated moved from v1.3 to v1.4 in "rpc reply"'],
    });
    expect(classifyEventSpecBump(withReply(["mv-1.3"]), withReply(["mv-2.0"])).bump).toBe("MAJOR");
    expect(classifyEventSpecBump(withReply(["mv-1.3"]), withReply([])).reasons).toEqual(['Message OrderCreated removed from operation "rpc reply"']);
  });
});

describe("unresolved message versions fail closed (fix round 1)", () => {
  const ops = (ids: string[], reply?: string[]) => side([op("o", ids, reply ? { reply: { channelId: "ch", messageVersionIds: reply } } : {})]);

  it("a previous-side id missing from messageVersions makes the bump MAJOR instead of being skipped", () => {
    expect(classifyEventSpecBump(ops(["mv-1.3", "gone"]), ops(["mv-1.3"]))).toEqual({
      bump: "MAJOR",
      reasons: ['Previous version of "o" references unknown message version "gone" (treated as breaking)'],
    });
    expect(classifyEventSpecBump(ops(["mv-1.3"], ["gone-reply"]), ops(["mv-1.3"], ["gone-reply"])).reasons).toEqual([
      'Previous version of "o reply" references unknown message version "gone-reply" (treated as breaking)',
    ]);
  });

  it("inherited object keys are not mistaken for known versions", () => {
    expect(classifyEventSpecBump(ops(["constructor"]), ops(["constructor"])).bump).toBe("MAJOR");
  });

  it("draft Message ids on the current side are neither removed nor added", () => {
    const prev = ops(["mv-1.3", "mv-c"]);
    const next = ops(["m1", "mv-c"]); // "m1" = the draft Message id (D4)
    expect(classifyEventSpecBump(prev, next, { draftMessageIds: ["m1"] })).toEqual({ bump: "MINOR", reasons: [] });
    // Without knowing it is a draft the same input is a (fail-closed) removal.
    expect(classifyEventSpecBump(prev, next).reasons).toEqual(['Message OrderCreated removed from operation "o"']);
    // Reply ids too.
    expect(classifyEventSpecBump(ops(["mv-c"], ["mv-1.3"]), ops(["mv-c"], ["m1"]), { draftMessageIds: ["m1"] })).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("findUnresolvedMessageVersions lists previous unknowns, and current unknowns that are not drafts, with pointers (replies too)", () => {
    const prev = ops(["mv-1.3", "gone"], ["gone-reply"]);
    const next = ops(["m1", "dangling"], ["mv-c", "dangling-reply"]);
    expect(findUnresolvedMessageVersions(prev, next, ["m1"])).toEqual([
      { side: "previous", operation: "o", id: "gone", pointer: "/operations/0/messageVersionIds/1" },
      { side: "previous", operation: "o reply", id: "gone-reply", pointer: "/operations/0/reply/messageVersionIds/0" },
      { side: "current", operation: "o", id: "dangling", pointer: "/operations/0/messageVersionIds/1" },
      { side: "current", operation: "o reply", id: "dangling-reply", pointer: "/operations/0/reply/messageVersionIds/1" },
    ]);
    expect(findUnresolvedMessageVersions(ops(["mv-1.3", "mv-c"]), ops(["mv-1.4", "mv-c"]))).toEqual([]);
    expect(findUnresolvedMessageVersions(null, ops(["dangling"]))).toEqual([
      { side: "current", operation: "o", id: "dangling", pointer: "/operations/0/messageVersionIds/0" },
    ]);
  });
});

describe("operation traits (fix round 1)", () => {
  const withTraits = (traitIds: string[], over: Partial<EventSpecBumpSide> = {}) => side([op("o", ["mv-1.3"], { traitIds })], over);

  it("removing an operation trait is MINOR with an explicit reason, naming it when known", () => {
    expect(classifyEventSpecBump(withTraits(["t1", "t2"], { traitNames: { t1: "Retry" } }), withTraits(["t2"], { traitNames: { t1: "Retry" } }))).toEqual({
      bump: "MINOR",
      reasons: ['Operation "o" trait Retry removed'],
    });
    expect(classifyEventSpecBump(withTraits(["t1"]), withTraits([])).reasons).toEqual(['Operation "o" trait t1 removed']);
  });

  it("adding an operation trait is MINOR and explicit; reordering is ignored", () => {
    expect(classifyEventSpecBump(withTraits(["t1"]), withTraits(["t1", "t2"]))).toEqual({ bump: "MINOR", reasons: ['Operation "o" trait t2 added'] });
    expect(classifyEventSpecBump(withTraits(["t1", "t2"]), withTraits(["t2", "t1"]))).toEqual({ bump: "MINOR", reasons: [] });
  });
});
