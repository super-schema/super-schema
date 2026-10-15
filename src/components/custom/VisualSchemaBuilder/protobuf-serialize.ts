/**
 * Pure serialization for the visual Protobuf builder (.proto text).
 *
 * Mirrors serialize.ts's pattern. Type vocabulary is a subset of what
 * protobuf.importer.ts (protobufjs) maps, and trailing `// doc` comments are
 * read back as field descriptions, so a schema built here parses back cleanly
 * through the real importer.
 *
 * oneof groups are emitted as real nested `oneof NAME { ... }` blocks; the
 * importer records the grouping as `governance.protobufOneofGroup`.
 */

export type ProtoFieldType =
  | "string"
  | "int32"
  | "int64"
  | "sint32"
  | "sint64"
  | "uint32"
  | "uint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "float"
  | "double"
  | "bool"
  | "bytes"
  | "google.protobuf.Timestamp"
  | "google.protobuf.Duration"
  | "reference";

export const PROTO_SCALAR_TYPES: ProtoFieldType[] = [
  "string",
  "int32",
  "int64",
  "sint32",
  "sint64",
  "uint32",
  "uint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "float",
  "double",
  "bool",
  "bytes",
];

export const PROTO_WELL_KNOWN_TYPES: ProtoFieldType[] = [
  "google.protobuf.Timestamp",
  "google.protobuf.Duration",
];

/** Full picker vocabulary for a regular (non-map) field, in display order. */
export const PROTO_FIELD_TYPES: ProtoFieldType[] = [
  ...PROTO_SCALAR_TYPES,
  ...PROTO_WELL_KNOWN_TYPES,
  "reference",
];

/** Valid proto3 map key types (no float/double/bytes/message per spec). */
export const PROTO_MAP_KEY_TYPES: ProtoFieldType[] = [
  "string",
  "int32",
  "int64",
  "sint32",
  "sint64",
  "uint32",
  "uint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "bool",
];

/** A field's "shape": a regular scalar/reference type, or a map<K,V>. */
export type ProtoFieldShape = ProtoFieldType | "map";

export interface ProtoField {
  id: string;
  name: string;
  type: ProtoFieldShape;
  fieldNumber: number;
  repeated: boolean;
  doc: string;

  // reference (type === "reference")
  refTarget?: string;

  // map (type === "map")
  mapKeyType?: ProtoFieldType;
  mapValueType?: ProtoFieldType;
  mapValueRefTarget?: string;

  // groups fields into a `oneof NAME { ... }` block
  oneofGroup?: string;
}

/** Next unused positive field number, for auto-suggesting on "Add field". */
export function nextFieldNumber(fields: ProtoField[]): number {
  const used = new Set(fields.map((f) => f.fieldNumber));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function protoTypeToken(
  type: ProtoFieldShape,
  opts: {
    refTarget?: string;
    mapKeyType?: ProtoFieldType;
    mapValueType?: ProtoFieldType;
    mapValueRefTarget?: string;
  }
): string {
  if (type === "reference") return opts.refTarget?.trim() || "string";
  if (type === "map") {
    const key = opts.mapKeyType ?? "string";
    const valueType = opts.mapValueType ?? "string";
    const value =
      valueType === "reference" ? opts.mapValueRefTarget?.trim() || "string" : valueType;
    return `map<${key}, ${value}>`;
  }
  return type;
}

function buildFieldLine(field: ProtoField, indent: string): string {
  // map fields can't be repeated (and are inherently map-shaped, not scalar).
  const modifier = field.type !== "map" && field.repeated ? "repeated " : "";
  const typeToken = protoTypeToken(field.type, field);
  const comment = field.doc.trim() ? ` // ${field.doc.trim()}` : "";
  return `${indent}${modifier}${typeToken} ${field.name.trim()} = ${field.fieldNumber};${comment}`;
}

/**
 * Serialize builder rows into .proto text, or null when the state is
 * incomplete (no message name or no named fields).
 */
export function buildProtoDocument(
  name: string,
  packageName: string,
  fields: ProtoField[]
): string | null {
  const named = fields.filter((f) => f.name.trim());
  if (!name.trim() || named.length === 0) return null;

  const lines: string[] = ['syntax = "proto3";', ""];
  if (packageName.trim()) {
    lines.push(`package ${packageName.trim()};`, "");
  }
  lines.push(`message ${name.trim()} {`);

  const emittedGroups = new Set<string>();
  for (const field of named) {
    const group = field.oneofGroup?.trim();
    if (group) {
      if (emittedGroups.has(group)) continue;
      emittedGroups.add(group);
      lines.push(`  oneof ${group} {`);
      const members = named.filter((f) => f.oneofGroup?.trim() === group);
      for (const member of members) {
        // oneof members can't be repeated or map in proto3 — fall back to the
        // bare scalar/reference token even if the UI state allows setting them.
        const safeType: ProtoFieldShape = member.type === "map" ? "string" : member.type;
        const typeToken = protoTypeToken(safeType, member);
        const comment = member.doc.trim() ? ` // ${member.doc.trim()}` : "";
        lines.push(`    ${typeToken} ${member.name.trim()} = ${member.fieldNumber};${comment}`);
      }
      lines.push("  }");
      continue;
    }
    lines.push(buildFieldLine(field, "  "));
  }

  lines.push("}", "");
  return lines.join("\n");
}

/** Alias kept for naming symmetry with the other formats' `serializeXxx`. */
export function serializeProtobufSchema(
  name: string,
  packageName: string,
  fields: ProtoField[]
): string | null {
  return buildProtoDocument(name, packageName, fields);
}
