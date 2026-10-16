import { describe, expect, it } from "vitest";
import type { LibraryTraitOption } from "@/features/events/builder/EventBuilder";
import {
  addBlankTrait, addChoice, addLibraryTrait, applyTrait, autoNameTrait, isBuiltInEntry, libraryTraitKey, optionOf, optionPropertyCount, removeTrait, traitHeaders, traitLabel,
  traitPropertyCount, traitUsage, unapplyTrait, usageText,
} from "@/features/events/builder/traits";
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

// ── applying a set to one message or operation (the cards) ──────────────────────────────────────────────────────────────

describe("addLibraryTrait", () => {
  const option = { id: "lib-ce", name: "CloudEvents", kind: "MESSAGE" as const };

  it("adds a library entry under a key made from the name", () => {
    const { doc: next, key } = addLibraryTrait(doc(), option);
    expect(key).toBe("CloudEvents");
    expect(next.traits[next.traits.length - 1]).toEqual({ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" });
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("keeps the key unique among the document's trait keys", () => {
    const d = doc();
    d.traits.push({ key: "CloudEvents", kind: "OPERATION", spec: {} });
    expect(addLibraryTrait(d, option).key).toBe("CloudEvents-2");
  });

  it("reuses the entry when the event already uses that library trait: no second entry, the same document", () => {
    const d = doc();
    const { doc: next, key } = addLibraryTrait(d, { id: "lib-1", name: "Audit log", kind: "OPERATION" });
    expect(key).toBe("audited");
    expect(next).toBe(d);
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    addLibraryTrait(before, option);
    expect(before).toEqual(snapshot);
  });
});

describe("addBlankTrait and addChoice", () => {
  it("adds a blank local set of the kind under a placeholder key", () => {
    const { doc: next, key } = addBlankTrait(doc(), "MESSAGE");
    expect(key).toBe("trait");
    expect(next.traits[next.traits.length - 1]).toEqual({ key: "trait", kind: "MESSAGE", spec: {} });
    expect(addBlankTrait(next, "OPERATION").key).toBe("trait-2");
  });

  it("routes a choice: a library option or a blank set", () => {
    expect(addChoice(doc(), { type: "library", option: { id: "lib-x", name: "Tracing", kind: "MESSAGE" } }).key).toBe("Tracing");
    expect(addChoice(doc(), { type: "blank", kind: "OPERATION" }).key).toBe("trait");
  });
});

describe("applyTrait and unapplyTrait", () => {
  it("applies a set to one message, once, leaving the other messages alone", () => {
    const d = doc();
    const next = applyTrait(d, { kind: "message", key: "Deleted" }, "idempotent");
    expect(next.messages.map((m) => m.traitKeys)).toEqual([["idempotent"], ["idempotent"], ["idempotent"]]);
    expect(next.messages[0]).toBe(d.messages[0]);
    expect(applyTrait(next, { kind: "message", key: "Deleted" }, "idempotent").messages[2].traitKeys).toEqual(["idempotent"]);
  });

  it("applies a set to one operation", () => {
    const next = applyTrait(doc(), { kind: "operation", key: "consume" }, "retry");
    expect(next.operations.map((o) => o.traitKeys)).toEqual([["audited"], ["retry"]]);
  });

  it("applying to an unknown target changes nothing visible", () => {
    const d = doc();
    expect(applyTrait(d, { kind: "message", key: "Ghost" }, "idempotent").messages).toEqual(d.messages);
  });

  it("takes a set off one message and keeps a local set in the document, even when nothing uses it any more", () => {
    const next = unapplyTrait(doc(), { kind: "message", key: "Created" }, "idempotent");
    expect(next.messages.map((m) => m.traitKeys)).toEqual([[], ["idempotent"], []]);
    expect(next.traits.map((t) => t.key)).toEqual(["idempotent", "audited", "retry"]);
    const none = unapplyTrait(next, { kind: "message", key: "Updated" }, "idempotent");
    expect(none.traits.map((t) => t.key)).toEqual(["idempotent", "audited", "retry"]);
  });

  it("prunes a library entry that nothing uses any more, and keeps one another item still uses", () => {
    const d = doc();
    const pruned = unapplyTrait(d, { kind: "operation", key: "publish" }, "audited");
    expect(pruned.traits.map((t) => t.key)).toEqual(["idempotent", "retry"]);
    expect(pruned.operations[0].traitKeys).toEqual([]);
    expect(parseEventDocument(pruned).success).toBe(true);
    d.operations[1] = { ...d.operations[1], traitKeys: ["audited"] };
    const kept = unapplyTrait(d, { kind: "operation", key: "publish" }, "audited");
    expect(kept.traits.map((t) => t.key)).toEqual(["idempotent", "audited", "retry"]);
  });

  it("does not mutate its input", () => {
    const before = doc();
    const snapshot = structuredClone(before);
    unapplyTrait(before, { kind: "operation", key: "publish" }, "audited");
    applyTrait(before, { kind: "message", key: "Deleted" }, "idempotent");
    expect(before).toEqual(snapshot);
  });
});

describe("what a set is called and what it brings", () => {
  const library: LibraryTraitOption[] = [
    { id: "lib-1", name: "Audit log", kind: "OPERATION", level: "Enterprise" },
    { id: "lib-ce", name: "CloudEvents 1.0", kind: "MESSAGE", bundled: true, properties: [
      { name: "id", type: "string", required: true }, { name: "time", type: "string (date-time)", required: false },
    ] },
    { id: "lib-spec", name: "From spec", kind: "MESSAGE", spec: { headers: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } },
  ];

  it("labels a library entry with the library trait's name and falls back to its key", () => {
    expect(traitLabel({ key: "audited", kind: "OPERATION", libraryTraitId: "lib-1" }, library)).toBe("Audit log");
    expect(traitLabel({ key: "gone", kind: "OPERATION", libraryTraitId: "nope" }, library)).toBe("gone");
  });

  it("labels a local set with its name or title, 'New message properties' while it is a placeholder, and its key once renamed", () => {
    expect(traitLabel({ key: "x", kind: "MESSAGE", spec: { name: " Idem " } }, library)).toBe("Idem");
    expect(traitLabel({ key: "x", kind: "OPERATION", spec: { title: "Retry" } }, library)).toBe("Retry");
    expect(traitLabel({ key: "trait", kind: "MESSAGE", spec: {} }, library)).toBe("New message properties");
    expect(traitLabel({ key: "trait-2", kind: "OPERATION", spec: {} }, library)).toBe("New operation properties");
    expect(traitLabel({ key: "custom-key", kind: "OPERATION", spec: {} }, library)).toBe("custom-key");
  });

  it("finds the option of a library entry and knows a built-in one", () => {
    const entry = { key: "ce", kind: "MESSAGE" as const, libraryTraitId: "lib-ce" };
    expect(optionOf(entry, library)?.name).toBe("CloudEvents 1.0");
    expect(optionOf({ key: "l", kind: "MESSAGE", spec: {} }, library)).toBeUndefined();
    expect(isBuiltInEntry(entry, library)).toBe(true);
    expect(isBuiltInEntry({ key: "a", kind: "OPERATION", libraryTraitId: "lib-1" }, library)).toBe(false);
    expect(isBuiltInEntry({ key: "l", kind: "MESSAGE", spec: {} }, library)).toBe(false);
  });

  it("counts the properties of a library option from its summary, else from its spec, else not at all", () => {
    expect(optionPropertyCount(library[1])).toBe(2);
    expect(optionPropertyCount(library[2])).toBe(1);
    expect(optionPropertyCount(library[0])).toBeNull();
  });

  it("counts the properties of a set in the document", () => {
    expect(traitPropertyCount({ key: "ce", kind: "MESSAGE", libraryTraitId: "lib-ce" }, library)).toBe(2);
    expect(traitPropertyCount({ key: "g", kind: "MESSAGE", libraryTraitId: "nope" }, library)).toBeNull();
    expect(traitPropertyCount({ key: "l", kind: "MESSAGE", spec: { headers: { type: "object", properties: { a: {}, b: {} } } } }, library)).toBe(2);
    expect(traitPropertyCount({ key: "l", kind: "MESSAGE", spec: {} }, library)).toBe(0);
    expect(traitPropertyCount({ key: "o", kind: "OPERATION", spec: { title: "x" } }, library)).toBeNull();
  });

  it("returns the headers a set defines inline", () => {
    expect(traitHeaders({ key: "l", kind: "MESSAGE", spec: { headers: { type: "object" } } }, library)).toEqual({ type: "object" });
    expect(traitHeaders({ key: "s", kind: "MESSAGE", libraryTraitId: "lib-spec" }, library)).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(traitHeaders({ key: "ce", kind: "MESSAGE", libraryTraitId: "lib-ce" }, library)).toBeUndefined();
  });
});

describe("autoNameTrait", () => {
  const withPlaceholder = (spec: Record<string, unknown>, kind: "MESSAGE" | "OPERATION" = "MESSAGE"): EventDocument => {
    const d = doc();
    d.traits.push({ key: "trait", kind, spec: spec as never });
    d.messages[2] = { ...d.messages[2], traitKeys: ["trait"] };
    return d;
  };

  it("names a placeholder key from the name of a message set, and every reference follows", () => {
    const { doc: next, key } = autoNameTrait(withPlaceholder({ name: "Idempotent writes" }), "trait");
    expect(key).toBe("Idempotent-writes");
    expect(next.traits[3].key).toBe("Idempotent-writes");
    expect(next.messages[2].traitKeys).toEqual(["Idempotent-writes"]);
    expect(parseEventDocument(next).success).toBe(true);
  });

  it("names an operation set from its title", () => {
    expect(autoNameTrait(withPlaceholder({ title: "Retry policy" }, "OPERATION"), "trait").key).toBe("Retry-policy");
  });

  it("prefers the name over the title", () => {
    expect(autoNameTrait(withPlaceholder({ title: "A title", name: "TheName" }), "trait").key).toBe("TheName");
  });

  it("changes nothing while there is nothing to name it by, for a real key, a library entry and an unknown key", () => {
    const d = withPlaceholder({});
    expect(autoNameTrait(d, "trait")).toEqual({ doc: d, key: "trait" });
    expect(autoNameTrait(doc(), "idempotent").key).toBe("idempotent");
    expect(autoNameTrait(doc(), "audited").key).toBe("audited");
    expect(autoNameTrait(doc(), "ghost").key).toBe("ghost");
  });
});
