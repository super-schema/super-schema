import { describe, it, expect } from "vitest";
import {
  buildEventSpecBumpSide, classifyEventSpecBump, classifyMessageBump, findUnresolvedMessageVersions, stableStringify,
  type BumpTraitHeadersPin, type EntityVersionFacts, type EventSpecBumpSide,
} from "@/lib/events/bump-rules";
import type { FrozenChannel, FrozenTrait, MessageResolvedSpec, ResolvedPin } from "@/lib/events/types";

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

// ── R78 (final review B-I1): channel profile / protocol / dialect, trait headers pins and the spec default content type ──
describe("R78: channel format profile, dialect and protocol", () => {
  const avro = { protocol: "kafka", format: "avro" as const };
  const withProfile = (profile: NonNullable<EventSpecBumpSide["channelProfiles"]>[string]) =>
    side([op("o", ["mv-1.3"])], { channelProfiles: { ch: profile } });
  const base = withProfile(avro);

  it("a format change (any pair) is MAJOR and says so", () => {
    expect(classifyEventSpecBump(base, withProfile({ protocol: "kafka", format: "json-schema", dialect: "draft-07" }))).toEqual({
      bump: "MAJOR",
      reasons: ["Channel orders: format avro → json-schema"],
    });
    expect(classifyEventSpecBump(base, withProfile({ protocol: "kafka", format: "protobuf" })).reasons).toEqual(["Channel orders: format avro → protobuf"]);
    expect(classifyEventSpecBump(withProfile({ protocol: "kafka", format: "protobuf" }), base).reasons).toEqual(["Channel orders: format protobuf → avro"]);
  });

  it("a JSON Schema dialect change is MAJOR; the dialect is irrelevant when the format itself changed", () => {
    const draft07 = withProfile({ protocol: "kafka", format: "json-schema", dialect: "draft-07" });
    const draft2020 = withProfile({ protocol: "kafka", format: "json-schema", dialect: "2020-12" });
    expect(classifyEventSpecBump(draft07, draft2020)).toEqual({ bump: "MAJOR", reasons: ["Channel orders: JSON Schema dialect draft-07 → 2020-12"] });
    expect(classifyEventSpecBump(draft2020, draft07).reasons).toEqual(["Channel orders: JSON Schema dialect 2020-12 → draft-07"]);
    expect(classifyEventSpecBump(draft07, base).reasons).toEqual(["Channel orders: format json-schema → avro"]);
  });

  it("a protocol change is MAJOR; format and protocol changing together report both", () => {
    expect(classifyEventSpecBump(base, withProfile({ protocol: "pulsar", format: "avro" }))).toEqual({
      bump: "MAJOR",
      reasons: ["Channel orders: protocol kafka → pulsar"],
    });
    expect(classifyEventSpecBump(base, withProfile({ protocol: "pulsar", format: "protobuf" })).reasons).toEqual([
      "Channel orders: format avro → protobuf",
      "Channel orders: protocol kafka → pulsar",
    ]);
  });

  it("an unchanged profile is MINOR with no reasons", () => {
    expect(classifyEventSpecBump(base, withProfile({ ...avro }))).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("a channel address change keeps its own reason (still MAJOR) next to a profile change", () => {
    const next = side([op("o", ["mv-1.3"])], { channelAddresses: { ch: "payments.orders.v2" }, channelProfiles: { ch: { protocol: "kafka", format: "protobuf" } } });
    expect(classifyEventSpecBump(base, next).reasons).toEqual([
      'Channel orders address changed from "payments.orders.v1" to "payments.orders.v2"',
      "Channel orders: format avro → protobuf",
    ]);
  });

  it("a channel only on one side, or a side without profiles (a version stored before R78), is never a false MAJOR", () => {
    const profiled = side([op("o", ["mv-1.3"])], { channelProfiles: { other: { protocol: "kafka", format: "protobuf" } } });
    expect(classifyEventSpecBump(base, profiled)).toEqual({ bump: "MINOR", reasons: [] });
    const old = side([op("o", ["mv-1.3"])]); // no channelProfiles at all
    expect(classifyEventSpecBump(old, withProfile({ protocol: "kafka", format: "protobuf" }))).toEqual({ bump: "MINOR", reasons: [] });
    expect(classifyEventSpecBump(withProfile({ protocol: "kafka", format: "protobuf" }), old)).toEqual({ bump: "MINOR", reasons: [] });
  });

  it("a JSON Schema channel whose frozen dialect is unknown is not compared on the dialect", () => {
    expect(
      classifyEventSpecBump(withProfile({ protocol: "kafka", format: "json-schema" }), withProfile({ protocol: "kafka", format: "json-schema", dialect: "2020-12" }))
    ).toEqual({ bump: "MINOR", reasons: [] });
  });
});

describe("R78: trait headers pins", () => {
  const pinOf = (label: string, over: Partial<BumpTraitHeadersPin> = {}): BumpTraitHeadersPin => ({
    entityId: "e-ce", entityName: "CloudEventsHeaders", entityVersionId: `ce@${label}`, major: Number(label.split(".")[0]), label, ...over,
  });
  const withHeaders = (pin: BumpTraitHeadersPin | null) =>
    side([op("o", ["mv-1.3"])], { traitHeaders: { "t-ce": pin }, traitNames: { "t-ce": "CloudEvents" } });

  it("a pin moving to a different major is MAJOR (up or down) and names the trait and the versions", () => {
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(pinOf("2.0")))).toEqual({
      bump: "MAJOR",
      reasons: ["Trait CloudEvents: headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)"],
    });
    expect(classifyEventSpecBump(withHeaders(pinOf("2.0")), withHeaders(pinOf("1.0"))).bump).toBe("MAJOR");
  });

  it("a pin moving within the same major is only MINOR (with a reason)", () => {
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(pinOf("1.2")))).toEqual({
      bump: "MINOR",
      reasons: ["Trait CloudEvents: headers pin moved from v1.0 to v1.2"],
    });
  });

  it("a headers entity added to or removed from a trait is MAJOR", () => {
    expect(classifyEventSpecBump(withHeaders(null), withHeaders(pinOf("1.0")))).toEqual({
      bump: "MAJOR",
      reasons: ["Trait CloudEvents: headers entity added (CloudEventsHeaders v1.0)"],
    });
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(null))).toEqual({
      bump: "MAJOR",
      reasons: ["Trait CloudEvents: headers entity removed (was CloudEventsHeaders v1.0)"],
    });
  });

  it("pinning a different entity is MAJOR even at the same major", () => {
    const other = pinOf("1.0", { entityId: "e-other", entityName: "OtherHeaders", entityVersionId: "o@1.0" });
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(other)).reasons).toEqual([
      "Trait CloudEvents: headers now reference OtherHeaders instead of CloudEventsHeaders",
    ]);
  });

  it("an unchanged pin is MINOR with no reasons; an unknown major (version row gone / unpinned) is never a MAJOR on its own", () => {
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(pinOf("1.0")))).toEqual({ bump: "MINOR", reasons: [] });
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), withHeaders(pinOf("2.0", { major: null, label: null })))).toEqual({
      bump: "MINOR",
      reasons: ["Trait CloudEvents: headers pin moved from v1.0 to (unpinned)"],
    });
  });

  it("traits that are unknown on either side (old stored versions) or not shared are not compared", () => {
    expect(classifyEventSpecBump(side([op("o", ["mv-1.3"])]), withHeaders(pinOf("1.0")))).toEqual({ bump: "MINOR", reasons: [] });
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), side([op("o", ["mv-1.3"])]))).toEqual({ bump: "MINOR", reasons: [] });
    const other = side([op("o", ["mv-1.3"])], { traitHeaders: { "t-other": pinOf("5.0") } });
    expect(classifyEventSpecBump(withHeaders(pinOf("1.0")), other)).toEqual({ bump: "MINOR", reasons: [] });
  });
});

describe("R78: the spec defaultContentType aligns with the Message contentType rule", () => {
  const withDefault = (defaultContentType?: string, info: { title: string } = { title: "checkout-service" }): EventSpecBumpSide => {
    const s = side([op("o", ["mv-1.3"])]);
    return { ...s, document: { ...s.document, info, ...(defaultContentType !== undefined ? { defaultContentType } : {}) } };
  };

  it("a change, an addition or a removal is MAJOR, with ONE reason (not also the generic shell note)", () => {
    expect(classifyEventSpecBump(withDefault("application/json"), withDefault("avro/binary"))).toEqual({
      bump: "MAJOR",
      reasons: ['defaultContentType changed from "application/json" to "avro/binary"'],
    });
    expect(classifyEventSpecBump(withDefault(), withDefault("application/json")).reasons).toEqual(['defaultContentType changed from "(none)" to "application/json"']);
    expect(classifyEventSpecBump(withDefault("application/json"), withDefault()).bump).toBe("MAJOR");
  });

  it("an unchanged default is MINOR / no reasons, and info changes stay a MINOR note", () => {
    expect(classifyEventSpecBump(withDefault("application/json"), withDefault("application/json"))).toEqual({ bump: "MINOR", reasons: [] });
    expect(classifyEventSpecBump(withDefault("application/json"), withDefault("application/json", { title: "other" }))).toEqual({
      bump: "MINOR",
      reasons: ["Info, servers or components changed"],
    });
  });
});

describe("buildEventSpecBumpSide (R78): old stored shapes never produce a false MAJOR", () => {
  const document = { info: { title: "x" }, servers: [], operations: [] };
  const channel = (over: Record<string, unknown> = {}): FrozenChannel =>
    ({ id: "ch", name: "orders", productSlug: "p", address: "a", protocol: "kafka", profile: { format: "avro" }, ...over }) as FrozenChannel;
  const trait = (over: Record<string, unknown> = {}): FrozenTrait =>
    ({ id: "t", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: {}, headersEntityId: "e-ce", headersEntityVersionId: "v-ce-1", ...over }) as FrozenTrait;
  const entityVersions = new Map<string, EntityVersionFacts>([
    ["v-ce-1", { entityId: "e-ce", entityName: "CloudEventsHeaders", major: 1, label: "1.0" }],
    ["v-ce-2", { entityId: "e-ce", entityName: "CloudEventsHeaders", major: 2, label: "2.0" }],
  ]);
  const build = (channels: FrozenChannel[], traits: FrozenTrait[]) =>
    buildEventSpecBumpSide({ document, channels, traits, versionIds: [], messageVersions: {}, entityVersions });

  it("records profile, protocol, dialect and the headers pin identity (entity, version id, major, label)", () => {
    const built = build([channel({ profile: { format: "json-schema", dialect: "2020-12" } })], [trait()]);
    expect(built.channelProfiles).toEqual({ ch: { protocol: "kafka", format: "json-schema", dialect: "2020-12" } });
    expect(built.traitHeaders).toEqual({ t: { entityId: "e-ce", entityName: "CloudEventsHeaders", entityVersionId: "v-ce-1", major: 1, label: "1.0" } });
    expect(built.channelAddresses).toEqual({ ch: "a" });
    expect(built.traitNames).toEqual({ t: "CloudEvents" });
  });

  it("a trait without a headers entity is `null`; an unresolvable pinned version has an unknown major", () => {
    expect(build([], [trait({ headersEntityId: null, headersEntityVersionId: null })]).traitHeaders).toEqual({ t: null });
    expect(build([], [trait({ headersEntityVersionId: "v-gone" })]).traitHeaders).toEqual({
      t: { entityId: "e-ce", entityVersionId: "v-gone", major: null, label: null },
    });
  });

  it("an old-shape frozen fixture (no profile / protocol on the channel, no headers fields on the trait) is left out as unknown", () => {
    const oldChannel = { id: "ch", name: "orders", address: "a" } as unknown as FrozenChannel;
    const oldTrait = { id: "t", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: {} } as unknown as FrozenTrait;
    const built = build([oldChannel], [oldTrait]);
    expect(built.channelProfiles).toEqual({});
    expect(built.traitHeaders).toEqual({});
    // Against a live, fully described current side the old previous side classifies as unchanged: no false MAJOR.
    const current = build([channel({ profile: { format: "protobuf" }, protocol: "pulsar" })], [trait({ headersEntityVersionId: "v-ce-2" })]);
    expect(classifyEventSpecBump(built, current)).toEqual({ bump: "MINOR", reasons: [] });
    // The same change against a fully described previous side IS the MAJOR the rules promise.
    const previous = build([channel()], [trait()]);
    expect(classifyEventSpecBump(previous, current)).toEqual({
      bump: "MAJOR",
      reasons: [
        "Channel orders: format avro → protobuf",
        "Channel orders: protocol kafka → pulsar",
        "Trait CloudEvents: headers pin moved from CloudEventsHeaders v1.0 to v2.0 (new major)",
      ],
    });
  });
});
