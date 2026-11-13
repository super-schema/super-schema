/**
 * Value-schema subset for metadata attribute definitions.
 *
 * Supported keywords: type (string/number/integer/boolean/array/object), enum,
 * format, pattern, minimum, maximum, minLength, maxLength, items, properties,
 * required. Anything else is rejected at definition time.
 */

export type ValueSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface ValueSchema {
  type: ValueSchemaType;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: ValueSchema;
  properties?: Record<string, ValueSchema>;
  required?: string[];
}

export interface ValueProblem {
  path: string;
  message: string;
}

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const KEYWORDS = new Set([
  "type", "enum", "format", "pattern", "minimum", "maximum", "minLength", "maxLength", "items", "properties", "required",
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns the problems with `schema`; an empty list means it is within the subset. */
export function checkValueSchema(schema: unknown, path = ""): string[] {
  const at = path === "" ? "valueSchema" : `valueSchema${path}`;
  if (!isObj(schema)) return [`${at} must be an object`];
  const problems: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) problems.push(`${at}: keyword "${k}" is not supported`);
  }
  if (typeof schema.type !== "string" || !TYPES.has(schema.type)) {
    problems.push(`${at}.type must be one of ${[...TYPES].join(", ")}`);
  }
  if ("enum" in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) problems.push(`${at}.enum must be a non-empty array`);
  if ("format" in schema && typeof schema.format !== "string") problems.push(`${at}.format must be a string`);
  if ("pattern" in schema) {
    if (typeof schema.pattern !== "string") problems.push(`${at}.pattern must be a string`);
    else {
      try {
        new RegExp(schema.pattern);
      } catch {
        problems.push(`${at}.pattern is not a valid regular expression`);
      }
    }
  }
  for (const k of ["minimum", "maximum", "minLength", "maxLength"] as const) {
    if (k in schema && (typeof schema[k] !== "number" || !Number.isFinite(schema[k]))) problems.push(`${at}.${k} must be a number`);
  }
  if ("required" in schema && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string"))) {
    problems.push(`${at}.required must be an array of strings`);
  }
  if ("items" in schema) problems.push(...checkValueSchema(schema.items, `${path}/items`));
  if ("properties" in schema) {
    if (!isObj(schema.properties)) problems.push(`${at}.properties must be an object`);
    else for (const [name, sub] of Object.entries(schema.properties)) problems.push(...checkValueSchema(sub, `${path}/properties/${name}`));
  }
  return problems;
}

const escapePtr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function typeOk(value: unknown, type: ValueSchemaType): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isObj(value);
  }
}

/** Validates `value` against a subset schema. Paths are JSON pointers ("" = root). */
export function validateValue(value: unknown, schema: ValueSchema, path = ""): ValueProblem[] {
  if (!typeOk(value, schema.type)) return [{ path, message: `must be of type ${schema.type}` }];
  const out: ValueProblem[] = [];
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push({ path, message: `must match pattern ${schema.pattern}` });
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => out.push(...validateValue(v, schema.items!, `${path}/${i}`)));
  }
  if (isObj(value)) {
    for (const r of schema.required ?? []) {
      if (!(r in value)) out.push({ path: `${path}/${escapePtr(r)}`, message: "is required" });
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (name in value) out.push(...validateValue(value[name], sub, `${path}/${escapePtr(name)}`));
    }
  }
  return out;
}
