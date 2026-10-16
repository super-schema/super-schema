import { describe, expect, it } from "vitest";
import { representationNote } from "@/features/events/builder/sections/representation-note";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import { emptyEventDocument, type DocChannel, type DocMessage, type EventDocument } from "@/lib/events/document/types";

const entity = (id: string, name: string, sourceFormat?: EntityOption["sourceFormat"]): EntityOption => ({
  id, name, ownerLabel: "Payments / Checkout", latestVersionId: `${id}-v1`, latestVersionLabel: "v1.0", ...(sourceFormat ? { sourceFormat } : {}),
});

const channel = (over: Partial<DocChannel> = {}): DocChannel => ({
  key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: [], messageKeys: ["OrderCreated"], ...over,
});
const message = (over: Partial<DocMessage> = {}): DocMessage => ({
  key: "OrderCreated", payload: { entityId: "ent-1", entityVersionId: "ver-1" }, traitKeys: [], ...over,
});
const documentOf = (c: DocChannel, m: DocMessage): EventDocument => ({ ...emptyEventDocument("Orders"), channels: [c], messages: [m] });

describe("representationNote", () => {
  it("Auto with an entity imported from Avro: names the entity and the format it was imported from, whatever the protocol", () => {
    const note = representationNote(documentOf(channel({ protocol: "googlepubsub" }), message()), "OrderCreated", [entity("ent-1", "Order", "avro")]);
    expect(note).toEqual({ tone: "auto", text: "Auto → Avro — the entity Order was imported from Avro" });
  });

  it("Auto with an entity imported from Protobuf or JSON Schema follows that format", () => {
    const doc = documentOf(channel(), message());
    expect(representationNote(doc, "OrderCreated", [entity("ent-1", "Order", "protobuf")]).text).toBe("Auto → Protobuf — the entity Order was imported from Protobuf");
    expect(representationNote(doc, "OrderCreated", [entity("ent-1", "Order", "json-schema")]).text)
      .toBe("Auto → JSON Schema (draft-07) — the entity Order was imported from JSON Schema");
  });

  it("Auto without a recorded source format on a Kafka channel: Avro, because Kafka channels default to it", () => {
    const note = representationNote(documentOf(channel(), message()), "OrderCreated", [entity("ent-1", "Order")]);
    expect(note).toEqual({ tone: "auto", text: "Auto → Avro — Kafka channels default to Avro" });
  });

  it("Auto without a recorded source format on any other protocol: JSON Schema with its dialect", () => {
    const note = representationNote(documentOf(channel({ protocol: "amqp" }), message()), "OrderCreated", [entity("ent-1", "Order")]);
    expect(note).toEqual({ tone: "auto", text: "Auto → JSON Schema (draft-07) — AMQP channels default to JSON Schema" });
  });

  it("Auto uses the dialect of the channel that carries the message", () => {
    const note = representationNote(documentOf(channel({ protocol: "amqp", formatDialect: "2020-12" }), message()), "OrderCreated", [entity("ent-1", "Order")]);
    expect(note.text).toContain("JSON Schema (2020-12)");
  });

  it("Auto on a message no channel carries yet says so and defaults to JSON Schema", () => {
    const note = representationNote(documentOf(channel({ messageKeys: [] }), message()), "OrderCreated", [entity("ent-1", "Order")]);
    expect(note.tone).toBe("auto");
    expect(note.text).toBe("Auto → JSON Schema (draft-07) — no channel carries this message yet, so it defaults to JSON Schema");
  });

  it("Auto when the channel overrides the format: says the channel decided", () => {
    const note = representationNote(documentOf(channel({ format: "protobuf" }), message()), "OrderCreated", [entity("ent-1", "Order", "avro")]);
    expect(note).toEqual({ tone: "auto", text: "Auto → Protobuf — set by channel orders" });
  });

  it("an explicit choice is stated as chosen on the message, with the dialect for JSON Schema", () => {
    const doc = documentOf(channel(), message({ representation: "json-schema" }));
    expect(representationNote(doc, "OrderCreated", [entity("ent-1", "Order", "avro")]))
      .toEqual({ tone: "explicit", text: "Chosen on this message: JSON Schema (draft-07)" });
    expect(representationNote(documentOf(channel(), message({ representation: "protobuf" })), "OrderCreated", []).text)
      .toBe("Chosen on this message: Protobuf");
  });

  it("an explicit choice wins over the channel's format and the entity's source format, and needs no entity yet", () => {
    const doc = documentOf(channel({ format: "avro" }), message({ representation: "protobuf", payload: { entityId: "", entityVersionId: null } }));
    expect(representationNote(doc, "OrderCreated", []).text).toBe("Chosen on this message: Protobuf");
  });

  it("no payload entity yet: a neutral hint instead of a guess", () => {
    const doc = documentOf(channel(), message({ payload: { entityId: "", entityVersionId: null } }));
    const note = representationNote(doc, "OrderCreated", [entity("ent-1", "Order", "avro")]);
    expect(note.tone).toBe("hint");
    expect(note.text).toMatch(/payload entity/i);
    expect(note.text).not.toContain("→");
  });

  it("an entity the options do not know falls back to the protocol default instead of failing", () => {
    const note = representationNote(documentOf(channel(), message({ payload: { entityId: "gone", entityVersionId: null } })), "OrderCreated", [entity("ent-1", "Order", "protobuf")]);
    expect(note.text).toBe("Auto → Avro — Kafka channels default to Avro");
  });

  it("a message that is not in the document gets the hint, never a throw", () => {
    expect(representationNote(emptyEventDocument("Orders"), "nope", []).tone).toBe("hint");
  });

  it("does not mutate the document or the options", () => {
    const doc = documentOf(channel(), message());
    const options = [entity("ent-1", "Order", "avro")];
    const before = JSON.stringify([doc, options]);
    representationNote(doc, "OrderCreated", options);
    expect(JSON.stringify([doc, options])).toBe(before);
  });
});
