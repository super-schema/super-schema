/**
 * JSON Schema inference from a sample value.
 *
 * Ported from jsonjoy-builder's `schema-inference.ts` (MIT, © Ophir LOJKINE)
 * and trimmed to the subset Super Schema's onboarding needs. Pure, zero-dep —
 * safe to run on the server or client. It turns a pasted *sample event*
 * (ordinary JSON data, not a schema) into a draft JSON Schema document, which
 * then feeds `parseJsonSchema()` like any other imported JSON Schema.
 *
 *   paste sample JSON → inferJsonSchema() → JSON Schema → parseJsonSchema() → IR
 */

type JsonSchema = Record<string, unknown>;

function inferStringSchema(str: string): JsonSchema {
  const formats: Record<string, RegExp> = {
    date: /^\d{4}-\d{2}-\d{2}$/,
    "date-time":
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/,
    email: /^[^@]+@[^@]+\.[^@]+$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    uri: /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i,
  };
  for (const [format, regex] of Object.entries(formats)) {
    if (regex.test(str)) return { type: "string", format };
  }
  return { type: "string" };
}

function inferNumberSchema(num: number): JsonSchema {
  return Number.isInteger(num) ? { type: "integer" } : { type: "number" };
}

function inferObjectSchema(obj: Record<string, unknown>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    // defineProperty: a `__proto__` key must stay own data, not set the prototype.
    Object.defineProperty(properties, key, { value: inferSchema(value), enumerable: true, writable: true, configurable: true });
    if (value !== undefined && value !== null) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: required.sort() } : {}),
  };
}

function inferArraySchema(arr: unknown[]): JsonSchema {
  if (arr.length === 0) return { type: "array", items: {} };
  const itemSchemas = arr.map((item) => inferSchema(item));
  const first = itemSchemas[0];
  const allSame = itemSchemas.every(
    (s) => JSON.stringify(s) === JSON.stringify(first)
  );
  if (allSame) return { type: "array", items: first };

  // Mixed item types → unique union via oneOf
  const unique = [
    ...new Map(itemSchemas.map((s) => [JSON.stringify(s), s])).values(),
  ];
  return {
    type: "array",
    items: unique.length === 1 ? unique[0] : { oneOf: unique },
  };
}

/** Infer a bare schema fragment for a single parsed JSON value. */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  const t = Array.isArray(value) ? "array" : typeof value;
  switch (t) {
    case "object":
      return inferObjectSchema(value as Record<string, unknown>);
    case "array":
      return inferArraySchema(value as unknown[]);
    case "string":
      return inferStringSchema(value as string);
    case "number":
      return inferNumberSchema(value as number);
    case "boolean":
      return { type: "boolean" };
    default:
      return {};
  }
}

/**
 * Build a complete JSON Schema document from a sample value. The root is always
 * normalized to an object schema (a primitive/array root is wrapped). Returns a
 * plain object; stringify it before handing to `parseJsonSchema`.
 */
export function inferJsonSchema(sample: unknown, title = "ImportedEntity"): JsonSchema {
  const inferred = inferSchema(sample);
  const root: JsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    type: "object",
  };

  if (inferred.type === "object" && inferred.properties) {
    root.properties = inferred.properties;
    if (inferred.required) root.required = inferred.required;
  } else if (inferred.type === "array") {
    // Wrap an array root under a single `items` property so it imports as an entity.
    root.properties = { items: inferred };
    root.required = ["items"];
  } else {
    root.properties = { value: inferred };
    root.required = ["value"];
  }

  return root;
}
