import { describe, expect, it } from "vitest";
import { externalItemSummaries, isNewerVersion, isReferenceableItem, missingItemKeys, referenceableItems } from "@/lib/events/external-refs";

/** What a published version's `resolvedSpec` really stores per item (`ResolvedChannel` / `ResolvedMessage`), reduced to the fields that count. */
const channel = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, productSlug: "checkout", address: `${id}.v1`, protocol: "kafka", profile: { format: "avro" }, ...extra });
const message = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, productSlug: "checkout", traitRefs: [], payloads: [], ...extra });
/** The item without one field: the corrupt shapes a stored `resolvedSpec` could hold. */
const without = (item: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== field));

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

describe("isReferenceableItem", () => {
  it("accepts a stored channel with a profile object and a stored message with payloads and string traitRefs", () => {
    expect(isReferenceableItem("channel", channel("orders"))).toBe(true);
    expect(isReferenceableItem("message", message("OrderCreated"))).toBe(true);
    expect(isReferenceableItem("message", message("WithTraits", { traitRefs: ["a", "b"], payloads: [{ format: "avro" }] }))).toBe(true);
  });

  it("rejects a channel without a profile object", () => {
    const noProfile = without(channel("orders"), "profile");
    expect(isReferenceableItem("channel", noProfile)).toBe(false);
    for (const profile of [null, "avro", 3, ["avro"], undefined]) expect(isReferenceableItem("channel", channel("orders", { profile }))).toBe(false);
  });

  it("rejects a message without a payloads array, or whose traitRefs is missing, not an array or not all strings", () => {
    const noPayloads = without(message("m"), "payloads");
    const noTraitRefs = without(message("m"), "traitRefs");
    expect(isReferenceableItem("message", noPayloads)).toBe(false);
    expect(isReferenceableItem("message", message("m", { payloads: {} }))).toBe(false);
    expect(isReferenceableItem("message", noTraitRefs)).toBe(false);
    expect(isReferenceableItem("message", message("m", { traitRefs: "a" }))).toBe(false);
    expect(isReferenceableItem("message", message("m", { traitRefs: ["a", 2] }))).toBe(false);
  });

  it("judges each kind by its own shape and rejects anything that is not an object with a string id", () => {
    expect(isReferenceableItem("message", channel("orders"))).toBe(false);
    expect(isReferenceableItem("channel", message("orders"))).toBe(false);
    expect(isReferenceableItem("channel", channel("orders", { id: 4 }))).toBe(false);
    const noId = without(message("m"), "id");
    expect(isReferenceableItem("message", noId)).toBe(false);
    for (const bad of [null, undefined, "x", 3, true, [], [channel("orders")]]) {
      expect(isReferenceableItem("channel", bad)).toBe(false);
      expect(isReferenceableItem("message", bad)).toBe(false);
    }
  });
});

describe("externalItemSummaries", () => {
  const spec = {
    channels: [
      channel("orders", { title: "Orders", summary: "All order events", description: "Long text" }),
      channel("refunds", { address: null }),
    ],
    messages: [message("OrderCreated", { title: "Order created", summary: "An order was placed" })],
  };

  it("lists each channel / message by its id with the title, summary and description it carries", () => {
    expect(externalItemSummaries(spec, "channel")).toEqual([
      { key: "orders", title: "Orders", summary: "All order events", description: "Long text" },
      { key: "refunds" },
    ]);
    expect(externalItemSummaries(spec, "message")).toEqual([{ key: "OrderCreated", title: "Order created", summary: "An order was placed" }]);
  });

  it("skips entries that are not objects or have no string id, and ignores non-string text fields", () => {
    const messy = { channels: [null, 7, "x", [], { name: "no-id" }, { id: 4 }, channel("ok", { title: 5, summary: null, description: ["d"] }), channel("ok", { title: "second" })] };
    expect(externalItemSummaries(messy, "channel")).toEqual([{ key: "ok" }]);
  });

  it("does not list an item that cannot be referenced (a corrupt stored item), and the first entry of an id decides", () => {
    const noProfile = without(channel("broken"), "profile");
    const noPayloads = without(message("broken-message"), "payloads");
    const corrupt = {
      channels: [noProfile, channel("fine"), noProfile, channel("first-corrupt-then-valid", { profile: null }), channel("first-corrupt-then-valid")],
      messages: [noPayloads, message("fine"), message("bad-traits", { traitRefs: [1] })],
    };
    expect(externalItemSummaries(corrupt, "channel")).toEqual([{ key: "fine" }]);
    expect(externalItemSummaries(corrupt, "message")).toEqual([{ key: "fine" }]);
  });

  it("is an empty list when the spec has no such array and null when there is no usable spec", () => {
    expect(externalItemSummaries({ channels: "nope" }, "channel")).toEqual([]);
    expect(externalItemSummaries({}, "message")).toEqual([]);
    for (const bad of [null, undefined, "text", 3, [], true]) expect(externalItemSummaries(bad, "channel")).toBeNull();
  });
});

describe("referenceableItems", () => {
  it("maps each referenceable entry by its id (the first entry of an id wins) and is null without a usable spec", () => {
    const first = channel("orders", { title: "first" });
    const spec = { channels: [first, channel("orders", { title: "second" }), { id: "no-profile" }], messages: [] };
    const items = referenceableItems(spec, "channel");
    expect([...(items?.keys() ?? [])]).toEqual(["orders"]);
    expect(items?.get("orders")).toBe(first);
    expect(referenceableItems({}, "message")).toEqual(new Map());
    expect(referenceableItems(null, "message")).toBeNull();
  });
});

describe("missingItemKeys", () => {
  const latest = { channels: [channel("orders")], messages: [message("OrderCreated"), message("orders")] };

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
    expect(missingItemKeys({ channels: [channel("a")], messages: [] }, [{ kind: "message", itemKey: "a" }])).toEqual(["a"]);
    expect(missingItemKeys(latest, [{ kind: "channel", itemKey: "orders" }, { kind: "message", itemKey: "orders" }])).toEqual([]);
  });

  it("treats every referenced item as missing when there is no usable latest spec", () => {
    expect(missingItemKeys(null, [{ kind: "channel", itemKey: "a" }, { kind: "message", itemKey: "b" }])).toEqual(["a", "b"]);
    expect(missingItemKeys({ channels: [channel("a")] }, [])).toEqual([]);
  });

  it("counts a corrupt stored item as missing, the way the picker and the snapshot see it", () => {
    const noProfile = without(channel("orders"), "profile");
    const refs = [{ kind: "channel" as const, itemKey: "orders" }, { kind: "message" as const, itemKey: "m" }];
    expect(missingItemKeys({ channels: [noProfile], messages: [message("m", { traitRefs: [7] })] }, refs)).toEqual(["orders", "m"]);
  });
});
