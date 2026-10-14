import { describe, it, expect } from "vitest";
import {
  headersSchema,
  kafkaKeyProfile,
  placeKafkaKey,
  rebaseLocalRefs,
  selectArtifact,
} from "@/lib/event-specs/message-schemas";
import type { SchemaArtifact } from "@/lib/event-specs/types";

const avro: SchemaArtifact = { format: "avro", schema: { type: "record", name: "Order", fields: [] } };
const json07: SchemaArtifact = { format: "json-schema", dialect: "draft-07", schema: { type: "object" } };
const json2020: SchemaArtifact = {
  format: "json-schema",
  dialect: "2020-12",
  schema: {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "string" } },
    unevaluatedProperties: false,
  },
};
const proto: SchemaArtifact = { format: "protobuf", schema: 'syntax = "proto3";\n// @RootNode\nmessage Order {}\n' };

describe("selectArtifact", () => {
  it("picks the artifact matching the channel's format profile", () => {
    expect(selectArtifact([avro, json07], { format: "avro" }, "payload", "/p").schema).toEqual(avro.schema);
    expect(selectArtifact([avro, json07], { format: "json-schema" }, "payload", "/p").schema).toEqual({
      type: "object",
    });
    expect(selectArtifact([proto], { format: "protobuf" }, "payload", "/p").schema).toBe(proto.schema);
  });

  it("down-converts 2020-12 when the channel wants draft-07 and rebases refs onto the document", () => {
    const res = selectArtifact(
      [json2020],
      { format: "json-schema", dialect: "draft-07" },
      "payload",
      "/components/messages/M/payload/schema",
    );
    expect(res.schema).toEqual({
      type: "object",
      properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
      definitions: { A: { type: "string" } },
    });
    expect(res.diagnostics).toEqual([
      {
        severity: "warning",
        code: "SCHEMA_KEYWORD_DROPPED",
        message: 'Down-converting to draft-07: "unevaluatedProperties" has no draft-07 equivalent and was dropped',
        pointer: "/components/messages/M/payload/schema/unevaluatedProperties",
      },
    ]);
  });

  it("reports a missing artifact per role", () => {
    expect(selectArtifact([avro], { format: "protobuf" }, "payload", "/p").diagnostics[0]).toMatchObject({
      severity: "error",
      code: "PAYLOAD_ARTIFACT_MISSING",
      pointer: "/p",
    });
    expect(selectArtifact([], { format: "avro" }, "key", "/k").diagnostics[0].code).toBe("KEY_ARTIFACT_MISSING");
  });

  it("rejects an artifact whose schema has the wrong shape for its format", () => {
    const bad: SchemaArtifact = { format: "protobuf", schema: { not: "text" } };
    const res = selectArtifact([bad], { format: "protobuf" }, "payload", "/p");
    expect(res.schema).toBeUndefined();
    expect(res.diagnostics[0].code).toBe("SCHEMA_SHAPE_INVALID");
  });
});

describe("headersSchema (headers always JSON Schema object)", () => {
  it("accepts a JSON Schema object schema", () => {
    const res = headersSchema({ format: "json-schema", schema: { type: "object", properties: {} } }, "/h");
    expect(res).toEqual({ schema: { type: "object", properties: {} }, diagnostics: [] });
  });

  it.each<[string, SchemaArtifact]>([
    ["a non-object JSON Schema", { format: "json-schema", schema: { type: "string" } }],
    ["an Avro schema", { format: "avro", schema: { type: "record", name: "H", fields: [] } }],
    ["protobuf text", { format: "protobuf", schema: "message H {}" }],
  ])("rejects %s", (_label, artifact) => {
    const res = headersSchema(artifact, "/components/messages/M/headers");
    expect(res.schema).toBeUndefined();
    expect(res.diagnostics).toEqual([
      {
        severity: "error",
        code: "HEADERS_NOT_OBJECT_SCHEMA",
        message: "Headers must be a JSON Schema object schema (type: object); headers omitted",
        pointer: "/components/messages/M/headers",
      },
    ]);
  });
});

describe("Kafka key placement (spec §7.2 step 3)", () => {
  it("uses Avro on Avro channels, JSON Schema draft-07 otherwise", () => {
    expect(kafkaKeyProfile({ format: "avro" })).toEqual({ format: "avro" });
    expect(kafkaKeyProfile({ format: "json-schema", dialect: "2020-12" })).toEqual({
      format: "json-schema",
      dialect: "draft-07",
    });
    expect(kafkaKeyProfile({ format: "protobuf" })).toEqual({ format: "json-schema", dialect: "draft-07" });
  });

  it("puts the key first under bindings.kafka and keeps other bindings", () => {
    const input = { kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" }, amqp: { ack: true } };
    const { bindings, overridden } = placeKafkaKey(input, { type: "string" });
    expect(bindings).toEqual({
      kafka: { key: { type: "string" }, schemaIdLocation: "header", bindingVersion: "0.5.0" },
      amqp: { ack: true },
    });
    expect(Object.keys(bindings.kafka as object)[0]).toBe("key");
    expect(overridden).toBe(false);
    expect(input).toEqual({ kafka: { schemaIdLocation: "header", bindingVersion: "0.5.0" }, amqp: { ack: true } });
  });

  it("reports a replaced hand-written key", () => {
    expect(placeKafkaKey({ kafka: { key: { type: "integer" } } }, { type: "string" })).toEqual({
      bindings: { kafka: { key: { type: "string" } } },
      overridden: true,
    });
    expect(placeKafkaKey(undefined, { type: "string" }).bindings).toEqual({ kafka: { key: { type: "string" } } });
  });
});

describe("rebaseLocalRefs", () => {
  it("rebases local refs but not remote refs or data keywords", () => {
    expect(
      rebaseLocalRefs(
        { properties: { a: { $ref: "#/definitions/A" }, b: { $ref: "other.json#/x" } }, default: { $ref: "#/keep" } },
        "/components/messages/M/payload/schema",
      ),
    ).toEqual({
      properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" }, b: { $ref: "other.json#/x" } },
      default: { $ref: "#/keep" },
    });
  });
});
