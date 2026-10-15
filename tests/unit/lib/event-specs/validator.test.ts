import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { StructuralAsyncApi3Validator, validateAsyncApi3Structure } from "@/lib/event-specs/validator";
import type { JsonObject } from "@/lib/event-specs/types";
import { SPEC_6_2_CHECKOUT_YAML } from "./fixtures/worked-example";

const valid = (): JsonObject => parse(SPEC_6_2_CHECKOUT_YAML) as JsonObject;
const codes = (doc: object) => validateAsyncApi3Structure(doc).map((d) => [d.severity, d.code, d.pointer]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at arbitrary document paths
type LooseDoc = any;

/** Apply a mutation to a fresh copy of the §6.2 document. */
function mutate(fn: (doc: LooseDoc) => void): JsonObject {
  const doc = valid();
  fn(doc);
  return doc;
}

describe("validateAsyncApi3Structure", () => {
  it("accepts the spec §6.2 document", () => {
    expect(validateAsyncApi3Structure(valid())).toEqual([]);
  });

  it("requires asyncapi 3.0.0, info.title and info.version", () => {
    expect(codes({ info: {} })).toEqual([
      ["error", "REQUIRED_FIELD", "/asyncapi"],
      ["error", "REQUIRED_FIELD", "/info/title"],
      ["error", "REQUIRED_FIELD", "/info/version"],
    ]);
    expect(codes(mutate((d) => (d.asyncapi = "2.6.0")))).toEqual([
      ["error", "UNSUPPORTED_ASYNCAPI_VERSION", "/asyncapi"],
    ]);
  });

  it("requires server host and protocol", () => {
    expect(codes(mutate((d) => delete d.servers["kafka-prod"].host))).toEqual([
      ["error", "REQUIRED_FIELD", "/servers/kafka-prod/host"],
    ]);
  });

  it("flags unresolved and remote $refs", () => {
    expect(codes(mutate((d) => (d.channels.orders.messages.OrderCreated.$ref = "#/components/messages/Nope")))).toEqual(
      [["error", "UNRESOLVED_REF", "/channels/orders/messages/OrderCreated"]],
    );
    expect(
      codes(mutate((d) => (d.components.messages.OrderCreated.traits[0].$ref = "https://evil.example/trait.yaml"))),
    ).toEqual([["error", "REMOTE_REF", "/components/messages/OrderCreated/traits/0"]]);
  });

  it("checks operation → channel → message consistency", () => {
    expect(codes(mutate((d) => (d.operations.publishOrderCreated.action = "publish")))).toEqual([
      ["error", "INVALID_ACTION", "/operations/publishOrderCreated/action"],
    ]);
    expect(
      codes(mutate((d) => (d.operations.publishOrderCreated.channel = { $ref: "#/components/messages/OrderCreated" }))),
    ).toEqual([["error", "OPERATION_CHANNEL_REF", "/operations/publishOrderCreated/channel"]]);
    expect(
      codes(
        mutate((d) => (d.operations.publishOrderCreated.messages = [{ $ref: "#/components/messages/OrderCreated" }])),
      ),
    ).toEqual([["error", "OPERATION_MESSAGE_NOT_IN_CHANNEL", "/operations/publishOrderCreated/messages/0"]]);
    expect(codes(mutate((d) => delete d.operations.publishOrderCreated.channel))).toEqual([
      ["error", "REQUIRED_FIELD", "/operations/publishOrderCreated/channel"],
    ]);
  });

  it("checks reply messages belong to the reply channel", () => {
    const doc = mutate((d) => {
      d.channels.verdicts = { address: "v", messages: { V: { $ref: "#/components/messages/OrderCreated" } } };
      d.operations.publishOrderCreated.reply = {
        channel: { $ref: "#/channels/verdicts" },
        messages: [{ $ref: "#/channels/verdicts/messages/V" }, { $ref: "#/channels/orders/messages/OrderCreated" }],
      };
    });
    expect(codes(doc)).toEqual([
      ["error", "REPLY_MESSAGE_NOT_IN_CHANNEL", "/operations/publishOrderCreated/reply/messages/1"],
    ]);
  });

  it("checks address parameters against declared parameters", () => {
    const doc = mutate((d) => {
      d.channels.orders.address = "payments.{region}.orders.v1";
      d.channels.orders.parameters = { tier: { enum: ["gold"] } };
    });
    expect(codes(doc)).toEqual([
      ["error", "CHANNEL_PARAMETER_MISSING", "/channels/orders/address"],
      ["warning", "CHANNEL_PARAMETER_UNUSED", "/channels/orders/parameters/tier"],
    ]);
  });

  it("requires object headers on messages and message traits", () => {
    expect(codes(mutate((d) => (d.components.messageTraits.CloudEvents.headers = { type: "string" })))).toEqual([
      ["error", "HEADERS_NOT_OBJECT_SCHEMA", "/components/messageTraits/CloudEvents/headers"],
    ]);
    expect(
      codes(
        mutate(
          (d) =>
            (d.components.messages.OrderCreated.headers = {
              schemaFormat: "application/vnd.apache.avro+json;version=1.9.0",
              schema: { type: "record" },
            }),
        ),
      ),
    ).toEqual([["error", "HEADERS_NOT_OBJECT_SCHEMA", "/components/messages/OrderCreated/headers"]]);
  });

  it("rejects component keys AsyncAPI does not allow", () => {
    const doc = mutate((d) => (d.components.securitySchemes = { "bad key": { type: "plain" } }));
    expect(codes(doc)).toEqual([["error", "COMPONENT_KEY_INVALID", "/components/securitySchemes/bad key"]]);
  });

  it("is usable through the EventSpecValidator interface", async () => {
    const validator = new StructuralAsyncApi3Validator();
    expect(validator.name).toBe("structural");
    expect(await validator.validate(valid())).toEqual({ success: true, data: [] });
  });
});
