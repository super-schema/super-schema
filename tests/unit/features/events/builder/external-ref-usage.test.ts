import { describe, expect, it } from "vitest";
import { externalRefUsage, withoutChannel, withoutExternalRef } from "@/features/events/builder/sections/graph-parts";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e1", entityVersionId: "v1" };

/**
 * Local: channel `orders` (allows OrderCreated and the external message `ext-msg`), message OrderCreated.
 * Operations: `a` receives ext-msg on orders, `b` sends on the external channel `ext-chan` with a reply on it, `c` replies on ext-chan only.
 */
function doc(): EventDocument {
  return {
    ...emptyEventDocument("billing"),
    channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: [], messageKeys: ["OrderCreated", "ext-msg"] }],
    messages: [{ key: "OrderCreated", payload: pin, traitKeys: [] }],
    externalRefs: [
      { key: "ext-msg", eventVersionId: "vv1", kind: "message", itemKey: "OrderPlaced" },
      { key: "ext-chan", eventVersionId: "vv1", kind: "channel", itemKey: "billing" },
    ],
    operations: [
      { key: "a", action: "receive", channelKey: "orders", messageKeys: ["ext-msg"], traitKeys: [] },
      { key: "b", action: "send", channelKey: "ext-chan", messageKeys: ["OrderCreated"], traitKeys: [], reply: { channelKey: "ext-chan", messageKeys: ["ext-msg"] } },
      { key: "c", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [], reply: { channelKey: "ext-chan", messageKeys: [] } },
    ],
  };
}

describe("externalRefUsage", () => {
  it("a message reference is used by the channels that allow it and by the operations that carry it, own or in a reply", () => {
    const usage = externalRefUsage(doc(), { key: "ext-msg", kind: "message" });
    expect(usage.channels.map((c) => c.key)).toEqual(["orders"]);
    expect(usage.operations.map((o) => o.key)).toEqual(["a", "b"]);
  });

  it("a channel reference is used by the operations on it and by the ones that reply on it; no channel uses a channel", () => {
    const usage = externalRefUsage(doc(), { key: "ext-chan", kind: "channel" });
    expect(usage.channels).toEqual([]);
    expect(usage.operations.map((o) => o.key)).toEqual(["b", "c"]);
  });

  it("a reference nothing names is not used", () => {
    expect(externalRefUsage(doc(), { key: "other", kind: "message" })).toEqual({ channels: [], operations: [] });
  });

  it("does not take a message for a channel of the same key", () => {
    const d = doc();
    d.operations.push({ key: "d", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] });
    expect(externalRefUsage(d, { key: "orders", kind: "message" }).operations).toEqual([]);
    expect(externalRefUsage(d, { key: "orders", kind: "channel" }).operations.map((o) => o.key)).toEqual(["a", "c", "d"]);
  });
});

describe("withoutChannel", () => {
  it("deletes the operations on the channel and drops the reply of an operation that answers on it", () => {
    const next = withoutChannel(doc(), "ext-chan");
    expect(next.operations.map((o) => o.key)).toEqual(["a", "c"]);
    expect(next.operations[1].reply).toBeUndefined();
  });

  it("keeps the identity of operations it does not touch", () => {
    const before = doc();
    expect(withoutChannel(before, "ext-chan").operations[0]).toBe(before.operations[0]);
  });
});

describe("withoutExternalRef", () => {
  it("removes a message reference and takes it out of the channels and of the operations (own and reply) that used it", () => {
    const next = withoutExternalRef(doc(), "ext-msg");
    expect(next.externalRefs.map((r) => r.key)).toEqual(["ext-chan"]);
    expect(next.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(next.operations.map((o) => o.messageKeys)).toEqual([[], ["OrderCreated"], ["OrderCreated"]]);
    expect(next.operations[1].reply).toEqual({ channelKey: "ext-chan", messageKeys: [] });
  });

  it("removes a channel reference with the operations on it", () => {
    const next = withoutExternalRef(doc(), "ext-chan");
    expect(next.externalRefs.map((r) => r.key)).toEqual(["ext-msg"]);
    expect(next.operations.map((o) => o.key)).toEqual(["a", "c"]);
    expect(next.operations[1].reply).toBeUndefined();
  });

  it("does not touch the uses when a local item still defines the key", () => {
    const d = doc();
    d.messages.push({ key: "ext-msg", payload: pin, traitKeys: [] });
    const next = withoutExternalRef(d, "ext-msg");
    expect(next.externalRefs.map((r) => r.key)).toEqual(["ext-chan"]);
    expect(next.channels[0].messageKeys).toEqual(["OrderCreated", "ext-msg"]);
    expect(next.operations[0].messageKeys).toEqual(["ext-msg"]);
  });

  it("returns the document itself for a key that is not a reference", () => {
    const d = doc();
    expect(withoutExternalRef(d, "OrderCreated")).toBe(d);
  });

  it("leaves a valid document valid", async () => {
    const { parseEventDocument } = await import("@/lib/events/document/parse");
    expect(parseEventDocument(doc()).success).toBe(true);
    expect(parseEventDocument(withoutExternalRef(doc(), "ext-msg")).success).toBe(true);
    expect(parseEventDocument(withoutExternalRef(doc(), "ext-chan")).success).toBe(true);
  });
});
