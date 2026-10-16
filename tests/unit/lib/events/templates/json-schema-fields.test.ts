import { describe, expect, it } from "vitest";
import {
  applyFieldOverrides,
  humanize,
  schemaToFields,
  type JsonSchema,
} from "../../../../../scripts/generate-asyncapi-templates";

const fields = (properties: Record<string, JsonSchema>, extra: JsonSchema = {}, options?: Parameters<typeof schemaToFields>[1]) =>
  schemaToFields({ type: "object", properties, ...extra }, options);
const byKey = (list: ReturnType<typeof schemaToFields>, key: string) => list.find((f) => f.key === key)!;

describe("JSON Schema -> FieldKind mapping", () => {
  it("maps the primitive types", () => {
    const out = fields({
      topic: { type: "string" },
      partitions: { type: "integer", minimum: 1 },
      ratio: { type: "number" },
      durable: { type: "boolean" },
      regions: { type: "array", items: { type: "string" } },
      labels: { type: "object" },
      anything: {},
    });
    expect(out.map((f) => [f.key, f.kind])).toEqual([
      ["topic", "text"], ["partitions", "integer"], ["ratio", "integer"], ["durable", "boolean"],
      ["regions", "stringList"], ["labels", "keyValue"], ["anything", "json"],
    ]);
  });

  it("maps string + enum to an enum with humanised options", () => {
    const f = byKey(fields({ persistence: { type: "string", enum: ["persistent", "non-persistent"] } }), "persistence");
    expect(f.kind).toBe("enum");
    expect(f.options).toEqual([{ value: "persistent", label: "Persistent" }, { value: "non-persistent", label: "Non persistent" }]);
  });

  it("maps an array of enum strings to a stringList that suggests the allowed items", () => {
    const f = byKey(fields({ policy: { type: "array", items: { type: "string", enum: ["compact", "delete"] } } }), "policy");
    expect(f.kind).toBe("stringList");
    expect(f.suggestions).toEqual(["compact", "delete"]);
  });

  it("maps an object with properties to an object with nested fields, carrying nested required", () => {
    const f = byKey(fields({ retention: { type: "object", properties: { time: { type: "integer" }, size: { type: "integer" } }, required: ["time"] } }), "retention");
    expect(f.kind).toBe("object");
    expect(f.fields!.map((n) => [n.key, n.kind, n.required ?? false])).toEqual([["time", "integer", true], ["size", "integer", false]]);
  });

  it("maps an object without properties to a keyValue, and to json when its values are not simple", () => {
    expect(byKey(fields({ labels: { type: "object" } }), "labels").kind).toBe("keyValue");
    expect(byKey(fields({ labels: { type: "object", additionalProperties: true } }), "labels").kind).toBe("keyValue");
    expect(byKey(fields({ labels: { type: "object", additionalProperties: { type: "string" } } }), "labels").kind).toBe("keyValue");
    expect(byKey(fields({ labels: { type: "object", additionalProperties: { type: "object" } } }), "labels").kind).toBe("json");
  });

  it("maps an array of objects with properties to a list with the item shape", () => {
    const f = byKey(fields({ queues: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }), "queues");
    expect(f.kind).toBe("list");
    expect(f.fields).toEqual([expect.objectContaining({ key: "name", kind: "text", required: true })]);
  });

  it("maps arrays of anything else to json", () => {
    expect(byKey(fields({ a: { type: "array" } }), "a").kind).toBe("json");
    expect(byKey(fields({ a: { type: "array", items: { type: "array", items: { type: "string" } } } }), "a").kind).toBe("json");
  });

  describe("$ref and composition", () => {
    const SCHEMA_REF = "http://asyncapi.com/definitions/3.0.0/schema.json";
    const REFERENCE_REF = "http://asyncapi.com/definitions/3.0.0/Reference.json";

    it("maps a reference to the AsyncAPI schema/reference definitions to json", () => {
      const out = fields({ headers: { $ref: SCHEMA_REF }, other: { $ref: REFERENCE_REF } });
      expect(out.map((f) => f.kind)).toEqual(["json", "json"]);
    });

    it("maps an unresolvable reference to json", () => {
      expect(byKey(fields({ x: { $ref: "http://example.com/missing.json" } }), "x").kind).toBe("json");
    });

    it("resolves #/definitions references (also written as full file URLs) and reuses them", () => {
      const root: JsonSchema = {
        type: "object",
        properties: {
          queue: { $ref: "http://asyncapi.com/bindings/sqs/0.3.0/channel.json#/definitions/queue" },
          deadLetterQueue: { $ref: "#/definitions/queue" },
        },
        definitions: { queue: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      };
      const out = schemaToFields(root);
      for (const key of ["queue", "deadLetterQueue"]) {
        expect(byKey(out, key).kind).toBe("object");
        expect(byKey(out, key).fields).toEqual([expect.objectContaining({ key: "name", kind: "text", required: true })]);
      }
    });

    it("does not loop on a self-referencing definition", () => {
      const root: JsonSchema = {
        type: "object",
        properties: { node: { $ref: "#/definitions/node" } },
        definitions: { node: { type: "object", properties: { child: { $ref: "#/definitions/node" }, label: { type: "string" } } } },
      };
      const node = byKey(schemaToFields(root), "node");
      expect(node.kind).toBe("object");
      expect(byKey(node.fields!, "child").kind).toBe("json");
    });

    it("keeps the property description when the property is a $ref", () => {
      const root: JsonSchema = {
        type: "object",
        properties: { queue: { $ref: "#/definitions/queue", description: "The main queue." } },
        definitions: { queue: { type: "object", properties: { name: { type: "string" } } } },
      };
      expect(byKey(schemaToFields(root), "queue").help).toBe("The main queue.");
    });

    it("takes the primitive branch of oneOf [primitive, schema, Reference]", () => {
      const f = byKey(fields({ ttl: { oneOf: [{ type: "integer", minimum: 0 }, { $ref: SCHEMA_REF }, { $ref: REFERENCE_REF }] } }), "ttl");
      expect(f.kind).toBe("integer");
      expect(byKey(fields({ topic: { oneOf: [{ type: "string", format: "uri-template" }, { $ref: SCHEMA_REF }, { $ref: REFERENCE_REF }] } }), "topic").kind).toBe("text");
    });

    it("maps oneOf [schema, Reference] and mixed oneOf branches to json", () => {
      expect(byKey(fields({ key: { oneOf: [{ $ref: REFERENCE_REF }, { $ref: SCHEMA_REF }] } }), "key").kind).toBe("json");
      expect(byKey(fields({ action: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }), "action").kind).toBe("json");
    });

    it("maps a multi-type property to json and a nullable one to its type", () => {
      expect(byKey(fields({ v: { type: ["string", "boolean", "number", "null"] } }), "v").kind).toBe("json");
      expect(byKey(fields({ v: { type: ["string", "null"] } }), "v").kind).toBe("text");
      expect(byKey(fields({ v: { type: ["integer", "number"] } }), "v").kind).toBe("integer");
    });

    it("maps a string const to a single-option enum", () => {
      const f = byKey(fields({ kind: { type: "string", const: "queue" } }), "kind");
      expect(f.kind).toBe("enum");
      expect(f.options!.map((o) => o.value)).toEqual(["queue"]);
    });

    it("keeps properties that only exist inside oneOf branches and unions their consts", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: { deliveryMode: { type: "string", enum: ["direct", "persistent"] } },
        oneOf: [
          { properties: { destinationType: { type: "string", const: "queue" }, queue: { type: "object", properties: { name: { type: "string" } } } }, required: ["queue"] },
          { properties: { destinationType: { type: "string", const: "topic" }, topicSubscriptions: { type: "array", items: { type: "string" } } } },
        ],
      };
      const out = schemaToFields(schema);
      expect(out.map((f) => f.key)).toEqual(["deliveryMode", "destinationType", "queue", "topicSubscriptions"]);
      expect(byKey(out, "destinationType").options!.map((o) => o.value)).toEqual(["queue", "topic"]);
      // A branch-only `required` applies to that branch, not to the whole object.
      expect(out.some((f) => f.required)).toBe(false);
    });

    it("does not let a oneOf const narrow an existing enum", () => {
      const out = schemaToFields({
        type: "object",
        properties: { is: { type: "string", enum: ["queue", "routingKey"] } },
        oneOf: [{ properties: { is: { const: "routingKey" } } }, { properties: { is: { const: "queue" } } }],
      });
      expect(byKey(out, "is").options!.map((o) => o.value)).toEqual(["queue", "routingKey"]);
    });

    it("merges allOf branches into the object, including their required", () => {
      const out = schemaToFields({ allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "boolean" } } }] });
      expect(out.map((f) => [f.key, f.kind, f.required ?? false])).toEqual([["a", "text", true], ["b", "boolean", false]]);
    });
  });

  describe("metadata", () => {
    it("carries required from the object schema", () => {
      const out = schemaToFields({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["b"] });
      expect(byKey(out, "a").required).toBeUndefined();
      expect(byKey(out, "b").required).toBe(true);
    });

    it("omits bindingVersion", () => {
      const out = schemaToFields({ type: "object", properties: { bindingVersion: { type: "string", enum: ["0.5.0"] }, topic: { type: "string" } }, required: ["bindingVersion"] });
      expect(out.map((f) => f.key)).toEqual(["topic"]);
    });

    it("turns description into help: whitespace collapsed, markdown links reduced to their text, long text shortened", () => {
      const out = fields({
        a: { type: "string", description: "The  [`cleanup.policy`](https://kafka.apache.org/documentation/#topicconfigs_cleanup.policy)\n option." },
        b: { type: "string", description: `${"Sentence one is short. "}${"word ".repeat(200)}` },
        c: { type: "string" },
      });
      expect(byKey(out, "a").help).toBe("The `cleanup.policy` option.");
      expect(byKey(out, "b").help!.length).toBeLessThanOrEqual(240);
      expect(byKey(out, "b").help!.startsWith("Sentence one is short.")).toBe(true);
      expect(byKey(out, "c").help).toBeUndefined();
    });

    it("carries scalar defaults", () => {
      const out = fields({ vhost: { type: "string", default: "/" }, durable: { type: "boolean", default: false }, n: { type: "integer", default: 3 }, obj: { type: "object", default: {} } });
      expect(byKey(out, "vhost").default).toBe("/");
      expect(byKey(out, "durable").default).toBe(false);
      expect(byKey(out, "n").default).toBe(3);
      expect(byKey(out, "obj").default).toBeUndefined();
    });

    it("turns examples into example: property level first, then the schema's own examples, nested too", () => {
      const root: JsonSchema = {
        type: "object",
        properties: {
          topic: { type: "string" },
          partitions: { type: "integer" },
          regions: { type: "array", items: { type: "string" } },
          retention: { type: "object", properties: { time: { type: "integer" } } },
          groupId: { $ref: "http://asyncapi.com/definitions/3.0.0/schema.json" },
          labels: { type: "object" },
          named: { type: "string", examples: ["from-property"] },
        },
        examples: [{ topic: "my-topic", partitions: 20, regions: ["us-west", "us-east"], retention: { time: 15 }, groupId: { type: "string", enum: ["g"] }, labels: { a: "b" }, named: "ignored" }],
      };
      const out = schemaToFields(root);
      expect(byKey(out, "topic").example).toBe("my-topic");
      expect(byKey(out, "partitions").example).toBe("20");
      expect(byKey(out, "regions").example).toBe("us-west, us-east");
      expect(byKey(byKey(out, "retention").fields!, "time").example).toBe("15");
      expect(byKey(out, "groupId").example).toBe('{"type":"string","enum":["g"]}');
      expect(byKey(out, "labels").example).toBe('{"a":"b"}');
      expect(byKey(out, "named").example).toBe("from-property");
      expect(byKey(out, "retention").example).toBeUndefined();
    });

    it("drops an example too long to read as a hint", () => {
      const out = schemaToFields({
        type: "object",
        properties: { headers: { $ref: "http://asyncapi.com/definitions/3.0.0/schema.json" }, short: { type: "string" } },
        examples: [{ headers: { description: "x".repeat(500) }, short: "ok" }],
      });
      expect(byKey(out, "headers").example).toBeUndefined();
      expect(byKey(out, "short").example).toBe("ok");
    });

    it("humanises keys into labels", () => {
      const out = fields({
        autoDelete: { type: "string" }, "geo-replication": { type: "string" }, "retention.ms": { type: "string" }, schemaRegistryUrl: { type: "string" },
        clientID: { type: "string" }, schemaIdLocation: { type: "string" }, ttl: { type: "string" }, snake_case_key: { type: "string" },
      });
      expect(out.map((f) => f.label)).toEqual([
        "Auto delete", "Geo replication", "Retention ms", "Schema registry URL", "Client ID", "Schema ID location", "TTL", "Snake case key",
      ]);
    });
  });

  describe("groups", () => {
    it("puts required properties in basics and the rest in more", () => {
      const out = fields({ a: { type: "string" }, b: { type: "string" } }, { required: ["b"] });
      expect(out.map((f) => [f.key, f.group])).toEqual([["a", "more"], ["b", "basics"]]);
    });

    it("promotes the first four properties to basics when nothing is required", () => {
      const props = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((k) => [k, { type: "string" } as JsonSchema]));
      expect(fields(props).map((f) => f.group)).toEqual(["basics", "basics", "basics", "basics", "more", "more"]);
    });

    it("applies the same rule inside nested objects", () => {
      const out = fields({ settings: { type: "object", properties: { encoding: { type: "string" }, name: { type: "string" }, extra: { type: "string" } }, required: ["encoding", "name"] } });
      expect(byKey(out, "settings").fields!.map((f) => f.group)).toEqual(["basics", "basics", "more"]);
    });
  });
});

describe("humanize", () => {
  it("splits camelCase, dashes, dots and underscores, and upper-cases known acronyms", () => {
    expect(humanize("topicConfiguration")).toBe("Topic configuration");
    expect(humanize("cleanup.policy")).toBe("Cleanup policy");
    expect(humanize("max.message.bytes")).toBe("Max message bytes");
    expect(humanize("tokenUrl")).toBe("Token URL");
    expect(humanize("GET")).toBe("GET");
    expect(humanize("")).toBe("");
  });
});

describe("applyFieldOverrides", () => {
  const base = () => schemaToFields({
    type: "object",
    properties: {
      topic: { type: "string" },
      topicConfiguration: { type: "object", properties: { "cleanup.policy": { type: "array", items: { type: "string" } }, "retention.ms": { type: "integer" } } },
    },
  });

  it("overrides label, help, group, placeholder, example and suggestions by protocol.target.key", () => {
    const out = applyFieldOverrides(base(), {
      "kafka.channel.topic": { label: "Topic name", help: "The topic.", group: "basics", placeholder: "orders.v1", example: "orders", suggestions: ["a", "b"] },
    }, "kafka", "channel");
    expect(byKey(out, "topic")).toMatchObject({ label: "Topic name", help: "The topic.", group: "basics", placeholder: "orders.v1", example: "orders", suggestions: ["a", "b"] });
  });

  it("reaches nested fields, including keys that contain dots", () => {
    const out = applyFieldOverrides(base(), {
      "kafka.channel.topicConfiguration": { label: "Topic settings" },
      "kafka.channel.topicConfiguration.cleanup.policy": { label: "Cleanup policy (custom)" },
      "kafka.channel.topicConfiguration.retention.ms": { group: "more" },
    }, "kafka", "channel");
    const config = byKey(out, "topicConfiguration");
    expect(config.label).toBe("Topic settings");
    expect(byKey(config.fields!, "cleanup.policy").label).toBe("Cleanup policy (custom)");
    expect(byKey(config.fields!, "retention.ms").group).toBe("more");
  });

  it("ignores overrides for other protocols or targets", () => {
    const out = applyFieldOverrides(base(), { "kafka.server.topic": { label: "no" }, "pulsar.channel.topic": { label: "no" } }, "kafka", "channel");
    expect(byKey(out, "topic").label).toBe("Topic");
  });

  it("fails loudly when an override points at a property that does not exist", () => {
    expect(() => applyFieldOverrides(base(), { "kafka.channel.nope": { label: "x" } }, "kafka", "channel")).toThrow(/kafka\.channel\.nope/);
  });

  it("does not mutate its input", () => {
    const input = base();
    applyFieldOverrides(input, { "kafka.channel.topic": { label: "Changed" } }, "kafka", "channel");
    expect(byKey(input, "topic").label).toBe("Topic");
  });
});
