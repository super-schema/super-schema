/**
 * protobuf-source.ts — projects the canonical TypeSpec source (from
 * `generateTypeSpec()`) onto the subset the official `@typespec/protobuf`
 * emitter can convert, WITHOUT touching the canonical source every other
 * target compiles.
 *
 * Why this exists: the protobuf emitter maps only the proto scalars
 * (bytes, boolean, string, int32/int64, uint32/uint64, float32/float64 and the
 * Protobuf.* sint/fixed variants). For any other scalar it walks the
 * `extends` chain looking for one of those, so int8/int16 (→ int32),
 * uint8/uint16 (→ uint32), safeint (→ int64), url (→ string) and float32 work
 * natively — but every chain that ends at `numeric` (numeric, integer, float,
 * decimal, decimal128) or at a temporal root (plainDate, plainTime,
 * utcDateTime, offsetDateTime, duration, unixTimestamp32 — which extends
 * utcDateTime) fails with `unsupported-field-type: no known protobuf scalar
 * for TypeSpec scalar type …`. It also requires `Protobuf.Map<K, V>` instead
 * of `Record<V>`, and explicit integer enum values with a zero first value.
 *
 * Mapping conventions (see the `protobuf` rows in
 * `src/lib/type-mapping/default-mappings.ts`, which document the lossy ones):
 * - instants (utcDateTime, offsetDateTime, unixTimestamp32) →
 *   `google.protobuf.Timestamp`; duration → `google.protobuf.Duration`
 *   (Google AIP-142, Confluent ProtobufConverter; both ship with protoc).
 * - plainDate → `google.type.Date`, plainTime → `google.type.TimeOfDay`
 *   (AIP-142; Confluent's converter uses the same messages and Schema
 *   Registry resolves google/type/* as built-in dependencies; the emitter
 *   already treats google/type/latlng.proto as a well-known type).
 * - exact/arbitrary decimals (numeric, decimal, decimal128) → `string`
 *   decimal text: proto3 has no decimal scalar, and `google.type.Decimal` is
 *   itself only a `string value` wrapper, so a plain string carries the same
 *   information without an extra dependency.
 * - integer → int64, float → double; object (`Record<unknown>`) →
 *   `google.protobuf.Struct`; map (`Record<V>`) → `map<string, V>`.
 * - enums get an `<ENUM>_UNSPECIFIED = 0` sentinel (AIP-126 / Buf
 *   ENUM_ZERO_VALUE_SUFFIX) unless the first member already is a zero-style
 *   value, then members are numbered in declaration order. Those ordinals are
 *   positional (not persisted), so reordering members is wire-breaking — see
 *   `normalizeEnumsForProtobuf`.
 *
 * Pure functions — no side effects, no I/O.
 */

const WELL_KNOWN_TIMESTAMP = "TypeSpec.Protobuf.WellKnown.Timestamp";

function externMessage(protoPath: string, protoName: string): string {
  return `TypeSpec.Protobuf.Extern<"${protoPath}", "${protoName}">`;
}

/** `Record<unknown>` (logical "object") has no typed proto equivalent. */
const STRUCT = externMessage("google/protobuf/struct.proto", "google.protobuf.Struct");

/**
 * TypeSpec stdlib scalar → the protobuf-representable TypeSpec type emitted in
 * its place. Only scalars the emitter cannot resolve on its own are listed.
 */
export const PROTOBUF_SCALAR_SUBSTITUTIONS: Readonly<Record<string, string>> = Object.freeze({
  numeric: "string",
  integer: "int64",
  float: "float64",
  decimal: "string",
  decimal128: "string",
  plainDate: externMessage("google/type/date.proto", "google.type.Date"),
  plainTime: externMessage("google/type/timeofday.proto", "google.type.TimeOfDay"),
  utcDateTime: WELL_KNOWN_TIMESTAMP,
  offsetDateTime: WELL_KNOWN_TIMESTAMP,
  unixTimestamp32: WELL_KNOWN_TIMESTAMP,
  duration: externMessage("google/protobuf/duration.proto", "google.protobuf.Duration"),
});

/**
 * Decorators whose validity depends on the property's type (numeric ranges,
 * string constraints, wire encodings, typed examples). Once a property's type
 * is substituted they can turn a valid compile into a `decorator-wrong-target`
 * / `invalid-encode` / not-assignable error, and the .proto output cannot carry
 * them anyway — so they are dropped from substituted properties only.
 */
const TYPE_BOUND_DECORATOR =
  /^[ \t]*@(?:minValue|maxValue|minValueExclusive|maxValueExclusive|minLength|maxLength|pattern|format|encode|example)\(/;

const DECORATOR_LINE = /^[ \t]*[@#]/;

/**
 * A model property line as emitted by `generateTypeSpec()`:
 * `<indent><name>[?]: <type>[ = <default>];`
 */
const PROPERTY_LINE =
  /^([ \t]*)((?:`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*)\??[ \t]*:[ \t]*)(.+?)(?:[ \t]*=[ \t]*.*?)?;[ \t]*$/;

/** A string literal, a backtick identifier, or a bare identifier that is not a member-access tail. */
const TYPE_TOKEN = /"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|(?<![\w.$])[A-Za-z_$][\w$]*/g;

/** `Record<…>` with non-generic arguments (the only shape the generator emits). */
const RECORD_TYPE = /(?<![\w.$])Record<([^<>]*)>/g;

const ENUM_BLOCK = /^([ \t]*)enum[ \t]+([A-Za-z_$][\w$]*)[ \t]*\{([^{}]*)\}/gm;

const ZERO_STYLE_MEMBER = /(?:^|_)(?:UNSPECIFIED|UNKNOWN)$/;

/**
 * Rewrite canonical TypeSpec source so the official protobuf emitter can
 * convert every model property. Only model property type expressions and
 * enum bodies change; everything else (namespaces, decorators on unchanged
 * properties, docs, field order) is preserved byte-for-byte.
 */
export function projectTypeSpecSourceForProtobuf(source: string): string {
  const lines = normalizeEnumsForProtobuf(source).split("\n");
  const projected: string[] = [];

  for (const line of lines) {
    const property = PROPERTY_LINE.exec(line);
    if (!property) {
      projected.push(line);
      continue;
    }

    const [, indent, head, typeExpression] = property;
    const protobufType = rewriteTypeExpressionForProtobuf(typeExpression);
    if (protobufType === typeExpression) {
      projected.push(line);
      continue;
    }

    dropTypeBoundDecorators(projected);
    // proto3 has no field defaults; a default typed for the original scalar
    // would not be assignable to the substituted type, so it is dropped too.
    projected.push(`${indent}${head}${protobufType};`);
  }

  return projected.join("\n");
}

/** Rewrite one TypeSpec type expression into its protobuf-representable form. */
export function rewriteTypeExpressionForProtobuf(typeExpression: string): string {
  const withMaps = typeExpression.replace(RECORD_TYPE, (record, rawArgs: string) => {
    const args = rawArgs.split(",").map((arg) => arg.trim());
    if (args.length === 1 && args[0] === "unknown") return STRUCT;
    if (args.length === 1) return `TypeSpec.Protobuf.Map<string, ${args[0]}>`;
    if (args.length === 2) return `TypeSpec.Protobuf.Map<${args[0]}, ${args[1]}>`;
    return record;
  });

  return withMaps.replace(TYPE_TOKEN, (token) =>
    Object.prototype.hasOwnProperty.call(PROTOBUF_SCALAR_SUBSTITUTIONS, token)
      ? PROTOBUF_SCALAR_SUBSTITUTIONS[token]
      : token
  );
}

/** Remove type-bound decorators from the decorator block directly above the next property. */
function dropTypeBoundDecorators(projected: string[]): void {
  for (let i = projected.length - 1; i >= 0 && DECORATOR_LINE.test(projected[i]); i--) {
    if (TYPE_BOUND_DECORATOR.test(projected[i])) {
      projected.splice(i, 1);
    }
  }
}

/**
 * The protobuf emitter requires every enum member to carry an explicit
 * integer and the first one to be zero (proto3 default value).
 */
function normalizeEnumsForProtobuf(source: string): string {
  return source.replace(ENUM_BLOCK, (_block, indent: string, enumName: string, body: string) => {
    const members = body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .map((line) => line.replace(/,$/, "").split(":")[0].trim())
      .filter(Boolean);

    const sentinel = `${toUpperSnakeCase(enumName)}_UNSPECIFIED`;
    const existingZero = members.includes(sentinel)
      ? members.indexOf(sentinel)
      : members.length > 0 && ZERO_STYLE_MEMBER.test(members[0])
        ? 0
        : -1;
    const ordered =
      existingZero === -1
        ? [sentinel, ...members]
        : [members[existingZero], ...members.filter((_, i) => i !== existingZero)];

    // WIRE-COMPATIBILITY HAZARD: ordinals are POSITIONAL. The logical model
    // stores enum members as an ordered name list with no persisted number,
    // so each member's proto value is its index here. Inserting, removing or
    // reordering a logical member silently renumbers every later member — a
    // breaking wire change for existing consumers (and a Buf breaking /
    // Schema Registry compatibility failure). Documented on the `enum` →
    // protobuf row in default-mappings.ts; stable, persisted, append-only
    // ordinals are a follow-up story.
    const memberLines = ordered.map((member, value) => `${indent}  ${member}: ${value},`);
    return [`${indent}enum ${enumName} {`, ...memberLines, `${indent}}`].join("\n");
  });
}

function toUpperSnakeCase(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
