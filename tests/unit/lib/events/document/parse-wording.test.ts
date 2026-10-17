// tests/unit/lib/events/document/parse-wording.test.ts
// The document layer's problem messages are read by the user, who knows a trait as "message properties" / "operation properties": no
// problem text says "trait" — the parser's, the resolver's and the key rename's (the save validation's are in the integration test
// of the event service). Pointers and the failing result's shape are unchanged by the wording (parse.test.ts pins those).
import { describe, expect, it } from "vitest";
import { propertiesNameLower } from "@/features/events/builder/labels";
import { renameKey } from "@/lib/events/document/keys";
import { parseEventDocument } from "@/lib/events/document/parse";
import { resolveDocument, type ResolveDocumentInput } from "@/lib/events/document/resolve";
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

  describe("the readers of a set's own content", () => {
    const setOf = (kind: "MESSAGE" | "OPERATION", spec: unknown) =>
      mutate((d) => { d.messages[0].traitKeys = []; d.traits[0] = { key: "CloudEvents", kind, spec: spec as never }; });

    it("a property AsyncAPI does not define names the set it was found in", () => {
      expect(problems(setOf("MESSAGE", { color: "red" }))).toEqual([{ pointer: "/traits/0/spec/color", message: `"color" is not a property of a set of ${MESSAGE}` }]);
      expect(problems(setOf("OPERATION", { color: "red" }))).toEqual([{ pointer: "/traits/0/spec/color", message: `"color" is not a property of a set of ${OPERATION}` }]);
    });

    it("an entry that is not an object says it is a set of message or operation properties", () => {
      const message = `set of ${MESSAGE.replace(/ properties$/, "")} or ${OPERATION} must be an object`;
      // the parser carries on with an empty entry, so more follow; the first one is the entry itself
      expect(problems(mutate((d) => { d.traits = [5 as never]; d.messages[0].traitKeys = []; }))[0]).toEqual({ pointer: "/traits/0", message });
    });

    it("none of them says trait", () => {
      for (const found of [problems(setOf("MESSAGE", { color: "red" })), problems(setOf("OPERATION", { color: "red" })), problems(mutate((d) => { d.traits = [5 as never]; d.messages[0].traitKeys = []; }))]) {
        expect(found.length).toBeGreaterThan(0);
        for (const p of found) expect(p.message).not.toMatch(/\btraits?\b/i);
      }
    });
  });
});

// The resolver, the key rename and the save validation share the parser's nouns (`document/wording.ts`). They cannot import
// `labels.ts` either, so these are the checks that they are the UI's words.
describe("the resolver and the key rename say message / operation properties, never trait", () => {
  const avro = { format: "avro" as const, schema: { type: "record", name: "Order", fields: [] } };
  const resolveInput = (doc: EventDocument): ResolveDocumentInput => ({
    doc, productSlug: "checkout", version: "2.0",
    artifacts: new Map([["OrderCreated", { payloads: [avro], keys: [avro] }]]),
    localTraitHeaders: new Map(), libraryTraits: new Map(), libraryTraitHeaders: new Map(), external: new Map(),
  });
  const resolved = (doc: EventDocument, tweak: (input: ResolveDocumentInput) => void = () => undefined) => {
    const input = resolveInput(doc);
    tweak(input);
    const r = resolveDocument(input);
    return r.success ? [] : (r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems;
  };
  const library = (kind: "MESSAGE" | "OPERATION") => ({ id: "trait-1", name: "x", kind, ownerSlug: "acme", spec: {}, headersEntityId: null, headersEntityVersionId: null });

  it("a library set that cannot be found, and one of the other kind", () => {
    expect(resolved(valid())).toEqual([{ pointer: "/traits/0/libraryTraitId", message: `Library ${MESSAGE} "trait-1" not found` }]);
    const wrongKind = resolved(valid(), (i) => { i.libraryTraits = new Map([["trait-1", library("OPERATION")]]); });
    expect(wrongKind).toEqual([{ pointer: "/traits/0/libraryTraitId", message: `Library "trait-1" is a set of ${OPERATION}, but "CloudEvents" is declared as a set of ${MESSAGE}` }]);
  });

  it("a set a message or operation names that does not exist, or is of the other kind", () => {
    const local = (d: EventDocument) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", spec: {} }; };
    expect(resolved(mutate((d) => { local(d); d.messages[0].traitKeys = ["Gone"]; }))).toEqual([{ pointer: "/messages/0/traitKeys/0", message: `Unknown ${MESSAGE} "Gone"` }]);
    expect(resolved(mutate((d) => { local(d); d.operations[0].traitKeys = ["Gone"]; }))).toEqual([{ pointer: "/operations/0/traitKeys/0", message: `Unknown ${OPERATION} "Gone"` }]);
    expect(resolved(mutate((d) => { local(d); d.operations[0].traitKeys = ["CloudEvents"]; }))).toEqual([
      { pointer: "/operations/0/traitKeys/0", message: `"CloudEvents" is not a set of ${OPERATION}` },
    ]);
  });

  it("an external message that brings a set its stored version did not supply", () => {
    const doc = mutate((d) => {
      d.channels = []; d.messages = []; d.traits = [];
      d.externalRefs = [
        { key: "ext-orders", eventVersionId: "ev9", kind: "channel", itemKey: "orders" },
        { key: "ext-created", eventVersionId: "ev9", kind: "message", itemKey: "OrderCreated" },
      ];
      d.operations = [{ key: "recv", action: "receive", channelKey: "ext-orders", messageKeys: ["ext-created"], traitKeys: [] }];
    });
    const found = resolved(doc, (i) => {
      i.artifacts = new Map();
      i.external = new Map([
        ["ext-orders", { channel: { id: "orders", name: "orders", productSlug: "up", address: "o", protocol: "kafka", profile: { format: "avro" as const } } }],
        ["ext-created", { message: { id: "OrderCreated", name: "OrderCreated", productSlug: "up", traitRefs: ["Envelope"], payloads: [avro] }, traits: [] }],
      ]);
    });
    expect(found).toEqual([{
      pointer: "/externalRefs/1",
      message: `External message "OrderCreated" (reference "ext-created") uses ${MESSAGE} "Envelope", which event version ev9 did not supply`,
    }]);
  });

  it("renaming a set that is not there says which things were looked for", () => {
    const refused = renameKey(valid(), "trait", "Gone", "Other");
    expect(refused.success).toBe(false);
    expect(refused.success ? "" : refused.error.message).toBe(`No ${MESSAGE.replace(/ properties$/, "")} or ${OPERATION} with key "Gone"`);
  });

  it("none of these says trait", () => {
    const texts = [
      ...resolved(valid()).map((p) => p.message),
      ...resolved(valid(), (i) => { i.libraryTraits = new Map([["trait-1", library("OPERATION")]]); }).map((p) => p.message),
      ...resolved(mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", spec: {} }; d.messages[0].traitKeys = ["Gone"]; })).map((p) => p.message),
      ...resolved(mutate((d) => { d.traits[0] = { key: "CloudEvents", kind: "MESSAGE", spec: {} }; d.operations[0].traitKeys = ["CloudEvents"]; })).map((p) => p.message),
    ];
    const renamed = renameKey(valid(), "trait", "Gone", "Other");
    if (!renamed.success) texts.push(renamed.error.message);
    expect(texts.length).toBe(5);
    // the words, not the ids and keys the texts quote ("trait-1" is the library item's id)
    for (const text of texts) expect(text.replace(/"[^"]*"/g, "")).not.toMatch(/\btraits?\b/i);
  });
});
