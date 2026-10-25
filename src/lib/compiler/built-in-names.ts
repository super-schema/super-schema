/**
 * Names that are built-in TYPE names of a language a schema is generated for. An entity gives its name to a TypeSpec namespace, a model,
 * a file, a record, a class, so an entity called like a built-in makes a field of that built-in type mean something else (or fail):
 * - TypeSpec: an unqualified `url` inside `namespace ...url { }` resolves to the namespace, not the std scalar (JSON Schema, OpenAPI and
 *   Protobuf then fail with an opaque diagnostic).
 * - Java: `import d.p.string.String;` shadows `java.lang.String`, so `private String id` silently becomes the entity.
 * - Protobuf and Avro: their scalar / primitive type names.
 *
 * ONE function ({@link builtInNameConflict}) is the answer everywhere: entity create (every path), rename, imports, and the closure's
 * naming (which qualifies such a name for entities stored before this check existed).
 *
 * The comparison is case-insensitive on the identifier the name makes (invalid characters become `_`), so `Url`, `URL` and `url` are
 * one, `my url` (`my_url`) is not, and neither is a name that merely contains a built-in (`Urls`). Pure.
 */

import { TYPESPEC_STD_TYPE_NAMES, sanitizeIdentifier } from "./typespec-identifiers";

export type BuiltInNameConflict = { name: string; languages: string[] };

/** TypeSpec: the std scalars, `Record` / `Array`, the type keywords and the reflection `Model`. */
const TYPESPEC = [...TYPESPEC_STD_TYPE_NAMES, "unknown", "never", "void", "null", "Model"];

/**
 * Java: the simple names the Java POJO emitter WRITES (the boxed types and `Object` / `String`, the `java.math`, `java.time` and
 * `java.util` types it imports), plus `Set` and `Date`, which a hand-written model would use next to them.
 */
const JAVA = [
  "String", "Object", "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double",
  "BigInteger", "BigDecimal", "LocalDate", "LocalTime", "Instant", "OffsetDateTime", "Duration",
  "List", "Map", "Set", "Date",
];

/** Protobuf: the scalar value types and `map`. */
const PROTOBUF = ["double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes", "map"];

/** Avro: the primitive and complex type names. */
const AVRO = ["null", "boolean", "int", "long", "float", "double", "bytes", "string", "record", "enum", "array", "map", "fixed"];

const LANGUAGES: ReadonlyArray<{ language: string; names: ReadonlySet<string> }> = [
  { language: "TypeSpec", names: new Set(TYPESPEC.map((name) => name.toLowerCase())) },
  { language: "Java", names: new Set(JAVA.map((name) => name.toLowerCase())) },
  { language: "Protobuf", names: new Set(PROTOBUF) },
  { language: "Avro", names: new Set(AVRO) },
];

/**
 * The identifier a name makes, as the generators spell it (`sanitizeIdentifier`: invalid characters `_`, a TypeSpec keyword gets a `_` prefix),
 * lowercase. A name that IS a TypeSpec keyword (`model`, `enum`, `union`) is therefore not a conflict: it is written `_model` everywhere
 * already. The reflection type `Model` (a capital: not a keyword) is.
 */
const identifierOf = (name: string): string => sanitizeIdentifier(name.trim()).toLowerCase();

/** The languages `name` is a built-in type name of, or null when it is not one (see the module note). */
export function builtInNameConflict(name: string): BuiltInNameConflict | null {
  if (typeof name !== "string") return null;
  const key = identifierOf(name);
  if (key === "") return null;
  const languages = LANGUAGES.filter(({ names }) => names.has(key)).map(({ language }) => language);
  return languages.length > 0 ? { name: name.trim(), languages } : null;
}

/** The refusal for a built-in name, or null: `"url" is a built-in type name in TypeSpec; choose another name.` */
export function builtInNameMessage(name: string): string | null {
  const conflict = builtInNameConflict(name);
  return conflict ? `"${conflict.name}" is a built-in type name in ${conflict.languages.join("/")}; choose another name.` : null;
}
