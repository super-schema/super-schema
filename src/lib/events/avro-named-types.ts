import type { JsonObject, JsonValue } from "@/lib/event-specs/types";
import { ok, err, type Result } from "@/types/result";

const NAMED_TYPES = new Set(["record", "error", "enum", "fixed"]);

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** A definition without the attributes that only spell its full name (they are equal by construction when compared). */
function withoutNaming(def: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(def).filter(([key]) => key !== "name" && key !== "namespace"));
}

/** Avro fullname of a named type definition, given the namespace it is defined in. */
function fullName(def: JsonObject, enclosing: string): { fullName: string; namespace: string } {
  const name = typeof def.name === "string" ? def.name : "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0) return { fullName: name, namespace: name.slice(0, dot) };
  const namespace = typeof def.namespace === "string" ? def.namespace : enclosing;
  return { fullName: namespace ? `${namespace}.${name}` : name, namespace };
}

/**
 * The `@typespec/avro` emitter inlines a nested record / enum at EVERY use of a model, so an entity that is used
 * twice (`billing: Address; shipping: Address;`, or `Address[]` next to an `Address`) yields a schema that defines
 * the named type twice — which Avro parsers reject ("Can't redefine: ns.Address"; spec: a name may be defined only
 * once, later uses refer to it by name). Walking the schema in document order (the order Avro parsers process it),
 * the first definition of each named type stays where it is and every later IDENTICAL definition becomes a
 * reference to its full name. A later definition of the same full name with a different body cannot be expressed
 * as a reference and is `AVRO_NAME_CONFLICT`. The input is never mutated.
 */
export function dedupeAvroNamedTypes(schema: JsonObject): Result<JsonObject> {
  const defined = new Map<string, JsonObject>();
  const conflicts = new Set<string>();

  function visit(node: JsonValue, enclosing: string): JsonValue {
    if (Array.isArray(node)) return node.map((member) => visit(member, enclosing));
    if (!isObject(node)) return node;
    const type = node.type;

    if (typeof type === "string" && NAMED_TYPES.has(type)) {
      const { fullName: name, namespace } = fullName(node, enclosing);
      const prior = defined.get(name);
      if (prior) {
        if (deepEqual(withoutNaming(prior), withoutNaming(node))) return name;
        conflicts.add(name);
        return node;
      }
      defined.set(name, node);
      if ((type === "record" || type === "error") && Array.isArray(node.fields)) {
        return {
          ...node,
          fields: node.fields.map((field) => (isObject(field) && field.type !== undefined ? { ...field, type: visit(field.type, namespace) } : field)),
        };
      }
      return node;
    }
    if (type === "array" && node.items !== undefined) return { ...node, items: visit(node.items, enclosing) };
    if (type === "map" && node.values !== undefined) return { ...node, values: visit(node.values, enclosing) };
    if (typeof type === "object" && type !== null) return { ...node, type: visit(type, enclosing) };
    return node;
  }

  const result = visit(schema, "");
  if (conflicts.size > 0) {
    const names = [...conflicts];
    return err({
      code: "AVRO_NAME_CONFLICT",
      message: `The Avro schema defines ${names.map((n) => `"${n}"`).join(", ")} more than once with different bodies`,
      details: { names },
    });
  }
  return ok(result as JsonObject);
}
