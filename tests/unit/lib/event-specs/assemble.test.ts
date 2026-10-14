import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { assembleAsyncApi3 } from "@/lib/event-specs/assemble";
import type { JsonObject, ResolvedChannel, ResolvedEventSpec, SchemaArtifact } from "@/lib/event-specs/types";
import { channel, deepFreeze, jsonObject, message, operation, spec } from "./fixtures/builders";
import { SPEC_6_2_CHECKOUT_YAML, checkoutServiceSpec, ordersChannel, orderCreatedV13 } from "./fixtures/worked-example";

const at = (doc: JsonObject, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);

describe("assembleAsyncApi3 — spec §6.2 worked example", () => {
  it("produces the documented checkout-service document with no diagnostics", () => {
    const { document, diagnostics } = assembleAsyncApi3(checkoutServiceSpec);
    expect(document).toEqual(parse(SPEC_6_2_CHECKOUT_YAML));
    expect(diagnostics).toEqual([]);
  });

  it("emits top-level keys in canonical AsyncAPI order", () => {
    const { document } = assembleAsyncApi3(checkoutServiceSpec);
    expect(Object.keys(document)).toEqual(["asyncapi", "info", "servers", "channels", "operations", "components"]);
    expect(Object.keys(at(document, "components", "messages", "OrderCreated") as object)).toEqual([
      "contentType",
      "traits",
      "payload",
      "bindings",
    ]);
  });

  it("never mutates its input", () => {
    const frozen = deepFreeze(structuredClone(checkoutServiceSpec));
    expect(() => assembleAsyncApi3(frozen)).not.toThrow();
    expect(frozen).toEqual(checkoutServiceSpec);
  });

  it("is independent of input array order", () => {
    const extra = channel({ id: "ch-refunds", name: "refunds" });
    const refund = message({ id: "msgv-refund", name: "RefundIssued" });
    const base = spec({
      channels: [ordersChannel, extra],
      messages: [orderCreatedV13, refund],
      traits: checkoutServiceSpec.traits,
      servers: [
        { key: "b", host: "b:9092", protocol: "kafka" },
        { key: "a", host: "a:9092", protocol: "kafka" },
      ],
      operations: [
        operation({ key: "z", channelRef: extra.id, messageRefs: [refund.id] }),
        operation({ key: "a", channelRef: ordersChannel.id, messageRefs: [orderCreatedV13.id] }),
      ],
    });
    const shuffled: ResolvedEventSpec = {
      ...base,
      channels: [...base.channels].reverse(),
      messages: [...base.messages].reverse(),
      servers: [...base.servers].reverse(),
      operations: [...base.operations].reverse(),
    };
    const a = assembleAsyncApi3(base);
    const b = assembleAsyncApi3(shuffled);
    expect(JSON.stringify(b.document)).toBe(JSON.stringify(a.document));
    expect(Object.keys(at(a.document, "servers") as object)).toEqual(["a", "b"]);
    expect(Object.keys(at(a.document, "operations") as object)).toEqual(["a", "z"]);
  });
});

describe("name-clash qualification", () => {
  it("qualifies a foreign channel that clashes with a home channel (checkout.orders)", () => {
    const fraudOrders = channel({
      id: "ch-fraud-orders",
      name: "orders",
      productSlug: "fraud",
      address: "risk.orders.v1",
    });
    const scored = message({ id: "msgv-scored", name: "OrderScored", productSlug: "fraud" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        productSlug: "fraud",
        channels: [ordersChannel, fraudOrders],
        messages: [{ ...orderCreatedV13, traitRefs: [] }, scored],
        operations: [
          operation({
            key: "consume",
            action: "receive",
            channelRef: ordersChannel.id,
            messageRefs: [orderCreatedV13.id],
          }),
          operation({ key: "publish", channelRef: fraudOrders.id, messageRefs: [scored.id] }),
        ],
      }),
    );
    expect(Object.keys(at(document, "channels") as object)).toEqual(["checkout.orders", "orders"]);
    expect(at(document, "channels", "orders", "address")).toBe("risk.orders.v1");
    expect(at(document, "operations", "consume")).toEqual({
      action: "receive",
      channel: { $ref: "#/channels/checkout.orders" },
      messages: [{ $ref: "#/channels/checkout.orders/messages/OrderCreated" }],
    });
    expect(diagnostics).toEqual([]);
  });

  it("suffixes one Message used in two formats (OrderCreated_avro / OrderCreated_json)", () => {
    const jsonOrders = channel({ id: "ch-orders-json", name: "orders-json", profile: { format: "json-schema" } });
    const msg = message({ id: "msgv-oc", name: "OrderCreated" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonOrders],
        messages: [msg],
        operations: [
          operation({ key: "avro", channelRef: ordersChannel.id, messageRefs: [msg.id] }),
          operation({ key: "json", channelRef: jsonOrders.id, messageRefs: [msg.id] }),
        ],
      }),
    );
    const messages = at(document, "components", "messages") as Record<string, JsonObject>;
    expect(Object.keys(messages)).toEqual(["OrderCreated_avro", "OrderCreated_json"]);
    expect(messages.OrderCreated_avro.name).toBe("OrderCreated");
    expect(at(messages.OrderCreated_avro, "payload", "schemaFormat")).toBe(
      "application/vnd.apache.avro+json;version=1.9.0",
    );
    expect(at(messages.OrderCreated_json, "payload", "schemaFormat")).toBe("application/schema+json;version=draft-07");
    expect(at(document, "channels", "orders-json", "messages")).toEqual({
      OrderCreated_json: { $ref: "#/components/messages/OrderCreated_json" },
    });
    expect(at(document, "operations", "json", "messages")).toEqual([
      { $ref: "#/channels/orders-json/messages/OrderCreated_json" },
    ]);
  });

  it("disambiguates two versions of one Message in one spec with a warning", () => {
    const v1 = message({ id: "msgv-1", name: "OrderCreated" });
    const v2 = message({ id: "msgv-2", name: "OrderCreated" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [v2, v1],
        operations: [operation({ key: "send", channelRef: ordersChannel.id, messageRefs: [v1.id, v2.id] })],
      }),
    );
    expect(Object.keys(at(document, "components", "messages") as object)).toEqual(["OrderCreated", "OrderCreated_2"]);
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        code: "NAME_DISAMBIGUATED",
        message: 'Name clash resolved with a numeric suffix: "OrderCreated_2"',
        pointer: "/components/messages/OrderCreated_2",
      },
    ]);
  });
});

describe("message schemas", () => {
  it("rejects a non-object headers schema and omits headers", () => {
    const msg = message({ id: "m", name: "M", headers: { format: "json-schema", schema: { type: "string" } } });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "headers")).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["HEADERS_NOT_OBJECT_SCHEMA", "/components/messages/M/headers"],
    ]);
  });

  it("places an Avro key on Avro Kafka channels and a JSON Schema key on JSON Kafka channels", () => {
    const keys: SchemaArtifact[] = [
      { format: "avro", schema: { type: "string" } },
      { format: "json-schema", schema: { type: "string", format: "uuid" } },
    ];
    const jsonOrders = channel({ id: "ch-json", name: "orders-json", profile: { format: "json-schema" } });
    const msg = message({ id: "m", name: "M", keys, bindings: { kafka: { schemaIdLocation: "header" } } });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonOrders],
        messages: [msg],
        operations: [
          operation({ key: "a", channelRef: ordersChannel.id, messageRefs: ["m"] }),
          operation({ key: "j", channelRef: jsonOrders.id, messageRefs: ["m"] }),
        ],
      }),
    );
    expect(at(document, "components", "messages", "M_avro", "bindings")).toEqual({
      kafka: { key: { type: "string" }, schemaIdLocation: "header" },
    });
    expect(at(document, "components", "messages", "M_json", "bindings")).toEqual({
      kafka: { key: { type: "string", format: "uuid" }, schemaIdLocation: "header" },
    });
  });

  it("does not place a key for non-Kafka channels, and reports a missing key format", () => {
    const pulsar = channel({ id: "ch-p", name: "p", protocol: "pulsar" });
    const keyed = message({ id: "m", name: "M", keys: [{ format: "json-schema", schema: { type: "string" } }] });
    const onPulsar = assembleAsyncApi3(
      spec({
        channels: [pulsar],
        messages: [keyed],
        operations: [operation({ key: "o", channelRef: pulsar.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(onPulsar.document, "components", "messages", "M", "bindings")).toBeUndefined();
    expect(onPulsar.diagnostics).toEqual([]);

    const onKafkaAvro = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [keyed],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(onKafkaAvro.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["KEY_ARTIFACT_MISSING", "/components/messages/M/bindings/kafka/key"],
    ]);
  });

  it("reports a missing payload rendering for the channel's format", () => {
    const protoChannel = channel({ id: "ch-proto", name: "proto", profile: { format: "protobuf" } });
    const msg = message({ id: "m", name: "M" });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [protoChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: protoChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "payload")).toBeUndefined();
    expect(diagnostics.map((d) => d.code)).toEqual(["PAYLOAD_ARTIFACT_MISSING"]);
  });

  it("down-converts a 2020-12 payload for a draft-07 channel and rebases its refs", () => {
    const jsonOrders = channel({
      id: "ch-json",
      name: "orders-json",
      profile: { format: "json-schema", dialect: "draft-07" },
    });
    const msg = message({
      id: "m",
      name: "M",
      payloads: [
        {
          format: "json-schema",
          dialect: "2020-12",
          schema: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } },
        },
      ],
    });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [jsonOrders],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: jsonOrders.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "M", "payload")).toEqual({
      schemaFormat: "application/schema+json;version=draft-07",
      schema: {
        type: "object",
        properties: { a: { $ref: "#/components/messages/M/payload/schema/definitions/A" } },
        definitions: { A: { type: "string" } },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("flags unpublished draft messages", () => {
    const msg = message({ id: "m", name: "M", unpublished: true });
    const { diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: ordersChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(diagnostics).toEqual([
      {
        severity: "info",
        code: "UNPUBLISHED_MESSAGE",
        message: 'Message "M" is an unpublished draft',
        pointer: "/components/messages/M",
      },
    ]);
  });
});

describe("operations, replies, channel parameters and components", () => {
  it("wires reply operations to the reply channel's messages", () => {
    const requests = channel({ id: "ch-req", name: "fraud-checks", profile: { format: "json-schema" } });
    const verdicts = channel({ id: "ch-res", name: "fraud-verdicts", profile: { format: "json-schema" } });
    const ask = message({ id: "msgv-ask", name: "FraudCheckRequested", payloads: [jsonObject("Ask")] });
    const verdict = message({ id: "msgv-verdict", name: "FraudVerdict", payloads: [jsonObject("Verdict")] });
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [requests, verdicts],
        messages: [ask, verdict],
        operations: [
          operation({
            key: "requestFraudCheck",
            channelRef: requests.id,
            messageRefs: [ask.id],
            reply: { channelRef: verdicts.id, messageRefs: [verdict.id] },
          }),
        ],
      }),
    );
    expect(at(document, "operations", "requestFraudCheck", "reply")).toEqual({
      channel: { $ref: "#/channels/fraud-verdicts" },
      messages: [{ $ref: "#/channels/fraud-verdicts/messages/FraudVerdict" }],
    });
    expect(at(document, "channels", "fraud-verdicts", "messages")).toEqual({
      FraudVerdict: { $ref: "#/components/messages/FraudVerdict" },
    });
    expect(diagnostics).toEqual([]);
  });

  it("requires a reply channel when reply messages are given", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [{ ...orderCreatedV13, traitRefs: [] }],
        operations: [
          operation({
            key: "o",
            channelRef: ordersChannel.id,
            messageRefs: [],
            reply: { messageRefs: [orderCreatedV13.id] },
          }),
        ],
      }),
    );
    expect(at(document, "operations", "o", "reply")).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["REPLY_CHANNEL_REQUIRED", "/operations/o/reply/messages"],
    ]);
  });

  it("emits channel parameters sorted by name", () => {
    const regional = channel({
      id: "ch-reg",
      name: "regional-orders",
      address: "orders.{region}.{tier}.v1",
      parameters: { tier: { enum: ["gold", "std"] }, region: { enum: ["eu", "us"], description: "Region code" } },
    });
    const msg = message({ id: "m", name: "M" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [regional],
        messages: [msg],
        operations: [operation({ key: "o", channelRef: regional.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "channels", "regional-orders")).toEqual({
      address: "orders.{region}.{tier}.v1",
      messages: { M: { $ref: "#/components/messages/M" } },
      parameters: { region: { enum: ["eu", "us"], description: "Region code" }, tier: { enum: ["gold", "std"] } },
    });
    expect(Object.keys(at(document, "channels", "regional-orders", "parameters") as object)).toEqual([
      "region",
      "tier",
    ]);
  });

  it("emits operation traits, operation bindings and local components", () => {
    const msg = message({ id: "m", name: "M" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        messages: [msg],
        traits: [
          {
            id: "t-kafka",
            name: "KafkaConsumer",
            kind: "OPERATION",
            ownerSlug: "payments",
            spec: { bindings: { kafka: { groupId: { type: "string" } } } },
          },
        ],
        operations: [
          operation({
            key: "o",
            action: "receive",
            channelRef: ordersChannel.id,
            messageRefs: ["m"],
            traitRefs: ["t-kafka"],
            summary: "Consume",
          }),
        ],
        components: {
          correlationIds: { byCeId: { location: "$message.header#/ce_id" } },
          securitySchemes: { sasl: { type: "scramSha512" } },
        },
      }),
    );
    expect(at(document, "operations", "o")).toEqual({
      action: "receive",
      channel: { $ref: "#/channels/orders" },
      summary: "Consume",
      traits: [{ $ref: "#/components/operationTraits/KafkaConsumer" }],
      messages: [{ $ref: "#/channels/orders/messages/M" }],
    });
    expect(at(document, "components", "operationTraits")).toEqual({
      KafkaConsumer: { bindings: { kafka: { groupId: { type: "string" } } } },
    });
    expect(at(document, "components", "correlationIds")).toEqual({ byCeId: { location: "$message.header#/ce_id" } });
    expect(at(document, "components", "securitySchemes")).toEqual({ sasl: { type: "scramSha512" } });
  });

  it("maps a server externalRef to externalDocs.url", () => {
    const { document } = assembleAsyncApi3(
      spec({ servers: [{ key: "prod", host: "k:9092", protocol: "kafka", externalRef: "https://wiki/kafka-prod" }] }),
    );
    expect(at(document, "servers", "prod")).toEqual({
      host: "k:9092",
      protocol: "kafka",
      externalDocs: { url: "https://wiki/kafka-prod" },
    });
  });

  it("reports unknown references instead of throwing", () => {
    const { document, diagnostics } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel],
        operations: [
          operation({ key: "a", channelRef: "ch-missing", messageRefs: [] }),
          operation({ key: "b", channelRef: ordersChannel.id, messageRefs: ["msg-missing"], traitRefs: ["t-missing"] }),
        ],
      }),
    );
    expect(diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["UNKNOWN_CHANNEL_REF", "/operations/a/channel"],
      ["UNKNOWN_MESSAGE_REF", "/operations/b/messages/0"],
      ["UNKNOWN_TRAIT_REF", "/operations/b/traits/0"],
    ]);
    expect(Object.keys(at(document, "operations") as object)).toEqual(["b"]);
  });
});

describe("message contentType follows the emitted format (R28)", () => {
  const PROTO: SchemaArtifact = {
    format: "protobuf",
    schema: 'syntax = "proto3";\n// @RootNode\nmessage OrderCreated {}\n',
  };
  const jsonChannel = channel({ id: "ch-json", name: "orders-json", profile: { format: "json-schema" } });
  const json2020Channel = channel({
    id: "ch-json2020",
    name: "orders-json2020",
    profile: { format: "json-schema", dialect: "2020-12" },
  });
  const protoChannel = channel({ id: "ch-proto", name: "orders-proto", profile: { format: "protobuf" } });
  const everyFormat: SchemaArtifact[] = [
    { format: "avro", schema: { type: "record", name: "OrderCreated", fields: [] } },
    jsonObject("OrderCreated"),
    jsonObject("OrderCreated", "2020-12"),
    PROTO,
  ];

  it("derives each per-format copy's contentType from its format when emitted in several formats", () => {
    const msg = message({ id: "m", name: "OrderCreated", contentType: "avro/binary", payloads: everyFormat });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonChannel, json2020Channel, protoChannel],
        messages: [msg],
        operations: [
          operation({ key: "a", channelRef: ordersChannel.id, messageRefs: ["m"] }),
          operation({ key: "b", channelRef: jsonChannel.id, messageRefs: ["m"] }),
          operation({ key: "c", channelRef: json2020Channel.id, messageRefs: ["m"] }),
          operation({ key: "d", channelRef: protoChannel.id, messageRefs: ["m"] }),
        ],
      }),
    );
    const messages = at(document, "components", "messages") as Record<string, JsonObject>;
    expect(Object.keys(messages)).toEqual([
      "OrderCreated_avro",
      "OrderCreated_json",
      "OrderCreated_json2020",
      "OrderCreated_proto",
    ]);
    expect(messages.OrderCreated_avro.contentType).toBe("avro/binary");
    expect(messages.OrderCreated_json.contentType).toBe("application/json");
    expect(messages.OrderCreated_json2020.contentType).toBe("application/json");
    expect(messages.OrderCreated_proto.contentType).toBe("application/x-protobuf");
  });

  it("also derives the contentType per format when the message has no explicit contentType", () => {
    const msg = message({ id: "m", name: "OrderCreated" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [ordersChannel, jsonChannel],
        messages: [msg],
        operations: [
          operation({ key: "a", channelRef: ordersChannel.id, messageRefs: ["m"] }),
          operation({ key: "b", channelRef: jsonChannel.id, messageRefs: ["m"] }),
        ],
      }),
    );
    expect(at(document, "components", "messages", "OrderCreated_avro", "contentType")).toBe("avro/binary");
    expect(at(document, "components", "messages", "OrderCreated_json", "contentType")).toBe("application/json");
  });

  it("keeps the explicit contentType when the message is emitted in exactly one format", () => {
    const msg = message({ id: "m", name: "OrderCreated", contentType: "application/vnd.acme.order+json" });
    const { document } = assembleAsyncApi3(
      spec({
        channels: [jsonChannel],
        messages: [msg],
        operations: [operation({ key: "a", channelRef: jsonChannel.id, messageRefs: ["m"] })],
      }),
    );
    expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe(
      "application/vnd.acme.order+json",
    );
  });

  it("uses the format default for a single-format message without an explicit contentType", () => {
    const cases: Array<[ResolvedChannel, string]> = [
      [ordersChannel, "avro/binary"],
      [jsonChannel, "application/json"],
      [json2020Channel, "application/json"],
      [protoChannel, "application/x-protobuf"],
    ];
    for (const [ch, expected] of cases) {
      const msg = message({ id: "m", name: "OrderCreated", payloads: everyFormat });
      const { document } = assembleAsyncApi3(
        spec({
          channels: [ch],
          messages: [msg],
          operations: [operation({ key: "a", channelRef: ch.id, messageRefs: ["m"] })],
        }),
      );
      expect(at(document, "components", "messages", "OrderCreated", "contentType")).toBe(expected);
    }
  });
});
