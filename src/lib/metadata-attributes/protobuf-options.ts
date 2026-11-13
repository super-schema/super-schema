/**
 * Metadata attributes as Protobuf custom options.
 *
 * - `buildOptionsProto` writes `superschema/metadata_options.proto`: for each `schema`-scope attribute used, a value type (an object value
 *   schema becomes a `<Pascal(key)>Value` message) and an extension of `google.protobuf.FieldOptions` (field attributes) and/or
 *   `google.protobuf.MessageOptions` (entity attributes) at the attribute's `protobufOptionNumber`.
 * - `annotateProto` sets the values on an emitted `.proto`: `[(.superschema.metadata.<name>) = <text format>]` on a field line,
 *   `option (.superschema.metadata.<name>) = <text format>;` inside the entity's message, and imports the options file. Option names are
 *   fully qualified (leading dot) so an entity package with a `superschema` segment cannot capture them.
 *
 * `internal` attributes never produce anything. A value that fails its value schema is left out with a warning naming the field and the
 * key. A definition Protobuf cannot express (no option number, a nested array, two names that collapse into one) is left out with a
 * warning. Pure: the input is never mutated, and a file with nothing to annotate comes back as the same object.
 */

import { protobufFieldName, sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { readEntityAttributes, readFieldAttributes } from "@/lib/metadata-attributes/values";
import { validateValue, type ValueSchema } from "@/lib/metadata-attributes/value-schema";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { SuperSchemaModel } from "@/types/super-schema-model";

export const METADATA_OPTIONS_PROTO_PATH = "superschema/metadata_options.proto";
const PACKAGE = "superschema.metadata";

/** What the options need of a definition: a stored row (`MetadataAttributeRecord`) is one. */
export type ProtoOptionDefinition = Pick<MetadataAttributeDefinition, "key" | "scope" | "targets" | "valueSchema"> & {
  protobufOptionNumber?: number | null;
};

/** Where `annotateProto` reports: the warnings it raised and the keys it wrote (what `buildOptionsProto` must then declare). */
export interface ProtoOptionReport {
  warnings?: string[];
  used?: Set<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The option name of a key: camelCase split to snake case, every other non-alphanumeric `_`, lowercased (`x-securityClassification` → `x_security_classification`). */
export function protoOptionName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]/g, "_")
    .toLowerCase();
}

const pascal = (snake: string): string =>
  snake
    .split("_")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Value";

/** A value schema property name as a `.proto` field name (the rule the emitter applies to model properties). */
const protoPropertyName = (name: string): string => protobufFieldName(name);

/** A Protobuf type for a value schema, with the nested message declarations it needs. */
interface ProtoType {
  /** `string`, `int64`, … or the message's (relative) name. */
  name: string;
  repeated: boolean;
  /** The declaration lines of the message, when the type is one (unindented). */
  message?: string[];
  /** The value schema of one value (an array's items). */
  element: ValueSchema;
}

class Unrepresentable extends Error {}

/** An integer value a JavaScript number cannot hold exactly (beyond 2^53): writing it would put a different number on the wire. */
class UnsafeInteger extends Error {
  constructor(readonly path: string) {
    super(path);
  }
}

const SCALARS: Record<string, string> = { string: "string", integer: "int64", number: "double", boolean: "bool" };

/** The lines of `message <name> { … }` for an object value schema: property fields numbered 1.. in property order, nested messages first. */
function messageLines(name: string, schema: ValueSchema): string[] {
  const nested: string[] = [];
  const fieldLines: string[] = [];
  const fieldNames = new Set<string>();
  const messageNames = new Set<string>();
  Object.entries(schema.properties ?? {}).forEach(([prop, sub], i) => {
    const fieldName = protoPropertyName(prop);
    if (fieldNames.has(fieldName)) throw new Unrepresentable(`properties "${prop}" and another one are both "${fieldName}" in Protobuf`);
    fieldNames.add(fieldName);
    let messageName = pascal(fieldName);
    for (let n = 2; messageNames.has(messageName); n++) messageName = `${pascal(fieldName)}${n}`;
    const type = protoType(sub, messageName, true);
    if (type.message) {
      messageNames.add(messageName);
      nested.push(...type.message.map((line) => `  ${line}`));
    }
    fieldLines.push(`  ${type.repeated ? "repeated " : ""}${type.name} ${fieldName} = ${i + 1};`);
  });
  return [`message ${name} {`, ...nested, ...fieldLines, "}"];
}

function protoType(schema: ValueSchema, messageName: string, nestedArrayIsError: boolean): ProtoType {
  if (schema.type === "array") {
    const items = schema.items;
    if (!items) return { name: "string", repeated: true, element: { type: "string" } };
    if (items.type === "array" && nestedArrayIsError) throw new Unrepresentable("an array of arrays has no Protobuf form");
    const inner = protoType(items, messageName, true);
    return { ...inner, repeated: true, element: items };
  }
  if (schema.type === "object") return { name: messageName, repeated: false, message: messageLines(messageName, schema), element: schema };
  return { name: SCALARS[schema.type] ?? "string", repeated: false, element: schema };
}

/** What a definition becomes in the options file, or why it cannot. */
type Emittable =
  | { ok: true; def: ProtoOptionDefinition; number: number; name: string; messageName: string; type: ProtoType; field: boolean; entity: boolean }
  | { ok: false; def: ProtoOptionDefinition; problem: string };

/** The extension name of an entity attribute: the option name, `_message`-suffixed when the definition also has a field extension (one package scope). */
const entityOptionName = (e: Extract<Emittable, { ok: true }>): string => (e.field ? `${e.name}_message` : e.name);

/** Every `schema`-scope definition with a field or entity target, by key: what it becomes in Protobuf, or the problem. Never an internal one. */
function emittable(defs: readonly ProtoOptionDefinition[]): Map<string, Emittable> {
  const out = new Map<string, Emittable>();
  const names = new Map<string, string>();
  const ordered = [...defs].sort((a, b) => (a.protobufOptionNumber ?? Infinity) - (b.protobufOptionNumber ?? Infinity) || (a.key < b.key ? -1 : 1));
  for (const def of ordered) {
    if (def.scope !== "schema") continue;
    const field = def.targets.includes("field");
    const entity = def.targets.includes("entity");
    if (!field && !entity) continue;
    const number = def.protobufOptionNumber;
    if (typeof number !== "number" || !Number.isInteger(number)) {
      out.set(def.key, { ok: false, def, problem: `${def.key} has no Protobuf option number, so it is not emitted as a Protobuf option.` });
      continue;
    }
    const name = protoOptionName(def.key);
    const clash = names.get(name) ?? names.get(`${name}_message`);
    if (clash !== undefined) {
      out.set(def.key, { ok: false, def, problem: `${def.key} and ${clash} have the same Protobuf option name "${name}", so ${def.key} is not emitted as a Protobuf option.` });
      continue;
    }
    const messageName = `${pascal(name)}Value`;
    try {
      const type = protoType(def.valueSchema, messageName, true);
      names.set(name, def.key);
      if (field && entity) names.set(`${name}_message`, def.key);
      out.set(def.key, { ok: true, def, number, name, messageName, type, field, entity });
    } catch (e) {
      if (!(e instanceof Unrepresentable)) throw e;
      out.set(def.key, { ok: false, def, problem: `${def.key} is not emitted as a Protobuf option: ${e.message}.` });
    }
  }
  return out;
}

/**
 * `superschema/metadata_options.proto` declaring the options of `usedKeys`: each one's value message (object value schemas) and its
 * extension of `google.protobuf.FieldOptions` / `google.protobuf.MessageOptions` at its option number, in number order. A used key that
 * cannot be declared is reported in `warnings`.
 */
export function buildOptionsProto(
  defs: readonly ProtoOptionDefinition[],
  usedKeys: Iterable<string>,
  warnings: string[] = []
): { path: typeof METADATA_OPTIONS_PROTO_PATH; content: string } {
  const used = new Set(usedKeys);
  const chosen: Array<Extract<Emittable, { ok: true }>> = [];
  for (const e of emittable(defs).values()) {
    if (!used.has(e.def.key)) continue;
    if (e.ok) chosen.push(e);
    else warnings.push(e.problem);
  }
  const lines = ["// Generated by Super Schema: the metadata attributes of this tenant as custom options.", "", 'syntax = "proto3";', "", `package ${PACKAGE};`, "", 'import "google/protobuf/descriptor.proto";'];
  for (const e of chosen) if (e.type.message) lines.push("", ...e.type.message);
  const extension = (e: Extract<Emittable, { ok: true }>, name: string) => `  ${e.type.repeated ? "repeated " : ""}${e.type.name} ${name} = ${e.number};`;
  const fieldExts = chosen.filter((e) => e.field).map((e) => extension(e, e.name));
  const messageExts = chosen.filter((e) => e.entity).map((e) => extension(e, entityOptionName(e)));
  if (fieldExts.length > 0) lines.push("", "extend google.protobuf.FieldOptions {", ...fieldExts, "}");
  if (messageExts.length > 0) lines.push("", "extend google.protobuf.MessageOptions {", ...messageExts, "}");
  return { path: METADATA_OPTIONS_PROTO_PATH, content: `${lines.join("\n")}\n` };
}

/** A text-format string literal. */
function quote(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

/** One (already validated) value in text format, by its value schema. */
function textValue(value: unknown, schema: ValueSchema, extras: string[], path: string): string {
  if (schema.type === "object" && isObj(value)) {
    const props = schema.properties ?? {};
    for (const k of Object.keys(value)) if (!(k in props)) extras.push(`${path}/${k}`);
    const parts: string[] = [];
    for (const [prop, sub] of Object.entries(props)) {
      if (!(prop in value)) continue;
      const v = value[prop];
      const name = protoPropertyName(prop);
      if (sub.type === "array") {
        if (!Array.isArray(v) || v.length === 0) continue;
        const items = sub.items ?? { type: "string" };
        parts.push(`${name}: [${v.map((item, i) => textValue(item, items, extras, `${path}/${prop}/${i}`)).join(", ")}]`);
      } else {
        parts.push(`${name}: ${textValue(v, sub, extras, `${path}/${prop}`)}`);
      }
    }
    return parts.length > 0 ? `{ ${parts.join(" ")} }` : "{}";
  }
  // An array without `items` is `repeated string`: whatever its elements are, they are written as strings.
  if (typeof value === "string" || schema.type === "string") return quote(typeof value === "string" ? value : JSON.stringify(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (schema.type === "integer") {
      if (!Number.isSafeInteger(value)) throw new UnsafeInteger(path);
      // A safe integer: its decimal digits, never an exponent.
      return BigInt(value).toString();
    }
    return String(value);
  }
  return quote(String(value));
}

/** The `(.superschema.metadata.<name>) = <value>` assignments (fully qualified: a `superschema` package segment cannot capture it) of one value (several for a repeated option), or the warning. */
function assignments(
  e: Extract<Emittable, { ok: true }>,
  optionName: string,
  value: unknown,
  where: string,
  warnings: string[]
): string[] | undefined {
  const problems = validateValue(value, e.def.valueSchema);
  if (problems.length > 0) {
    const first = problems[0];
    warnings.push(
      `Protobuf: the ${e.def.key} value of ${where} does not match its value schema (${first.path || "value"} ${first.message}), so it was not emitted as an option.`
    );
    return undefined;
  }
  const extras: string[] = [];
  const values = e.type.repeated ? (value as unknown[]) : [value];
  let out: string[];
  try {
    out = values.map((v, i) => `(.${PACKAGE}.${optionName}) = ${textValue(v, e.type.element, extras, e.type.repeated ? `/${i}` : "")}`);
  } catch (error) {
    if (!(error instanceof UnsafeInteger)) throw error;
    warnings.push(
      `Protobuf: the ${e.def.key} value of ${where} holds an integer too large to write exactly (${error.path || "value"}), so it was not emitted as an option.`
    );
    return undefined;
  }
  if (extras.length > 0) {
    warnings.push(`Protobuf: the ${e.def.key} value of ${where} has properties its value schema does not declare (${extras.join(", ")}); they were left out of the option.`);
  }
  return out;
}

const MESSAGE_LINE = /^(\s*)message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*(\/\/.*)?$/;
const FIELD_LINE = /^(\s*)(?:(?:optional|repeated)\s+)?(?:map\s*<[^>]*>|[A-Za-z_][\w.]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+\s*(\[.*\])?\s*;\s*(\/\/.*)?$/;

const braceDelta = (line: string): number => {
  const code = line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, "");
  return (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
};

/** `line` (a field declaration) with `options` appended to its `[...]` (or a new one). */
function withFieldOptions(line: string, options: string[]): string {
  const m = /^(.*?)(\s*\[(.*)\])?(\s*;)(\s*\/\/.*)?$/.exec(line);
  if (!m) return line;
  const existing = m[3]?.trim();
  const all = existing ? [existing, ...options] : options;
  return `${m[1]} [${all.join(", ")}]${m[4]}${m[5] ?? ""}`;
}

/** `content` with `import "superschema/metadata_options.proto";` after its last import, else after `package` / `syntax`. */
function withImport(lines: string[]): string[] {
  const statement = `import "${METADATA_OPTIONS_PROTO_PATH}";`;
  if (lines.some((l) => l.trim() === statement)) return lines;
  const lastImport = lines.map((l, i) => (/^\s*import\s/.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  if (lastImport >= 0) return [...lines.slice(0, lastImport + 1), statement, ...lines.slice(lastImport + 1)];
  const anchor = [/^\s*package\s/, /^\s*syntax\s*=/].map((re) => lines.findIndex((l) => re.test(l))).find((i) => i >= 0);
  if (anchor === undefined) return [statement, "", ...lines];
  return [...lines.slice(0, anchor + 1), "", statement, ...lines.slice(anchor + 1)];
}

/**
 * The `.proto` with the `schema`-scope attribute values of `model` set as custom options on the entity's message (matched by the entity
 * name, as written or as a valid identifier) and on its fields (by their `.proto` name), and the options file imported. Values that fail
 * their value schema are left out, warned in `report.warnings`; the keys written are added to `report.used`. The same file when nothing
 * was set.
 */
export function annotateProto<F extends { path: string; content: string }>(
  file: F,
  model: SuperSchemaModel,
  defs: readonly ProtoOptionDefinition[],
  report: ProtoOptionReport = {}
): F {
  const warnings = report.warnings ?? [];
  const table = emittable(defs);
  if (![...table.values()].some((e) => e.ok)) {
    // Nothing can be declared; say why for the keys this model holds a value for.
    noteProblems(table, model, warnings);
    return file;
  }
  const messageNames = new Set([model.entity.name, sanitizeIdentifier(model.entity.name)]);
  const fieldOptions = new Map<string, { options: string[]; keys: string[]; fieldName: string }>();
  const problemsSeen = new Set<string>();
  const problem = (e: Emittable) => {
    if (!e.ok && !problemsSeen.has(e.def.key)) {
      problemsSeen.add(e.def.key);
      warnings.push(e.problem);
    }
  };
  for (const f of model.fields) {
    const values = readFieldAttributes(f.decorators);
    const options: string[] = [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      const e = table.get(key);
      if (!e || (e.ok && !e.field) || (!e.ok && !e.def.targets.includes("field"))) continue;
      if (!e.ok) {
        problem(e);
        continue;
      }
      const set = assignments(e, e.name, value, `field "${f.name}"`, warnings);
      if (!set) continue;
      options.push(...set);
      if (set.length > 0) keys.push(key);
    }
    if (options.length > 0) fieldOptions.set(protobufFieldName(f.name), { options, keys, fieldName: f.name });
  }
  const messageOptions: string[] = [];
  const messageKeys: string[] = [];
  for (const [key, value] of Object.entries(readEntityAttributes(model.entity.metadata))) {
    const e = table.get(key);
    if (!e || (e.ok && !e.entity) || (!e.ok && !e.def.targets.includes("entity"))) continue;
    if (!e.ok) {
      problem(e);
      continue;
    }
    const set = assignments(e, entityOptionName(e), value, `entity "${model.entity.name}"`, warnings);
    if (!set) continue;
    messageOptions.push(...set);
    if (set.length > 0) messageKeys.push(key);
  }
  if (fieldOptions.size === 0 && messageOptions.length === 0) return file;

  const lines = file.content.split("\n");
  const out: string[] = [];
  const written = new Set<string>();
  const annotatedFields = new Set<string>();
  let messageFound = false;
  let depth = 0;
  let inTarget = false;
  for (const line of lines) {
    const message = depth === 0 ? MESSAGE_LINE.exec(line) : null;
    if (message && messageNames.has(message[2])) {
      inTarget = true;
      messageFound = true;
      out.push(line);
      depth += braceDelta(line);
      if (messageOptions.length > 0) {
        out.push(...messageOptions.map((o) => `${message[1]}  option ${o};`));
        for (const k of messageKeys) written.add(k);
      }
      continue;
    }
    if (inTarget && depth === 1) {
      const fieldMatch = FIELD_LINE.exec(line);
      const set = fieldMatch ? fieldOptions.get(fieldMatch[2]) : undefined;
      if (set) {
        out.push(withFieldOptions(line, set.options));
        for (const k of set.keys) written.add(k);
        annotatedFields.add(fieldMatch![2]);
        depth += braceDelta(line);
        continue;
      }
    }
    out.push(line);
    depth += braceDelta(line);
    if (depth === 0) inTarget = false;
  }
  // Values that had a place in the model but found none in the file are said, never dropped silently.
  if (!messageFound) {
    const keys = [...new Set([...messageKeys, ...[...fieldOptions.values()].flatMap((f) => f.keys)])].sort();
    warnings.push(`Protobuf: ${file.path} has no message ${model.entity.name}, so these metadata attributes were not emitted as options: ${keys.join(", ")}.`);
  } else {
    for (const [protoName, set] of fieldOptions) {
      if (annotatedFields.has(protoName)) continue;
      warnings.push(
        `Protobuf: field "${set.fieldName}" has no declaration in message ${model.entity.name} of ${file.path}, so its ${set.keys.join(", ")} value was not emitted as an option.`
      );
    }
  }
  if (written.size === 0) return file;
  for (const k of written) report.used?.add(k);
  return { ...file, content: withImport(out).join("\n") };
}

function noteProblems(table: Map<string, Emittable>, model: SuperSchemaModel, warnings: string[]): void {
  const held = new Set([...Object.keys(readEntityAttributes(model.entity.metadata)), ...model.fields.flatMap((f) => Object.keys(readFieldAttributes(f.decorators)))]);
  for (const e of table.values()) if (!e.ok && held.has(e.def.key)) warnings.push(e.problem);
}
