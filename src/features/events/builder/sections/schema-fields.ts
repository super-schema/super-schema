// src/features/events/builder/sections/schema-fields.ts
// A short, read-only summary of the fields of a JSON Schema (the schema the server renders for an entity): the first level of
// `properties`, read through `allOf` members and `$ref`s into `$defs` / `definitions`. Pure — no React. It is a preview for a person, not a
// validator: a schema it cannot read (no properties, a `$ref` it cannot follow, a cycle) simply gives no rows.

type Schema = Record<string, unknown>;
const isRecord = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SchemaFieldRow { name: string; type: string; required: boolean }

/** How deep `allOf` members are followed (a guard, not a feature: real schemas nest a level or two). */
const MAX_DEPTH = 8;

/** The node a local `$ref` (`#/$defs/X`, `#/definitions/X`) points at, following a chain of refs; null when it cannot be followed. */
function resolve(root: Schema, node: Schema, seen: Set<string> = new Set()): Schema | null {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match || seen.has(ref)) return null;
  seen.add(ref);
  const group = root[match[1]];
  const target = isRecord(group) ? group[match[2]] : undefined;
  return isRecord(target) ? resolve(root, target, seen) : null;
}

/** The properties and required names of `node`, with its `allOf` members merged in (after its own). */
function collect(root: Schema, node: Schema, depth = 0): { properties: Map<string, unknown>; required: Set<string> } | null {
  const resolved = resolve(root, node);
  if (!resolved) return null;
  const properties = new Map<string, unknown>();
  const required = new Set<string>();
  if (isRecord(resolved.properties)) for (const [name, value] of Object.entries(resolved.properties)) properties.set(name, value);
  if (Array.isArray(resolved.required)) for (const name of resolved.required) if (typeof name === "string") required.add(name);
  if (Array.isArray(resolved.allOf) && depth < MAX_DEPTH) {
    for (const member of resolved.allOf) {
      const part = isRecord(member) ? collect(root, member, depth + 1) : null;
      if (!part) continue;
      for (const [name, value] of part.properties) if (!properties.has(name)) properties.set(name, value);
      for (const name of part.required) required.add(name);
    }
  }
  return { properties, required };
}

const refName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

/** What a person would call the type of one property: its type (with format), a referenced name, `T[]`, or what it is when it has no type. */
function typeLabel(value: unknown): string {
  if (!isRecord(value)) return "any";
  if (typeof value.$ref === "string") return refName(value.$ref);
  const type = value.type;
  if (type === "array") {
    const items = isRecord(value.items) ? value.items : null;
    if (!items) return "array";
    if (typeof items.$ref === "string") return `${refName(items.$ref)}[]`;
    return typeof items.type === "string" ? `${items.type}[]` : "array";
  }
  if (typeof type === "string") return typeof value.format === "string" ? `${type} (${value.format})` : type;
  if (Array.isArray(type) && type.every((t) => typeof t === "string") && type.length > 0) return type.join(" | ");
  if (Array.isArray(value.enum)) return "enum";
  if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf)) return "one of";
  if (isRecord(value.properties)) return "object";
  return "any";
}

/** The first `limit` fields of `schema` and how many more there are. A schema that gives no fields gives `{ rows: [], more: 0 }`. */
export function summarizeSchemaFields(schema: Schema | null, limit = 8): { rows: SchemaFieldRow[]; more: number } {
  if (!schema) return { rows: [], more: 0 };
  const found = collect(schema, schema);
  if (!found) return { rows: [], more: 0 };
  const all = [...found.properties].map(([name, value]): SchemaFieldRow => ({ name, type: typeLabel(value), required: found.required.has(name) }));
  return { rows: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
