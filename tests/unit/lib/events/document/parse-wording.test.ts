// tests/unit/lib/events/document/parse-wording.test.ts
// The parser's problem messages are read by the user, who knows a trait as "message properties" / "operation properties": no problem
// text says "trait". Pointers and the failing result's shape are unchanged by the wording (parse.test.ts pins those).
import { describe, expect, it } from "vitest";
import { propertiesNameLower } from "@/features/events/builder/labels";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

function valid(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order"), keyPin: pin("ent-key"), traitKeys: ["CloudEvents"] }],
    traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "trait-1" }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
const mutate = (fn: (d: EventDocument) => void) => { const d = valid(); fn(d); return d; };
function problems(value: unknown): Array<{ pointer: string; message: string }> {
  const r = parseEventDocument(value);
  return r.success ? [] : ((r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems);
}

const MESSAGE = propertiesNameLower("MESSAGE"); // "message properties"
const OPERATION = propertiesNameLower("OPERATION"); // "operation properties"

describe("the parser says message / operation properties, never trait", () => {
  it("an unknown reference names the kind of the item that holds it", () => {
    expect(problems(mutate((d) => { d.messages[0].traitKeys = ["Gone"]; }))).toEqual([
      { pointer: "/messages/0/traitKeys/0", message: 'Unknown message properties "Gone"' },
    ]);
    expect(problems(mutate((d) => { d.operations[0].traitKeys = ["Gone"]; }))).toEqual([
      { pointer: "/operations/0/traitKeys/0", message: 'Unknown operation properties "Gone"' },
    ]);
  });

  it("a reference to a set of the other kind says it is not a set of the kind that item takes", () => {
    const onMessage = mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "OPERATION", libraryTraitId: "t" }; });
    expect(problems(onMessage)).toEqual([{ pointer: "/messages/0/traitKeys/0", message: '"CloudEvents" is not a set of message properties' }]);
    const onOperation = mutate((d) => { d.operations[0].traitKeys = ["CloudEvents"]; });
    expect(problems(onOperation)).toEqual([{ pointer: "/operations/0/traitKeys/0", message: '"CloudEvents" is not a set of operation properties' }]);
  });

  it("a set with neither or both of spec and libraryTraitId", () => {
    const expected = { pointer: "/traits/0", message: "Message properties need exactly one of spec or libraryTraitId" };
    const neither = mutate((d) => { d.messages[0].traitKeys = []; d.traits[0] = { key: "CloudEvents", kind: "MESSAGE" } as never; });
    expect(problems(neither)).toEqual([expected]);
    const both = mutate((d) => { d.messages[0].traitKeys = []; d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "t", spec: {} } as never; });
    expect(problems(both)).toEqual([expected]);
  });

  it("a key shared by two sets, whatever their kinds (the key space is shared)", () => {
    const sameKind = mutate((d) => { d.traits.push({ key: "CloudEvents", kind: "MESSAGE", spec: {} }); });
    const otherKind = mutate((d) => { d.traits.push({ key: "CloudEvents", kind: "OPERATION", spec: {} }); });
    for (const d of [sameKind, otherKind]) {
      expect(problems(d)).toEqual([{ pointer: "/traits/1/key", message: 'Duplicate message or operation properties key "CloudEvents"' }]);
    }
  });

  it("no message of these four situations contains the word trait", () => {
    const docs = [
      mutate((d) => { d.messages[0].traitKeys = ["Gone"]; }),
      mutate((d) => { d.operations[0].traitKeys = ["CloudEvents"]; }),
      mutate((d) => { d.messages[0].traitKeys = []; d.traits[0] = { key: "CloudEvents", kind: "MESSAGE" } as never; }),
      mutate((d) => { d.traits.push({ key: "CloudEvents", kind: "OPERATION", spec: {} }); }),
    ];
    for (const d of docs) {
      const found = problems(d);
      expect(found.length).toBeGreaterThan(0);
      for (const p of found) expect(p.message).not.toMatch(/\btraits?\b/i);
    }
  });

  // `src/lib` cannot import the UI's label file, so parse.ts keeps its own nouns. This is the check that they are the UI's words.
  it("uses the nouns of builder/labels.ts, so a renamed label cannot leave the parser behind", () => {
    const unknown = problems(mutate((d) => { d.operations[0].traitKeys = ["Gone"]; }))[0].message;
    expect(unknown).toBe(`Unknown ${OPERATION} "Gone"`);
    const wrongKind = problems(mutate((d) => { d.operations[0].traitKeys = ["CloudEvents"]; }))[0].message;
    expect(wrongKind).toBe(`"CloudEvents" is not a set of ${OPERATION}`);
    const sentence = problems(mutate((d) => { d.messages[0].traitKeys = []; d.traits[0] = { key: "CloudEvents", kind: "MESSAGE" } as never; }))[0].message;
    expect(sentence.toLowerCase().startsWith(MESSAGE)).toBe(true);
    const duplicate = problems(mutate((d) => { d.traits.push({ key: "CloudEvents", kind: "MESSAGE", spec: {} }); }))[0].message;
    expect(duplicate).toBe(`Duplicate ${MESSAGE.replace(/ properties$/, "")} or ${OPERATION} key "CloudEvents"`);
  });
});
