// @vitest-environment jsdom
// tests/unit/features/events/builder/auto-key.test.ts
// Generated keys (round-2 R3): a new item starts with a placeholder key; once it has something to name it by, the key is renamed
// once (references follow); after that, or after a manual rename, it never changes on its own.
import { describe, expect, it } from "vitest";
import { autoRenameKey, isPlaceholderKey, leftForm, newKey } from "@/features/events/builder/auto-key";
import { renameKey } from "@/lib/events/document/keys";
import { emptyEventDocument, type DocChannel, type DocMessage, type EventDocument } from "@/lib/events/document/types";

const PIN = { entityId: "ent-1", entityVersionId: "ver-1" };

const channel = (key: string, extra: Partial<DocChannel> = {}): DocChannel => ({
  key, address: null, protocol: "kafka", serverKeys: [], format: "avro", messageKeys: [], ...extra,
});
const message = (key: string, extra: Partial<DocMessage> = {}): DocMessage => ({ key, payload: PIN, traitKeys: [], ...extra });

function doc(overrides: Partial<EventDocument> = {}): EventDocument {
  return { ...emptyEventDocument("Orders"), ...overrides };
}

describe("isPlaceholderKey", () => {
  it.each(["server", "server-2", "channel", "channel-17", "message", "operation", "operation-3", "trait", "trait-9"])("%s is a placeholder", (key) => {
    expect(isPlaceholderKey(key)).toBe(true);
  });
  it.each(["kafka-prod", "servers", "server-", "server-a", "my-server", "server-2-x", "Server", "reference", ""])("%s is not a placeholder", (key) => {
    expect(isPlaceholderKey(key)).toBe(false);
  });
});

describe("newKey", () => {
  it("starts from the kind itself and counts up while it is taken", () => {
    const d = doc({ servers: [{ key: "server", protocol: "kafka", host: "" }, { key: "server-2", protocol: "kafka", host: "" }] });
    expect(newKey(emptyEventDocument("x"), "server")).toBe("server");
    expect(newKey(d, "server")).toBe("server-3");
  });

  it("uses the namespace of the kind: channels count external channel references, messages count external message references", () => {
    const d = doc({
      channels: [channel("channel")],
      messages: [message("message"), message("message-2")],
      externalRefs: [
        { key: "channel-2", eventVersionId: "v1", kind: "channel", itemKey: "x" },
        { key: "message-3", eventVersionId: "v1", kind: "message", itemKey: "y" },
      ],
    });
    expect(newKey(d, "channel")).toBe("channel-3");
    expect(newKey(d, "message")).toBe("message-4");
  });

  it("keeps operations and traits in their own namespaces", () => {
    const d = doc({
      operations: [{ key: "operation", action: "send", channelKey: "c", messageKeys: [], traitKeys: [] }],
      traits: [{ key: "trait", kind: "MESSAGE", spec: {} }],
      servers: [{ key: "operation-2", protocol: "kafka", host: "h" }],
    });
    expect(newKey(d, "operation")).toBe("operation-2");
    expect(newKey(d, "trait")).toBe("trait-2");
    expect(newKey(d, "server")).toBe("server");
  });

  it("always matches the placeholder pattern, so autoRenameKey picks it up later", () => {
    expect(isPlaceholderKey(newKey(emptyEventDocument("x"), "operation"))).toBe(true);
    expect(isPlaceholderKey(newKey(doc({ servers: [{ key: "server", protocol: "kafka", host: "" }] }), "server"))).toBe(true);
  });
});

describe("autoRenameKey: servers", () => {
  const withServer = (extra: Partial<EventDocument> = {}) => doc({
    servers: [{ key: "server", protocol: "kafka", host: "broker.example.com:9092" }],
    channels: [channel("orders", { serverKeys: ["server"] })],
    ...extra,
  });

  it("renames a placeholder key from the host and rewrites the channel references", () => {
    const next = autoRenameKey(withServer(), "server", "server", { host: "broker.example.com:9092" });
    expect(next.servers[0].key).toBe("broker.example.com-9092");
    expect(next.channels[0].serverKeys).toEqual(["broker.example.com-9092"]);
  });

  it("prefers the title over the host", () => {
    const next = autoRenameKey(withServer(), "server", "server", { title: "Production Kafka", host: "broker.example.com:9092" });
    expect(next.servers[0].key).toBe("Production-Kafka");
    expect(next.channels[0].serverKeys).toEqual(["Production-Kafka"]);
  });

  it("does nothing while there is nothing to name the item by, and returns the same document", () => {
    const d = withServer();
    expect(autoRenameKey(d, "server", "server", { host: "" })).toBe(d);
    expect(autoRenameKey(d, "server", "server", { title: "   ", host: "" })).toBe(d);
    expect(autoRenameKey(d, "server", "server", { title: "***" })).toBe(d);
    expect(autoRenameKey(d, "server", "server", {})).toBe(d);
  });

  it("never renames a key that does not look like a placeholder", () => {
    const d = doc({ servers: [{ key: "kafka-prod", protocol: "kafka", host: "x:1" }] });
    expect(autoRenameKey(d, "server", "kafka-prod", { host: "other:2" })).toBe(d);
  });

  it("renames once: after the first auto-rename a later edit of the name does not rename again", () => {
    const first = autoRenameKey(withServer(), "server", "server", { host: "a.example.com:1" });
    expect(first.servers[0].key).toBe("a.example.com-1");
    const second = autoRenameKey(first, "server", "a.example.com-1", { host: "b.example.com:2" });
    expect(second).toBe(first);
    expect(second.servers[0].key).toBe("a.example.com-1");
  });

  it("never renames after a manual rename", () => {
    const manual = renameKey(withServer(), "server", "server", "my-kafka");
    expect(manual.success).toBe(true);
    if (!manual.success) return;
    const next = autoRenameKey(manual.data, "server", "my-kafka", { host: "broker.example.com:9092" });
    expect(next).toBe(manual.data);
    expect(next.servers[0].key).toBe("my-kafka");
  });

  it("gives two servers with the same host distinct keys", () => {
    let d = doc({
      servers: [
        { key: "server", protocol: "kafka", host: "broker.example.com:9092" },
        { key: "server-2", protocol: "kafka", host: "broker.example.com:9092" },
      ],
    });
    d = autoRenameKey(d, "server", "server", { host: "broker.example.com:9092" });
    d = autoRenameKey(d, "server", "server-2", { host: "broker.example.com:9092" });
    expect(d.servers.map((s) => s.key)).toEqual(["broker.example.com-9092", "broker.example.com-9092-2"]);
  });

  it("gives two servers with the same title distinct keys, whichever is named first", () => {
    let d = doc({
      servers: [{ key: "server", protocol: "kafka", host: "a:1" }, { key: "server-2", protocol: "kafka", host: "b:1" }],
    });
    d = autoRenameKey(d, "server", "server-2", { title: "Prod" });
    d = autoRenameKey(d, "server", "server", { title: "Prod" });
    expect(d.servers.map((s) => s.key)).toEqual(["Prod-2", "Prod"]);
  });

  it("does not count its own key as taken (the suggestion may equal a name the item already holds)", () => {
    const d = doc({ servers: [{ key: "server-2", protocol: "kafka", host: "h:1" }, { key: "other", protocol: "kafka", host: "o:1" }] });
    const next = autoRenameKey(d, "server", "server-2", { title: "other" });
    expect(next.servers.map((s) => s.key)).toEqual(["other-2", "other"]);
  });

  it("returns the document untouched when the key is not in the document", () => {
    const d = withServer();
    expect(autoRenameKey(d, "server", "server-9", { host: "x:1" })).toBe(d);
  });

  it("never mutates the document it is given", () => {
    const d = withServer();
    const before = JSON.stringify(d);
    autoRenameKey(d, "server", "server", { host: "x:1" });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("autoRenameKey: the other kinds", () => {
  it("channel: from the title, else the address; operations pointing at it follow", () => {
    const d = doc({
      channels: [channel("channel", { address: "orders.created" })],
      operations: [{ key: "op", action: "send", channelKey: "channel", messageKeys: [], traitKeys: [], reply: { channelKey: "channel" } }],
    });
    const byAddress = autoRenameKey(d, "channel", "channel", { address: "orders.created" });
    expect(byAddress.channels[0].key).toBe("orders.created");
    expect(byAddress.operations[0].channelKey).toBe("orders.created");
    expect(byAddress.operations[0].reply?.channelKey).toBe("orders.created");
    expect(autoRenameKey(d, "channel", "channel", { title: "Order events", address: "orders.created" }).channels[0].key).toBe("Order-events");
    expect(autoRenameKey(d, "channel", "channel", { address: null })).toBe(d);
  });

  it("channel: avoids the key of an external channel reference", () => {
    const d = doc({
      channels: [channel("channel")],
      externalRefs: [{ key: "orders", eventVersionId: "v1", kind: "channel", itemKey: "x" }],
    });
    expect(autoRenameKey(d, "channel", "channel", { address: "orders" }).channels[0].key).toBe("orders-2");
  });

  it("message: from the name, else the title; channels and operations allowing it follow", () => {
    const d = doc({
      channels: [channel("c", { messageKeys: ["message"] })],
      messages: [message("message")],
      operations: [{ key: "op", action: "send", channelKey: "c", messageKeys: ["message"], traitKeys: [], reply: { channelKey: "c", messageKeys: ["message"] } }],
    });
    const named = autoRenameKey(d, "message", "message", { name: "OrderCreated", title: "Order created" });
    expect(named.messages[0].key).toBe("OrderCreated");
    expect(named.channels[0].messageKeys).toEqual(["OrderCreated"]);
    expect(named.operations[0].messageKeys).toEqual(["OrderCreated"]);
    expect(named.operations[0].reply?.messageKeys).toEqual(["OrderCreated"]);
    expect(autoRenameKey(d, "message", "message", { title: "Order created" }).messages[0].key).toBe("Order-created");
    expect(autoRenameKey(d, "message", "message", {})).toBe(d);
  });

  it("operation: from the title, else `${action}-${channel}`", () => {
    const d = doc({
      channels: [channel("orders")],
      operations: [{ key: "operation", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] }],
    });
    expect(autoRenameKey(d, "operation", "operation", { title: "Place order", action: "send", channel: "orders" }).operations[0].key).toBe("Place-order");
    expect(autoRenameKey(d, "operation", "operation", { action: "send", channel: "orders" }).operations[0].key).toBe("send-orders");
    expect(autoRenameKey(d, "operation", "operation", { action: "receive", channel: "" })).toBe(d);
  });

  it("operation: two operations named from the same action and channel stay distinct", () => {
    let d = doc({
      channels: [channel("orders")],
      operations: [
        { key: "operation", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] },
        { key: "operation-2", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] },
      ],
    });
    d = autoRenameKey(d, "operation", "operation", { action: "send", channel: "orders" });
    d = autoRenameKey(d, "operation", "operation-2", { action: "send", channel: "orders" });
    expect(d.operations.map((o) => o.key)).toEqual(["send-orders", "send-orders-2"]);
  });

  it("trait: from the name, else the title; messages and operations using it follow", () => {
    const d = doc({
      traits: [{ key: "trait", kind: "MESSAGE", spec: {} }],
      messages: [message("m", { traitKeys: ["trait"] })],
      operations: [{ key: "op", action: "send", channelKey: "c", messageKeys: [], traitKeys: ["trait"] }],
    });
    const named = autoRenameKey(d, "trait", "trait", { name: "envelope" });
    expect(named.traits[0].key).toBe("envelope");
    expect(named.messages[0].traitKeys).toEqual(["envelope"]);
    expect(named.operations[0].traitKeys).toEqual(["envelope"]);
    expect(autoRenameKey(d, "trait", "trait", { title: "Standard envelope" }).traits[0].key).toBe("Standard-envelope");
  });

  it("an external reference has no placeholder and is never renamed", () => {
    const d = doc({ externalRefs: [{ key: "channel", eventVersionId: "v1", kind: "channel", itemKey: "x" }] });
    expect(autoRenameKey(d, "externalRef", "channel", { title: "Anything" })).toBe(d);
  });

  it("a title that slugs to a reserved name still gives a valid key", () => {
    const d = doc({ servers: [{ key: "server", protocol: "kafka", host: "" }] });
    const next = autoRenameKey(d, "server", "server", { title: "constructor" });
    expect(next.servers[0].key).toBe("constructor-1");
  });
});

describe("leftForm", () => {
  function setup() {
    const wrapper = document.createElement("div");
    const first = document.createElement("input");
    const second = document.createElement("input");
    const outside = document.createElement("button");
    wrapper.append(first, second);
    document.body.append(wrapper, outside);
    return { wrapper, first, second, outside };
  }

  it("is false while focus only moves between two fields of the form", () => {
    const { wrapper, second } = setup();
    expect(leftForm({ currentTarget: wrapper, relatedTarget: second })).toBe(false);
  });

  it("is true when focus goes to something outside the form", () => {
    const { wrapper, outside } = setup();
    expect(leftForm({ currentTarget: wrapper, relatedTarget: outside })).toBe(true);
  });

  it("is true when focus goes nowhere (a click on plain page area, or a button that takes no focus)", () => {
    const { wrapper } = setup();
    expect(leftForm({ currentTarget: wrapper, relatedTarget: null })).toBe(true);
  });
});
