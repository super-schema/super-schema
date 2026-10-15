/**
 * Final review F5, M3: a payload property or `$defs` entry NAMED `__proto__` used to vanish in the passes that run after
 * the down-conversion (`mapSchemaRefs`, `inlineJsonSchemaBundle`): `out["__proto__"] = subschema` sets the prototype of
 * `out` instead of creating an entry. The whole chain now keeps it.
 */
import { describe, it, expect } from "vitest";
import { mapSchemaRefs } from "@/lib/event-specs/json-schema-keywords";
import { downConvertToDraft07 } from "@/lib/event-specs/json-schema-downconvert";
import { rebaseLocalRefs } from "@/lib/event-specs/message-schemas";
import { inlineJsonSchemaBundle } from "@/lib/events/json-schema-bundle";
import type { JsonObject } from "@/lib/event-specs/types";

/** JSON.parse creates a genuine own `__proto__` property (an object literal would set the prototype instead). */
const parsed = (text: string): JsonObject => JSON.parse(text) as JsonObject;

const keys = (value: unknown): string[] => Object.keys(value as object);
const hasPlainPrototype = (value: unknown): boolean => Object.getPrototypeOf(value) === Object.prototype;

describe("a __proto__ property / $defs entry survives the schema passes", () => {
  const schema = parsed(
    '{"type":"object","properties":{"__proto__":{"$ref":"#/$defs/__proto__"},"ok":{"type":"string"}},"$defs":{"__proto__":{"type":"integer"}},"patternProperties":{"__proto__":{"type":"boolean"}},"dependencies":{"__proto__":{"required":["ok"]}}}'
  );

  it("mapSchemaRefs keeps property, $defs, patternProperties and dependencies entries and rewrites the refs inside them", () => {
    const out = mapSchemaRefs(schema, (ref) => `#/rebased${ref.slice(1)}`);
    for (const container of [out.properties, out.$defs, out.patternProperties, out.dependencies]) {
      expect(keys(container)).toContain("__proto__");
      expect(hasPlainPrototype(container)).toBe(true);
    }
    expect(keys(out.properties)).toEqual(["__proto__", "ok"]);
    expect(JSON.stringify(out.properties)).toContain('"__proto__":{"$ref":"#/rebased/$defs/__proto__"}');
    expect(JSON.stringify(out.$defs)).toBe('{"__proto__":{"type":"integer"}}');
  });

  it("mapSchemaRefs keeps a keyword literally called __proto__ (copied as data)", () => {
    const out = mapSchemaRefs(parsed('{"type":"object","__proto__":{"x":1}}'), (ref) => ref);
    expect(keys(out)).toEqual(["type", "__proto__"]);
    expect(hasPlainPrototype(out)).toBe(true);
  });

  it("down-conversion followed by ref rebasing (the payload pipeline) keeps the entries", () => {
    const converted = downConvertToDraft07(schema).schema;
    const rebased = rebaseLocalRefs(converted, "/components/messages/M/payload/schema");
    expect(keys(rebased.properties)).toEqual(["__proto__", "ok"]);
    expect(keys(rebased.definitions)).toEqual(["__proto__"]);
    expect(JSON.stringify(rebased.properties)).toContain("#/components/messages/M/payload/schema/definitions/__proto__");
  });

  it("inlineJsonSchemaBundle keeps a model called __proto__ and a property called __proto__", () => {
    const bundle = parsed(
      '{"$id":"Order","$defs":{"Order":{"$id":"Order.json","type":"object","properties":{"__proto__":{"$ref":"__proto__.json"},"ok":{"type":"string"}}},"__proto__":{"$id":"__proto__.json","type":"object","properties":{"x":{"type":"string"}}}}}'
    );
    const r = inlineJsonSchemaBundle(bundle, "Order");
    if (!r.success) throw new Error(r.error.message);
    expect(keys(r.data.properties)).toEqual(["__proto__", "ok"]);
    expect(keys(r.data.$defs)).toEqual(["__proto__"]);
    expect(hasPlainPrototype(r.data.$defs)).toBe(true);
    expect(JSON.stringify(r.data.properties)).toContain('"__proto__":{"$ref":"#/$defs/__proto__"}');
  });
});
