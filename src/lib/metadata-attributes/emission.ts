/**
 * Metadata attributes at emission: what the tenant's dictionary changes in an emitted target output.
 *
 * - `internal` keys stay in the canonical TypeSpec and GitOps source but never reach a target output: they are stripped from the
 *   emission input (`stripInternal`, `stripInternalFromClosure`).
 * - An `abc-primitive` key of an array of primitives (or a nested array) sits on the innermost non-array `items` of the emitted
 *   JSON Schema / OpenAPI schema (`itemsTagsFor` + `moveTagsToItems`): TypeSpec can only put it on the property.
 * - Avro has no extension decorator: the `schema`-scope values are added to the emitted `.avsc` as custom properties
 *   (`addAvroProperties`).
 * - Protobuf carries them as custom options (`protobuf-options.ts`).
 * - Targets that cannot carry them warn (`skippedAttributeWarning`).
 *
 * Every function is pure, never mutates its input, and returns its input unchanged (same reference / same string) when nothing applies.
 */

import { parseDocument, isMap, isScalar, isSeq, type Document, type YAMLMap, type Pair } from "yaml";
import { abcPlacement } from "@/lib/metadata-attributes/placement";
import { readEntityAttributes, readFieldAttributes, writeEntityAttribute, writeFieldAttribute } from "@/lib/metadata-attributes/values";
import { toAvroSymbol } from "@/lib/typespec-official/avro-source";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

/** The tenant's dictionary as emission needs it. Absent (undefined) for a tenant without definitions: nothing changes then. */
export interface MetadataEmissionContext {
  /** A stored row carries its `protobufOptionNumber` (the Protobuf custom option it is emitted as). */
  definitions: Array<MetadataAttributeDefinition & { protobufOptionNumber?: number | null }>;
}

type Obj = Record<string, unknown>;
type Defs = readonly Pick<MetadataAttributeDefinition, "key" | "scope" | "placement">[];

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const internalKeys = (defs: Defs): string[] => defs.filter((d) => d.scope === "internal").map((d) => d.key);

/** The keys of the dictionary's `internal` attributes, as a Set for an emitter that drops them itself; undefined when there are none. */
export function internalKeySet(defs: Defs | undefined): ReadonlySet<string> | undefined {
  const keys = defs ? internalKeys(defs) : [];
  return keys.length > 0 ? new Set(keys) : undefined;
}

/** `decorators` without the internal keys of its field extension map; the same reference when it holds none. */
function stripFieldDecorators<T>(decorators: T, keys: readonly string[]): T {
  const present = keys.filter((k) => k in readFieldAttributes(decorators));
  if (present.length === 0) return decorators;
  let next = decorators as unknown as Obj;
  for (const k of present) next = writeFieldAttribute(next, k, undefined);
  return next as unknown as T;
}

/** `metadata` without the internal keys of its entity extension map; the same reference when it holds none. */
function stripEntityMetadata<T>(metadata: T, keys: readonly string[]): T {
  const present = keys.filter((k) => k in readEntityAttributes(metadata));
  if (present.length === 0) return metadata;
  let next = metadata as unknown as Obj;
  for (const k of present) next = writeEntityAttribute(next, k, undefined);
  return next as unknown as T;
}

/** `operations` without the internal keys of their extension maps; the same reference when none holds one. */
function stripOperations<T extends { extensions?: Record<string, unknown> }>(operations: T[] | undefined, keys: readonly string[]): T[] | undefined {
  if (!operations) return operations;
  let changed = false;
  const out = operations.map((op) => {
    const map = op.extensions;
    if (!map || !keys.some((k) => k in map)) return op;
    changed = true;
    const { extensions: _dropped, ...rest } = op;
    const kept = Object.fromEntries(Object.entries(map).filter(([k]) => !keys.includes(k)));
    return (Object.keys(kept).length > 0 ? { ...rest, extensions: kept } : rest) as T;
  });
  return changed ? out : operations;
}

/** The model without the `internal` keys on its fields, entity and API operations. The same reference when there is nothing to strip. */
export function stripInternal(model: SuperSchemaModel, defs: Defs): SuperSchemaModel {
  const keys = internalKeys(defs);
  if (keys.length === 0) return model;
  let changed = false;
  const fieldsOut = model.fields.map((f) => {
    const decorators = stripFieldDecorators(f.decorators, keys);
    if (decorators === f.decorators) return f;
    changed = true;
    return { ...f, decorators };
  });
  const metadata = stripEntityMetadata(model.entity.metadata, keys);
  const apiOperations = stripOperations(model.apiOperations, keys);
  if (!changed && metadata === model.entity.metadata && apiOperations === model.apiOperations) return model;
  return { ...model, entity: { ...model.entity, metadata }, fields: fieldsOut, ...(apiOperations ? { apiOperations } : {}) };
}

interface ClosureMemberLike {
  entityId: string;
  entity: { metadata?: unknown; apiOperations?: Array<{ extensions?: Record<string, unknown> }> };
  fields: Array<{ decorators?: unknown }>;
}

/**
 * The closure with the `internal` keys stripped from every member's raw input (field decorators, entity metadata), which both the
 * stand-alone and the combined plan compile from. The same reference when nothing changes.
 */
export function stripInternalFromClosure<C extends { entities: M[]; root?: M }, M extends ClosureMemberLike>(closure: C, defs: Defs): C {
  const keys = internalKeys(defs);
  if (keys.length === 0) return closure;
  let changed = false;
  const entities = closure.entities.map((member) => {
    const metadata = stripEntityMetadata(member.entity.metadata, keys);
    let fieldsChanged = false;
    const fieldsOut = member.fields.map((f) => {
      const decorators = stripFieldDecorators(f.decorators, keys);
      if (decorators === f.decorators) return f;
      fieldsChanged = true;
      return { ...f, decorators };
    });
    const apiOperations = stripOperations(member.entity.apiOperations, keys);
    if (!fieldsChanged && metadata === member.entity.metadata && apiOperations === member.entity.apiOperations) return member;
    changed = true;
    return { ...member, entity: { ...member.entity, metadata, ...(apiOperations ? { apiOperations } : {}) }, fields: fieldsOut };
  });
  if (!changed) return closure;
  const root = closure.root ? (entities.find((e) => e.entityId === closure.root?.entityId) ?? closure.root) : undefined;
  return { ...closure, entities, ...(closure.root ? { root } : {}) };
}

/** True when the abc-primitive key of `field` belongs on the (innermost) items: an array of primitives, or a nested array. */
function belongsOnItems(field: SuperSchemaField): boolean {
  const placementField = {
    type: field.type,
    decorators: { danglingRef: field.danglingRef, arrayElementType: field.complexType?.arrayElementType },
    complexType: field.complexType,
  };
  if (abcPlacement(placementField) === "items") return true;
  // `T[][]` keeps no nesting information in storage (its element is just "array"): the post-pass finds the innermost level.
  return field.type === "array" && field.complexType?.arrayElementType === "array" && field.danglingRef === undefined;
}

/** For each field whose `abc-primitive` keys belong on `items`: the keys it holds. */
export function itemsTagsFor(model: SuperSchemaModel, defs: Defs): Record<string, string[]> {
  const abcKeys = defs.filter((d) => d.placement === "abc-primitive").map((d) => d.key);
  const out: Record<string, string[]> = {};
  if (abcKeys.length === 0) return out;
  for (const field of model.fields) {
    if (!belongsOnItems(field)) continue;
    const values = readFieldAttributes(field.decorators);
    const keys = abcKeys.filter((k) => k in values);
    if (keys.length > 0) out[field.name] = keys;
  }
  return out;
}

/** The indentation unit of a JSON text (the emitters write 2 or 4 spaces); 2 when it cannot be told. */
function jsonIndent(content: string): string | number {
  const m = /^\{\r?\n([ \t]+)"/.exec(content);
  return m ? m[1] : 2;
}

function reformatJson(content: string, value: unknown): string {
  return JSON.stringify(value, null, jsonIndent(content)) + (content.endsWith("\n") ? "\n" : "");
}

const isArrayType = (type: unknown): boolean => type === "array" || (Array.isArray(type) && type.includes("array"));

/**
 * The array schema a property stands for: the property itself, or (a nullable array, `T[] | null`) the ONE branch of its `anyOf` / `oneOf`
 * that is an array with object `items`. Undefined when there is none, or more than one.
 */
function arraySchemaOf(schema: Obj): Obj | undefined {
  if (isArrayType(schema.type) && isObj(schema.items)) return schema;
  for (const combinator of ["anyOf", "oneOf"]) {
    const branches = schema[combinator];
    if (!Array.isArray(branches)) continue;
    const arrays = branches.filter((b): b is Obj => isObj(b) && isArrayType(b.type) && isObj(b.items));
    if (arrays.length === 1) return arrays[0];
  }
  return undefined;
}

/** Moves `keys` of a JSON property onto the innermost non-array items of its array schema (a `$ref` items is wrapped in `allOf`). Mutates `schema` (a clone). */
function moveJson(schema: Obj, keys: readonly string[]): boolean {
  const array = arraySchemaOf(schema);
  if (!array) return false;
  const present = keys.filter((k) => k in schema);
  if (present.length === 0) return false;
  let parent: Obj = array;
  while (isObj(parent.items) && isArrayType(parent.items.type) && isObj(parent.items.items)) parent = parent.items;
  let items = parent.items as Obj;
  if (typeof items.$ref === "string") {
    const { $ref, ...rest } = items;
    items = { allOf: [{ $ref }], ...rest };
  } else {
    items = { ...items };
  }
  for (const k of present) {
    items[k] = schema[k];
    delete schema[k];
  }
  parent.items = items;
  return true;
}

/**
 * The schemas of a JSON document whose `properties` are looked at. Without `schemaNames`: the root and every `components.schemas` entry.
 * With them: the named `$defs` / `components.schemas` entries, and the root when its `$id` names one of them.
 */
function jsonContainers(doc: Obj, schemaNames?: readonly string[]): Obj[] {
  const out: Obj[] = [];
  const rootId = typeof doc.$id === "string" ? doc.$id : undefined;
  if (!schemaNames || (rootId !== undefined && schemaNames.some((n) => rootId === n || rootId === `${n}.json`))) out.push(doc);
  const named = (map: unknown, all: boolean) => {
    if (!isObj(map)) return;
    for (const [name, s] of Object.entries(map)) if (isObj(s) && (schemaNames ? schemaNames.includes(name) : all)) out.push(s);
  };
  named(doc.$defs, false);
  named(isObj(doc.components) ? doc.components.schemas : undefined, true);
  return out;
}

function moveInJson(file: { path: string; content: string }, itemsTags: Record<string, string[]>, schemaNames?: readonly string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return file.content;
  }
  if (!isObj(parsed)) return file.content;
  const doc = structuredClone(parsed);
  let changed = false;
  for (const container of jsonContainers(doc, schemaNames)) {
    const props = container.properties;
    if (!isObj(props)) continue;
    for (const [fieldName, keys] of Object.entries(itemsTags)) {
      const prop = props[fieldName];
      if (isObj(prop) && moveJson(prop, keys)) changed = true;
    }
  }
  return changed ? reformatJson(file.content, doc) : file.content;
}

const yamlMapAt = (node: unknown, key: string): YAMLMap | undefined => {
  if (!isMap(node)) return undefined;
  const v = node.get(key, true);
  return isMap(v) ? (v as YAMLMap) : undefined;
};

function yamlIsArray(map: YAMLMap): boolean {
  const type: unknown = map.get("type", true);
  if (isScalar(type)) return type.value === "array";
  return isSeq(type) && type.items.some((t) => isScalar(t) && t.value === "array");
}

/** The YAML twin of {@link arraySchemaOf}. */
function yamlArraySchemaOf(prop: YAMLMap): YAMLMap | undefined {
  if (yamlIsArray(prop) && yamlMapAt(prop, "items")) return prop;
  for (const combinator of ["anyOf", "oneOf"]) {
    const branches = prop.get(combinator, true);
    if (!isSeq(branches)) continue;
    const arrays = branches.items.filter((b): b is YAMLMap => isMap(b) && yamlIsArray(b as YAMLMap) && !!yamlMapAt(b, "items"));
    if (arrays.length === 1) return arrays[0];
  }
  return undefined;
}

function moveYaml(doc: Document, prop: YAMLMap, keys: readonly string[]): boolean {
  const array = yamlArraySchemaOf(prop);
  if (!array) return false;
  const present = keys.filter((k) => prop.has(k));
  if (present.length === 0) return false;
  let parent = array;
  let items = yamlMapAt(parent, "items") as YAMLMap;
  for (let inner = yamlMapAt(items, "items"); inner && yamlIsArray(items); inner = yamlMapAt(items, "items")) {
    parent = items;
    items = inner;
  }
  if (items.has("$ref")) {
    const wrapped = doc.createNode({}) as YAMLMap;
    const refPair = items.items.find((p) => isScalar(p.key) && p.key.value === "$ref") as Pair;
    const allOf = doc.createNode([{}]);
    (allOf.items[0] as YAMLMap).items.push(refPair);
    wrapped.items.push(doc.createPair("allOf", allOf));
    for (const p of items.items) if (p !== refPair) wrapped.items.push(p);
    parent.set("items", wrapped);
    items = wrapped;
  }
  for (const k of present) {
    const pair = prop.items.find((p) => isScalar(p.key) && p.key.value === k) as Pair;
    prop.items.splice(prop.items.indexOf(pair), 1);
    items.items.push(pair);
  }
  return true;
}

function moveInYaml(file: { path: string; content: string }, itemsTags: Record<string, string[]>, schemaNames?: readonly string[]): string {
  const doc = parseDocument(file.content);
  if (doc.errors.length > 0) return file.content;
  const schemas = yamlMapAt(yamlMapAt(doc.contents, "components"), "schemas");
  if (!schemas) return file.content;
  let changed = false;
  for (const pair of schemas.items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (name === undefined || (schemaNames && !schemaNames.includes(name))) continue;
    const props = yamlMapAt(pair.value, "properties");
    if (!props) continue;
    for (const [fieldName, keys] of Object.entries(itemsTags)) {
      const prop = yamlMapAt(props, fieldName);
      if (prop && moveYaml(doc, prop, keys)) changed = true;
    }
  }
  return changed ? doc.toString() : file.content;
}

/**
 * Moves each listed key from the `properties.<field>` array schema (or the one array branch of a nullable `anyOf` / `oneOf`) to its innermost
 * non-array `items` (a `$ref` items becomes `{allOf: [{$ref}], key}`), in a JSON Schema file or an OpenAPI document (JSON or YAML; YAML keeps
 * its formatting). Without `schemaNames`: the root schema and every `components.schemas` entry; with them, only the named `$defs` /
 * `components.schemas` entries (and a root whose `$id` names one). The same content string when nothing matched.
 */
export function moveTagsToItems<F extends { path: string; content: string }>(file: F, itemsTags: Record<string, string[]>, schemaNames?: readonly string[]): F {
  if (Object.keys(itemsTags).length === 0) return file;
  const content = file.path.endsWith(".json")
    ? moveInJson(file, itemsTags, schemaNames)
    : /\.ya?ml$/.test(file.path)
      ? moveInYaml(file, itemsTags, schemaNames)
      : file.content;
  return content === file.content ? file : { ...file, content };
}

/** The values of `keys` held in `attributes`, as entries (in `keys` order). */
const pick = (attributes: Obj, keys: readonly string[]): [string, unknown][] => keys.filter((k) => k in attributes).map((k) => [k, attributes[k]]);

const avroName = (name: string): string => toAvroSymbol(name);

/** An Avro full name: `namespace.name`, or `name` alone in the null namespace. */
export interface AvroRecordName {
  namespace?: string;
  name: string;
}

const fullName = (r: AvroRecordName): string => (r.namespace ? `${r.namespace}.${r.name}` : r.name);

const NAMED_AVRO_TYPES = new Set(["record", "error", "enum", "fixed"]);

/** The full name of a named Avro schema and the namespace it passes on (Avro spec: a dotted name, else its own `namespace`, else the enclosing one). */
function avroFullName(node: Obj, enclosing: string | undefined): { full: string; namespace: string | undefined } | undefined {
  if (typeof node.name !== "string") return undefined;
  if (node.name.includes(".")) return { full: node.name, namespace: node.name.slice(0, node.name.lastIndexOf(".")) };
  const ns = typeof node.namespace === "string" ? node.namespace || undefined : enclosing;
  return { full: ns ? `${ns}.${node.name}` : node.name, namespace: ns };
}

/**
 * Adds the `schema`-scope attribute values of `model` as custom properties on the `.avsc` objects they belong to: the entity's on its
 * record, a field's on the field object of that record. The record is matched by its full name (namespace and name): `record` when given,
 * else the full name of the file's top-level record when that record is named after the entity. Only keys the dictionary defines; the same
 * content string when nothing matched.
 */
export function addAvroProperties<F extends { path: string; content: string }>(
  file: F,
  model: SuperSchemaModel,
  defs: readonly MetadataAttributeDefinition[],
  record?: AvroRecordName
): F {
  if (!file.path.endsWith(".avsc") && !file.path.endsWith(".json")) return file;
  const schemaKeys = defs.filter((d) => d.scope === "schema").map((d) => d.key);
  if (schemaKeys.length === 0) return file;
  const entityValues = pick(readEntityAttributes(model.entity.metadata), schemaKeys);
  const fieldValues = new Map<string, [string, unknown][]>();
  for (const f of model.fields) {
    const values = pick(readFieldAttributes(f.decorators), schemaKeys);
    if (values.length > 0) {
      fieldValues.set(f.name, values);
      fieldValues.set(avroName(f.name), values);
    }
  }
  if (entityValues.length === 0 && fieldValues.size === 0) return file;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return file;
  }
  let target = record ? fullName(record) : undefined;
  if (target === undefined && isObj(parsed) && parsed.type === "record" && typeof parsed.name === "string") {
    const short = parsed.name.split(".").pop() as string;
    if (short === model.entity.name || short === avroName(model.entity.name)) target = avroFullName(parsed, undefined)?.full;
  }
  if (target === undefined) return file;
  let changed = false;
  const visit = (node: unknown, enclosing: string | undefined): unknown => {
    if (Array.isArray(node)) return node.map((child) => visit(child, enclosing));
    if (!isObj(node)) return node;
    const named = typeof node.type === "string" && NAMED_AVRO_TYPES.has(node.type) ? avroFullName(node, enclosing) : undefined;
    const inner = named ? named.namespace : enclosing;
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) out[k] = visit(v, inner);
    if (out.type === "record" && named?.full === target) {
      for (const [k, v] of entityValues) if (!(k in out)) {
        out[k] = v;
        changed = true;
      }
      if (Array.isArray(out.fields)) {
        out.fields = out.fields.map((f) => {
          if (!isObj(f) || typeof f.name !== "string") return f;
          const values = fieldValues.get(f.name);
          if (!values) return f;
          const next = { ...f };
          for (const [k, v] of values) if (!(k in next)) {
            next[k] = v;
            changed = true;
          }
          return next;
        });
      }
    }
    return out;
  };
  const result = visit(parsed, undefined);
  if (!changed) return file;
  return { ...file, content: reformatJson(file.content, result) };
}

/** The `schema`-scope keys defined in the dictionary that `models` hold a value for (fields or entities), sorted. */
export function attributeKeysIn(models: readonly SuperSchemaModel[], defs: readonly MetadataAttributeDefinition[]): string[] {
  const schemaKeys = defs.filter((d) => d.scope === "schema").map((d) => d.key);
  const found = new Set<string>();
  for (const m of models) {
    const entity = readEntityAttributes(m.entity.metadata);
    for (const k of schemaKeys) if (k in entity) found.add(k);
    for (const f of m.fields) {
      const values = readFieldAttributes(f.decorators);
      for (const k of schemaKeys) if (k in values) found.add(k);
    }
  }
  return [...found].sort();
}

/** The warning of a target that has no place for metadata attributes (Java POJO, the DDL targets). */
export function skippedAttributeWarning(target: string, keys: readonly string[]): string {
  const name = getSchemaTargetDefinition(target)?.displayName ?? target;
  return `${name} has no place for metadata attributes; these were not emitted: ${keys.join(", ")}.`;
}
