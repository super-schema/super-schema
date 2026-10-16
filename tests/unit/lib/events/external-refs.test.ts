import { describe, expect, it } from "vitest";
import { externalItemSummaries, isNewerVersion, missingItemKeys } from "@/lib/events/external-refs";

describe("isNewerVersion", () => {
  it("is true only when the latest version is above the current one", () => {
    expect(isNewerVersion({ major: 1, minor: 1 }, { major: 1, minor: 2 })).toBe(true);
    expect(isNewerVersion({ major: 1, minor: 2 }, { major: 1, minor: 2 })).toBe(false);
    expect(isNewerVersion({ major: 1, minor: 9 }, { major: 2, minor: 0 })).toBe(true);
  });

  it("compares the numbers, not their text, and is false for an older latest", () => {
    expect(isNewerVersion({ major: 1, minor: 9 }, { major: 1, minor: 10 })).toBe(true);
    expect(isNewerVersion({ major: 2, minor: 0 }, { major: 1, minor: 9 })).toBe(false);
    expect(isNewerVersion({ major: 1, minor: 3 }, { major: 1, minor: 2 })).toBe(false);
  });
});

describe("externalItemSummaries", () => {
  const spec = {
    channels: [
      { id: "orders", name: "orders", productSlug: "checkout", address: "orders.v1", protocol: "kafka", profile: { format: "avro" }, title: "Orders", summary: "All order events", description: "Long text" },
      { id: "refunds", name: "refunds", address: null, protocol: "kafka", profile: { format: "avro" } },
    ],
    messages: [{ id: "OrderCreated", name: "OrderCreated", title: "Order created", summary: "An order was placed", payloads: [], traitRefs: [] }],
  };

  it("lists each channel / message by its id with the title, summary and description it carries", () => {
    expect(externalItemSummaries(spec, "channel")).toEqual([
      { key: "orders", title: "Orders", summary: "All order events", description: "Long text" },
      { key: "refunds" },
    ]);
    expect(externalItemSummaries(spec, "message")).toEqual([{ key: "OrderCreated", title: "Order created", summary: "An order was placed" }]);
  });

  it("skips entries that are not objects or have no string id, and ignores non-string text fields", () => {
    const messy = { channels: [null, 7, "x", [], { name: "no-id" }, { id: 4 }, { id: "ok", title: 5, summary: null, description: ["d"] }, { id: "ok", title: "second" }] };
    expect(externalItemSummaries(messy, "channel")).toEqual([{ key: "ok" }]);
  });

  it("is an empty list when the spec has no such array and null when there is no usable spec", () => {
    expect(externalItemSummaries({ channels: "nope" }, "channel")).toEqual([]);
    expect(externalItemSummaries({}, "message")).toEqual([]);
    for (const bad of [null, undefined, "text", 3, [], true]) expect(externalItemSummaries(bad, "channel")).toBeNull();
  });
});

describe("missingItemKeys", () => {
  const latest = { channels: [{ id: "orders" }], messages: [{ id: "OrderCreated" }, { id: "orders" }] };

  it("names the referenced items the latest spec no longer has, once each, in reference order", () => {
    const refs = [
      { kind: "channel" as const, itemKey: "refunds" },
      { kind: "message" as const, itemKey: "OrderCreated" },
      { kind: "message" as const, itemKey: "Gone" },
      { kind: "channel" as const, itemKey: "refunds" },
    ];
    expect(missingItemKeys(latest, refs)).toEqual(["refunds", "Gone"]);
  });

  it("looks a channel up among the channels and a message among the messages", () => {
    expect(missingItemKeys({ channels: [{ id: "a" }], messages: [] }, [{ kind: "message", itemKey: "a" }])).toEqual(["a"]);
    expect(missingItemKeys(latest, [{ kind: "channel", itemKey: "orders" }, { kind: "message", itemKey: "orders" }])).toEqual([]);
  });

  it("treats every referenced item as missing when there is no usable latest spec", () => {
    expect(missingItemKeys(null, [{ kind: "channel", itemKey: "a" }, { kind: "message", itemKey: "b" }])).toEqual(["a", "b"]);
    expect(missingItemKeys({ channels: [{ id: "a" }] }, [])).toEqual([]);
  });
});
