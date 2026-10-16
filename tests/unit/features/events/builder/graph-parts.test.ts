import { describe, expect, it } from "vitest";
import { aliasPointers, channelLabel, messageLabel, pointerSegment } from "@/features/events/builder/sections/graph-parts";

describe("channelLabel / messageLabel", () => {
  it("a channel is called by its title, else its address, else its key (blank texts do not count)", () => {
    expect(channelLabel({ key: "orders", title: "Order events", address: "orders.v1" })).toBe("Order events");
    expect(channelLabel({ key: "orders", title: "  ", address: "orders.v1" })).toBe("orders.v1");
    expect(channelLabel({ key: "orders", address: null })).toBe("orders");
    expect(channelLabel({ key: "orders", title: "", address: " " })).toBe("orders");
  });

  it("a message is called by its name, else its title, else its key", () => {
    expect(messageLabel({ key: "OrderCreated", name: "order.created", title: "Order created" })).toBe("order.created");
    expect(messageLabel({ key: "OrderCreated", name: " ", title: "Order created" })).toBe("Order created");
    expect(messageLabel({ key: "OrderCreated" })).toBe("OrderCreated");
  });
});

describe("pointerSegment", () => {
  it("escapes ~ and / the way RFC 6901 does, and nothing else", () => {
    expect(pointerSegment("tenantId")).toBe("tenantId");
    expect(pointerSegment("a/b")).toBe("a~1b");
    expect(pointerSegment("a~b")).toBe("a~0b");
    expect(pointerSegment("~/")).toBe("~0~1");
  });
});

describe("aliasPointers", () => {
  const problems = [
    { pointer: "/channels/0/serverKeys", message: "a" },
    { pointer: "/channels/0/serverKeys/1", message: "b" },
    { pointer: "/channels/0/messageKeys/0", message: "c" },
    { pointer: "/channels/0/address", message: "d" },
    { pointer: "/channels/1/serverKeys/0", message: "e" },
    { pointer: "/channels/0/serverKeysExtra", message: "f" },
    { pointer: "/channels/0", message: "g" },
    { pointer: "", message: "h" },
  ];

  it("renames the first segment below the prefix, keeping the rest of the pointer", () => {
    const out = aliasPointers(problems, "/channels/0", { serverKeys: "servers", messageKeys: "messages" });
    expect(out.map((p) => p.pointer)).toEqual([
      "/channels/0/servers", "/channels/0/servers/1", "/channels/0/messages/0", "/channels/0/address",
      "/channels/1/serverKeys/0", "/channels/0/serverKeysExtra", "/channels/0", "",
    ]);
  });

  it("keeps the messages, returns new objects only for renamed ones, and never mutates the input", () => {
    const before = JSON.stringify(problems);
    const out = aliasPointers(problems, "/channels/0", { serverKeys: "servers" });
    expect(out.map((p) => p.message)).toEqual(problems.map((p) => p.message));
    expect(out[3]).toBe(problems[3]);
    expect(out[0]).not.toBe(problems[0]);
    expect(JSON.stringify(problems)).toBe(before);
  });

  it("does nothing for an empty alias map, and treats Object.prototype names as plain names", () => {
    expect(aliasPointers(problems, "/channels/0", {})).toEqual(problems);
    expect(aliasPointers([{ pointer: "/channels/0/constructor", message: "x" }], "/channels/0", {})).toEqual([{ pointer: "/channels/0/constructor", message: "x" }]);
  });
});
