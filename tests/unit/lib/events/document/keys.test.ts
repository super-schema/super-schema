import { describe, expect, it } from "vitest";
import { renameKey, slugKey, uniqueKey } from "@/lib/events/document/keys";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e", entityVersionId: "v" };
function doc(): EventDocument {
  return {
    ...emptyEventDocument("t"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "h:9092" }],
    channels: [
      { key: "orders", address: "o", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] },
      { key: "refunds", address: "r", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated"] },
    ],
    messages: [{ key: "OrderCreated", payload: pin, traitKeys: ["Envelope"] }],
    traits: [{ key: "Envelope", kind: "MESSAGE", spec: {} }, { key: "Audited", kind: "OPERATION", spec: {} }],
    operations: [{ key: "pub", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: ["Audited"], reply: { channelKey: "refunds", messageKeys: ["OrderCreated"] } }],
  };
}

describe("slugKey / uniqueKey", () => {
  it("slugs titles into valid keys", () => {
    expect(slugKey("Order Created!")).toBe("Order-Created");
    expect(slugKey("  a//b  ")).toBe("a-b");
    expect(slugKey("")).toBe("item");
    expect(slugKey("x".repeat(100))).toHaveLength(64);
    expect(slugKey("naïve café")).toBe("na-ve-caf");
  });
  it("appends a numeric suffix until the key is free", () => {
    expect(uniqueKey("orders", ["orders", "orders-2"])).toBe("orders-3");
    expect(uniqueKey("fresh", ["orders"])).toBe("fresh");
    expect(uniqueKey("x".repeat(64), ["x".repeat(64)])).toHaveLength(64);
  });
});

describe("renameKey", () => {
  it("rewrites every reference to a renamed channel", () => {
    const r = renameKey(doc(), "channel", "orders", "orders-v2");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.channels[0].key).toBe("orders-v2");
    expect(r.data.operations[0].channelKey).toBe("orders-v2");
    expect(r.data.operations[0].reply?.channelKey).toBe("refunds");
    expect(parseEventDocument(r.data).success).toBe(true);
  });
  it("rewrites a renamed reply channel", () => {
    const r = renameKey(doc(), "channel", "refunds", "returns");
    expect(r.success && r.data.operations[0].reply?.channelKey).toBe("returns");
  });
  it("rewrites message references in channels, operations and replies", () => {
    const r = renameKey(doc(), "message", "OrderCreated", "OrderPlaced");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.channels.every((c) => c.messageKeys[0] === "OrderPlaced")).toBe(true);
    expect(r.data.operations[0].messageKeys).toEqual(["OrderPlaced"]);
    expect(r.data.operations[0].reply?.messageKeys).toEqual(["OrderPlaced"]);
    expect(parseEventDocument(r.data).success).toBe(true);
  });
  it("rewrites server and trait references", () => {
    const s = renameKey(doc(), "server", "kafka-prod", "kafka-eu");
    expect(s.success && s.data.channels[0].serverKeys).toEqual(["kafka-eu"]);
    const t = renameKey(doc(), "trait", "Envelope", "CloudEvents");
    expect(t.success && t.data.messages[0].traitKeys).toEqual(["CloudEvents"]);
    const o = renameKey(doc(), "trait", "Audited", "Tracked");
    expect(o.success && o.data.operations[0].traitKeys).toEqual(["Tracked"]);
  });
  it("renames an operation (nothing references it)", () => {
    const r = renameKey(doc(), "operation", "pub", "publish");
    expect(r.success && r.data.operations[0].key).toBe("publish");
  });
  it("renames an external ref and the keys that point at it", () => {
    const d = doc();
    d.externalRefs = [{ key: "ext", eventVersionId: "ev", kind: "channel", itemKey: "c" }];
    d.operations.push({ key: "recv", action: "receive", channelKey: "ext", messageKeys: [], traitKeys: [] });
    const r = renameKey(d, "externalRef", "ext", "upstream");
    expect(r.success && r.data.operations[1].channelKey).toBe("upstream");
  });
  it("refuses invalid, taken or unknown keys and never mutates the input", () => {
    const d = doc();
    const before = JSON.stringify(d);
    expect(renameKey(d, "channel", "orders", "a b").success).toBe(false);
    expect(renameKey(d, "channel", "orders", "refunds").success).toBe(false); // taken in the channel-ish namespace
    expect(renameKey(d, "channel", "ghost", "x").success).toBe(false);
    expect(renameKey(d, "trait", "Envelope", "Audited").success).toBe(false); // trait keys unique across kinds
    expect(JSON.stringify(d)).toBe(before);
  });
  it("is a no-op success when from === to", () => {
    expect(renameKey(doc(), "channel", "orders", "orders").success).toBe(true);
  });
});
