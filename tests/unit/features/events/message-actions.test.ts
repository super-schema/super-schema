import { describe, expect, it } from "vitest";
import { duplicateMessage, removeMessageAt } from "@/features/events/builder/sections/message-actions";
import { sampleDocument } from "../../components/events/builder-harness";

describe("duplicateMessage", () => {
  it("appends a copy under a new key with the same content, and leaves the original alone", () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], title: "Order created", tags: [{ name: "orders" }], headers: { entityId: "ent-2", entityVersionId: "ver-2" }, traitKeys: ["Envelope"] };
    const before = structuredClone(doc);
    const result = duplicateMessage(doc, "OrderCreated");
    expect(result).not.toBeNull();
    const { doc: next, key } = result!;
    expect(key).not.toBe("OrderCreated");
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1]).toEqual({ ...doc.messages[0], key });
    expect(next.messages[0]).toBe(doc.messages[0]);
    expect(doc).toEqual(before);
  });

  it("does not share nested objects with the original, so editing one cannot change the other", () => {
    const doc = sampleDocument();
    doc.messages[0] = { ...doc.messages[0], tags: [{ name: "orders" }] };
    const { doc: next } = duplicateMessage(doc, "OrderCreated")!;
    expect(next.messages[1].tags).not.toBe(doc.messages[0].tags);
    expect(next.messages[1].payload).not.toBe(doc.messages[0].payload);
  });

  it("does not put the copy on any channel or operation", () => {
    const doc = sampleDocument();
    const { doc: next, key } = duplicateMessage(doc, "OrderCreated")!;
    expect(next.channels.every((c) => !c.messageKeys.includes(key))).toBe(true);
    expect(next.operations.every((o) => !o.messageKeys.includes(key))).toBe(true);
    expect(next.channels).toEqual(doc.channels);
  });

  it("picks a key no message, channel or operation uses", () => {
    const doc = sampleDocument();
    const first = duplicateMessage(doc, "OrderCreated")!;
    const second = duplicateMessage(first.doc, "OrderCreated")!;
    expect(new Set([...second.doc.messages.map((m) => m.key)]).size).toBe(3);
  });

  it("answers null for a key that is not a message of the document", () => {
    expect(duplicateMessage(sampleDocument(), "Nope")).toBeNull();
  });
});

describe("removeMessageAt", () => {
  it("removes the message and every reference to it", () => {
    const next = removeMessageAt(sampleDocument(), 0);
    expect(next.messages).toEqual([]);
    expect(next.channels.map((c) => c.messageKeys)).toEqual([[], []]);
    expect(next.operations[0].messageKeys).toEqual([]);
  });

  it("keeps the references while another definition of the same key remains", () => {
    const doc = sampleDocument();
    doc.messages.push({ ...doc.messages[0] });
    const next = removeMessageAt(doc, 1);
    expect(next.messages).toHaveLength(1);
    expect(next.channels[0].messageKeys).toEqual(["OrderCreated"]);
  });

  it("keeps the references while an external message of that key stands in for it", () => {
    const doc = sampleDocument();
    doc.externalRefs = [{ key: "OrderCreated", kind: "message", eventVersionId: "ev-1", itemKey: "OrderCreated" }];
    const next = removeMessageAt(doc, 0);
    expect(next.messages).toEqual([]);
    expect(next.channels[0].messageKeys).toEqual(["OrderCreated"]);
  });

  it("does not change the document it was given", () => {
    const doc = sampleDocument();
    const before = structuredClone(doc);
    removeMessageAt(doc, 0);
    expect(doc).toEqual(before);
  });
});
