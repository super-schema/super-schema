import { describe, expect, it } from "vitest";
import { libraryTraitKey, removeTrait, traitUsage, usageText } from "@/features/events/builder/traits";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = { entityId: "e1", entityVersionId: "v1" };

/** `idempotent` (message) is on two messages, `audited` (operation, library) on one operation, `retry` (operation) on none. */
function doc(): EventDocument {
  return {
    ...emptyEventDocument("Orders"),
    channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: [], messageKeys: ["Created", "Updated"] }],
    messages: [
      { key: "Created", payload: pin, traitKeys: ["idempotent"] },
      { key: "Updated", payload: pin, traitKeys: ["idempotent"] },
      { key: "Deleted", payload: pin, traitKeys: [] },
    ],
    traits: [
      { key: "idempotent", kind: "MESSAGE", spec: { name: "Idempotent" } },
      { key: "audited", kind: "OPERATION", libraryTraitId: "lib-1" },
      { key: "retry", kind: "OPERATION", spec: { title: "Retry" } },
    ],
    operations: [
      { key: "publish", action: "send", channelKey: "orders", messageKeys: ["Created"], traitKeys: ["audited"] },
      { key: "consume", action: "receive", channelKey: "orders", messageKeys: ["Updated"], traitKeys: [] },
    ],
  };
}

it("the fixture is a valid document, so any problem below comes from the edit under test", () => {
  expect(parseEventDocument(doc()).success).toBe(true);
});

describe("traitUsage", () => {
  it("lists the keys of the messages and operations that carry the trait", () => {
    expect(traitUsage(doc(), "idempotent")).toEqual({ messages: ["Created", "Updated"], operations: [] });
    expect(traitUsage(doc(), "audited")).toEqual({ messages: [], operations: ["publish"] });
  });

  it("is empty for a trait nothing uses or that does not exist", () => {
    expect(traitUsage(doc(), "retry")).toEqual({ messages: [], operations: [] });
    expect(traitUsage(doc(), "gone")).toEqual({ messages: [], operations: [] });
  });
});

describe("usageText", () => {
  it("says how many messages use a message trait, singular and plural, and zero", () => {
    expect(usageText("MESSAGE", { messages: ["a", "b"], operations: [] })).toBe("Used by 2 messages");
    expect(usageText("MESSAGE", { messages: ["a"], operations: [] })).toBe("Used by 1 message");
    expect(usageText("MESSAGE", { messages: [], operations: [] })).toBe("Used by 0 messages");
  });

  it("says how many operations use an operation trait", () => {
    expect(usageText("OPERATION", { messages: [], operations: ["a", "b", "c"] })).toBe("Used by 3 operations");
    expect(usageText("OPERATION", { messages: [], operations: ["a"] })).toBe("Used by 1 operation");
    expect(usageText("OPERATION", { messages: [], operations: [] })).toBe("Used by 0 operations");
  });

  it("also names the other kind when a (broken) document uses a trait on both", () => {
    expect(usageText("MESSAGE", { messages: ["a"], operations: ["o"] })).toBe("Used by 1 message and 1 operation");
    expect(usageText("OPERATION", { messages: ["a", "b"], operations: ["o"] })).toBe("Used by 1 operation and 2 messages");
  });
});

describe("removeTrait", () => {
  it("removes the trait and takes its key off every message", () => {
    const next = removeTrait(doc(), 0);
    expect(next.traits.map((t) => t.key)).toEqual(["audited", "retry"]);
    expect(next.messages.map((m) => m.traitKeys)).toEqual([[], [], []]);
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("takes an operation trait's key off every operation", () => {
    const next = removeTrait(doc(), 1);
    expect(next.traits.map((t) => t.key)).toEqual(["idempotent", "retry"]);
    expect(next.operations.map((o) => o.traitKeys)).toEqual([[], []]);
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("keeps the other trait keys of an item, and untouched items keep their identity", () => {
    const d = doc();
    d.traits.push({ key: "extra", kind: "MESSAGE", spec: {} });
    d.messages[0] = { ...d.messages[0], traitKeys: ["extra", "idempotent"] };
    const next = removeTrait(d, 0);
    expect(next.messages[0].traitKeys).toEqual(["extra"]);
    expect(next.messages[2]).toBe(d.messages[2]);
    expect(next.operations[1]).toBe(d.operations[1]);
  });

  it("removing an unused trait changes nothing else", () => {
    const d = doc();
    const next = removeTrait(d, 2);
    expect(next.traits.map((t) => t.key)).toEqual(["idempotent", "audited"]);
    expect(next.messages.every((m, i) => m === d.messages[i])).toBe(true);
    expect(next.operations.every((o, i) => o === d.operations[i])).toBe(true);
  });

  it("keeps the references when another trait still has the key (a broken document with a duplicate key)", () => {
    const d = doc();
    d.traits.push({ key: "idempotent", kind: "MESSAGE", spec: {} });
    const next = removeTrait(d, 0);
    expect(next.traits.map((t) => t.key)).toEqual(["audited", "retry", "idempotent"]);
    expect(next.messages[0].traitKeys).toEqual(["idempotent"]);
  });

  it("an index that is not in the list changes nothing", () => {
    const d = doc();
    expect(removeTrait(d, 9)).toBe(d);
    expect(removeTrait(d, -1)).toBe(d);
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    removeTrait(before, 0);
    expect(before).toEqual(snapshot);
  });
});

describe("libraryTraitKey", () => {
  it("is the library trait's name as a key", () => {
    expect(libraryTraitKey(doc(), "Audit log")).toBe("Audit-log");
  });

  it("stays unique among the document's trait keys", () => {
    expect(libraryTraitKey(doc(), "audited")).toBe("audited-2");
    expect(libraryTraitKey(doc(), "retry")).toBe("retry-2");
  });

  it("falls back to a valid key for a name with nothing usable in it", () => {
    expect(libraryTraitKey(doc(), "ΩΩ")).toBe("trait");
    expect(libraryTraitKey(doc(), "")).toBe("trait");
  });
});
