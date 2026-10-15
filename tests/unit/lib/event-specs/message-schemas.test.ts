import { describe, it, expect } from "vitest";
import {
  headersSchema,
  kafkaKeyProfile,
  placeKafkaKey,
  rebaseLocalRefs,
  selectArtifact,
} from "@/lib/event-specs/message-schemas";
import type { JsonObject, SchemaArtifact } from "@/lib/event-specs/types";
import { deepFreeze } from "./fixtures/builders";

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
    // `unevaluatedProperties: false` on a plain object is exactly `additionalProperties: false` (C-I4): converted, no warning
    expect(res.schema).toEqual({
      type: "object",
      properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
      definitions: { A: { type: "string" } },
      additionalProperties: false,
    });
    expect(res.diagnostics).toEqual([]);
  });

  it("reports a dropped keyword when it cannot be expressed in draft-07 (composition siblings)", () => {
    const composed: SchemaArtifact = {
      format: "json-schema",
      dialect: "2020-12",
      schema: { allOf: [{ properties: { a: { type: "string" } } }], unevaluatedProperties: false },
    };
    const res = selectArtifact([composed], { format: "json-schema", dialect: "draft-07" }, "payload", "/components/messages/M/payload/schema");
    expect(res.schema).toEqual({ allOf: [{ properties: { a: { type: "string" } } }] });
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

  const BASE = "/components/messages/M/payload/schema";
  const LOCAL = "#/definitions/A";
  const REBASED = `#${BASE}/definitions/A`;

  it("rebases refs under properties/definitions named like data keywords (names are not keywords)", () => {
    const input = {
      type: "object",
      properties: {
        default: { $ref: LOCAL },
        enum: { $ref: LOCAL },
        const: { $ref: LOCAL },
        examples: { $ref: LOCAL },
        ok: { $ref: LOCAL },
      },
      patternProperties: { "^default$": { $ref: LOCAL } },
      definitions: { default: { $ref: LOCAL }, A: { type: "string" } },
      $defs: { enum: { $ref: LOCAL } },
      dependentSchemas: { default: { $ref: LOCAL } },
      dependencies: { enum: { $ref: LOCAL }, plain: ["x"] },
    };
    expect(rebaseLocalRefs(input, BASE)).toEqual({
      type: "object",
      properties: {
        default: { $ref: REBASED },
        enum: { $ref: REBASED },
        const: { $ref: REBASED },
        examples: { $ref: REBASED },
        ok: { $ref: REBASED },
      },
      patternProperties: { "^default$": { $ref: REBASED } },
      definitions: { default: { $ref: REBASED }, A: { type: "string" } },
      $defs: { enum: { $ref: REBASED } },
      dependentSchemas: { default: { $ref: REBASED } },
      dependencies: { enum: { $ref: REBASED }, plain: ["x"] },
    });
  });

  it("walks every schema position (items in both forms, allOf, if/then, not, additionalProperties)", () => {
    const ref = { $ref: LOCAL };
    const rebased = { $ref: REBASED };
    expect(
      rebaseLocalRefs(
        {
          items: ref,
          allOf: [ref],
          prefixItems: [ref],
          if: ref,
          then: ref,
          else: ref,
          not: ref,
          additionalProperties: ref,
          properties: { list: { items: [ref], contains: ref } },
        },
        BASE,
      ),
    ).toEqual({
      items: rebased,
      allOf: [rebased],
      prefixItems: [rebased],
      if: rebased,
      then: rebased,
      else: rebased,
      not: rebased,
      additionalProperties: rebased,
      properties: { list: { items: [rebased], contains: rebased } },
    });
  });

  it("copies data keywords in schema position and unknown keywords verbatim, and never mutates its input", () => {
    const input = deepFreeze<JsonObject>({
      const: { $ref: LOCAL },
      enum: [{ $ref: LOCAL }],
      default: { $ref: LOCAL },
      examples: [{ $ref: LOCAL }],
      "x-custom": { $ref: LOCAL },
      properties: { p: { default: { $ref: LOCAL }, examples: [{ $ref: LOCAL }] } },
    });
    expect(rebaseLocalRefs(input, BASE)).toEqual(input);
  });
});

describe("rebasing through selectArtifact / headersSchema", () => {
  const withNamedProperties = {
    type: "object",
    properties: { default: { $ref: "#/definitions/A" }, enum: { $ref: "#/definitions/A" }, ok: { $ref: "#/definitions/A" } },
    definitions: { A: { type: "string" } },
  };
  const rebased = { $ref: "#/components/messages/M/headers/definitions/A" };

  it("rebases headers whose properties are named like data keywords", () => {
    const res = headersSchema({ format: "json-schema", schema: withNamedProperties }, "/components/messages/M/headers");
    expect(res.diagnostics).toEqual([]);
    expect(res.schema?.properties).toEqual({ default: rebased, enum: rebased, ok: rebased });
  });

  it("rebases payloads whose properties are named like data keywords", () => {
    const res = selectArtifact(
      [{ format: "json-schema", dialect: "draft-07", schema: withNamedProperties }],
      { format: "json-schema", dialect: "draft-07" },
      "payload",
      "/components/messages/M/headers",
    );
    expect((res.schema as JsonObject).properties).toEqual({ default: rebased, enum: rebased, ok: rebased });
  });

  it("reports a $ref sibling rewrite from the down-converter as its own warning code", () => {
    const res = selectArtifact(
      [
        {
          format: "json-schema",
          dialect: "2020-12",
          schema: { type: "object", properties: { a: { $ref: "#/$defs/A", maxLength: 3 } }, $defs: { A: { type: "string" } } },
        },
      ],
      { format: "json-schema", dialect: "draft-07" },
      "payload",
      "/components/messages/M/payload/schema",
    );
    expect((res.schema as JsonObject).properties).toEqual({
      a: { allOf: [{ $ref: "#/components/messages/M/payload/schema/definitions/A" }, { maxLength: 3 }] },
    });
    expect(res.diagnostics).toEqual([
      {
        severity: "warning",
        code: "SCHEMA_REF_SIBLINGS_WRAPPED",
        message:
          'Down-converting to draft-07: "$ref" siblings (maxLength) are ignored in draft-07; wrapped as allOf: [{ $ref }, { ...siblings }]',
        pointer: "/components/messages/M/payload/schema/properties/a/$ref",
      },
    ]);
  });
});
