import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  generateBindingJsonSchemas,
  generateBindingJsonSchemasModule,
  jsonLeaves,
  type GeneratedBindings,
} from "../../../../../scripts/generate-asyncapi-templates";
import { BINDING_JSON_SCHEMAS, BINDING_JSON_SCHEMAS_FROM } from "@/lib/events/templates/binding-json-schemas.generated";
import { bindingFieldSchema } from "@/lib/events/templates/binding-schemas";
import { GENERATED_BINDINGS } from "@/lib/events/templates/bindings.generated";
import type { BindingTarget, FieldTemplate } from "@/lib/events/templates";
import { SPECS_ROOT } from "./spec-helpers";

const COMMITTED = fileURLToPath(new URL("../../../../../src/lib/events/templates/binding-json-schemas.generated.ts", import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// The raw-JSON leaves of the committed catalog, found here on our own (not through the generator), so a coverage hole in the
// generator's own walk cannot hide itself.
// ---------------------------------------------------------------------------------------------------------------

interface Leaf { protocol: string; target: BindingTarget; segments: string[]; key: string }

function walk(fields: FieldTemplate[], prefix: string[], found: string[][]): void {
  for (const field of fields) {
    const here = [...prefix, field.key];
    if (field.kind === "json") found.push(here);
    if (field.fields) walk(field.fields, field.kind === "list" ? [...here, "[]"] : here, found);
  }
}

const LEAVES: Leaf[] = [];
for (const [protocol, targets] of Object.entries(GENERATED_BINDINGS)) {
  for (const [target, binding] of Object.entries(targets)) {
    const found: string[][] = [];
    walk(binding!.fields, [], found);
    for (const segments of found) LEAVES.push({ protocol, target: target as BindingTarget, segments, key: [protocol, target, ...segments].join(".") });
  }
}

const COLLECTION: Record<BindingTarget, string> = { server: "servers", channel: "channels", operation: "operations", message: "messages" };
/** The pointer FieldControl hands the lookup for a leaf: array items are `index` (a different number for every level). */
function pointerOf(leaf: Leaf, index: number): string {
  let level = index;
  const rest = leaf.segments.map((segment) => (segment === "[]" ? String(level++) : segment));
  return `/${COLLECTION[leaf.target]}/${index}/bindings/${leaf.protocol}/${rest.join("/")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every object in a JSON value (the value itself included). */
function* objectsIn(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) for (const item of value) yield* objectsIn(item);
  else if (isRecord(value)) {
    yield value;
    for (const item of Object.values(value)) yield* objectsIn(item);
  }
}

describe("binding-json-schemas.generated.ts", () => {
  it("is up to date: regenerating from node_modules/@asyncapi/specs yields the committed file (run `npm run gen:asyncapi-templates` if this fails)", () => {
    expect(generateBindingJsonSchemasModule(SPECS_ROOT)).toBe(fs.readFileSync(COMMITTED, "utf8"));
  });

  it("is deterministic", () => {
    expect(generateBindingJsonSchemasModule(SPECS_ROOT)).toBe(generateBindingJsonSchemasModule(SPECS_ROOT));
  });

  it("records the @asyncapi/specs version it was generated from", () => {
    const { version } = JSON.parse(fs.readFileSync(`${SPECS_ROOT}/package.json`, "utf8")) as { version: string };
    expect(BINDING_JSON_SCHEMAS_FROM).toBe(`@asyncapi/specs@${version}`);
  });

  it("starts with a do-not-edit banner and imports nothing (the app never reads @asyncapi/specs)", () => {
    const committed = fs.readFileSync(COMMITTED, "utf8");
    expect(committed.split("\n")[0]).toMatch(/AUTO-GENERATED/);
    expect(committed).not.toMatch(/^import /m);
    expect(committed).not.toMatch(/@asyncapi\/specs["']/);
    expect(committed).not.toMatch(/require\(/);
  });

  it("is small: the schemas stay under 64 KB as compact JSON and the committed file under 130 KB", () => {
    expect(JSON.stringify(BINDING_JSON_SCHEMAS).length).toBeLessThan(64 * 1024);
    expect(fs.statSync(COMMITTED).size).toBeLessThan(130 * 1024);
  });
});

describe("coverage: every raw-JSON field of the binding catalog has a schema", () => {
  it("finds the 24 raw-JSON leaves the catalog has today (a change in this number is a catalog change to look at)", () => {
    expect(LEAVES).toHaveLength(24);
  });

  it.each(LEAVES.map((leaf) => [leaf.key, leaf] as const))("%s has a schema", (key, leaf) => {
    expect(Object.hasOwn(BINDING_JSON_SCHEMAS, key), `no schema for ${key}: run \`npm run gen:asyncapi-templates\``).toBe(true);
    const schema = BINDING_JSON_SCHEMAS[key];
    expect(isRecord(schema)).toBe(true);
    expect(Object.keys(schema).length).toBeGreaterThan(0);
    // and the lookup finds it from the pointer the form builds
    expect(bindingFieldSchema(pointerOf(leaf, 0))).toBe(schema);
  });

  it("has no schema for anything that is not a raw-JSON leaf, and the generator's own walk finds the same leaves", () => {
    expect(Object.keys(BINDING_JSON_SCHEMAS).sort()).toEqual(LEAVES.map((leaf) => leaf.key).sort());
    expect(jsonLeaves(GENERATED_BINDINGS).map((leaf) => leaf.key)).toEqual(LEAVES.map((leaf) => leaf.key));
  });

  it("lists the schemas in catalog order (protocols sorted, targets server, channel, operation, message)", () => {
    expect(Object.keys(BINDING_JSON_SCHEMAS)).toEqual(LEAVES.map((leaf) => leaf.key));
  });
});

describe("what a generated schema is", () => {
  const entries = Object.entries(BINDING_JSON_SCHEMAS);

  it.each(entries)("%s is plain, self-contained data: no $ref, $id, $schema or definitions", (key, schema) => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    for (const node of objectsIn(schema)) {
      // a `$ref` string is a reference; the property NAMED `$ref` (of the Reference Object) holds a schema, an object
      expect(typeof node.$ref, `${key} still holds a $ref`).not.toBe("string");
      for (const dropped of ["$id", "$schema", "$comment", "definitions"]) expect(Object.hasOwn(node, dropped) && typeof node[dropped] !== "object", `${key} keeps ${dropped}`).toBe(false);
    }
  });

  it("keeps the spec's own description at the place the field is described", () => {
    expect(BINDING_JSON_SCHEMAS["kafka.operation.groupId"].description).toBe("Id of the consumer group.");
    expect(BINDING_JSON_SCHEMAS["kafka.operation.clientId"].description).toBe("Id of the consumer inside a consumer group.");
    expect(BINDING_JSON_SCHEMAS["sns.channel.policy.statements.[].principal"].description).toMatch(/AWS account/);
  });

  it("reads 'a schema or a reference to one' as anyOf, so a `$ref` object is not a violation", () => {
    for (const key of ["anypointmq.message.headers", "kafka.message.key", "ws.channel.query", "ws.channel.headers"]) {
      const schema = BINDING_JSON_SCHEMAS[key];
      expect(schema.anyOf, key).toHaveLength(2);
      expect(schema.oneOf, key).toBeUndefined();
    }
    // and no `oneOf` anywhere has the Reference Object (the only schema that requires `$ref`) among its branches
    for (const [key, schema] of entries) {
      for (const node of objectsIn(schema)) {
        if (!Array.isArray(node.oneOf)) continue;
        const requiresRef = node.oneOf.some((branch) => isRecord(branch) && Array.isArray(branch.required) && branch.required.includes("$ref"));
        expect(requiresRef, `${key} has a oneOf with the Reference Object`).toBe(false);
      }
    }
  });

  it("describes a plain value for the fields that are not schemas", () => {
    expect(BINDING_JSON_SCHEMAS["jms.server.properties.[].value"]).toMatchObject({ type: ["string", "boolean", "number", "null"] });
    expect(BINDING_JSON_SCHEMAS["sns.channel.policy.statements.[].action"].oneOf).toHaveLength(2);
    expect(BINDING_JSON_SCHEMAS["sns.operation.consumers.[].filterPolicy"]).toMatchObject({ type: "object" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------------------------------------------

describe("bindingFieldSchema", () => {
  it("finds the schema from the pointer a control sits at, whatever the index of its server, channel, message or operation", () => {
    expect(bindingFieldSchema("/channels/0/bindings/ws/query")).toBe(BINDING_JSON_SCHEMAS["ws.channel.query"]);
    expect(bindingFieldSchema("/channels/41/bindings/ws/query")).toBe(BINDING_JSON_SCHEMAS["ws.channel.query"]);
    expect(bindingFieldSchema("/operations/2/bindings/kafka/groupId")).toBe(BINDING_JSON_SCHEMAS["kafka.operation.groupId"]);
    expect(bindingFieldSchema("/operations/2/bindings/kafka/clientId")).toBe(BINDING_JSON_SCHEMAS["kafka.operation.clientId"]);
    expect(bindingFieldSchema("/messages/1/bindings/kafka/key")).toBe(BINDING_JSON_SCHEMAS["kafka.message.key"]);
    expect(bindingFieldSchema("/messages/0/bindings/anypointmq/headers")).toBe(BINDING_JSON_SCHEMAS["anypointmq.message.headers"]);
    expect(bindingFieldSchema("/operations/0/bindings/http/query")).toBe(BINDING_JSON_SCHEMAS["http.operation.query"]);
    expect(bindingFieldSchema("/messages/0/bindings/mqtt/correlationData")).toBe(BINDING_JSON_SCHEMAS["mqtt.message.correlationData"]);
  });

  it("turns every index inside the binding into [] (a JMS property value, SNS and SQS policy statements, consumers and queues)", () => {
    const jms = BINDING_JSON_SCHEMAS["jms.server.properties.[].value"];
    expect(bindingFieldSchema("/servers/0/bindings/jms/properties/3/value")).toBe(jms);
    expect(bindingFieldSchema("/servers/9/bindings/jms/properties/0/value")).toBe(jms);

    const principal = BINDING_JSON_SCHEMAS["sns.channel.policy.statements.[].principal"];
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements/1/principal")).toBe(principal);
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements/12/principal")).toBe(principal);
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements/1/action")).toBe(BINDING_JSON_SCHEMAS["sns.channel.policy.statements.[].action"]);
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements/1/resource")).toBe(BINDING_JSON_SCHEMAS["sns.channel.policy.statements.[].resource"]);

    expect(bindingFieldSchema("/channels/2/bindings/sqs/queue/policy/statements/0/principal")).toBe(BINDING_JSON_SCHEMAS["sqs.channel.queue.policy.statements.[].principal"]);
    expect(bindingFieldSchema("/channels/2/bindings/sqs/deadLetterQueue/policy/statements/5/action")).toBe(BINDING_JSON_SCHEMAS["sqs.channel.deadLetterQueue.policy.statements.[].action"]);
    expect(bindingFieldSchema("/operations/1/bindings/sqs/queues/3/policy/statements/2/resource")).toBe(BINDING_JSON_SCHEMAS["sqs.operation.queues.[].policy.statements.[].resource"]);
    expect(bindingFieldSchema("/operations/1/bindings/sns/consumers/4/filterPolicy")).toBe(BINDING_JSON_SCHEMAS["sns.operation.consumers.[].filterPolicy"]);
  });

  it("takes the target from the collection: the same protocol and key under another collection has no schema", () => {
    expect(bindingFieldSchema("/channels/0/bindings/kafka/groupId")).toBeNull();
    expect(bindingFieldSchema("/messages/0/bindings/kafka/groupId")).toBeNull();
    expect(bindingFieldSchema("/servers/0/bindings/kafka/groupId")).toBeNull();
    expect(bindingFieldSchema("/operations/0/bindings/kafka/key")).toBeNull();
    expect(bindingFieldSchema("/operations/0/bindings/ws/query")).toBeNull();
    expect(bindingFieldSchema("/messages/0/bindings/ws/query")).toBeNull();
  });

  it("returns null for a protocol or a field the catalog does not know, and for the JSON fallback of an unknown protocol", () => {
    expect(bindingFieldSchema("/channels/0/bindings/acme/query")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/acme/json")).toBeNull();
    expect(bindingFieldSchema("/servers/0/bindings/googlepubsub/json")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/ws/unknown")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/kafka/topic")).toBeNull();
  });

  it("returns null above a raw-JSON field (the protocol, a list, an object) and below it (inside the JSON the user writes)", () => {
    expect(bindingFieldSchema("/channels/0/bindings/ws")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/sns/policy/statements/1")).toBeNull();
    expect(bindingFieldSchema("/servers/0/bindings/jms/properties/3")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/ws/query/type")).toBeNull();
    expect(bindingFieldSchema("/channels/0/bindings/ws/query/properties/q")).toBeNull();
  });

  it("returns null for a pointer that is not in a binding at all, or is malformed", () => {
    for (const pointer of [
      "", "/", "/info/title", "/channels", "/channels/0", "/channels/0/bindings/",
      "/traits/0/spec/bindings/kafka/key", "/components/messageTraits/0/bindings/kafka/key",
      "/channels/x/bindings/ws/query", "/channels//bindings/ws/query", "/channels/-1/bindings/ws/query", "/channels/1.5/bindings/ws/query",
      "/channels/0/binding/ws/query", "/channel/0/bindings/ws/query", "channels/0/bindings/ws/query", "/CHANNELS/0/bindings/ws/query",
      "/servers/0/bindings/jms/properties/x/value", "/servers/0/bindings/jms/properties//value", "/servers/0/bindings/jms/properties/-/value",
      "/channels/0/bindings/ws/query/", "/channels/0/bindings/ws//query",
    ]) expect(bindingFieldSchema(pointer), pointer).toBeNull();
  });

  it("is not fooled by names that live on every object", () => {
    for (const name of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      expect(bindingFieldSchema(`/channels/0/bindings/${name}/query`), name).toBeNull();
      expect(bindingFieldSchema(`/channels/0/bindings/ws/${name}`), name).toBeNull();
      expect(bindingFieldSchema(`/${name}/0/bindings/ws/query`), name).toBeNull();
    }
  });

  it("hands out the same object every time (an editor compares schemas by identity first)", () => {
    expect(bindingFieldSchema("/operations/0/bindings/kafka/groupId")).toBe(bindingFieldSchema("/operations/7/bindings/kafka/groupId"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The generator's inlining, on small documents of its own: the real files only show the cases they happen to contain.
// ---------------------------------------------------------------------------------------------------------------

describe("generateBindingJsonSchemas: inlining", () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  const ACME = "http://asyncapi.com/bindings/acme/1.0.0/channel.json";
  const DEFINITIONS = "http://asyncapi.com/definitions/3.0.0";

  /** A throw-away `@asyncapi/specs` with one binding (`acme` channel) and the given extra files (relative path -> JSON). */
  function specs(binding: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wpv2-specs-"));
    roots.push(root);
    const files: Record<string, unknown> = {
      "bindings/acme/1.0.0/channel.json": { $schema: "http://json-schema.org/draft-07/schema#", $id: ACME, type: "object", ...binding },
      "definitions/3.0.0/Reference.json": {
        type: "object", required: ["$ref"],
        properties: { $ref: { description: "The reference string.", $ref: `${DEFINITIONS}/ReferenceObject.json` } },
        example: { $ref: "http://asyncapi.com/examples/3.0.0/ReferenceObject.json" },
        $id: `${DEFINITIONS}/Reference.json`,
      },
      "definitions/3.0.0/ReferenceObject.json": { type: "string", format: "uri-reference", $id: `${DEFINITIONS}/ReferenceObject.json` },
      "package.json": { version: "0.0.0-test" },
      ...extra,
    };
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), JSON.stringify(content));
    }
    return root;
  }

  const leaf = (key: string, extra: Partial<FieldTemplate> = {}): FieldTemplate => ({ key, label: key, kind: "json", group: "basics", ...extra });
  const catalog = (...fields: FieldTemplate[]): GeneratedBindings => ({ acme: { channel: { version: "1.0.0", fields } } });
  const inline = (binding: Record<string, unknown>, fields: FieldTemplate[], extra: Record<string, unknown> = {}) =>
    generateBindingJsonSchemas(specs(binding, extra), catalog(...fields));

  it("inlines references to the same file, whether written `#/definitions/x` or with the file's own address", () => {
    const { schemas } = inline(
      {
        properties: {
          a: { $ref: "#/definitions/thing" },
          b: { $ref: `${ACME}#/definitions/thing` },
        },
        definitions: { thing: { type: "object", properties: { n: { $ref: "#/definitions/count" } } }, count: { type: "integer", minimum: 0 } },
      },
      [leaf("a"), leaf("b")],
    );
    const expected = { type: "object", properties: { n: { type: "integer", minimum: 0 } } };
    expect(schemas["acme.channel.a"]).toEqual(expected);
    expect(schemas["acme.channel.b"]).toEqual(expected);
  });

  it("drops $id, $schema, $comment, definitions, examples and example, and keeps what a value is checked against", () => {
    const { schemas } = inline(
      {
        properties: {
          a: {
            $id: "x", $schema: "y", $comment: "z", examples: [{ n: 1 }], example: { n: 1 },
            type: "object", required: ["n"], additionalProperties: false,
            properties: { n: { type: "integer", default: 3, enum: [1, 2, 3] } },
            definitions: { unused: { type: "string" } },
          },
        },
      },
      [leaf("a")],
    );
    expect(schemas["acme.channel.a"]).toEqual({
      type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer", default: 3, enum: [1, 2, 3] } },
    });
  });

  it("resolves a reference to another file by its address, with that file's own local references", () => {
    const { schemas } = inline(
      { properties: { a: { $ref: `${DEFINITIONS}/shape.json` } } },
      [leaf("a")],
      { "definitions/3.0.0/shape.json": { type: "object", properties: { size: { $ref: "#/definitions/size" } }, definitions: { size: { type: "number" } } } },
    );
    expect(schemas["acme.channel.a"]).toEqual({ type: "object", properties: { size: { type: "number" } } });
  });

  it("cuts a cycle with {} instead of looping, and reports it", () => {
    const { schemas, cycles } = inline(
      { properties: { a: { $ref: `${DEFINITIONS}/node.json` } } },
      [leaf("a")],
      {
        "definitions/3.0.0/node.json": {
          $id: `${DEFINITIONS}/node.json`, type: "object",
          properties: { value: { type: "string" }, child: { $ref: `${DEFINITIONS}/node.json` }, children: { type: "array", items: { $ref: "#" } } },
        },
      },
    );
    expect(schemas["acme.channel.a"]).toEqual({
      type: "object",
      properties: { value: { type: "string" }, child: {}, children: { type: "array", items: {} } },
    });
    expect(cycles).toEqual([`${DEFINITIONS}/node.json#`]);
  });

  it("cuts a cycle that runs through two definitions, and inlines the same definition again where it is not a cycle", () => {
    const { schemas, cycles } = inline(
      {
        properties: { a: { type: "object", properties: { first: { $ref: "#/definitions/even" }, second: { $ref: "#/definitions/even" } } } },
        definitions: {
          even: { type: "object", properties: { next: { $ref: "#/definitions/odd" } } },
          odd: { type: "object", properties: { next: { $ref: "#/definitions/even" } } },
        },
      },
      [leaf("a")],
    );
    const unrolled = { type: "object", properties: { next: { type: "object", properties: { next: {} } } } };
    expect(schemas["acme.channel.a"]).toEqual({ type: "object", properties: { first: unrolled, second: unrolled } });
    expect(cycles).toEqual([`${ACME}#/definitions/even`]);
  });

  it("lets the description next to a $ref win, and ignores every other keyword next to it (draft-07)", () => {
    const { schemas } = inline(
      {
        properties: { a: { $ref: "#/definitions/id", description: "Where it is used.", type: "number", minimum: 5 } },
        definitions: { id: { type: "string", description: "Generic." } },
      },
      [leaf("a")],
    );
    expect(schemas["acme.channel.a"]).toEqual({ type: "string", description: "Where it is used." });
  });

  it("reads oneOf [x, Reference] as anyOf, and leaves every other oneOf alone", () => {
    const { schemas } = inline(
      {
        properties: {
          a: { oneOf: [{ type: "string" }, { $ref: `${DEFINITIONS}/Reference.json` }] },
          b: { oneOf: [{ type: "string" }, { type: "array" }] },
        },
      },
      [leaf("a"), leaf("b")],
    );
    expect(schemas["acme.channel.a"]).toEqual({
      anyOf: [
        { type: "string" },
        { type: "object", required: ["$ref"], properties: { $ref: { description: "The reference string.", type: "string", format: "uri-reference" } } },
      ],
    });
    expect(schemas["acme.channel.b"]).toEqual({ oneOf: [{ type: "string" }, { type: "array" }] });
  });

  it("does not take a property NAMED $ref for a reference, nor a $ref inside data (enum, const, default)", () => {
    const { schemas } = inline(
      {
        properties: {
          a: {
            type: "object", required: ["$ref"], properties: { $ref: { type: "string" } },
            default: { $ref: "elsewhere.json" }, enum: [{ $ref: "#/nowhere" }],
          },
        },
      },
      [leaf("a")],
    );
    expect(schemas["acme.channel.a"]).toEqual({
      type: "object", required: ["$ref"], properties: { $ref: { type: "string" } }, default: { $ref: "elsewhere.json" }, enum: [{ $ref: "#/nowhere" }],
    });
  });

  it("keeps true and false, which are schemas too", () => {
    const { schemas } = inline(
      { properties: { a: { type: "object", additionalProperties: false, properties: { anything: true, nothing: false } } } },
      [leaf("a")],
    );
    expect(schemas["acme.channel.a"]).toEqual({ type: "object", additionalProperties: false, properties: { anything: true, nothing: false } });
  });

  it("finds a field inside a list and inside an object, the way the form template nests them", () => {
    const { schemas } = inline(
      {
        properties: {
          policy: {
            type: "object",
            properties: { statements: { type: "array", items: { $ref: "#/definitions/statement" } } },
          },
        },
        definitions: { statement: { type: "object", properties: { rule: { type: "string", description: "The rule." } } } },
      },
      [{
        key: "policy", label: "Policy", kind: "object", group: "basics",
        fields: [{ key: "statements", label: "Statements", kind: "list", group: "basics", fields: [leaf("rule")] }],
      }],
    );
    expect(Object.keys(schemas)).toEqual(["acme.channel.policy.statements.[].rule"]);
    expect(schemas["acme.channel.policy.statements.[].rule"]).toEqual({ type: "string", description: "The rule." });
  });

  it("stops, naming the address, at a reference it cannot read, rather than silently validating nothing", () => {
    expect(() => inline({ properties: { a: { $ref: "https://example.com/elsewhere.json" } } }, [leaf("a")])).toThrow(/https:\/\/example\.com\/elsewhere\.json/);
    expect(() => inline({ properties: { a: { $ref: `${DEFINITIONS}/missing.json` } } }, [leaf("a")])).toThrow();
    expect(() => inline({ properties: { a: { $ref: "../../etc/passwd.json" } } }, [leaf("a")])).toThrow();
    expect(() => inline({ properties: { a: { $ref: `${DEFINITIONS}/../../package.json` } } }, [leaf("a")])).toThrow(/Cannot inline/);
  });

  it("stops at a reference whose pointer leads nowhere", () => {
    expect(() => inline({ properties: { a: { $ref: "#/definitions/nope" } } }, [leaf("a")])).toThrow(/does not point at anything/);
  });

  it("stops at a field that has no property in its binding file", () => {
    expect(() => inline({ properties: { a: { type: "string" } } }, [leaf("gone")])).toThrow(/no property at "gone"/);
  });

  it("gives the same output for the same input", () => {
    const binding = { properties: { a: { $ref: "#/definitions/t" }, b: { $ref: "#/definitions/t" } }, definitions: { t: { type: "object", properties: { z: { type: "string" }, y: { type: "number" } } } } };
    const first = JSON.stringify(inline(binding, [leaf("a"), leaf("b")]));
    expect(JSON.stringify(inline(binding, [leaf("a"), leaf("b")]))).toBe(first);
  });
});

describe("the real catalog's references", () => {
  it("are inlined, with the cyclic ones the AsyncAPI and draft-07 schemas have cut and nothing else", () => {
    const { cycles } = generateBindingJsonSchemas(SPECS_ROOT, GENERATED_BINDINGS);
    expect(cycles).toEqual([
      "http://asyncapi.com/definitions/3.0.0/schema.json#",
      "http://json-schema.org/draft-07/schema#",
    ]);
  });
});
