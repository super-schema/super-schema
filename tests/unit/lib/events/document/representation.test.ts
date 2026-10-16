// tests/unit/lib/events/document/representation.test.ts
// WP-1b (R4): the effective schema representation of every message — message → channel → entity → protocol → default.
import { describe, expect, it } from "vitest";
import {
  createRepresentations, describeRepresentation, effectiveRepresentationFormats, entitySourceFormat, protocolDefaultFormat, resolveRepresentations,
} from "@/lib/events/document/representation";
import { emptyEventDocument, type DocChannel, type DocMessage, type DocOperation, type EventDocument } from "@/lib/events/document/types";
import type { PayloadFormat } from "@/lib/event-specs/types";

const pin = (entityId: string) => ({ entityId, entityVersionId: null });
const message = (key: string, entityId = `ent-${key}`, extra: Partial<DocMessage> = {}): DocMessage => ({ key, payload: pin(entityId), traitKeys: [], ...extra });
const channel = (key: string, protocol: string, messageKeys: string[], extra: Partial<DocChannel> = {}): DocChannel =>
  ({ key, address: key, protocol, serverKeys: [], messageKeys, ...extra });
const op = (key: string, channelKey: string, messageKeys: string[], extra: Partial<DocOperation> = {}): DocOperation =>
  ({ key, action: "send", channelKey, messageKeys, traitKeys: [], ...extra });
const docOf = (parts: Partial<EventDocument>): EventDocument => ({ ...emptyEventDocument("checkout"), ...parts });
const formats = (entries: Array<[string, PayloadFormat | undefined]> = []): ReadonlyMap<string, PayloadFormat | undefined> => new Map(entries);
const one = (doc: EventDocument, map = formats(), key = "Order") => {
  const r = resolveRepresentations(doc, map, { entityLabels: new Map([["ent-Order", "Order"]]) }).get(key);
  if (!r) throw new Error(`no representation for ${key}`);
  return r;
};

describe("entitySourceFormat", () => {
  it.each([["avro", "avro"], ["protobuf", "protobuf"], ["json-schema", "json-schema"]] as const)("maps the import format %s", (sourceFormat, expected) => {
    expect(entitySourceFormat({ sourceFormat })).toBe(expected);
  });

  it.each(["typespec", "openapi", "bigquery-ddl", "sql", "", "xml"])("has no opinion for the import format %j", (sourceFormat) => {
    expect(entitySourceFormat({ sourceFormat })).toBeUndefined();
  });

  it("tolerates case and surrounding spaces in the stored string", () => {
    expect(entitySourceFormat({ sourceFormat: " Avro " })).toBe("avro");
  });

  it.each([[undefined], [null], ["avro"], [42], [true], [[]], [["avro"]], [{}], [{ sourceFormat: 7 }], [{ sourceFormat: null }], [{ tags: ["a"] }]])(
    "returns undefined for metadata %j that records no usable source format",
    (metadata) => {
      expect(entitySourceFormat(metadata)).toBeUndefined();
    },
  );

  it("keeps the other metadata keys out of it", () => {
    expect(entitySourceFormat({ tags: ["a"], sourceStale: true, sourceFormat: "protobuf" })).toBe("protobuf");
  });

  it("falls back to the drift record `importedFrom.format`, and prefers `sourceFormat`", () => {
    expect(entitySourceFormat({ importedFrom: { format: "avro", originalContent: "x", importedAt: "2026-10-16" } })).toBe("avro");
    expect(entitySourceFormat({ sourceFormat: "json-schema", importedFrom: { format: "avro" } })).toBe("json-schema");
    expect(entitySourceFormat({ sourceFormat: "typespec", importedFrom: { format: "avro" } })).toBe("avro");
  });
});

describe("describeRepresentation", () => {
  it("labels each representation for the UI", () => {
    expect(describeRepresentation({ format: "avro" })).toBe("Avro");
    expect(describeRepresentation({ format: "protobuf" })).toBe("Protobuf");
    expect(describeRepresentation({ format: "json-schema", dialect: "draft-07" })).toBe("JSON Schema (draft-07)");
    expect(describeRepresentation({ format: "json-schema", dialect: "2020-12" })).toBe("JSON Schema (2020-12)");
  });

  it("names JSON Schema without a dialect when none is known, and ignores a dialect on other formats", () => {
    expect(describeRepresentation({ format: "json-schema" })).toBe("JSON Schema");
    expect(describeRepresentation({ format: "avro", dialect: "draft-07" })).toBe("Avro");
  });

  it("accepts a full effective representation", () => {
    const effective = one(docOf({ channels: [channel("orders", "kafka", ["Order"])], messages: [message("Order")] }));
    expect(describeRepresentation(effective)).toBe("Avro");
  });
});

describe("protocolDefaultFormat", () => {
  it("is Avro for Kafka and JSON Schema for everything else", () => {
    expect(protocolDefaultFormat("kafka")).toBe("avro");
    for (const protocol of ["googlepubsub", "amqp", "mqtt", "nats", "pulsar", "http", "ws", "", "KAFKA-ish"]) {
      expect(protocolDefaultFormat(protocol)).toBe("json-schema");
    }
  });

  it("matches the lowercase AsyncAPI protocol id exactly, like the Kafka key placement does", () => {
    expect(protocolDefaultFormat("Kafka")).toBe("json-schema");
  });
});

describe("resolveRepresentations: precedence", () => {
  it("1. the message's own representation wins over the channel, the entity and the protocol", () => {
    const doc = docOf({
      channels: [channel("orders", "kafka", ["Order"], { format: "avro" })],
      messages: [message("Order", "ent-Order", { representation: "protobuf" })],
    });
    expect(one(doc, formats([["ent-Order", "json-schema"]]))).toEqual({
      format: "protobuf", source: "message", reason: "Chosen on the message",
    });
  });

  it("1b. a JSON Schema message representation takes the dialect of the channel it is on, else draft-07", () => {
    const plain = docOf({ channels: [channel("orders", "kafka", ["Order"], { format: "avro" })], messages: [message("Order", "ent-Order", { representation: "json-schema" })] });
    expect(one(plain)).toMatchObject({ format: "json-schema", dialect: "draft-07", source: "message" });
    const dialect = docOf({ channels: [channel("orders", "googlepubsub", ["Order"], { formatDialect: "2020-12" })], messages: [message("Order", "ent-Order", { representation: "json-schema" })] });
    expect(one(dialect)).toMatchObject({ format: "json-schema", dialect: "2020-12", source: "message" });
  });

  it("1c. a message with a representation but on no channel still reports it", () => {
    const doc = docOf({ messages: [message("Order", "ent-Order", { representation: "avro" })] });
    expect(one(doc)).toEqual({ format: "avro", source: "message", reason: "Chosen on the message" });
  });

  it("2. the channel's explicit format wins over the entity and the protocol", () => {
    const doc = docOf({ channels: [channel("orders", "kafka", ["Order"], { format: "protobuf" })], messages: [message("Order")] });
    expect(one(doc, formats([["ent-Order", "avro"]]))).toEqual({ format: "protobuf", source: "channel", reason: "Set by channel orders" });
  });

  it("2b. an explicit JSON Schema channel carries its dialect, defaulting to draft-07", () => {
    const withDialect = docOf({ channels: [channel("orders", "kafka", ["Order"], { format: "json-schema", formatDialect: "2020-12" })], messages: [message("Order")] });
    expect(one(withDialect)).toMatchObject({ format: "json-schema", dialect: "2020-12", source: "channel" });
    const without = docOf({ channels: [channel("orders", "kafka", ["Order"], { format: "json-schema" })], messages: [message("Order")] });
    expect(one(without)).toMatchObject({ format: "json-schema", dialect: "draft-07", source: "channel" });
  });

  it("2c. an explicit Avro channel has no dialect", () => {
    const doc = docOf({ channels: [channel("orders", "kafka", ["Order"], { format: "avro" })], messages: [message("Order")] });
    expect(one(doc)).not.toHaveProperty("dialect");
  });

  it.each([
    ["avro", "Avro"],
    ["json-schema", "JSON Schema"],
    ["protobuf", "Protobuf"],
  ] as const)("3. the entity's recorded format %s is used when the channel sets none", (format, label) => {
    const doc = docOf({ channels: [channel("orders", "googlepubsub", ["Order"])], messages: [message("Order")] });
    const r = one(doc, formats([["ent-Order", format]]));
    expect(r).toMatchObject({ format, source: "entity" });
    expect(r.reason).toBe(`Auto: the entity Order was imported from ${label}`);
    if (format === "json-schema") expect(r.dialect).toBe("draft-07");
  });

  it("3b. the reason falls back to a generic sentence when the entity has no label", () => {
    const doc = docOf({ channels: [channel("orders", "googlepubsub", ["Order"])], messages: [message("Order")] });
    const r = resolveRepresentations(doc, formats([["ent-Order", "avro"]])).get("Order");
    expect(r?.reason).toBe("Auto: the payload entity was imported from Avro");
  });

  it("3c. an entity JSON Schema takes the channel's dialect when the channel sets one without a format", () => {
    const doc = docOf({ channels: [channel("orders", "googlepubsub", ["Order"], { formatDialect: "2020-12" })], messages: [message("Order")] });
    expect(one(doc, formats([["ent-Order", "json-schema"]]))).toMatchObject({ format: "json-schema", dialect: "2020-12", source: "entity" });
  });

  it("3d. the entity beats the protocol default", () => {
    const doc = docOf({ channels: [channel("orders", "kafka", ["Order"])], messages: [message("Order")] });
    expect(one(doc, formats([["ent-Order", "json-schema"]]))).toMatchObject({ format: "json-schema", source: "entity" });
  });

  it("4. an entity without a recorded format (explicit undefined, absent, or an unrelated entity) falls through to the protocol", () => {
    const doc = docOf({ channels: [channel("orders", "kafka", ["Order"])], messages: [message("Order")] });
    for (const map of [formats([["ent-Order", undefined]]), formats(), formats([["ent-other", "protobuf"]])]) {
      expect(one(doc, map)).toMatchObject({ format: "avro", source: "protocol" });
    }
  });

  it("4b. Kafka defaults to Avro, with a reason that says so", () => {
    const doc = docOf({ channels: [channel("orders", "kafka", ["Order"])], messages: [message("Order")] });
    expect(one(doc)).toEqual({ format: "avro", source: "protocol", reason: "Auto: Kafka channels default to Avro" });
  });

  it("4c. every other protocol defaults to JSON Schema (draft-07), named in the reason", () => {
    const pubsub = docOf({ channels: [channel("notices", "googlepubsub", ["Order"])], messages: [message("Order")] });
    expect(one(pubsub)).toEqual({ format: "json-schema", dialect: "draft-07", source: "protocol", reason: "Auto: Google Pub/Sub channels default to JSON Schema" });
    const mqtt = docOf({ channels: [channel("notices", "mqtt", ["Order"])], messages: [message("Order")] });
    expect(one(mqtt).reason).toBe("Auto: MQTT channels default to JSON Schema");
    const exotic = docOf({ channels: [channel("notices", "solace", ["Order"])], messages: [message("Order")] });
    expect(one(exotic).reason).toBe("Auto: solace channels default to JSON Schema");
  });

  it("4d. a channel dialect (without a format) applies to the protocol default too", () => {
    const doc = docOf({ channels: [channel("notices", "googlepubsub", ["Order"], { formatDialect: "2020-12" })], messages: [message("Order")] });
    expect(one(doc)).toMatchObject({ format: "json-schema", dialect: "2020-12", source: "protocol" });
  });

  it("5. a message that no channel carries defaults to JSON Schema (draft-07)", () => {
    const doc = docOf({ messages: [message("Order")] });
    expect(one(doc)).toEqual({
      format: "json-schema", dialect: "draft-07", source: "default", reason: "Auto: no channel carries this message yet, so it defaults to JSON Schema",
    });
  });

  it("5b. a message that no channel carries still follows its entity", () => {
    const doc = docOf({ messages: [message("Order")] });
    expect(one(doc, formats([["ent-Order", "protobuf"]]))).toMatchObject({ format: "protobuf", source: "entity" });
  });
});

describe("resolveRepresentations: which channels carry a message", () => {
  it("uses the FIRST channel carrying the message for the protocol default", () => {
    const kafkaFirst = docOf({ channels: [channel("a", "kafka", ["Order"]), channel("b", "googlepubsub", ["Order"])], messages: [message("Order")] });
    expect(one(kafkaFirst)).toMatchObject({ format: "avro", source: "protocol" });
    const pubsubFirst = docOf({ channels: [channel("b", "googlepubsub", ["Order"]), channel("a", "kafka", ["Order"])], messages: [message("Order")] });
    expect(one(pubsubFirst)).toMatchObject({ format: "json-schema", source: "protocol" });
  });

  it("skips a channel that does not carry the message", () => {
    const doc = docOf({ channels: [channel("a", "googlepubsub", ["Other"]), channel("b", "kafka", ["Order"])], messages: [message("Order"), message("Other")] });
    expect(one(doc)).toMatchObject({ format: "avro" });
  });

  it("with several channels of different explicit formats, the first explicit channel supplies the headline", () => {
    const doc = docOf({
      channels: [channel("a", "kafka", ["Order"], { format: "protobuf" }), channel("b", "kafka", ["Order"], { format: "json-schema" })],
      messages: [message("Order")],
    });
    expect(one(doc)).toMatchObject({ format: "protobuf", source: "channel", reason: "Set by channel a" });
  });

  it("an explicit channel later in the list still beats an earlier channel without a format", () => {
    const doc = docOf({
      channels: [channel("auto", "googlepubsub", ["Order"]), channel("fixed", "kafka", ["Order"], { format: "avro" })],
      messages: [message("Order")],
    });
    expect(one(doc)).toMatchObject({ format: "avro", source: "channel", reason: "Set by channel fixed" });
  });

  it("counts a channel an operation puts the message on, even when the channel does not list it", () => {
    const doc = docOf({ channels: [channel("a", "kafka", [])], messages: [message("Order")], operations: [op("send", "a", ["Order"])] });
    expect(one(doc)).toMatchObject({ format: "avro", source: "protocol" });
  });

  it("counts the reply channel of an operation", () => {
    const doc = docOf({
      channels: [channel("replies", "kafka", [])], messages: [message("Order")],
      operations: [op("ask", "ext", [], { reply: { channelKey: "replies", messageKeys: ["Order"] } })],
    });
    expect(one(doc)).toMatchObject({ format: "avro", source: "protocol" });
  });

  it("ignores external channels (they bring their own rendered messages)", () => {
    const doc = docOf({
      messages: [message("Order")], operations: [op("recv", "ext", ["Order"])],
      externalRefs: [{ key: "ext", eventVersionId: "ev1", kind: "channel", itemKey: "orders" }],
    });
    expect(one(doc)).toMatchObject({ source: "default" });
  });

  it("answers for every local message in document order and for nothing else", () => {
    const doc = docOf({
      channels: [channel("a", "kafka", ["B", "A", "ext-msg"])], messages: [message("B"), message("A")],
      externalRefs: [{ key: "ext-msg", eventVersionId: "ev1", kind: "message", itemKey: "M" }],
    });
    expect([...resolveRepresentations(doc, formats()).keys()]).toEqual(["B", "A"]);
  });

  it("the first of two messages with the same key wins, like everywhere else", () => {
    const doc = docOf({ channels: [channel("a", "kafka", ["Order"])], messages: [message("Order", "ent-Order", { representation: "protobuf" }), message("Order", "ent-Order", { representation: "avro" })] });
    expect(one(doc).format).toBe("protobuf");
  });

  it("does not mutate the document or the entity map", () => {
    const doc = docOf({ channels: [channel("a", "kafka", ["Order"])], messages: [message("Order")] });
    const map = formats([["ent-Order", "json-schema"]]);
    const before = JSON.stringify([doc, [...map]]);
    resolveRepresentations(doc, map);
    expect(JSON.stringify([doc, [...map]])).toBe(before);
  });
});

describe("effectiveRepresentationFormats", () => {
  it("is the effective format of every message by key, for the bump rules", () => {
    const doc = docOf({
      channels: [channel("a", "kafka", ["Order", "Refund", "Notice"])],
      messages: [message("Order"), message("Refund", "ent-Refund", { representation: "protobuf" }), message("Notice", "ent-Notice")],
    });
    expect(effectiveRepresentationFormats(doc, formats([["ent-Notice", "json-schema"]]))).toEqual({ Order: "avro", Refund: "protobuf", Notice: "json-schema" });
  });
});

describe("createRepresentations: the profile a message renders as on one channel", () => {
  const engine = (doc: EventDocument, map = formats()) => createRepresentations(doc, map);

  it("an explicit channel keeps exactly the profile the assembler used before (no invented dialect)", () => {
    const doc = docOf({
      channels: [
        channel("avro", "kafka", ["Order"], { format: "avro" }),
        channel("json", "kafka", ["Order"], { format: "json-schema" }),
        channel("json2020", "kafka", ["Order"], { format: "json-schema", formatDialect: "2020-12" }),
        channel("proto", "kafka", ["Order"], { format: "protobuf" }),
      ],
      messages: [message("Order")],
    });
    const e = engine(doc);
    expect(e.profileOn("Order", "avro")).toEqual({ format: "avro" });
    expect(e.profileOn("Order", "json")).toEqual({ format: "json-schema" });
    expect(e.profileOn("Order", "json2020")).toEqual({ format: "json-schema", dialect: "2020-12" });
    expect(e.profileOn("Order", "proto")).toEqual({ format: "protobuf" });
  });

  it("a message representation wins on every channel and takes that channel's dialect", () => {
    const doc = docOf({
      channels: [channel("a", "kafka", ["Order"], { format: "avro" }), channel("b", "googlepubsub", ["Order"], { formatDialect: "2020-12" })],
      messages: [message("Order", "ent-Order", { representation: "json-schema" })],
    });
    const e = engine(doc);
    expect(e.profileOn("Order", "a")).toEqual({ format: "json-schema", dialect: "draft-07" });
    expect(e.profileOn("Order", "b")).toEqual({ format: "json-schema", dialect: "2020-12" });
  });

  it("Auto on a channel without a format: the entity, else the first auto channel's protocol", () => {
    const doc = docOf({
      channels: [channel("fixed", "googlepubsub", ["Order", "Other"], { format: "json-schema" }), channel("k", "kafka", ["Order", "Other"]), channel("p", "googlepubsub", ["Order", "Other"])],
      messages: [message("Order", "ent-Order"), message("Other", "ent-Other")],
    });
    const e = engine(doc, formats([["ent-Order", "protobuf"]]));
    expect(e.profileOn("Order", "fixed")).toEqual({ format: "json-schema" });
    expect(e.profileOn("Order", "k")).toEqual({ format: "protobuf" });
    expect(e.profileOn("Order", "p")).toEqual({ format: "protobuf" });
    // no entity format: the first channel WITHOUT a format that carries it decides — here Kafka, for both automatic channels
    expect(e.profileOn("Other", "k")).toEqual({ format: "avro" });
    expect(e.profileOn("Other", "p")).toEqual({ format: "avro" });
    expect(e.profileOn("Other", "fixed")).toEqual({ format: "json-schema" });
  });

  it("is undefined for an unknown or external channel", () => {
    const doc = docOf({ channels: [channel("a", "kafka", ["Order"])], messages: [message("Order")] });
    expect(engine(doc).profileOn("Order", "nope")).toBeUndefined();
  });

  it("an external (non-local) message follows the channel: its explicit format, else the protocol default", () => {
    const doc = docOf({
      channels: [channel("fixed", "kafka", ["ext-msg"], { format: "protobuf" }), channel("k", "kafka", ["ext-msg"]), channel("p", "googlepubsub", ["ext-msg"])],
      externalRefs: [{ key: "ext-msg", eventVersionId: "ev1", kind: "message", itemKey: "M" }],
    });
    const e = engine(doc);
    expect(e.profileOn("ext-msg", "fixed")).toEqual({ format: "protobuf" });
    expect(e.profileOn("ext-msg", "k")).toEqual({ format: "avro" });
    expect(e.profileOn("ext-msg", "p")).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("lists the carriers of a message and the messages of a channel in order, local only", () => {
    const doc = docOf({
      channels: [channel("a", "kafka", ["Order", "ext-msg", "Refund"]), channel("b", "kafka", ["Refund"]), channel("c", "kafka", [])],
      messages: [message("Order"), message("Refund")],
      operations: [op("viaC", "c", ["Order"]), op("onExternal", "ext", ["Order"])],
      externalRefs: [{ key: "ext-msg", eventVersionId: "ev1", kind: "message", itemKey: "M" }, { key: "ext", eventVersionId: "ev1", kind: "channel", itemKey: "x" }],
    });
    const e = engine(doc);
    expect(e.carriers("Order")).toEqual(["a", "c"]);
    expect(e.carriers("Refund")).toEqual(["a", "b"]);
    expect(e.messagesOn("a")).toEqual(["Order", "Refund"]);
    expect(e.messagesOn("c")).toEqual(["Order"]);
    expect(e.messagesOn("nope")).toEqual([]);
  });
});

describe("createRepresentations: the profile of a channel without an explicit format", () => {
  const profileOf = (doc: EventDocument, key: string, map = formats()) => createRepresentations(doc, map).channelProfile(key);

  it("an explicit channel is its explicit profile, unchanged", () => {
    const doc = docOf({ channels: [channel("a", "kafka", ["Order"], { format: "json-schema", formatDialect: "2020-12" }), channel("b", "kafka", [], { format: "avro" })], messages: [message("Order")] });
    expect(profileOf(doc, "a")).toEqual({ format: "json-schema", dialect: "2020-12" });
    expect(profileOf(doc, "b")).toEqual({ format: "avro" });
  });

  it("follows the first message when there is a single one", () => {
    const doc = docOf({ channels: [channel("a", "googlepubsub", ["Order"])], messages: [message("Order")] });
    expect(profileOf(doc, "a", formats([["ent-Order", "avro"]]))).toEqual({ format: "avro" });
  });

  it("follows the MAJORITY of its messages", () => {
    const doc = docOf({
      channels: [channel("a", "googlepubsub", ["A", "B", "C"])],
      messages: [message("A", "ea"), message("B", "eb"), message("C", "ec")],
    });
    expect(profileOf(doc, "a", formats([["ea", "avro"], ["eb", "protobuf"], ["ec", "protobuf"]]))).toEqual({ format: "protobuf" });
  });

  it("breaks a tie in favour of the first message listed", () => {
    const doc = docOf({ channels: [channel("a", "googlepubsub", ["A", "B"])], messages: [message("A", "ea"), message("B", "eb")] });
    expect(profileOf(doc, "a", formats([["ea", "protobuf"], ["eb", "avro"]]))).toEqual({ format: "protobuf" });
    expect(profileOf(doc, "a", formats([["ea", "avro"], ["eb", "protobuf"]]))).toEqual({ format: "avro" });
  });

  it("counts a message's own representation, not just its entity", () => {
    const doc = docOf({ channels: [channel("a", "kafka", ["A", "B"])], messages: [message("A", "ea", { representation: "protobuf" }), message("B", "eb", { representation: "protobuf" })] });
    expect(profileOf(doc, "a")).toEqual({ format: "protobuf" });
  });

  it("without messages it is the protocol default, with the channel's dialect", () => {
    const kafka = docOf({ channels: [channel("k", "kafka", [])] });
    expect(profileOf(kafka, "k")).toEqual({ format: "avro" });
    const pubsub = docOf({ channels: [channel("p", "googlepubsub", [], { formatDialect: "2020-12" })] });
    expect(profileOf(pubsub, "p")).toEqual({ format: "json-schema", dialect: "2020-12" });
    const plain = docOf({ channels: [channel("p", "googlepubsub", [])] });
    expect(profileOf(plain, "p")).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("is undefined for a channel that is not in the document", () => {
    expect(profileOf(docOf({}), "nope")).toBeUndefined();
  });
});
