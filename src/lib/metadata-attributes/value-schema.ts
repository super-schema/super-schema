/**
 * Value-schema subset for metadata attribute definitions.
 *
 * Supported keywords: type (string/number/integer/boolean/array/object), enum,
 * format, pattern, minimum, maximum, minLength, maxLength, items, properties,
 * required. Anything else is rejected at definition time.
 *
 * Tenant-defined patterns run on the server, so they are bounded (ReDoS): a `pattern` is at most 256 characters and has no nested quantifier
 * (`hasNestedQuantifier`, a heuristic); a value longer than 10,000 characters is not tested against a pattern; a schema nests at most 10
 * levels deep.
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

/** The longest `pattern` a definition may carry (tenant-defined patterns run on the server: D1, ReDoS). */
export const MAX_PATTERN_LENGTH = 256;
/** A string value longer than this is not tested against a pattern (the pattern test is skipped and reported). */
export const MAX_PATTERN_INPUT_LENGTH = 10_000;
/** How deep `items` / `properties` may nest. */
export const MAX_SCHEMA_DEPTH = 10;

/**
 * True when `pattern` holds a NESTED QUANTIFIER: a group repeated by `*`, `+` or `{n,m}` that itself contains a quantifier (`(a+)+`,
 * `(a*)*`, `((ab)*)+`, `(a{1,3})+`) or an alternation (`(a|aa)+`). Those are the shapes of catastrophic backtracking.
 *
 * A simple heuristic, not a regex engine: it walks the pattern once, skipping escapes (`\(`) and character classes (`[(a+)]`), keeping a
 * stack of open groups. It errs on the strict side (`(foo|bar)+` is refused too, though it is linear): such a pattern can be rewritten,
 * e.g. `(?:foo|bar)` once, or a character class.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  type Frame = { quantified: boolean; alternation: boolean };
  const stack: Frame[] = [{ quantified: false, alternation: false }];
  const top = () => stack[stack.length - 1];
  /** The length of the repeating quantifier at `i` (`*`, `+`, `{n}`, `{n,}`, `{n,m}`), 0 when there is none. */
  const repeatAt = (i: number): number => {
    const c = pattern[i];
    if (c === "*" || c === "+") return 1;
    if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      return m ? m[0].length : 0;
    }
    return 0;
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      // Skip the class: `]` right after `[` or `[^` is a literal.
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      for (; j < pattern.length && pattern[j] !== "]"; j++) if (pattern[j] === "\\") j++;
      i = j;
      continue;
    }
    if (c === "(") {
      stack.push({ quantified: false, alternation: false });
      // `(?:`, `(?=`, `(?<name>`: the `?` is the group's kind, not a quantifier.
      if (pattern[i + 1] === "?") i++;
      continue;
    }
    if (c === "|") {
      top().alternation = true;
      continue;
    }
    if (c === ")") {
      const group = stack.length > 1 ? stack.pop()! : { quantified: false, alternation: false };
      const repeat = repeatAt(i + 1);
      if (repeat > 0 && (group.quantified || group.alternation)) return true;
      // A group that holds a repeat makes its parent hold one (its own quantifier, if any, is read as the next character).
      if (group.quantified) top().quantified = true;
      continue;
    }
    if (repeatAt(i) > 0 || c === "?") top().quantified = true;
  }
  return false;
}

/** Returns the problems with `schema`; an empty list means it is within the subset. */
export function checkValueSchema(schema: unknown, path = "", depth = 0): string[] {
  const at = path === "" ? "valueSchema" : `valueSchema${path}`;
  if (depth > MAX_SCHEMA_DEPTH) return [`${at}: the schema is nested more than ${MAX_SCHEMA_DEPTH} levels`];
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
    else if (schema.pattern.length > MAX_PATTERN_LENGTH) problems.push(`${at}.pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
    else if (hasNestedQuantifier(schema.pattern)) {
      problems.push(`${at}.pattern has a nested quantifier (a repeated group that repeats inside, e.g. (a+)+ or (a|aa)+), which can take exponential time`);
    } else {
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
  if ("items" in schema) problems.push(...checkValueSchema(schema.items, `${path}/items`, depth + 1));
  if ("properties" in schema) {
    if (!isObj(schema.properties)) problems.push(`${at}.properties must be an object`);
    else for (const [name, sub] of Object.entries(schema.properties)) problems.push(...checkValueSchema(sub, `${path}/properties/${name}`, depth + 1));
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
    if (schema.pattern !== undefined) {
      // A very long value is never run through a tenant-defined pattern (D1): the check is skipped and reported instead.
      if (value.length > MAX_PATTERN_INPUT_LENGTH) out.push({ path, message: "value too long to check pattern" });
      else if (!new RegExp(schema.pattern).test(value)) out.push({ path, message: `must match pattern ${schema.pattern}` });
    }
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
