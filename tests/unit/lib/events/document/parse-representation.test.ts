// tests/unit/lib/events/document/parse-representation.test.ts
// WP-1b: `DocMessage.representation` (absent = Auto) and an optional `DocChannel.format` / `formatDialect` (absent = follow the messages).
import { describe, expect, it } from "vitest";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type DocChannel, type EventDocument } from "@/lib/events/document/types";

const pin = (id: string, v: string | null = "ev1") => ({ entityId: id, entityVersionId: v });

function valid(): EventDocument {
  return {
    ...emptyEventDocument("checkout-service"),
    servers: [{ key: "kafka-prod", protocol: "kafka", host: "kafka-prod.internal:9092" }],
    channels: [{ key: "orders", address: "payments.orders.v1", protocol: "kafka", serverKeys: ["kafka-prod"], format: "avro", messageKeys: ["OrderCreated"] }],
    messages: [{ key: "OrderCreated", payload: pin("ent-order"), traitKeys: [] }],
    operations: [{ key: "publishOrderCreated", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}
const mutate = (fn: (d: EventDocument) => void): EventDocument => { const d = valid(); fn(d); return d; };
const problems = (value: unknown): Array<{ pointer: string; message: string }> => {
  const r = parseEventDocument(value);
  return r.success ? [] : (r.error.details as { problems: Array<{ pointer: string; message: string }> }).problems;
};
const parsed = (value: unknown): EventDocument => {
  const r = parseEventDocument(value);
  if (!r.success) throw new Error(`parse failed: ${JSON.stringify(r.error.details)}`);
  return r.data;
};

describe("message.representation", () => {
  it.each(["avro", "json-schema", "protobuf"] as const)("accepts %s and keeps it", (representation) => {
    const d = parsed(mutate((x) => { x.messages[0].representation = representation; }));
    expect(d.messages[0].representation).toBe(representation);
  });

  it("is absent (Auto) when the message does not set one — nothing is added", () => {
    const d = parsed(valid());
    expect("representation" in d.messages[0]).toBe(false);
  });

  it.each([[undefined], [null], [""], ["   "]])("treats %j as absent", (value) => {
    const raw = mutate((x) => { (x.messages[0] as { representation?: unknown }).representation = value; });
    const d = parsed(raw);
    expect("representation" in d.messages[0]).toBe(false);
  });

  it.each([["xml"], ["Avro"], ["json"], [3], [true], [{}]])("rejects %j at /messages/0/representation", (value) => {
    const p = problems(mutate((x) => { (x.messages[0] as { representation?: unknown }).representation = value; }));
    const hit = p.find((e) => e.pointer === "/messages/0/representation");
    expect(hit).toBeDefined();
    expect(hit?.message).toMatch(/avro, json-schema, protobuf/);
  });

  it("reports the pointer of the right message when several are present", () => {
    const p = problems(mutate((x) => {
      x.messages.push({ key: "Other", payload: pin("e2"), traitKeys: [] });
      (x.messages[1] as { representation?: unknown }).representation = "yaml";
    }));
    expect(p.map((e) => e.pointer)).toEqual(["/messages/1/representation"]);
  });

  it("round-trips: parsing a parsed document gives the same document", () => {
    const once = parsed(mutate((x) => { x.messages[0].representation = "protobuf"; }));
    expect(parsed(once)).toEqual(once);
  });
});

describe("channel.format and channel.formatDialect are optional", () => {
  const channelWithout = (...omit: Array<keyof DocChannel>): EventDocument =>
    mutate((x) => { for (const key of omit) delete x.channels[0][key]; });

  it("accepts a channel without a format and does not invent one", () => {
    const d = parsed(channelWithout("format"));
    expect("format" in d.channels[0]).toBe(false);
    expect("formatDialect" in d.channels[0]).toBe(false);
  });

  it.each([[undefined], [null], [""], ["  "]])("treats a channel format of %j as absent", (value) => {
    const d = parsed(mutate((x) => { (x.channels[0] as { format?: unknown }).format = value; }));
    expect("format" in d.channels[0]).toBe(false);
  });

  it("still keeps an explicit format exactly as given", () => {
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      const d = parsed(mutate((x) => { x.channels[0].format = format; }));
      expect(d.channels[0].format).toBe(format);
    }
  });

  it("still rejects an unknown format at /channels/0/format", () => {
    expect(problems(mutate((x) => { (x.channels[0] as { format?: unknown }).format = "xml"; })).map((p) => p.pointer)).toContain("/channels/0/format");
    expect(problems(mutate((x) => { (x.channels[0] as { format?: unknown }).format = 7; })).map((p) => p.pointer)).toContain("/channels/0/format");
  });

  it("allows a dialect without a format: the dialect for every JSON Schema message on the channel", () => {
    const d = parsed(mutate((x) => { delete x.channels[0].format; x.channels[0].formatDialect = "2020-12"; }));
    expect(d.channels[0]).toMatchObject({ formatDialect: "2020-12" });
    expect("format" in d.channels[0]).toBe(false);
  });

  it("rejects an unknown dialect, with or without a format", () => {
    const bad = (format: DocChannel["format"]) =>
      problems(mutate((x) => { x.channels[0].format = format; (x.channels[0] as { formatDialect?: unknown }).formatDialect = "draft-04"; })).map((p) => p.pointer);
    expect(bad(undefined)).toContain("/channels/0/formatDialect");
    expect(bad("json-schema")).toContain("/channels/0/formatDialect");
  });

  it("still rejects a dialect on an explicit non-JSON-Schema format", () => {
    expect(problems(mutate((x) => { x.channels[0].formatDialect = "2020-12"; })).map((p) => p.pointer)).toContain("/channels/0/formatDialect");
    expect(problems(mutate((x) => { x.channels[0].format = "protobuf"; x.channels[0].formatDialect = "draft-07"; })).map((p) => p.pointer)).toContain("/channels/0/formatDialect");
  });

  it("keeps accepting a JSON Schema channel with a dialect", () => {
    const raw = mutate((x) => { x.channels[0].format = "json-schema"; x.channels[0].formatDialect = "2020-12"; });
    expect(parsed(raw).channels[0]).toMatchObject({ format: "json-schema", formatDialect: "2020-12" });
  });

  it("an existing document (explicit channel formats, no representation) parses to exactly what was authored", () => {
    const authored = mutate((x) => {
      x.channels.push({ key: "audit", address: "a", protocol: "googlepubsub", serverKeys: [], format: "json-schema", formatDialect: "draft-07", messageKeys: ["OrderCreated"] });
    });
    expect(parsed(authored)).toEqual(authored);
  });
});
