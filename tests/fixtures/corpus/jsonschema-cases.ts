/**
 * JSON Schema corpus: hand-written cases for each variation axis plus programmatically generated combinations.
 * Every case is a TEXT document (as pasted into the import dialog), so each runs through the real importer.
 */
import type { CorpusCase, CorpusExpectations } from "./types";

type Json = Record<string, unknown>;
const obj = (properties: Json, extra: Json = {}): Json => ({ type: "object", properties, ...extra });
const str = (v: unknown): string => JSON.stringify(v, null, 2);

function js(id: string, title: string, schema: unknown, tags: string[], expectations: CorpusExpectations = {}): CorpusCase {
  return { id: `js-${id}`, title, kind: "jsonschema", source: typeof schema === "string" ? schema : str(schema), tags: ["jsonschema", ...tags], expectations };
}

const cases: CorpusCase[] = [];
const add = (c: CorpusCase): void => { cases.push(c); };
const withKey = (props: Json): Json => ({ id: { type: "string" }, ...props });

// ── 1. primitives and formats ───────────────────────────────────────────────
const PRIMITIVES: Array<[string, Json]> = [
  ["string", { type: "string" }], ["integer", { type: "integer" }], ["number", { type: "number" }], ["boolean", { type: "boolean" }],
  ["int32", { type: "integer", format: "int32" }], ["int64", { type: "integer", format: "int64" }],
  ["uint8", { type: "integer", format: "uint8", minimum: 0, maximum: 255 }], ["uint16", { type: "integer", format: "uint16" }],
  ["uint32", { type: "integer", format: "uint32", minimum: 0 }], ["uint64", { type: "integer", format: "uint64", minimum: 0 }],
  ["float", { type: "number", format: "float" }], ["double", { type: "number", format: "double" }], ["decimal", { type: "string", format: "decimal" }],
  ["date", { type: "string", format: "date" }], ["date-time", { type: "string", format: "date-time" }], ["time", { type: "string", format: "time" }],
  ["duration", { type: "string", format: "duration" }], ["uri", { type: "string", format: "uri" }], ["uuid", { type: "string", format: "uuid" }],
  ["email", { type: "string", format: "email" }], ["hostname", { type: "string", format: "hostname" }], ["ipv4", { type: "string", format: "ipv4" }],
  ["ipv6", { type: "string", format: "ipv6" }], ["byte", { type: "string", format: "byte" }], ["binary", { type: "string", format: "binary" }],
  ["null", { type: "null" }], ["any", {}], ["contentEncoding", { type: "string", contentEncoding: "base64", contentMediaType: "image/png" }],
];
for (const [name, schema] of PRIMITIVES) {
  add(js(`prim-${name}`, `Primitive ${name}`, { title: `Prim_${name.replace(/\W/g, "_")}`, ...obj(withKey({ value: schema }), { required: ["id"] }) }, ["primitive", "format"]));
}
add(js("all-primitives-one-doc", "Every primitive in one object", { title: "AllPrimitives", ...obj(withKey(Object.fromEntries(PRIMITIVES.map(([n, s]) => [`f_${n.replace(/\W/g, "_")}`, s]))), { required: ["id"] }) }, ["primitive", "format", "wide"]));

// ── 2. nullable ─────────────────────────────────────────────────────────────
add(js("nullable-type-array", "nullable via type array", { title: "NullArr", ...obj(withKey({ a: { type: ["string", "null"] }, b: { type: ["integer", "null"], format: "int64" }, c: { type: ["null", "boolean"] } }), { required: ["id", "a", "b"] }) }, ["nullable"]));
add(js("nullable-anyof", "nullable via anyOf null", { title: "NullAny", ...obj(withKey({ a: { anyOf: [{ type: "string" }, { type: "null" }] }, b: { anyOf: [{ type: "null" }, { type: "number" }] } }), { required: ["id", "a"] }) }, ["nullable", "union"]));
add(js("nullable-oneof", "nullable via oneOf null", { title: "NullOne", ...obj(withKey({ a: { oneOf: [{ type: "string", format: "uuid" }, { type: "null" }] } }), { required: ["id", "a"] }) }, ["nullable", "union"]));
add(js("nullable-ref", "nullable reference", { title: "NullRef", $defs: { Addr: obj({ line: { type: "string" } }) }, ...obj(withKey({ addr: { oneOf: [{ $ref: "#/$defs/Addr" }, { type: "null" }] } }), { required: ["id"] }) }, ["nullable", "ref"]));
add(js("required-vs-optional", "required and optional mix", { title: "ReqOpt", ...obj(withKey({ a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }), { required: ["id", "a", "ghost"] }) }, ["required"]));
add(js("required-none", "no required list", { title: "NoReq", ...obj({ a: { type: "string" }, b: { type: "integer" } }) }, ["required"], { requiresPrimaryKey: true }));
add(js("openapi-nullable", "OpenAPI-style nullable: true", { title: "OaNullable", ...obj(withKey({ a: { type: "string", nullable: true } }), { required: ["id"] }) }, ["nullable", "openapi-style"]));

// ── 3. constraints ──────────────────────────────────────────────────────────
add(js("constraints-string", "string constraints", { title: "StrCons", ...obj(withKey({ s: { type: "string", minLength: 2, maxLength: 40, pattern: "^[a-z]+$" } }), { required: ["id"] }) }, ["constraints"]));
add(js("constraints-number", "number constraints", { title: "NumCons", ...obj(withKey({ n: { type: "number", minimum: 0, maximum: 100, multipleOf: 0.5 }, e: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 } }), { required: ["id"] }) }, ["constraints"]));
add(js("constraints-exclusive-draft4", "draft-04 boolean exclusive bounds", { $schema: "http://json-schema.org/draft-04/schema#", title: "Draft4Excl", ...obj(withKey({ n: { type: "number", minimum: 0, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: true } }), { required: ["id"] }) }, ["constraints", "draft-04"]));
add(js("constraints-array", "array constraints", { title: "ArrCons", ...obj(withKey({ a: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true } }), { required: ["id"] }) }, ["constraints", "array"]));
add(js("constraints-object", "object constraints", { title: "ObjCons", minProperties: 1, maxProperties: 5, ...obj(withKey({ a: { type: "string" } }), { required: ["id"], additionalProperties: false }) }, ["constraints"]));
add(js("pattern-hostile", "regex with escapes and quotes", { title: "PatHostile", ...obj(withKey({ p: { type: "string", pattern: "^\\d{3}-\"q\"-'a'\\\\\\n$" }, q: { type: "string", pattern: "${x}`tick`" } }), { required: ["id"] }) }, ["constraints", "hostile"]));

// ── 4. enums ────────────────────────────────────────────────────────────────
add(js("enum-string", "string enum", { title: "EnumStr", ...obj(withKey({ s: { type: "string", enum: ["NEW", "OPEN", "CLOSED"] } }), { required: ["id", "s"] }) }, ["enum"]));
add(js("enum-mixed", "mixed-type enum", { title: "EnumMixed", ...obj(withKey({ s: { enum: ["a", 1, true, null] } }), { required: ["id"] }) }, ["enum", "mixed"]));
add(js("enum-numeric", "numeric enum", { title: "EnumNum", ...obj(withKey({ n: { type: "integer", enum: [1, 2, 3] } }), { required: ["id"] }) }, ["enum"]));
add(js("enum-const", "single const", { title: "ConstOne", ...obj(withKey({ kind: { const: "event" } }), { required: ["id", "kind"] }) }, ["enum", "const"]));
add(js("enum-weird-values", "enum values needing sanitising", { title: "EnumWeird", ...obj(withKey({ s: { type: "string", enum: ["in-progress", "on hold", "1st", "class", "", "x.y", "ÄÖ", "a\"b", "$x"] } }), { required: ["id"] }) }, ["enum", "hostile"]));
add(js("enum-shared-def", "enum in $defs used by two fields", { title: "EnumShared", $defs: { Status: { type: "string", enum: ["on", "off"] } }, ...obj(withKey({ a: { $ref: "#/$defs/Status" }, b: { $ref: "#/$defs/Status" } }), { required: ["id"] }) }, ["enum", "ref"]));
add(js("enum-huge", "enum of 2000 values", { title: "EnumHuge", ...obj(withKey({ s: { type: "string", enum: Array.from({ length: 2000 }, (_, i) => `VALUE_${i}`) } }), { required: ["id"] }) }, ["enum", "hostile", "huge"]));

// ── 5. nesting, arrays, maps ────────────────────────────────────────────────
add(js("nested-inline", "inline nested object", { title: "NestedInline", ...obj(withKey({ address: obj({ street: { type: "string" }, geo: obj({ lat: { type: "number" }, lon: { type: "number" } }, { required: ["lat"] }) }, { required: ["street"] }) }), { required: ["id", "address"] }) }, ["nested", "object"]));
add(js("array-primitive", "arrays of primitives", { title: "ArrPrim", ...obj(withKey({ s: { type: "array", items: { type: "string" } }, i: { type: "array", items: { type: "integer", format: "int64" } }, d: { type: "array", items: { type: "string", format: "date-time" } } }), { required: ["id"] }) }, ["array"]));
add(js("array-objects", "array of inline objects", { title: "ArrObj", ...obj(withKey({ lines: { type: "array", items: obj({ sku: { type: "string" }, qty: { type: "integer" } }, { required: ["sku"] }) } }), { required: ["id"] }) }, ["array", "nested"]));
add(js("array-refs", "array of internal refs", { title: "ArrRef", $defs: { Line: obj({ sku: { type: "string" } }) }, ...obj(withKey({ lines: { type: "array", items: { $ref: "#/$defs/Line" } } }), { required: ["id"] }) }, ["array", "ref"]));
add(js("array-of-arrays", "array of arrays", { title: "ArrArr", ...obj(withKey({ grid: { type: "array", items: { type: "array", items: { type: "number" } } }, cube: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } } }), { required: ["id"] }) }, ["array", "nested"]));
add(js("array-untyped", "array without items", { title: "ArrUntyped", ...obj(withKey({ a: { type: "array" }, b: { type: "array", items: {} } }), { required: ["id"] }) }, ["array"]));
add(js("array-of-enum", "array of enum", { title: "ArrEnum", ...obj(withKey({ a: { type: "array", items: { type: "string", enum: ["x", "y"] } } }), { required: ["id"] }) }, ["array", "enum"]));
add(js("array-of-union", "array of oneOf", { title: "ArrUnion", ...obj(withKey({ a: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] } } }), { required: ["id"] }) }, ["array", "union"], { expectedDegraded: [{ target: "protobuf", reason: "a .proto field cannot be a union: the items are written as string (warning)" }] }));
add(js("map-primitive", "map via additionalProperties", { title: "MapPrim", ...obj(withKey({ labels: { type: "object", additionalProperties: { type: "string" } }, counts: { type: "object", additionalProperties: { type: "integer" } } }), { required: ["id"] }) }, ["map"]));
add(js("map-of-objects", "map of objects", { title: "MapObj", ...obj(withKey({ m: { type: "object", additionalProperties: obj({ v: { type: "number" } }) } }), { required: ["id"] }) }, ["map", "nested"]));
add(js("map-of-refs", "map of internal refs", { title: "MapRef", $defs: { V: obj({ v: { type: "number" } }) }, ...obj(withKey({ m: { type: "object", additionalProperties: { $ref: "#/$defs/V" } } }), { required: ["id"] }) }, ["map", "ref"]));
add(js("map-true", "additionalProperties true / empty object", { title: "MapTrue", ...obj(withKey({ a: { type: "object", additionalProperties: true }, b: { type: "object" } }), { required: ["id"], additionalProperties: true }) }, ["map"]));
add(js("map-propertynames", "map with propertyNames", { title: "MapPN", ...obj(withKey({ m: { type: "object", propertyNames: { pattern: "^[a-z]+$" }, additionalProperties: { type: "string" } } }), { required: ["id"] }) }, ["map", "unsupported"]));

// ── 6. $defs / definitions / refs / recursion ──────────────────────────────
add(js("defs-internal", "$defs refs", { title: "DefsInternal", $defs: { Money: obj({ amount: { type: "number" }, currency: { type: "string" } }, { required: ["amount"] }), Id: { type: "string", format: "uuid" } }, ...obj({ id: { $ref: "#/$defs/Id" }, price: { $ref: "#/$defs/Money" } }, { required: ["id"] }) }, ["ref", "defs"]));
add(js("definitions-internal", "definitions (draft-07) refs", { $schema: "http://json-schema.org/draft-07/schema#", title: "DefinitionsInternal", definitions: { Tag: obj({ k: { type: "string" } }) }, ...obj(withKey({ tag: { $ref: "#/definitions/Tag" } }), { required: ["id"] }) }, ["ref", "defs", "draft-07"]));
add(js("recursive-self", "self-recursive ref", { title: "Tree", $defs: { Node: obj({ name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Node" } }, parent: { $ref: "#/$defs/Node" } }) }, $ref: "#/$defs/Node" }, ["ref", "recursive"], { requiresPrimaryKey: true }));
add(js("recursive-root", "root refs itself", { title: "RootRec", ...obj(withKey({ next: { $ref: "#" }, items: { type: "array", items: { $ref: "#" } } }), { required: ["id"] }) }, ["ref", "recursive"]));
add(js("recursive-mutual", "mutually recursive defs", { title: "Mutual", $defs: { A: obj({ b: { $ref: "#/$defs/B" } }), B: obj({ a: { $ref: "#/$defs/A" } }) }, ...obj(withKey({ a: { $ref: "#/$defs/A" } }), { required: ["id"] }) }, ["ref", "recursive"]));
add(js("ref-chain", "ref to a ref", { title: "RefChain", $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/C" }, C: { type: "string", maxLength: 8 } }, ...obj(withKey({ x: { $ref: "#/$defs/A" } }), { required: ["id"] }) }, ["ref"]));
add(js("ref-missing-local", "ref to a missing local definition", { title: "RefMissing", ...obj(withKey({ x: { $ref: "#/$defs/Nope" } }), { required: ["id"] }) }, ["ref", "dangling"]));
add(js("ref-escaped-pointer", "pointer with ~1 and %20", { title: "RefEscaped", $defs: { "a/b": { type: "string" }, "sp ace": { type: "integer" } }, ...obj(withKey({ x: { $ref: "#/$defs/a~1b" }, y: { $ref: "#/$defs/sp%20ace" } }), { required: ["id"] }) }, ["ref"]));

// ── 7. composition ──────────────────────────────────────────────────────────
add(js("allof-inheritance", "allOf with an in-document base", { title: "Dog", $defs: { Animal: obj({ name: { type: "string" }, legs: { type: "integer" } }, { required: ["name"] }) }, allOf: [{ $ref: "#/$defs/Animal" }, obj({ breed: { type: "string" } }, { required: ["breed"] })] }, ["allof", "inheritance"], { requiresPrimaryKey: true }));
add(js("allof-external-base", "allOf with an external base", { title: "Cat", allOf: [{ $ref: "https://example.com/schemas/animal.json" }, obj({ indoor: { type: "boolean" } })] }, ["allof", "inheritance", "dangling"], { requiresPrimaryKey: true }));
add(js("allof-property-level", "property allOf [ref, description]", { title: "AllOfProp", $defs: { Addr: obj({ line: { type: "string" } }) }, ...obj(withKey({ home: { allOf: [{ $ref: "#/$defs/Addr" }], description: "Home address" }, work: { allOf: [{ $ref: "#/$defs/Addr" }, { description: "Work" }] } }), { required: ["id"] }) }, ["allof", "ref"]));
add(js("allof-merge-inline", "allOf of inline objects", { title: "AllOfInline", allOf: [obj({ a: { type: "string" } }, { required: ["a"] }), obj({ b: { type: "integer" } })] }, ["allof"], { requiresPrimaryKey: true }));
add(js("oneof-refs", "oneOf union of refs", { title: "OneOfRefs", $defs: { Card: obj({ pan: { type: "string" } }), Bank: obj({ iban: { type: "string" } }) }, ...obj(withKey({ method: { oneOf: [{ $ref: "#/$defs/Card" }, { $ref: "#/$defs/Bank" }] } }), { required: ["id"] }) }, ["union", "ref"]));
add(js("anyof-refs", "anyOf union of refs", { title: "AnyOfRefs", $defs: { A: obj({ a: { type: "string" } }), B: obj({ b: { type: "string" } }) }, ...obj(withKey({ x: { anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] } }), { required: ["id"] }) }, ["union", "ref"]));
add(js("union-mixed", "mixed primitive/object union", { title: "UnionMixed", ...obj(withKey({ x: { oneOf: [{ type: "string" }, { type: "integer" }, obj({ k: { type: "string" } })] } }), { required: ["id"] }) }, ["union"]));
add(js("union-discriminator", "oneOf with discriminator mapping", { title: "UnionDisc", $defs: { Cat: obj({ kind: { const: "cat" }, lives: { type: "integer" } }), Dog: obj({ kind: { const: "dog" }, bark: { type: "string" } }) }, ...obj(withKey({ pet: { oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }], discriminator: { propertyName: "kind", mapping: { cat: "#/$defs/Cat", dog: "#/$defs/Dog" } } } }), { required: ["id"] }) }, ["union", "discriminator"]));
add(js("union-top-level", "root is a oneOf", { title: "RootUnion", $defs: { A: obj({ a: { type: "string" } }), B: obj({ b: { type: "string" } }) }, oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] }, ["union", "root"], { requiresPrimaryKey: true }));
add(js("union-1000-members", "oneOf with 250 members (cap)", { title: "UnionHuge", ...obj(withKey({ x: { oneOf: Array.from({ length: 250 }, (_, i) => obj({ [`p${i}`]: { type: "string" } })) } }), { required: ["id"] }) }, ["union", "hostile", "huge"]));

// ── 8. dangling external refs ───────────────────────────────────────────────
add(js("dangling-direct", "$ref to an external file", { title: "DanglingDirect", ...obj(withKey({ ts: { $ref: "common/date_time.json", description: "when" } }), { required: ["id", "ts"] }) }, ["dangling", "ref"]));
add(js("dangling-array-items", "array items $ref to an external file", { title: "DanglingItems", ...obj(withKey({ links: { type: "array", minItems: 1, items: { $ref: "links.json" } } }), { required: ["id", "links"] }) }, ["dangling", "ref", "array"]));
add(js("dangling-url", "$ref to an https URL", { title: "DanglingUrl", ...obj(withKey({ p: { $ref: "https://example.com/schemas/person.json#/definitions/Person" } }), { required: ["id"] }) }, ["dangling", "ref"]));
add(js("dangling-relative-fragment", "$ref to ../file.json#/pointer", { title: "DanglingFrag", ...obj(withKey({ p: { $ref: "../shared/common.json#/$defs/Money" } }), { required: ["id"] }) }, ["dangling", "ref"]));
add(js("dangling-hostile", "$ref containing quotes, newline and ${x}", { title: "DanglingHostile", ...obj(withKey({ a: { $ref: "x\"y'z.json" }, b: { $ref: "line1\nline2.json" }, c: { $ref: "${x}/`t`.json" }, d: { $ref: "a\\b\\c.json" } }), { required: ["id"] }) }, ["dangling", "ref", "hostile"]));
add(js("dangling-two-fields-same-ref", "two fields to the same external ref", { title: "DanglingTwice", ...obj(withKey({ a: { $ref: "m.json" }, b: { $ref: "m.json" } }), { required: ["id"] }) }, ["dangling", "ref"]));

// ── 9. vendor extensions and classification ─────────────────────────────────
add(js("ext-scalar", "x-* extensions with scalar values", { title: "ExtScalar", "x-owner": "payments", "x-version": 3, "x-beta": true, ...obj(withKey({ a: { type: "string", "x-pii": true, "x-note": "n", "x-weight": 1.5, "x-nothing": null } }), { required: ["id"] }) }, ["extension"]));
add(js("ext-object-array", "x-* extensions with object and array values", { title: "ExtComplex", ...obj(withKey({ a: { type: "string", "x-meta": { a: 1, b: [1, 2, { c: "d" }], e: { f: null } }, "x-list": ["a", "b", 3] } }), { required: ["id"] }) }, ["extension"]));
add(js("ext-reserved-keys", "reserved-word keys inside extension values", { title: "ExtReserved", ...obj(withKey({ a: { type: "string", "x-meta": { model: 1, enum: 2, namespace: 3, const: 4, import: 5, using: 6, op: 7, interface: 8, union: 9, "end": 10 } } }), { required: ["id"] }) }, ["extension", "hostile", "reserved-words"]));
add(js("ext-key-escapes", "extension keys that need escaping", { title: "ExtEscapes", ...obj(withKey({ a: { type: "string", "x-a\"b": 1, "x-a b": 2, "x-é": 3, "x-${y}": 4, "x-back\\slash": 5, "x-new\nline": 6 } }), { required: ["id"] }) }, ["extension", "hostile"]));
add(js("ext-entity-level", "entity-level x-* extension keys", { title: "ExtEntity", "x-domain": "orders", "x-tags": ["a", "b"], "x-classification": "class2", ...obj(withKey({ a: { type: "string" } }), { required: ["id"] }) }, ["extension", "entity-level"]));
add(js("ext-proto-key", "x-__proto__ and x-constructor keys", { title: "ExtProto", ...obj(withKey({ a: { type: "string", "x-__proto__": { polluted: true }, "x-constructor": { prototype: 1 } } }), { required: ["id"] }) }, ["extension", "hostile"]));
add(js("classification-default", "x-securityClassification default key", { title: "ClsDefault", ...obj(withKey({ a: { type: "string", "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" } }, b: { type: "integer", "x-securityClassification": { data_class: "class2" } }, c: { type: "string", "x-securityClassification": { data_class: "unknown-level", data_category: "X" } } }), { required: ["id"] }) }, ["classification"]));
add(js("classification-env-key", "classification under a configured key with a value map", { title: "ClsEnv", ...obj(withKey({ a: { type: "string", "x-vendor-class": { level: "RESTRICTED", cat: "Financial" } }, b: { type: "string", "x-vendor-class": { level: "PUBLIC" } } }), { required: ["id"] }) }, ["classification", "env"], {
  env: { SCHEMA_CLASSIFICATION_EXTENSION_KEY: "x-vendor-class", SCHEMA_CLASSIFICATION_LEVEL_FIELD: "level", SCHEMA_CLASSIFICATION_CATEGORY_FIELD: "cat", SCHEMA_CLASSIFICATION_VALUE_MAP: JSON.stringify({ RESTRICTED: "class4", PUBLIC: "class1" }) },
}));
add(js("classification-string-form", "plain string x-classification", { title: "ClsString", ...obj(withKey({ a: { type: "string", "x-classification": "class3" } }), { required: ["id"] }) }, ["classification"]));

// ── 10. unsupported keywords ────────────────────────────────────────────────
add(js("unsupported-not", "not", { title: "UnsNot", ...obj(withKey({ a: { type: "string", not: { enum: ["x"] } } }), { required: ["id"] }) }, ["unsupported"]));
add(js("unsupported-if-then-else", "if/then/else", { title: "UnsIf", ...obj(withKey({ a: { type: "string" }, b: { type: "string" } }), { required: ["id"], if: { properties: { a: { const: "x" } } }, then: { required: ["b"] }, else: { required: [] } }) }, ["unsupported"]));
add(js("unsupported-pattern-properties", "patternProperties", { title: "UnsPattern", ...obj(withKey({ m: { type: "object", patternProperties: { "^x-": { type: "string" } } } }), { required: ["id"] }) }, ["unsupported"]));
add(js("unsupported-contains", "contains / minContains", { title: "UnsContains", ...obj(withKey({ a: { type: "array", items: { type: "integer" }, contains: { const: 1 }, minContains: 1 } }), { required: ["id"] }) }, ["unsupported"]));
add(js("unsupported-prefix-items", "prefixItems (tuple)", { title: "UnsTuple", ...obj(withKey({ t: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false } }), { required: ["id"] }) }, ["unsupported", "array"]));
add(js("unsupported-unevaluated", "unevaluatedProperties / unevaluatedItems", { title: "UnsUneval", unevaluatedProperties: false, ...obj(withKey({ a: { type: "array", unevaluatedItems: false } }), { required: ["id"] }) }, ["unsupported"]));
add(js("unsupported-dependent", "dependentRequired / dependentSchemas / dependencies", { title: "UnsDep", dependentRequired: { a: ["b"] }, dependencies: { b: ["a"] }, ...obj(withKey({ a: { type: "string" }, b: { type: "string" } }), { required: ["id"] }) }, ["unsupported"]));
add(js("unsupported-ref-siblings", "$dynamicRef / $anchor / $comment", { title: "UnsDynamic", $comment: "c", $anchor: "root", ...obj(withKey({ a: { $dynamicRef: "#node" }, b: { type: "string", $comment: "field comment" } }), { required: ["id"] }) }, ["unsupported"]));

// ── 11. names ───────────────────────────────────────────────────────────────
const RESERVED = ["model", "enum", "namespace", "const", "import", "using", "op", "interface", "union", "scalar", "alias", "extends", "is", "dec", "fn", "void", "never", "unknown", "true", "false", "null", "string", "int32", "boolean", "service", "order", "when", "select", "table", "group", "user", "end", "key", "default", "class", "int", "package", "public", "static", "final"];
add(js("names-reserved-words", "property names that are language reserved words", { title: "ReservedNames", ...obj(Object.fromEntries(RESERVED.map((n) => [n, { type: "string" }])), { required: ["model", "namespace"] }) }, ["names", "reserved-words"], { requiresPrimaryKey: true }));
add(js("names-reserved-words-with-id", "reserved words next to an id", { title: "ReservedNamesId", ...obj(withKey(Object.fromEntries(RESERVED.slice(0, 12).map((n) => [n, { type: "integer" }]))), { required: ["id"] }) }, ["names", "reserved-words"]));
add(js("names-dashes-spaces-dots", "dashes, spaces and dots", { title: "OddNames", ...obj(withKey({ "first-name": { type: "string" }, "last name": { type: "string" }, "a.b.c": { type: "string" }, "x/y": { type: "string" }, "a:b": { type: "string" }, "p+q": { type: "string" } }), { required: ["id"] }) }, ["names"]));
add(js("names-unicode-emoji", "unicode and emoji names", { title: "UnicodeNames", ...obj(withKey({ "名前": { type: "string" }, "prénom": { type: "string" }, "😀": { type: "string" }, "ключ": { type: "integer" }, "a​b": { type: "string" } }), { required: ["id"] }) }, ["names", "unicode"]));
add(js("names-leading-digit", "leading digits", { title: "DigitNames", ...obj(withKey({ "1st": { type: "string" }, "2nd_place": { type: "string" }, "3": { type: "integer" }, "007": { type: "string" } }), { required: ["id"] }) }, ["names"]));
add(js("names-very-long", "very long names (refused at import)", { title: "L".repeat(300), ...obj(withKey({ ["p".repeat(250)]: { type: "string" }, ["q".repeat(1000)]: { type: "string" } }), { required: ["id"] }) }, ["names", "hostile"], { importError: /has a name of 300 characters/ }));
add(js("names-long-field-only", "a field name over the limit (dropped at import with a warning)", { title: "LongField", ...obj(withKey({ ["p".repeat(200)]: { type: "string" } }), { required: ["id"] }) }, ["names", "hostile"], { importWarnings: [/has the field "p+\.\.\." with a name of 200 characters.*dropped/] }));
add(js("names-at-limit", "entity and field names exactly at the limit", { title: "E".repeat(128), ...obj(withKey({ ["p".repeat(60)]: { type: "string" } }), { required: ["id"] }) }, ["names", "hostile"]));
add(js("names-proto", "__proto__ / constructor / prototype property names", `{"title":"ProtoNames","type":"object","properties":{"id":{"type":"string"},"__proto__":{"type":"string"},"constructor":{"type":"integer"},"prototype":{"type":"string"},"toString":{"type":"string"},"hasOwnProperty":{"type":"string"}},"required":["id","__proto__"]}`, ["names", "hostile"]));
add(js("names-case-collisions", "names that collide after case/snake conversion", { title: "Collide", ...obj(withKey({ userId: { type: "string" }, user_id: { type: "string" }, UserID: { type: "string" }, "user-id": { type: "string" } }), { required: ["id"] }) }, ["names", "hostile"]));
add(js("names-title-variants", "title with spaces/symbols", { title: "My Cool-Event v2!", ...obj(withKey({ a: { type: "string" } }), { required: ["id"] }) }, ["names", "title"]));
add(js("title-absent", "no title (ImportedEntity fallback)", obj(withKey({ a: { type: "string" } }), { required: ["id"] }), ["title"]));
add(js("title-reserved", "title is a reserved word", { title: "model", ...obj(withKey({ a: { type: "string" } }), { required: ["id"] }) }, ["title", "reserved-words"]));
add(js("title-sql-reserved", "title is an SQL reserved word", { title: "Order", ...obj(withKey({ when: { type: "string", format: "date-time" } }), { required: ["id"] }) }, ["title", "reserved-words"]));

// ── 12. dialects ────────────────────────────────────────────────────────────
for (const [name, dialect] of [["draft-07", { $schema: "http://json-schema.org/draft-07/schema#", $id: "https://example.com/draft07.json" }], ["2019-09", { $schema: "https://json-schema.org/draft/2019-09/schema", $id: "https://example.com/2019.json" }], ["2020-12", { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://example.com/2020.json" }], ["draft-04", { $schema: "http://json-schema.org/draft-04/schema#", id: "http://example.com/draft04.json" }], ["draft-06", { $schema: "http://json-schema.org/draft-06/schema#", $id: "http://example.com/draft06.json" }], ["unknown-dialect", { $schema: "https://example.com/my-meta.json" }], ["id-only", { $id: "urn:example:thing" }]] as Array<[string, Json]>) {
  add(js(`dialect-${name}`, `dialect ${name}`, { ...dialect, title: `Dialect_${name.replace(/\W/g, "_")}`, ...obj(withKey({ a: { type: "string" }, n: { type: "integer" } }), { required: ["id"] }) }, ["dialect"]));
}
add(js("yaml-format", "YAML document", `$schema: https://json-schema.org/draft/2020-12/schema
title: YamlThing
description: authored in YAML
type: object
required: [id, name]
properties:
  id:
    type: string
    format: uuid
  name:
    type: string
    minLength: 1
  tags:
    type: array
    items: {type: string}
  meta:
    type: object
    additionalProperties: {type: string}
`, ["yaml", "dialect"]));
add(js("yaml-anchors", "YAML with anchors and aliases", `title: YamlAnchors
type: object
required: [id]
properties:
  id: &str {type: string}
  other: *str
  third: *str
`, ["yaml"]));
add(js("bom-prefixed", "BOM-prefixed document", `﻿${str({ title: "BomDoc", ...obj(withKey({ a: { type: "string" } }), { required: ["id"] }) })}`, ["dialect", "hostile"]));

// ── 13. structure extremes ──────────────────────────────────────────────────
function deep(levels: number): Json {
  let node: Json = obj({ leaf: { type: "string" } });
  for (let i = 0; i < levels; i += 1) node = obj({ [`n${levels - i}`]: node });
  return node;
}
add(js("deep-50", "50 levels of nesting", { title: "Deep50", ...(deep(50)) }, ["deep", "hostile"], { requiresPrimaryKey: true }));
add(js("deep-10", "10 levels of nesting", { title: "Deep10", ...obj(withKey({ chain: deep(10) }), { required: ["id"] }) }, ["deep"]));
add(js("wide-500", "500 properties", { title: "Wide500", ...obj(withKey(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`field_${i}`, { type: i % 3 === 0 ? "integer" : i % 3 === 1 ? "string" : "boolean" }]))), { required: ["id"] }) }, ["wide", "hostile"]));
add(js("empty-object", "empty object", { title: "Empty", type: "object" }, ["empty"], { importError: /no properties to import/ }));
add(js("empty-properties", "empty properties", { title: "EmptyProps", type: "object", properties: {} }, ["empty"], { importError: /no properties to import/ }));
add(js("boolean-schema-true", "boolean schema true as a property", { title: "BoolSchema", ...obj(withKey({ anything: true, nothing: false }), { required: ["id"] }) }, ["boolean-schema"]));
add(js("root-primitive", "root is a primitive", { title: "RootString", type: "string", minLength: 3 }, ["root"], { importError: /no properties to import/ }));
add(js("root-array", "root is an array", { title: "RootArray", type: "array", items: obj(withKey({ a: { type: "string" } })) }, ["root", "array"], { importError: /Array-root JSON Schemas are not supported/ }));
add(js("root-boolean-true", "root is the boolean schema true", "true", ["root", "boolean-schema"], { importError: /Expected a JSON Schema object/ }));

// ── 14. metadata everywhere ─────────────────────────────────────────────────
add(js("meta-default-examples", "default / examples / readOnly / writeOnly / deprecated / description", { title: "Meta", description: "entity description", ...obj(withKey({ a: { type: "string", default: "x", examples: ["a", "b"], description: "d", deprecated: true }, b: { type: "integer", default: 7, readOnly: true }, c: { type: "boolean", default: false, writeOnly: true }, d: { type: "array", items: { type: "string" }, default: [] }, e: { type: "object", additionalProperties: { type: "string" }, default: {} }, f: { type: "string", default: null }, g: { type: "string", title: "G title", $comment: "c" } }), { required: ["id"] }) }, ["metadata"]));
add(js("meta-description-hostile", "descriptions with comment/quote hazards", { title: "DescHostile", description: "ends with */ and \"quotes\" and 'single' and ${x} and `tick` \\ back", ...obj(withKey({ a: { type: "string", description: "multi\nline\r\ndesc with */ and @decorator and #{x}" }, b: { type: "string", description: "-- sql comment; DROP TABLE x;" }, c: { type: "string", description: "<script>alert(1)</script> & é 名前 😀" } }), { required: ["id"] }) }, ["metadata", "hostile"]));
add(js("meta-default-hostile", "default values with quotes", { title: "DefaultHostile", ...obj(withKey({ a: { type: "string", default: "q\"u'o`t${e}\n" }, b: { type: "string", default: "" }, c: { type: "number", default: 1e21 }, d: { type: "integer", default: -0 }, e: { type: "number", default: 0.1 } }), { required: ["id"] }) }, ["metadata", "hostile"]));
add(js("meta-number-edges", "numeric boundary constraints", { title: "NumEdges", ...obj(withKey({ a: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 }, b: { type: "number", minimum: -1e308, maximum: 1e308 }, c: { type: "integer", format: "int64", maximum: 9223372036854775807 } }), { required: ["id"] }) }, ["constraints", "hostile"]));

// ── 15. the user's `user event` schema and realistic documents ─────────────
add(js("user-event", "the user's `user event` schema (plan Task 14)", {
  type: "object",
  description: "A user event containing user level customer id information used to link a user across different tenants.",
  properties: {
    component: { type: "string", description: "Name of the source component logging the user event(s).", minLength: 1, maxLength: 100, pattern: "^([A-Za-z0-9-_])+$", "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" } },
    tenant: { type: "string", description: "Name of the adjacency to PayPal.", minLength: 1, maxLength: 100, pattern: "^[a-z0-9_]+$", "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" } },
    created_time: { description: "Event creation timestamp.", $ref: "common_components/v4/schema/json/openapi-2.0/date_time.json", "x-securityClassification": { data_class: "class4", data_category: "Intrinsic" } },
    user_links: { type: "array", description: "List of list of users and their customer ids along with tenant information.", minItems: 1, maxItems: 100, items: { $ref: "user_links.json" } },
  },
  required: ["user_links", "created_time", "tenant"],
}, ["real-world", "classification", "dangling", "user-supplied"], { requiresPrimaryKey: true }));
add(js("realistic-order", "realistic order document", {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://example.com/order.json", title: "Order", description: "A customer order", type: "object",
  $defs: { Money: obj({ amount: { type: "string", format: "decimal" }, currency: { type: "string", minLength: 3, maxLength: 3 } }, { required: ["amount", "currency"] }), Status: { type: "string", enum: ["NEW", "PAID", "SHIPPED"] }, Line: obj({ sku: { type: "string" }, qty: { type: "integer", minimum: 1 }, price: { $ref: "#/$defs/Money" } }, { required: ["sku", "qty"] }) },
  properties: { orderId: { type: "string", format: "uuid" }, status: { $ref: "#/$defs/Status" }, placedAt: { type: "string", format: "date-time" }, total: { $ref: "#/$defs/Money" }, lines: { type: "array", items: { $ref: "#/$defs/Line" }, minItems: 1 }, notes: { type: ["string", "null"] }, attributes: { type: "object", additionalProperties: { type: "string" } } },
  required: ["orderId", "status", "lines"],
}, ["real-world"]));
add(js("realistic-event-envelope", "event envelope with payload union", {
  title: "EventEnvelope", type: "object", required: ["eventId", "type", "occurredAt", "payload"],
  $defs: { Created: obj({ id: { type: "string" } }, { required: ["id"] }), Deleted: obj({ id: { type: "string" }, reason: { type: "string" } }) },
  properties: { eventId: { type: "string", format: "uuid" }, type: { type: "string", enum: ["created", "deleted"] }, occurredAt: { type: "string", format: "date-time" }, payload: { oneOf: [{ $ref: "#/$defs/Created" }, { $ref: "#/$defs/Deleted" }] }, headers: { type: "object", additionalProperties: { type: "string" } } },
}, ["real-world", "union"]));

// ── 16. combinatorial variants (generated, deterministic) ───────────────────
const BASE_TYPES: Array<[string, Json]> = [["string", { type: "string" }], ["int64", { type: "integer", format: "int64" }], ["double", { type: "number", format: "double" }], ["bool", { type: "boolean" }], ["datetime", { type: "string", format: "date-time" }], ["uuid", { type: "string", format: "uuid" }], ["ref", { $ref: "#/$defs/Thing" }], ["enum", { type: "string", enum: ["p", "q"] }]];
const SHAPES: Array<[string, (s: Json) => Json]> = [["plain", (s) => s], ["nullable-typearr", (s) => (typeof s.type === "string" ? { ...s, type: [s.type, "null"] } : { anyOf: [s, { type: "null" }] })], ["array", (s) => ({ type: "array", items: s })], ["array-minmax", (s) => ({ type: "array", items: s, minItems: 1, maxItems: 3 })], ["map", (s) => ({ type: "object", additionalProperties: s })], ["described", (s) => ({ ...s, description: "has a description", deprecated: true })]];
for (const [bn, base] of BASE_TYPES) {
  for (const [sn, shape] of SHAPES) {
    for (const required of [true, false]) {
      add(js(`combo-${bn}-${sn}-${required ? "req" : "opt"}`, `${bn} / ${sn} / ${required ? "required" : "optional"}`, { title: `Combo_${bn}_${sn}_${required ? "req" : "opt"}`, $defs: { Thing: obj({ v: { type: "string" } }) }, ...obj(withKey({ value: shape(base) }), { required: required ? ["id", "value"] : ["id"] }) }, ["combo", bn, sn]));
    }
  }
}
// dialect x classification-key x extension matrix
for (const dialect of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
  for (const withCls of [true, false]) {
    for (const withExt of [true, false]) {
      const tag = `${dialect.includes("2020") ? "2020" : "d7"}-${withCls ? "cls" : "nocls"}-${withExt ? "ext" : "noext"}`;
      add(js(`matrix-${tag}`, `dialect/classification/extension ${tag}`, { $schema: dialect, title: `Matrix_${tag.replace(/-/g, "_")}`, ...obj(withKey({ a: { type: "string", ...(withCls ? { "x-securityClassification": { data_class: "class3", data_category: "Pii" } } : {}), ...(withExt ? { "x-note": { k: [1, "two"] } } : {}) } }), { required: ["id"] }) }, ["combo", "matrix"]));
    }
  }
}

export const JSONSCHEMA_CASES: CorpusCase[] = cases;
