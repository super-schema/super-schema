/**
 * name-collisions.ts — names that two different inputs turn into the same identifier on a target (pure).
 *
 * Avro, protobuf and java-pojo rewrite a property name into an identifier of their own (`a-b` and `a_b` are both `a_b` in Avro and
 * protobuf, `aB` in Java), and java-pojo rewrites enum symbols into constants. The emitters do not notice: avro writes a duplicate
 * field, java-pojo a class that does not compile, protobuf reports `duplicate-property`. The DB targets already refuse such names
 * (db-source.ts, over the column names); this is the same refusal for the other renaming targets. json-schema and openapi3 keep
 * every name verbatim, so they cannot collide.
 *
 * The three rename functions MIRROR the sibling emitters' (`@typespec/avro` naming.ts sanitizeAvroName, `@typespec/java-pojo` naming.ts
 * toJavaFieldName and write.ts sanitizeEnumConstant); the corpus (tests/integration/corpus) fails when they drift apart.
 */
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { protobufFieldName } from "@/lib/compiler/typespec-identifiers";

export interface NameCollision {
  kind: "field" | "enum symbol";
  /** The inputs, in document order. */
  names: string[];
  /** The identifier they all become. */
  becomes: string;
  /** For an enum symbol: the field (or shared enum) it belongs to. */
  owner?: string;
}

const sanitizeAvroName = (input: string): string => {
  const name = input.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(name) ? `_${name}` : name || "field";
};

const JAVA_RESERVED = new Set(("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var yield record sealed permits true false null").split(" "));

const pascal = (input: string): string =>
  input.replace(/[^a-zA-Z0-9]+/g, " ").split(" ").filter((s) => s.length > 0).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("") || "Unnamed";

function toJavaFieldName(input: string): string {
  const p = pascal(input);
  let name = p.charAt(0).toLowerCase() + p.slice(1);
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) name = name.replace(/^[^a-zA-Z_$]+/, "") || "value";
  return JAVA_RESERVED.has(name) ? `${name}Value` : name;
}

function toJavaConstant(value: string): string {
  const upper = value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(upper) ? `_${upper}` : upper || "UNKNOWN";
}

const FIELD_NAMERS: Record<string, (name: string) => string> = { avro: sanitizeAvroName, protobuf: protobufFieldName, "java-pojo": toJavaFieldName };
const SYMBOL_NAMERS: Record<string, (name: string) => string> = { "java-pojo": toJavaConstant };

function group(names: readonly string[], rename: (name: string) => string): Array<{ names: string[]; becomes: string }> {
  const byIdentifier = new Map<string, string[]>();
  for (const name of new Set(names)) {
    const id = rename(name);
    byIdentifier.set(id, [...(byIdentifier.get(id) ?? []), name]);
  }
  return [...byIdentifier].filter(([, members]) => members.length > 1).map(([becomes, members]) => ({ names: members, becomes }));
}

/** Every set of names of `model` that `targetKey` would write as one identifier (empty for a target that keeps names). */
export function findNameCollisions(model: SuperSchemaModel, targetKey: string): NameCollision[] {
  const found: NameCollision[] = [];
  const fieldNamer = FIELD_NAMERS[targetKey];
  if (fieldNamer) {
    for (const g of group(model.fields.map((f) => f.name), fieldNamer)) found.push({ kind: "field", ...g });
  }
  const symbolNamer = SYMBOL_NAMERS[targetKey];
  if (symbolNamer) {
    for (const field of model.fields) {
      const symbols = field.type === "enum" ? (field.aliases.length > 0 ? field.aliases : field.complexType?.enumValues ?? []) : field.complexType?.enumValues ?? [];
      for (const g of group(symbols, symbolNamer)) found.push({ kind: "enum symbol", ...g, owner: field.name });
    }
    for (const shared of model.sharedEnums ?? []) {
      for (const g of group(shared.values, symbolNamer)) found.push({ kind: "enum symbol", ...g, owner: shared.name });
    }
  }
  return found;
}

const DISPLAY: Record<string, string> = { avro: "Avro", protobuf: "Protobuf", "java-pojo": "Java" };

export function describeNameCollision(collision: NameCollision, targetKey: string): string {
  const quoted = collision.names.map((n) => `"${n}"`);
  const list = quoted.length === 2 ? `${quoted[0]} and ${quoted[1]}` : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  const what = collision.kind === "field" ? "fields" : `enum symbols${collision.owner ? ` of "${collision.owner}"` : ""}`;
  return `The ${what} ${list} would all be written as "${collision.becomes}" in ${DISPLAY[targetKey] ?? targetKey}, so the generated schema would be invalid. Rename all but one of them.`;
}

/** Fields whose names collide on ANY renaming target (the importer warns at import time). */
export function collidingFieldNames(names: readonly string[]): Array<{ names: string[]; becomes: string; targets: string[] }> {
  const merged = new Map<string, { names: string[]; becomes: string; targets: string[] }>();
  for (const [target, rename] of Object.entries(FIELD_NAMERS)) {
    for (const g of group(names, rename)) {
      const key = g.names.join("\u0000");
      const entry = merged.get(key);
      if (entry) entry.targets.push(DISPLAY[target]);
      else merged.set(key, { ...g, targets: [DISPLAY[target]] });
    }
  }
  return [...merged.values()];
}
