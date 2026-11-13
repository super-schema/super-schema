/**
 * Metadata attributes at emission: what the tenant's dictionary changes in an emitted target output.
 *
 * - `internal` keys stay in the canonical TypeSpec and GitOps source but never reach a target output: they are stripped from the
 *   emission input (`stripInternal`, `stripInternalFromClosure`).
 * - An `abc-primitive` key of an array of primitives (or a nested array) sits on the innermost non-array `items` of the emitted
 *   JSON Schema / OpenAPI schema (`itemsTagsFor` + `moveTagsToItems`): TypeSpec can only put it on the property.
 * - Avro has no extension decorator: the `schema`-scope values are added to the emitted `.avsc` as custom properties
 *   (`addAvroProperties`).
 * - Targets that cannot carry them warn (`skippedAttributeWarning`).
 *
 * Every function is pure, never mutates its input, and returns its input unchanged (same reference / same string) when nothing applies.
 */

import { parseDocument, isMap, isScalar, type Document, type YAMLMap, type Pair } from "yaml";
import { abcPlacement } from "@/lib/metadata-attributes/placement";
import { readEntityAttributes, readFieldAttributes, writeEntityAttribute, writeFieldAttribute } from "@/lib/metadata-attributes/values";
import { toAvroSymbol } from "@/lib/typespec-official/avro-source";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

/** The tenant's dictionary as emission needs it. Absent (undefined) for a tenant without definitions: nothing changes then. */
export interface MetadataEmissionContext {
  definitions: MetadataAttributeDefinition[];
}

type Obj = Record<string, unknown>;
type Defs = readonly Pick<MetadataAttributeDefinition, "key" | "scope" | "placement">[];

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const internalKeys = (defs: Defs): string[] => defs.filter((d) => d.scope === "internal").map((d) => d.key);

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

/** The model without the `internal` keys on its fields and entity. The same reference when there is nothing to strip. */
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
  if (!changed && metadata === model.entity.metadata) return model;
  return { ...model, entity: { ...model.entity, metadata }, fields: fieldsOut };
}

interface ClosureMemberLike {
  entityId: string;
  entity: { metadata?: unknown };
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
    if (!fieldsChanged && metadata === member.entity.metadata) return member;
    changed = true;
    return { ...member, entity: { ...member.entity, metadata }, fields: fieldsOut };
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

/** Moves `keys` of a JSON array schema onto its innermost non-array items (a `$ref` items is wrapped in `allOf`). Mutates `schema` (a clone). */
function moveJson(schema: Obj, keys: readonly string[]): boolean {
  if (schema.type !== "array" || !isObj(schema.items)) return false;
  const present = keys.filter((k) => k in schema);
  if (present.length === 0) return false;
  let parent: Obj = schema;
  while (isObj(parent.items) && parent.items.type === "array" && isObj(parent.items.items)) parent = parent.items;
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

function moveInJson(file: { path: string; content: string }, itemsTags: Record<string, string[]>, schemaNames?: readonly string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return file.content;
  }
  if (!isObj(parsed)) return file.content;
  const doc = structuredClone(parsed);
  const containers: Obj[] = [];
  if (isObj(doc.properties)) containers.push(doc);
  const schemas = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : undefined;
  if (schemas) for (const [name, s] of Object.entries(schemas)) if (isObj(s) && (!schemaNames || schemaNames.includes(name))) containers.push(s);
  let changed = false;
  for (const container of containers) {
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

function moveYaml(doc: Document, prop: YAMLMap, keys: readonly string[]): boolean {
  const typeNode = prop.get("type", true);
  if (!isScalar(typeNode) || typeNode.value !== "array") return false;
  let parent = prop;
  let items = yamlMapAt(parent, "items");
  if (!items) return false;
  const present = keys.filter((k) => prop.has(k));
  if (present.length === 0) return false;
  for (let inner = yamlMapAt(items, "items"); inner && (items.get("type", true) as { value?: unknown } | undefined)?.value === "array"; inner = yamlMapAt(items, "items")) {
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
 * Moves each listed key from the `properties.<field>` array schema to its innermost non-array `items` (a `$ref` items becomes
 * `{allOf: [{$ref}], key}`), in a JSON Schema file (root `properties`) or an OpenAPI document (`components.schemas.*`, JSON or YAML;
 * YAML keeps its formatting). `schemaNames` limits which component schemas are touched. The same content string when nothing matched.
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

/**
 * Adds the `schema`-scope attribute values of `model` as custom properties on the `.avsc` objects they belong to: the entity's on its
 * record, a field's on the field object of that record. Only keys the dictionary defines; the same content string when nothing matched.
 */
export function addAvroProperties<F extends { path: string; content: string }>(file: F, model: SuperSchemaModel, defs: readonly MetadataAttributeDefinition[]): F {
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
  const recordNames = new Set([model.entity.name, avroName(model.entity.name)]);
  let changed = false;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isObj(node)) return node;
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) out[k] = visit(v);
    if (out.type === "record" && typeof out.name === "string" && recordNames.has(out.name)) {
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
  const result = visit(parsed);
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

/** The warning of a target that has no place for metadata attributes (Java POJO, the DDL targets, Protobuf for now). */
export function skippedAttributeWarning(target: string, keys: readonly string[]): string {
  const name = getSchemaTargetDefinition(target)?.displayName ?? target;
  return `${name} has no place for metadata attributes; these were not emitted: ${keys.join(", ")}.`;
}
