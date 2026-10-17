// tests/unit/lib/events/import/payloads.test.ts
// WP-I1: every payload and headers schema of every message (component or inline), self-contained, with the key the message gets.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPayloads, pascalName } from "@/lib/events/import/payloads";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { ExtractedPayload, RawAsyncApi3 } from "@/lib/events/import/types";

function fixture(name: string): RawAsyncApi3 {
  const parsed = parseAsyncApiSource(readFileSync(path.join(process.cwd(), "tests/fixtures/asyncapi-import", name), "utf8"));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}
function extract(raw: RawAsyncApi3): ExtractedPayload[] {
  const result = extractPayloads(raw);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
const find = (list: ExtractedPayload[], messageKey: string, role: "payload" | "headers" = "payload"): ExtractedPayload => {
  const hit = list.find((p) => p.messageKey === messageKey && p.role === role);
  if (!hit) throw new Error(`no ${role} for ${messageKey}; have ${list.map((p) => `${p.messageKey}:${p.role}`).join(", ")}`);
  return hit;
};
const docWith = (messages: Record<string, unknown>): RawAsyncApi3 => ({ asyncapi: "3.0.0", components: { messages } });

describe("extractPayloads: component messages with $ref payloads (Kafka streetlights)", () => {
  const list = extract(fixture("streetlights-kafka.yaml"));

  it("finds one payload per message, keyed like the message, and no headers (trait headers stay in the trait)", () => {
    expect(list.map((p) => `${p.messageKey}:${p.role}`)).toEqual(["lightMeasured:payload", "turnOnOff:payload", "dimLight:payload"]);
  });

  it("inlines the local refs: the schema is self-contained", () => {
    const light = find(list, "lightMeasured");
    expect(JSON.stringify(light.raw)).not.toContain("$ref");
    expect(light).toMatchObject({
      format: "json-schema",
      sourcePointer: "/components/messages/lightMeasured/payload",
      suggestedName: "LightMeasured",
      raw: {
        type: "object",
        properties: {
          lumens: { type: "integer", minimum: 0, description: "Light intensity measured in lumens." },
          sentAt: { type: "string", format: "date-time", description: "Date and time when the message was sent." },
        },
      },
    });
  });

  it("names entities from the message name (PascalCase)", () => {
    expect(find(list, "turnOnOff").suggestedName).toBe("TurnOnOff");
    expect(find(list, "dimLight").suggestedName).toBe("DimLight");
  });

  it("does not change the document it reads", () => {
    const raw = fixture("streetlights-kafka.yaml");
    const before = JSON.stringify(raw);
    extract(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("extractPayloads: inline messages and headers", () => {
  const list = extract(fixture("inline-messages-and-traits.yaml"));

  it("finds payloads and headers of inline messages, with the key the message will get and where the schema is written", () => {
    expect(find(list, "signedUp")).toMatchObject({ format: "json-schema", sourcePointer: "/channels/userSignedUp/messages/signedUp/payload", suggestedName: "UserSignedUp" });
    expect(find(list, "signedUp", "headers")).toMatchObject({
      format: "json-schema", sourcePointer: "/channels/userSignedUp/messages/signedUp/headers", suggestedName: "UserSignedUpHeaders",
      raw: { type: "object", properties: { "correlation-id": { type: "string" } } },
    });
  });

  it("an inline message whose channel-local key is taken gets the next free key, the same one the mapper uses", () => {
    expect(find(list, "signedUp-2")).toMatchObject({ sourcePointer: "/channels/userDeleted/messages/signedUp/payload", suggestedName: "UserDeleted" });
  });

  it("a component message keeps its component key even when channels give it other local keys, and appears once", () => {
    expect(list.filter((p) => p.messageKey === "userLeft")).toHaveLength(1);
    expect(find(list, "userLeft").sourcePointer).toBe("/components/messages/userLeft/payload");
  });

  it("has exactly one entry per message and role", () => {
    const ids = list.map((p) => `${p.messageKey}:${p.role}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["signedUp-2:payload", "signedUp:headers", "signedUp:payload", "userLeft:payload"]);
  });
});

describe("extractPayloads: schema formats", () => {
  const list = extract(fixture("multi-format-payloads.yaml"));

  it("a bare schema is JSON Schema, and so are the AsyncAPI-schema and draft-07 multi-format payloads (raw is the schema, not the wrapper)", () => {
    expect(find(list, "defaultSchema")).toMatchObject({ format: "json-schema", raw: { type: "object", properties: { value: { type: "number" } } } });
    expect(find(list, "asyncApiSchema")).toMatchObject({
      format: "json-schema",
      raw: { type: "object", properties: { value: { type: "number" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } } },
    });
    const draft = find(list, "draft07Schema");
    expect(draft.format).toBe("json-schema");
    expect(draft.raw).toMatchObject({ $schema: "http://json-schema.org/draft-07/schema#", required: ["value"] });
  });

  it("an Avro payload is the record, whatever the +json / version suffix", () => {
    expect(find(list, "avroReading")).toMatchObject({ format: "avro", raw: { type: "record", name: "Reading", namespace: "com.example.sensors" }, suggestedName: "AvroReading" });
  });

  it("a Protobuf payload is the .proto source text", () => {
    const proto = find(list, "protobufReading");
    expect(proto.format).toBe("protobuf");
    expect(typeof proto.raw).toBe("string");
    expect(proto.raw).toContain("message ProtoReading");
  });

  it("an OpenAPI-schema payload is unsupported and carries no raw schema", () => {
    expect(find(list, "openApiReading")).toMatchObject({ format: "unsupported", raw: undefined, sourcePointer: "/components/messages/openApiReading/payload" });
  });

  it("headers are found next to the payload", () => {
    expect(find(list, "defaultSchema", "headers")).toMatchObject({ format: "json-schema", suggestedName: "ReadingDefaultSchemaFormatHeaders" });
  });
});

describe("extractPayloads: payloads that cannot become entities", () => {
  const list = extract(fixture("unsupported-payloads.yaml"));

  it("OpenAPI and RAML payloads are unsupported", () => {
    expect(find(list, "openApiPayload").format).toBe("unsupported");
    expect(find(list, "ramlPayload").format).toBe("unsupported");
  });

  it("a message with no payload still gets an entry (format none), so the event can pin a placeholder", () => {
    expect(find(list, "noPayload")).toMatchObject({ format: "none", raw: undefined, sourcePointer: "/components/messages/noPayload/payload" });
  });

  it("a Protobuf payload that is not source text, a boolean schema and a multi-format payload without a schema are not usable either", () => {
    const result = extract(docWith({
      protoObject: { payload: { schemaFormat: "application/vnd.google.protobuf;version=3", schema: { message: "x" } } },
      boolSchema: { payload: true },
      noSchema: { payload: { schemaFormat: "application/schema+json;version=draft-07" } },
      stringAvro: { payload: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: "string" } },
    }));
    expect(result.map((p) => [p.messageKey, p.format])).toEqual([
      ["protoObject", "unsupported"], ["boolSchema", "unsupported"], ["noSchema", "none"], ["stringAvro", "unsupported"],
    ]);
  });

  it("headers are always JSON Schema: Avro or Protobuf headers are unsupported, and a wrapper with no schema is no headers at all", () => {
    const result = extract(docWith({
      m: {
        payload: { type: "object" },
        headers: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "H", fields: [] } },
      },
      n: { payload: { type: "object" }, headers: { schemaFormat: "application/schema+json;version=draft-07" } },
    }));
    expect(result.map((p) => `${p.messageKey}:${p.role}:${p.format}`)).toEqual(["m:payload:json-schema", "m:headers:unsupported", "n:payload:json-schema"]);
  });

  it("an empty headers value is no headers", () => {
    const result = extract(docWith({ m: { payload: { type: "object" }, headers: null } }));
    expect(result.map((p) => p.role)).toEqual(["payload"]);
  });
});

describe("extractPayloads: shared and renamed schemas", () => {
  it("two messages that share one payload by $ref each get their own entry", () => {
    const result = extract({
      asyncapi: "3.0.0",
      components: {
        messages: { a: { name: "first", payload: { $ref: "#/components/schemas/S" } }, b: { title: "Second one", payload: { $ref: "#/components/schemas/S" } } },
        schemas: { S: { type: "object" } },
      },
    });
    expect(result.map((p) => [p.messageKey, p.suggestedName, p.raw])).toEqual([["a", "First", { type: "object" }], ["b", "SecondOne", { type: "object" }]]);
  });

  it("a payload that is itself a component $ref to a multi-format schema", () => {
    const result = extract({
      asyncapi: "3.0.0",
      components: {
        messages: { m: { payload: { $ref: "#/components/schemas/Avro" } } },
        schemas: { Avro: { schemaFormat: "application/vnd.apache.avro;version=1.9.0", schema: { type: "record", name: "R", fields: [] } } },
      },
    });
    expect(result[0]).toMatchObject({ format: "avro", raw: { type: "record", name: "R" } });
  });

  it("a schema ref inside a multi-format wrapper is inlined too", () => {
    const result = extract({
      asyncapi: "3.0.0",
      components: {
        messages: { m: { payload: { schemaFormat: "application/schema+json;version=draft-07", schema: { $ref: "#/components/schemas/S" } } } },
        schemas: { S: { type: "string" } },
      },
    });
    expect(result[0]).toMatchObject({ format: "json-schema", raw: { type: "string" } });
  });
});

describe("extractPayloads: rejects", () => {
  it.each([
    ["negative-external-ref.yaml", "EXTERNAL_REF"],
    ["negative-ref-cycle.yaml", "REF_CYCLE"],
    ["negative-missing-ref.yaml", "REF_NOT_FOUND"],
  ])("%s as %s", (name, code) => {
    const result = extractPayloads(fixture(name));
    expect(result.success ? "ok" : result.error.code).toBe(code);
  });
});

describe("pascalName", () => {
  it.each([
    ["lightMeasured", "LightMeasured"],
    ["Order created", "OrderCreated"],
    ["order.created", "OrderCreated"],
    ["user_signed-up", "UserSignedUp"],
    ["Turn on/off", "TurnOnOff"],
    ["ORDER", "ORDER"],
    ["123 report", "Message123Report"],
    ["", "Message"],
    ["---", "Message"],
  ])("%j -> %s", (text, expected) => {
    expect(pascalName(text)).toBe(expected);
  });

  it("is at most 64 characters", () => {
    expect(pascalName("word ".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});
